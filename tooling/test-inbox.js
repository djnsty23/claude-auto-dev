#!/usr/bin/env node
// Tests for the out-of-band inbox: the watcher and the UserPromptSubmit hook.
//
// The hook runs on every prompt, so the properties under test are as much about
// cost as correctness: silent when there is nothing new, never opens a file, and
// flat in wall-clock regardless of how much is waiting.
//
// Run: node tooling/test-inbox.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CORE = path.resolve(__dirname, '..', 'plugins', 'autodev-core');
const WATCH = path.join(CORE, 'scripts', 'inbox-watch.js');
const HOOK = path.join(CORE, 'hooks', 'inbox-notify.js');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-test-')));
const INBOX = path.join(TMP, 'claude-inbox');
fs.mkdirSync(INBOX, { recursive: true });

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

const env = { ...process.env, AUTODEV_INBOX: INBOX, CLAUDE_PLUGIN_ROOT: CORE };
const PAYLOAD = JSON.stringify({ prompt: 'hi', cwd: TMP, session_id: 's' });

const runWatch = (cmd) => spawnSync(process.execPath, [WATCH, cmd], { encoding: 'utf8', env });
const runHook = (e = {}) => spawnSync(process.execPath, [HOOK], { input: PAYLOAD, encoding: 'utf8', env: { ...env, ...e } });

function drop(name, bytes = 1024, ageMs = 0) {
    const p = path.join(INBOX, name);
    fs.writeFileSync(p, Buffer.alloc(bytes, 1));
    if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(p, t, t); }
    return p;
}

// --- resolution
check('resolves AUTODEV_INBOX override', runWatch('path').stdout.trim() === INBOX);

// --- empty is silent and free
let r = runHook();
check('empty inbox → hook exits 0', r.status === 0);
check('empty inbox → emits NOTHING (zero context cost)', (r.stdout || '').trim() === '');

// --- a new arrival is announced
drop('shot-1.png');
r = runHook();
let out = null;
try { out = JSON.parse(r.stdout); } catch { /* stays null */ }
check('new file → valid hook JSON', out !== null);
check('new file → UserPromptSubmit additionalContext',
    out?.hookSpecificOutput?.hookEventName === 'UserPromptSubmit' && !!out?.hookSpecificOutput?.additionalContext);
const ctx = out?.hookSpecificOutput?.additionalContext || '';
check('announces the filename', ctx.includes('shot-1.png'));
check('announces the absolute path so it can be Read', ctx.includes(INBOX));
check('announces arrival age for relevance judgement', /arrived .*(s|m|h|d) ago/.test(ctx));
check('warns against speculative reads', /thousand tokens|only if it plausibly/i.test(ctx));

// --- the file itself is never opened by the hook
check('hook does not read file CONTENT', !ctx.includes(''));

// The hook claims on announce, so a second prompt must be silent WITHOUT any
// manual claim — otherwise every later turn re-pays the announcement.
r = runHook();
check('hook self-claims: second prompt is silent', (r.stdout || '').trim() === '');

// --- claiming suppresses repeats
runWatch('claim');
r = runHook();
check('claimed file is not re-announced', (r.stdout || '').trim() === '');

// --- re-saving the same name counts as new (mtime is part of identity)
drop('shot-1.png', 2048);
r = runHook();
check('same filename re-saved later is announced again', (r.stdout || '').includes('shot-1.png'));
runWatch('claim');

// --- mid-sync placeholders are ignored
drop('half.png', 0);
r = runHook();
check('zero-byte (mid-sync) file is ignored', !(r.stdout || '').includes('half.png'));

// --- non-media is ignored
fs.writeFileSync(path.join(INBOX, 'notes.xyz'), 'x');
r = runHook();
check('unknown extension ignored', !(r.stdout || '').includes('notes.xyz'));

// --- age formatting
drop('old.png', 1024, 3 * 3600 * 1000);
r = runHook();
check('reports hours for an older arrival', /old\.png · arrived 3h ago/.test(r.stdout || ''));
runWatch('claim');

// --- opt-out
drop('opt.png');
r = runHook({ AUTODEV_INBOX_DISABLED: '1' });
check('AUTODEV_INBOX_DISABLED silences the hook', (r.stdout || '').trim() === '');
runWatch('claim');

// --- missing inbox must not break a prompt
r = spawnSync(process.execPath, [HOOK], {
    input: PAYLOAD, encoding: 'utf8',
    env: { ...env, AUTODEV_INBOX: path.join(TMP, 'does-not-exist') },
});
check('missing inbox → exit 0, silent', r.status === 0 && (r.stdout || '').trim() === '');

// --- malformed stdin must not break a prompt
r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', env });
check('malformed stdin → exit 0', r.status === 0);

// --- cost: wall-clock must not scale with inbox size
const timeN = (n) => {
    const t0 = Date.now();
    for (let i = 0; i < n; i++) runHook();
    return (Date.now() - t0) / n;
};
runWatch('claim');
const emptyMs = timeN(5);
for (let i = 0; i < 25; i++) drop(`bulk-${i}.png`, 4096);
const fullMs = timeN(5);
check(`flat cost: ${emptyMs.toFixed(0)}ms empty vs ${fullMs.toFixed(0)}ms with 25 files`,
    fullMs < emptyMs * 2 + 25);

// --- the inbox must not be CLAIMED when there is nothing to announce.
//
// Found by mutation: `if (out) { inbox.claim(); }` forced to `if (true)` left
// every assertion green. The suite checked that the hook stays silent on an
// empty inbox, but never that it stays silent WITHOUT marking anything seen.
//
// That gap matters more than it looks. claim() marks every file in the folder as
// seen, and the hook announces each arrival exactly once. Any path where check()
// returns nothing while unclaimed files are present would mark them consumed and
// they would never be announced at all — arrivals lost silently, which is the
// one outcome an inbox cannot have.
{
    const STATE = path.join(INBOX, '.autodev-seen.json');
    for (const f of fs.readdirSync(INBOX)) fs.rmSync(path.join(INBOX, f), { force: true });

    runWatch('claim');                       // establish a baseline state file
    const before = fs.readFileSync(STATE, 'utf8');

    const r = runHook();                     // empty inbox: nothing to announce
    const after = fs.readFileSync(STATE, 'utf8');

    check('empty inbox: hook says nothing', (r.stdout || '').trim() === '');
    check('  and does NOT claim (seen-state untouched)', after === before);
}

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
