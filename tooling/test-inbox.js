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

// --- cost: the hook must not OPEN what is waiting, however much is waiting
//
// This replaced a wall-clock assertion, `fullMs < emptyMs * 2 + 25`, on
// 2026-09-12. Two reasons, and the second is why no timing threshold is put
// back in its place.
//
// 1. THE FORM WAS MACHINE-DEPENDENT IN THE WRONG DIRECTION. It reduces to
//    `D < E + 25`, where E is the bare spawn cost (CPU-bound) and D the
//    marginal cost of the waiting files (filesystem-bound): a fixed I/O cost
//    budgeted as a MULTIPLE of an unrelated baseline, so a FASTER machine got a
//    TIGHTER absolute allowance while D did not shrink. PR #213 went red on
//    macOS CI at E=38 D=113 (budget 63) while ubuntu passed at D=0 and windows
//    at D=3 ON THE SAME COMMIT, and a 14-core Mac could not reproduce it at
//    load 68 in 5 runs (E~200, D in [-44,+9]). "Re-run it somewhere quiet" is
//    the one remedy that cannot work on this shape, because a slow box makes
//    the budget generous.
//
// 2. NO THRESHOLD HERE CAN FAIL FOR THE RIGHT REASON, which is why this is a
//    replacement and not a repair. `[measured 2026-09-12]` D scales at roughly
//    16us per waiting file: N=250 D=6ms, N=2500 D=54ms, N=10000 D=157ms. At
//    N=25 the signal is about 0.4ms against a noise floor of +/-20ms, and 16
//    consecutive macOS CI jobs ran D in [-11,+8] against that one 113ms
//    excursion. So any ceiling loose enough not to flake is far too loose to
//    catch a per-file regression, and any ceiling tight enough to catch one
//    fires on stalls instead. Planting one anyway is the size check
//    rule-gate-integrity warns about: green that reads as cover it never gave.
//
// The PROPERTY the timing was proxying is exact and cheap to assert directly.
// `listFiles()` is a readdir plus a stat per entry and nothing else, so an
// UNREADABLE file must still be announced. Mode 000 is the canary: it costs no
// wall clock, it does not care how fast the machine is, and it fires for the
// regression the number never could. Confirmed 2026-09-12 by adding
// `fs.readFileSync(full)` beside the statSync in `listFiles()` -- the file
// stops being announced, and this check goes red.
if (process.platform === 'win32' || process.getuid?.() === 0) {
    // Out loud, because a silent skip is indistinguishable from a pass: mode
    // 000 does not deny reads to root, and on Windows chmod only toggles the
    // read-only bit. macOS and the ubuntu runner both run this as a real user.
    console.log(`  SKIP  unreadable-file canary (${process.platform}, uid ${process.getuid?.() ?? 'n/a'}) `
        + '— mode 000 does not deny reads here');
} else {
    const locked = drop('locked.png', 4096);
    fs.chmodSync(locked, 0o000);
    const rl = runHook();
    let lctx = '';
    try { lctx = JSON.parse(rl.stdout).hookSpecificOutput.additionalContext || ''; } catch { /* stays '' */ }
    check('a file the hook cannot READ is still announced (it only readdirs and stats)',
        lctx.includes('locked.png'));
    check('...and the hook still exits 0 and says nothing on stderr',
        rl.status === 0 && (rl.stderr || '').trim() === '');
    fs.chmodSync(locked, 0o644);
}

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

// --- the `list` subcommand, which nothing exercised.
//
// Every mutant on it survived — the whole branch could be deleted and this suite
// would stay green. It is the command a user runs by hand to see what is
// waiting, so "it prints nothing" is the failure that matters.
{
    for (const f of fs.readdirSync(INBOX)) fs.rmSync(path.join(INBOX, f), { force: true });

    const empty = runWatch('list');
    check('list on an empty inbox says so', /Inbox is empty/.test(empty.stdout || ''));
    check('  and exits 0', empty.status === 0);

    drop('screenshot-a.png', 2048);
    drop('screenshot-b.png', 4096);
    const full = runWatch('list');
    check('list counts the waiting files', /2 file\(s\)/.test(full.stdout || ''));
    check('  and names each one',
        /screenshot-a\.png/.test(full.stdout || '') && /screenshot-b\.png/.test(full.stdout || ''));
    check('  and does not claim them (list is read-only)',
        /screenshot-a\.png/.test(runWatch('check').stdout || ''));
}

// --- the announce-once cycle, asserted at the watcher level.
//
// `!claimed.has(idOf(f))` with its negation dropped inverts the filter: already
// claimed files become the "fresh" ones and genuinely new arrivals are hidden.
// That is the exact opposite of the behaviour, and it survived.
{
    for (const f of fs.readdirSync(INBOX)) fs.rmSync(path.join(INBOX, f), { force: true });

    drop('first.png', 1024);
    check('a new file is fresh', /first\.png/.test(runWatch('check').stdout || ''));

    runWatch('claim');
    check('after claim, the same file is no longer fresh',
        !/first\.png/.test(runWatch('check').stdout || ''));

    drop('second.png', 1024);
    const after = runWatch('check').stdout || '';
    check('a file arriving after the claim IS fresh', /second\.png/.test(after));
    check('  and the already-claimed one stays hidden', !/first\.png/.test(after));
}

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
