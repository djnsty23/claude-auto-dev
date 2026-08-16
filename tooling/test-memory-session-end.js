#!/usr/bin/env node
// Tests for autodev-memory's SessionEnd hook: hooks/memory-session-end.js.
//
// 68 lines, wired at SessionEnd, and it had no tests. Found by
// tooling/find-untested-hooks.js.
//
// The header records why it is on SessionEnd and not Stop: on Stop it closed the
// memory session after turn one and deleted the carrier, so every later turn's
// observations were silently dropped. That failure was invisible — nothing broke,
// memory just stopped recording. The tests below pin the properties that would
// have caught it: the carrier is cleared for THIS session only, and only when
// there is something to close.
//
// Run: node tooling/test-memory-session-end.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_SRC = path.resolve(__dirname, '..', 'plugins', 'autodev-memory');
const HOOK = path.join(PLUGIN_SRC, 'hooks', 'memory-session-end.js');
const carrier = require(path.join(PLUGIN_SRC, 'scripts', 'session-carrier.js'));

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'msend-test-')));
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'msend-home-')));

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

let n = 0;
function project(files = {}) {
    const dir = path.join(TMP, 'p' + ++n);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, rel), body);
    }
    return dir;
}

function run(dir, sessionId) {
    return spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ cwd: dir, session_id: sessionId, hook_event_name: 'SessionEnd' }),
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_SRC, HOME, USERPROFILE: HOME },
    });
}

// --------------------------------------------------------- teardown must be safe

// SessionEnd runs while Claude is shutting down. Nothing here may fail loudly.
{
    const dir = project();
    const r = run(dir, 'no-carrier-here');
    check('no carrier: exits 0', r.status === 0);
    check('  and emits no decision payload', (r.stdout || '') === '');
    check('  and reports no error', !/session close error/.test(r.stderr || ''));
}

// Malformed stdin must not break teardown either.
{
    const dir = project();
    const r = spawnSync(process.execPath, [HOOK], {
        input: 'not json', encoding: 'utf8', cwd: dir,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_SRC, HOME, USERPROFILE: HOME },
    });
    check('malformed stdin: exits 0', r.status === 0);
    check('  and stays silent', (r.stdout || '') === '');
}

// A prd.json that does not parse must not stop the session being closed. The
// summary is context, not the point.
{
    const dir = project({ 'prd.json': '{ broken' });
    carrier.write(dir, 'sess-broken-prd', 'ses_bp');
    const r = run(dir, 'sess-broken-prd');
    check('unparseable prd.json: still exits 0', r.status === 0);
    check('  and the carrier is still cleared', carrier.read(dir, 'sess-broken-prd') === null);
}

// ------------------------------------------------------ the concurrency property

// The regression this hook's placement exists to prevent, asserted directly:
// ending ONE session must not disturb another live session on the same project.
// On Stop this ran every turn and cleared the carrier, silently dropping every
// later observation.
{
    const dir = project({ 'prd.json': JSON.stringify({ stories: { 'S1-001': { title: 'a', passes: true } } }) });
    carrier.write(dir, 'sess-A', 'ses_a');
    carrier.write(dir, 'sess-B', 'ses_b');
    carrier.writePrompt(dir, 'sess-B', 'B is still working');

    const r = run(dir, 'sess-A');

    check('ending a session exits 0', r.status === 0);
    check("clears only the ending session's carrier", carrier.read(dir, 'sess-A') === null);
    check("  and leaves the other session's carrier intact", carrier.read(dir, 'sess-B') === 'ses_b');
    check("  and leaves the other session's prompt intact",
        carrier.readPrompt(dir, 'sess-B') === 'B is still working');
}

// The prompt carrier holds verbatim user text and must not outlive its session.
{
    const dir = project();
    carrier.write(dir, 'sess-P', 'ses_p');
    carrier.writePrompt(dir, 'sess-P', 'something the user typed');
    run(dir, 'sess-P');
    check('the ending session\'s stored prompt is cleared',
        carrier.readPrompt(dir, 'sess-P') === '');
}

// ---------------------------------------------------------------- report

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
