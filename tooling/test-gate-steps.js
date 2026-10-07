#!/usr/bin/env node
/**
 * test-gate-steps.js - drives tooling/gate-lock.js as a SUBPROCESS to prove
 * the gate records each chain step as it starts and ends, so a gate whose
 * process tree dies mid-step still names that step.
 *
 * `[measured 2026-10-06]` a detached `npm run gate` lost its process tree mid
 * check:suites and left no exit line and no kill in any log. Each case here
 * runs the real wrapper against a synthetic tree whose gate:chain is three
 * `node step.js` steps, with the lock path in a temp directory, and reads the
 * step records (gate-records.js readSteps) the runner left. The machine's real
 * lock is never touched: every spawn sets AUTODEV_GATE_LOCK_PATH.
 *
 *   T1  green chain: three start and three end records, in order, exit 0
 *   T2  red middle step: the chain stops there with its exit, as && does
 *   T3  the whole tree killed mid-step: the step that was running has a start
 *       record, no end, and its own pid, and every reader names it
 *   T4  only the runner killed: the wrapper exits 2 and names the step
 *   T5  headless-worker settle --lost names the step its worker's gate died in
 *   T6  a chain this cannot split still runs whole, as one recorded step
 *   T7  a forwarded SIGTERM still exits 2, never a recorded red
 *
 * PLANTED DEFECTS, each by an exact anchor in a copy of the subject tree:
 *   P1  no start record before a step runs           -> T3 goes red
 *   P2  the chain runs whole, never split            -> T1 and T3 go red
 *   P3  the wrapper does not name the lost step      -> T4 goes red
 *   P4  settle --lost does not read the step records -> T5 goes red
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SUBJECT = path.join(__dirname, 'gate-lock.js');
const WIN = process.platform === 'win32';
let failed = 0;
let passed = 0;

function check(name, cond, detail) {
    if (cond) { passed++; console.log(`PASS  ${name}`); return; }
    failed++;
    console.log(`FAIL  ${name}`);
    if (detail) console.log(String(detail).split('\n').map((l) => '      ' + l).join('\n'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const temps = [];
const mkTemp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };

/** One step: writes its pid to step-<name>.pid, sleeps, exits with the code asked. */
const STEP = `'use strict';
const fs = require('fs');
const [name, code, sleepMs] = [process.argv[2], Number(process.argv[3] || 0), Number(process.argv[4] || 0)];
fs.writeFileSync('step-' + name + '.pid', String(process.pid));
console.log('step ' + name + ' running');
if (sleepMs > 0) setTimeout(() => process.exit(code), sleepMs);
else process.exitCode = code;
`;

const CHAIN3 = (b = '0 0') => `node step.js a 0 0 && node step.js b ${b} && node step.js c 0 0`;

/** The subject library a (possibly mutant) gate-lock.js sits beside. */
const libOf = (subject, rel) => require(path.join(path.dirname(subject), '..', rel));

function fixture(chain) {
    const dir = mkTemp('gate-steps-tree-');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0', private: true,
        scripts: { gate: 'node gate-lock.js', 'gate:chain': chain } }, null, 2));
    fs.writeFileSync(path.join(dir, 'step.js'), STEP);
    const lockDir = path.join(mkTemp('gate-steps-home-'), 'locks');
    return { dir, lockDir, lockPath: path.join(lockDir, 'full-gate.lock') };
}

function envFor(fx, extra = {}) {
    const env = { ...process.env, AUTODEV_GATE_LOCK_PATH: fx.lockPath, AUTODEV_GATE_LOCK_POLL_MS: '100',
                  AUTODEV_GATE_LOCK_REPORT_MS: '100000', AUTODEV_GATE_DESCENDANT_WAIT_MS: '0', ...extra };
    delete env.AUTODEV_GATE_LOCK;
    delete env.AUTODEV_GATE_LANES;
    delete env.AUTODEV_GATE_RECOVERY;
    return env;
}

function start(subject, fx) {
    const child = spawn(process.execPath, [subject, '--root', fx.dir], { env: envFor(fx), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const run = { child, out: '' };
    child.stdout.on('data', (b) => { run.out += b; });
    child.stderr.on('data', (b) => { run.out += b; });
    run.done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, out: run.out })));
    return run;
}

async function finished(run, ms = 60000) {
    const r = await Promise.race([run.done, sleep(ms).then(() => null)]);
    if (r) return r;
    try { run.child.kill('SIGKILL'); } catch { /* gone */ }
    return { code: null, signal: 'TIMEOUT', out: `${run.out}\n(test killed the wrapper after ${ms} ms)` };
}

async function waitFor(pred, ms, what) {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (pred()) return true; await sleep(50); }
    console.log(`      (timed out after ${ms} ms waiting for ${what})`);
    return false;
}

