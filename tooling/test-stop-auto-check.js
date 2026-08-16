#!/usr/bin/env node
// Tests for autodev-core's Stop hook — the state machine that drives `auto`.
//
// This hook can BLOCK the end of a turn, so a wrong answer here does not throw,
// it hangs the session. It shipped untested. Every transition is covered below,
// including the two that must always terminate: the idle one-shot, and a sprint
// whose remaining stories are all deferred.
//
// Run: node tooling/test-stop-auto-check.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', 'plugins', 'autodev-core');
const HOOK = path.join(PLUGIN_ROOT, 'hooks', 'stop-auto-check.js');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stopcheck-test-')));

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

// Each scenario gets a clean project directory.
let n = 0;
function project({ auto = false, exit = false, idle = false, prd = undefined, autoAgeMs = 0 } = {}) {
    const dir = path.join(TMP, 'proj' + ++n);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    if (auto) {
        const f = path.join(dir, '.claude', 'auto-active');
        fs.writeFileSync(f, '');
        if (autoAgeMs) {
            const when = new Date(Date.now() - autoAgeMs);
            fs.utimesSync(f, when, when);
        }
    }
    if (exit) fs.writeFileSync(path.join(dir, '.claude', 'auto-exit'), '');
    if (idle) fs.writeFileSync(path.join(dir, '.claude', 'auto-idle-triggered'), 'x');
    if (prd !== undefined) {
        fs.writeFileSync(path.join(dir, 'prd.json'), typeof prd === 'string' ? prd : JSON.stringify(prd));
    }
    return dir;
}

function run(dir, payload = {}) {
    const r = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ session_id: 'sess', cwd: dir, hook_event_name: 'Stop', ...payload }),
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    let decision = null;
    try { decision = JSON.parse(r.stdout); } catch { /* stays null */ }
    return { r, decision };
}

const exists = (dir, f) => fs.existsSync(path.join(dir, '.claude', f));

const SPRINT_PENDING = { stories: { 'S1-001': { title: 'a', passes: true }, 'S1-002': { title: 'b', passes: null } } };
const SPRINT_DONE = { stories: { 'S1-001': { title: 'a', passes: true } } };
const SPRINT_DEFERRED = {
    stories: {
        'S1-001': { title: 'a', passes: true },
        'S1-002': { title: 'b', passes: 'deferred' },
    },
};

// ---------------------------------------------------------------- not in auto

let d = project({ prd: SPRINT_PENDING });
let { r, decision } = run(d);
check('no auto flag → exit 0', r.status === 0);
check('no auto flag → approve', decision?.decision === 'approve');
check('no auto flag → emits valid JSON', decision !== null);

// ---------------------------------------------------------------- blocking

d = project({ auto: true, prd: SPRINT_PENDING });
({ decision } = run(d));
check('auto + pending story → block', decision?.decision === 'block');
check('block names the next story', (decision?.reason || '').includes('S1-002'));

// ---------------------------------------------------------------- idle one-shot

d = project({ auto: true, prd: SPRINT_DONE });
({ decision } = run(d));
check('auto + all done, first stop → block for idle detection', decision?.decision === 'block');
check('idle marker written', exists(d, 'auto-idle-triggered'));

// The critical termination property: a second stop must NOT block again.
({ decision } = run(d));
check('auto + all done, second stop → approve (idle is one-shot)', decision?.decision === 'approve');
check('idle marker cleared', !exists(d, 'auto-idle-triggered'));
check('auto flag cleared after idle', !exists(d, 'auto-active'));

// And a third stop, with the flag gone, still approves.
({ decision } = run(d));
check('third stop → approve', decision?.decision === 'approve');

// ------------------------------------------------- deferred stories terminate

// `deferred` means "not doing this now". Counting it as remaining work makes
// auto mode block forever on a sprint that is, in fact, finished — the 2h stale
// flag was the only escape.
d = project({ auto: true, prd: SPRINT_DEFERRED });
({ decision } = run(d));
// It may still block once for idle detection — that is the normal
// sprint-complete path — but it must not claim there is work outstanding.
check('auto + only deferred left → not counted as remaining work',
    !/tasks remaining/.test(decision?.reason || ''));

// Drive it to completion the same way the idle path terminates.
let guard = 0;
while (decision?.decision === 'block' && guard++ < 5) ({ decision } = run(d));
check('deferred sprint reaches approve within a few stops', decision?.decision === 'approve');

// ---------------------------------------------------------------- exit signal

d = project({ auto: true, idle: true, prd: SPRINT_PENDING, exit: true });
({ decision } = run(d));
check('auto-exit → approve even with pending work', decision?.decision === 'approve');
check('auto-exit consumes the exit flag', !exists(d, 'auto-exit'));
check('auto-exit clears the auto flag', !exists(d, 'auto-active'));
check('auto-exit clears the idle marker', !exists(d, 'auto-idle-triggered'));

// ---------------------------------------------------------------- stale flag

d = project({ auto: true, prd: SPRINT_PENDING, autoAgeMs: 3 * 60 * 60 * 1000 });
({ decision } = run(d));
check('auto flag older than 2h → approve', decision?.decision === 'approve');
check('stale auto flag removed', !exists(d, 'auto-active'));

// A flag just inside the window still blocks.
d = project({ auto: true, prd: SPRINT_PENDING, autoAgeMs: 60 * 60 * 1000 });
({ decision } = run(d));
check('auto flag younger than 2h still blocks', decision?.decision === 'block');

// ---------------------------------------------------------------- no prd.json

d = project({ auto: true });
({ decision } = run(d));
check('auto flag with no prd.json → approve', decision?.decision === 'approve');
check('auto flag with no prd.json is cleaned up', !exists(d, 'auto-active'));

// ---------------------------------------------------------------- bad input

// A malformed prd.json must not strand the session in auto mode.
d = project({ auto: true, prd: '{ not json' });
({ r, decision } = run(d));
check('malformed prd.json → exit 0', r.status === 0);
check('malformed prd.json → does not block forever', decision?.decision === 'approve');
check('malformed prd.json clears the auto flag', !exists(d, 'auto-active'));

// Malformed stdin must still produce a decision.
d = project({ prd: SPRINT_PENDING });
r = spawnSync(process.execPath, [HOOK], {
    input: 'not json', encoding: 'utf8', cwd: d,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
});
let parsed = null;
try { parsed = JSON.parse(r.stdout); } catch { /* stays null */ }
check('malformed stdin → exit 0', r.status === 0);
check('malformed stdin → still approves', parsed?.decision === 'approve');

// ---------------------------------------------------------------- payload cwd

// The hook must act on the project Claude is working in, not on the shell that
// spawned it.
const other = project({ auto: true, prd: SPRINT_PENDING });
const elsewhere = path.join(TMP, 'elsewhere');
fs.mkdirSync(elsewhere, { recursive: true });
r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: 's', cwd: other, hook_event_name: 'Stop' }),
    encoding: 'utf8',
    cwd: elsewhere,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
});
try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
check('uses payload cwd, not process cwd', parsed?.decision === 'block');

// ---------------------------------------------------------------- report

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

process.exit(fail > 0 ? 1 : 0);
