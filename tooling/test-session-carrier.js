#!/usr/bin/env node
// Tests for autodev-memory's cross-process session state.
//
// This covers the three mechanisms that previously failed silently:
//   1. The session id carrier — was an env var that died with its process, then
//      a single per-project file that concurrent sessions clobbered.
//   2. The prompt carrier — the classifier's `userPrompt` argument was read from
//      AUTO_DEV_LAST_PROMPT, which nothing set, so every observation fell back
//      to a generic type and concept.
//   3. memory-prompt-capture.js and memory-session-start.js, which had no tests.
//
// Run: node tooling/test-session-carrier.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_SRC = path.resolve(__dirname, '..', 'plugins', 'autodev-memory');
const carrier = require(path.join(PLUGIN_SRC, 'scripts', 'session-carrier.js'));

// realpathSync: on macOS os.tmpdir() is /var/folders/... but a child process
// reports cwd as /private/var/folders/..., and the two must agree.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-test-')));
const PROJ = path.join(TMP, 'proj');
fs.mkdirSync(PROJ, { recursive: true });

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

// ---------------------------------------------------------------- carrier

carrier.write(PROJ, 'harness-A', 'ses_aaa');
carrier.write(PROJ, 'harness-B', 'ses_bbb');

check('carrier reads back session A', carrier.read(PROJ, 'harness-A') === 'ses_aaa');
check('carrier reads back session B', carrier.read(PROJ, 'harness-B') === 'ses_bbb');
check('unknown session reads null', carrier.read(PROJ, 'harness-Z') === null);

// The regression that motivated the per-session keying: closing one session must
// not blind the other. Under the old single-file carrier, B stopped capturing.
carrier.clear(PROJ, 'harness-A');
check('clearing A removes only A', carrier.read(PROJ, 'harness-A') === null);
check('B survives A closing (concurrent sessions)', carrier.read(PROJ, 'harness-B') === 'ses_bbb');

// A hostile session id must not escape the carrier directory.
carrier.write(PROJ, '../../escape', 'ses_evil');
const escaped = path.join(TMP, 'escape');
check('path-traversal session id cannot escape the carrier dir', !fs.existsSync(escaped));
check('sanitized id still round-trips', carrier.read(PROJ, '../../escape') === 'ses_evil');

// Prompt carrier
carrier.writePrompt(PROJ, 'harness-B', 'fix the login redirect bug');
check('prompt round-trips', carrier.readPrompt(PROJ, 'harness-B') === 'fix the login redirect bug');
check('prompt is per-session', carrier.readPrompt(PROJ, 'harness-Z') === '');
carrier.clearPrompt(PROJ, 'harness-B');
check('prompt clears', carrier.readPrompt(PROJ, 'harness-B') === '');

// ------------------------------------------------- memory-prompt-capture.js

function runHook(hookFile, payload, env = {}) {
    return spawnSync(process.execPath, [path.join(PLUGIN_SRC, 'hooks', hookFile)], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        cwd: PROJ,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_SRC, ...env },
    });
}

// No carrier for this session → nothing recorded. Writing prompts to disk that
// nothing will read is pure cost.
let r = runHook('memory-prompt-capture.js', {
    prompt: 'no session here', cwd: PROJ, session_id: 'harness-none',
});
check('prompt capture exits 0 with no session', r.status === 0);
check('prompt capture writes nothing without a carrier', carrier.readPrompt(PROJ, 'harness-none') === '');

// With a live carrier the prompt is recorded.
carrier.write(PROJ, 'harness-C', 'ses_ccc');
r = runHook('memory-prompt-capture.js', {
    prompt: 'refactor the auth middleware', cwd: PROJ, session_id: 'harness-C',
});
check('prompt capture exits 0', r.status === 0);
check('prompt capture records the prompt', carrier.readPrompt(PROJ, 'harness-C') === 'refactor the auth middleware');
check('prompt capture emits nothing on stdout', (r.stdout || '') === '');

// <private> content is redacted before it ever touches disk.
runHook('memory-prompt-capture.js', {
    prompt: 'deploy with <private>sk_live_abc123</private> please',
    cwd: PROJ,
    session_id: 'harness-C',
});
const stored = carrier.readPrompt(PROJ, 'harness-C');
check('private blocks are redacted', !stored.includes('sk_live_abc123') && stored.includes('[REDACTED]'));

// An empty prompt is a no-op, not an overwrite.
runHook('memory-prompt-capture.js', { prompt: '', cwd: PROJ, session_id: 'harness-C' });
check('empty prompt does not clobber the stored one', carrier.readPrompt(PROJ, 'harness-C') === stored);

// Malformed stdin must never break a turn.
r = spawnSync(process.execPath, [path.join(PLUGIN_SRC, 'hooks', 'memory-prompt-capture.js')], {
    input: 'not json', encoding: 'utf8', cwd: PROJ,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_SRC },
});
check('malformed stdin → exit 0', r.status === 0);

// -------------------------------------------------- memory-session-start.js

const SS_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-home-')));
r = runHook('memory-session-start.js',
    { cwd: PROJ, session_id: 'harness-D', hook_event_name: 'SessionStart' },
    { HOME: SS_HOME, USERPROFILE: SS_HOME });

check('session start exits 0', r.status === 0);

const memDB = require(path.join(PLUGIN_SRC, 'scripts', 'memory-db.js'));
if (memDB.isAvailable()) {
    check('session start writes a carrier for its own session', /^ses_/.test(carrier.read(PROJ, 'harness-D') || ''));
} else {
    console.log('[skip] node:sqlite unavailable — skipping session-start carrier assertion');
}

// Whatever it prints must be valid hook JSON; a bare string would land in
// Claude's context as noise.
if ((r.stdout || '').trim()) {
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* stays null */ }
    check('session start stdout is valid JSON', parsed !== null);
    check('session start uses hookSpecificOutput',
        parsed === null || parsed.hookSpecificOutput?.hookEventName === 'SessionStart');
} else {
    check('session start is silent with no prior memory', true);
}

// ---------------------------------------------------------------- report

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
try { fs.rmSync(SS_HOME, { recursive: true, force: true }); } catch {}

process.exit(fail > 0 ? 1 : 0);