/**
 * The recorded pid is the step's own on POSIX, which spawns it without a
 * shell. On Windows the step runs through cmd.exe (npm is npm.cmd there), so
 * the recorded pid is that shell, the step's parent.
 */
const isStepPid = (recorded, step) => (WIN ? Number.isInteger(recorded) && recorded > 0 : recorded === step);
const pidOf = (fx, name) => { try { return Number(fs.readFileSync(path.join(fx.dir, `step-${name}.pid`), 'utf8')); } catch { return null; } };
const runIdOf = (out) => { const m = /run (\S+) token/.exec(out); return m ? m[1] : null; };
const runnerPidOf = (out) => { const m = /chain pid (\d+)/.exec(out); return m ? Number(m[1]) : null; };

function hardKill(pid) {
    if (!pid) return;
    if (WIN) spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

/** The run's step records, read through the subject's own gate-records.js. */
function stepsOf(subject, fx, runId) {
    const records = libOf(subject, 'plugins/autodev-core/scripts/gate-records.js');
    return runId ? records.readSteps(fx.lockPath, runId) : { state: 'absent', steps: [], bad: 0 };
}

// ---------------------------------------------------------------------------
// Scenarios. Each returns [name, ok, detail] rows, so a plant can count reds.
// ---------------------------------------------------------------------------

async function t1Green(subject) {
    const fx = fixture(CHAIN3());
    const r = await finished(start(subject, fx));
    const s = stepsOf(subject, fx, runIdOf(r.out));
    const names = s.steps.map((x) => x.step);
    const detail = `${JSON.stringify(s)}\n${r.out}`;
    return [
        ['T1: a green chain exits 0 with verdict PASS', r.code === 0 && /verdict PASS \(exit 0\)/.test(r.out), detail],
        ['T1: three steps recorded, in chain order', JSON.stringify(names) === JSON.stringify(['node step.js a 0 0', 'node step.js b 0 0', 'node step.js c 0 0']), detail],
        ['T1: every step recorded its end with exit 0', s.steps.length === 3 && s.steps.every((x) => x.ended && x.exit === 0 && x.signal === null), detail],
        ['T1: each record carries the step\'s own pid and "of 3"', s.steps.length === 3 && ['a', 'b', 'c'].every((n, i) => isStepPid(s.steps[i].pid, pidOf(fx, n)) && s.steps[i].of === 3), detail],
        ['T1: no record line is torn', s.bad === 0, detail],
    ];
}

async function t2RedMiddle(subject) {
    const fx = fixture(CHAIN3('3 0'));
    const r = await finished(start(subject, fx));
    const s = stepsOf(subject, fx, runIdOf(r.out));
    const detail = `${JSON.stringify(s)}\n${r.out}`;
    return [
        ['T2: a red middle step makes the gate exit its code, 3, verdict FAIL', r.code === 3 && /verdict FAIL \(exit 3\), the chain finished/.test(r.out), detail],
        ['T2: the step after it never started, as && stops', s.steps.length === 2 && pidOf(fx, 'c') === null, detail],
        ['T2: the red step recorded exit 3', s.steps.length === 2 && s.steps[1].ended && s.steps[1].exit === 3, detail],
    ];
}

async function t3TreeKilled(subject) {
    const fx = fixture(CHAIN3('0 30000'));
    const run = start(subject, fx);
    const up = await waitFor(() => pidOf(fx, 'b') !== null, 30000, 'step b to start');
    // The lost tree: the wrapper, its runner and the running step all die at
    // once, with no signal any of them can handle.
    const runner = runnerPidOf(run.out);
    const step = pidOf(fx, 'b');
    for (const pid of [run.child.pid, runner, step]) hardKill(pid);
    await finished(run, 10000);
    const runId = runIdOf(run.out);
    const s = stepsOf(subject, fx, runId);
    const records = libOf(subject, 'plugins/autodev-core/scripts/gate-records.js');
    const ident = libOf(subject, 'plugins/autodev-core/scripts/gate-identity.js');
    const recovery = libOf(subject, 'tooling/gate-recovery.js');
    const open = records.openStep(s.steps);
    const lost = recovery.lostStep(s);
    const found = records.findOpenSteps(fx.lockPath, { worktree: ident.canonicalPath(fx.dir), sinceMs: 0 });
    const detail = `runId=${runId} step pid=${step}\n${JSON.stringify(s)}\n${run.out}`;
    return [
        ['T3: step b was running when the tree was killed', up && step !== null, detail],
        ['T3: step a recorded its end, exit 0', s.steps.length >= 1 && s.steps[0].ended && s.steps[0].exit === 0, detail],
        ['T3: step b has a start record and no end record', s.steps.length === 2 && s.steps[1].step === 'node step.js b 0 30000' && !s.steps[1].ended, detail],
        ['T3: the open record carries step b\'s own pid', Boolean(open) && isStepPid(open.pid, step), detail],
        ['T3: gate-recovery lostStep names step 2 of 3', Boolean(lost) && /^step 2 of 3 \(node step\.js b 0 30000, pid \d+\) started .+ and recorded no exit$/.test(lost.why), lost && lost.why],
        ['T3: findOpenSteps finds it by worktree', found.length === 1 && found[0].runId === runId && found[0].index === 2, JSON.stringify(found)],
        ['T3: findOpenSteps finds nothing for another worktree', records.findOpenSteps(fx.lockPath, { worktree: ident.canonicalPath(fx.lockDir), sinceMs: 0 }).length === 0, ''],
    ];
}

async function t4RunnerKilled(subject) {
    const fx = fixture(CHAIN3('0 30000'));
    const run = start(subject, fx);
    const up = await waitFor(() => pidOf(fx, 'b') !== null, 30000, 'step b to start');
    const step = pidOf(fx, 'b');
    hardKill(runnerPidOf(run.out));
    const r = await finished(run);
    hardKill(step);
    const detail = r.out;
    return [
        ['T4: the runner was killed while step b ran', up, detail],
        ['T4: the wrapper exits 2, INDETERMINATE, as before', r.code === 2 && /verdict INDETERMINATE \(exit 2\), the chain did NOT finish/.test(r.out), detail],
        ['T4: its verdict names the step the chain died in', new RegExp(`step 2 of 3 \\(node step\\.js b 0 30000, pid ${WIN ? '\\d+' : step}\\) started \\S+ and recorded no exit`).test(r.out), detail],
    ];
}

async function t5SettleLost(subject) {
    const fx = fixture(CHAIN3('0 30000'));
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const run = start(subject, fx);
    const up = await waitFor(() => pidOf(fx, 'b') !== null, 30000, 'step b to start');
    const step = pidOf(fx, 'b');
    for (const pid of [run.child.pid, runnerPidOf(run.out), step]) hardKill(pid);
    await finished(run, 10000);
    // A worker record whose supervisor is dead (a finished node pid) and
    // whose log has no exit line: the shape settle --lost settles.
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
    const deadPid = Number(String(dead.stdout).trim());
    const wdir = mkTemp('gate-steps-worker-');
    const log = path.join(wdir, 'worker.log');
    const report = path.join(wdir, 'worker.report.md');
    fs.writeFileSync(log, 'started\n');
    const ledger = path.join(wdir, 'ledger.json');
    fs.writeFileSync(ledger, `${JSON.stringify({ version: 1, records: [{ code: 'GS5', pid: deadPid, startedAt, log, report, cwd: fx.dir,
        promptFile: null, configDir: null, model: null, permissionMode: 'default', state: 'running' }] }, null, 2)}\n`);
    const hw = path.join(path.dirname(subject), '..', 'plugins', 'autodev-core', 'scripts', 'headless-worker.js');
    const res = spawnSync(process.execPath, [hw, 'settle', '--code', 'GS5', '--lost', '--ledger', ledger],
        { encoding: 'utf8', env: { ...envFor(fx), HOME: wdir, USERPROFILE: wdir }, windowsHide: true });
    let json = null;
    try { json = JSON.parse(res.stdout); } catch { /* reported below */ }
    const v = json && json.value;
    const detail = `${res.stdout}${res.stderr}`;
    return [
        ['T5: the gate was killed mid step b', up && step !== null, run.out],
        ['T5: settle --lost settles the record as lost', Boolean(json && json.ok && v.state === 'lost'), detail],
        ['T5: and names the gate step its worker died in', Boolean(v && v.gateStep && v.gateStep.step === 'node step.js b 0 30000' && v.gateStep.index === 2 && isStepPid(v.gateStep.pid, step)), detail],
        ['T5: the ledger keeps the gate step', (() => { try { const g = JSON.parse(fs.readFileSync(ledger, 'utf8')).records[0].gateStep; return Boolean(g && g.index === 2); } catch { return false; } })(), ''],
    ];
}

async function t6Unsplittable(subject) {
    const fx = fixture('node step.js a 4 0 || node step.js b 0 0');
    const r = await finished(start(subject, fx));
    const s = stepsOf(subject, fx, runIdOf(r.out));
    const detail = `${JSON.stringify(s)}\n${r.out}`;
    return [
        ['T6: an || chain still runs whole and exits as the shell says, 0', r.code === 0 && pidOf(fx, 'a') !== null && pidOf(fx, 'b') !== null, detail],
        ['T6: recorded as one step, npm run gate:chain, ended 0', s.steps.length === 1 && s.steps[0].step === 'npm run gate:chain' && s.steps[0].ended && s.steps[0].exit === 0, detail],
    ];
}

async function t7Sigterm(subject) {
    if (WIN) return [['T7: skipped on Windows, where a signal cannot be sent to a node process', true, '']];
    const fx = fixture(CHAIN3('0 30000'));
    const run = start(subject, fx);
    const up = await waitFor(() => pidOf(fx, 'b') !== null, 30000, 'step b to start');
    run.child.kill('SIGTERM');
    const r = await finished(run);
    hardKill(pidOf(fx, 'b'));
    const s = stepsOf(subject, fx, runIdOf(r.out));
    const detail = `${JSON.stringify(s)}\n${r.out}`;
    return [
        ['T7: a SIGTERM mid-step exits 2, never a recorded red', up && r.code === 2 && /verdict INDETERMINATE \(exit 2\)/.test(r.out), detail],
        ['T7: step b recorded its end by SIGTERM, and step c never started', s.steps.length === 2 && s.steps[1].signal === 'SIGTERM' && pidOf(fx, 'c') === null, detail],
    ];
}

// ---------------------------------------------------------------------------
// Plants.
// ---------------------------------------------------------------------------

function mutant(id, rel, edits) {
    const root = mkTemp(`gsteps-${id}-`);
    const files = ['tooling/gate-lock.js', 'tooling/gate-steps.js', 'tooling/gate-recovery.js', 'tooling/coverage-receipt.js',
        'plugins/autodev-core/scripts/full-gate-queue.js', 'plugins/autodev-core/scripts/gate-identity.js',
        'plugins/autodev-core/scripts/gate-records.js', 'plugins/autodev-core/scripts/headless-worker.js',
        'plugins/autodev-core/scripts/claude-paths.js'];
    for (const f of files) {
        fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, f), path.join(root, f));
    }
    const target = path.join(root, rel);
    let src = fs.readFileSync(target, 'utf8');
    for (const [anchor, replacement] of edits) {
        const count = src.split(anchor).length - 1;
        check(`${id}: the anchor matches exactly once in ${rel} (found ${count})`, count === 1, anchor);
        if (count !== 1) return null;
        src = src.replace(anchor, replacement);
    }
    fs.writeFileSync(target, src);
    return path.join(root, 'tooling', 'gate-lock.js');
}

function expectRed(id, what, rows) {
    const red = rows.filter(([, ok]) => !ok).map(([name]) => name);
    check(`${id} planted (${what}): the scenario goes red (${red.length} of ${rows.length} rows fail)`,
        red.length > 0, red.length ? `failing: ${red.join(' | ')}` : 'every row passed against the defect');
}

async function main() {
    const only = process.env.GATE_STEPS_ONLY ? process.env.GATE_STEPS_ONLY.split(',') : null;
    const want = (id) => !only || only.includes(id);
    const real = { T1: t1Green, T2: t2RedMiddle, T3: t3TreeKilled, T4: t4RunnerKilled, T5: t5SettleLost, T6: t6Unsplittable, T7: t7Sigterm };
    for (const [id, fn] of Object.entries(real)) if (want(id)) for (const [n, ok, d] of await fn(SUBJECT)) check(n, ok, d);

    const plants = [
        ['P1', 'no start record before a step runs', 'tooling/gate-steps.js',
            [["safeRecord({ event: 'start', ...base, startUtc: new Date().toISOString() });", '']], (s) => t3TreeKilled(s), ['T3']],
        ['P2', 'the chain runs whole, never split', 'tooling/gate-lock.js',
            [['return gateSteps.splitChain(readGateChain(pkg)) || [`npm run ${CHAIN_SCRIPT}`];', 'return [`npm run ${CHAIN_SCRIPT}`];']],
            async (s) => [...await t1Green(s), ...await t3TreeKilled(s)], ['T1', 'T3']],
        ['P3', 'the wrapper does not name the lost step', 'tooling/gate-lock.js',
            [['        if (lost) v.why = `${v.why}; ${lost.why}`;\n', '']], (s) => t4RunnerKilled(s), ['T4']],
        ['P4', 'settle --lost does not read the step records', 'plugins/autodev-core/scripts/headless-worker.js',
            [['    const gateStep = lostGateStep(rec);', '    const gateStep = null;']], (s) => t5SettleLost(s), ['T5']],
    ];
    for (const [id, what, rel, edits, scenario, covers] of plants) {
        if (!want(id) && !covers.some(want)) continue;
        const m = mutant(id, rel, edits);
        if (!m) continue;
        expectRed(id, what, await scenario(m));
    }
}

main()
    .catch((e) => { failed++; console.log(`FAIL  the suite threw: ${e.stack || e.message}`); })
    .finally(() => {
        for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* a child may hold it */ } }
        console.log(`\n${passed} passed, ${failed} failed`);
        if (failed) { console.log(`${failed} gate-steps check(s) failed`); process.exitCode = 1; } else console.log('all gate-steps checks passed');
    });
