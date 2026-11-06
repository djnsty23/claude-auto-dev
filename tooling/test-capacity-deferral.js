#!/usr/bin/env node
'use strict';
// A launch the capacity gate turned away never ran, so it is not a failed job.
//
// WHY. [measured 2026-11-05] a crash breaker tripped on 2026-11-03 and stayed
// tripped. Every Conveyor C1 launched after it wrote CAPACITY_DEFERRED and
// CLAUDE_EXIT=-1, settled `unreported`, and worker-reconcile closed the task as
// runStatus failed. The judge then escalated it, so C2 to C9 of each chain sat
// `queued` behind a job that had never started. Four other C1s waited in `held`
// after a refused login, and their dependants read as plain pending with no
// reason. Nothing alarmed on a breaker two days old. And the breaker itself was
// tripped by the frontier harness killing an overdue supervisor by pid without
// settling its capacity reservation.
//
//   D1  a capacity-deferred attempt settles `deferred` and returns the task to
//       queued with the attempt in its history: no runStatus, no verdict
//   D2  a deferred task waits for its retry time: pending with the reason
//   D3  its dependant names the deferral in its pending reason
//   D4  control: a worker that exited 1 with no report still closes failed,
//       and its dependant is blocked with that reason
//   D5  a held predecessor blocks its dependant, naming the hold and its reason
//   D6  a deferral whose retry time has passed is ready again
//   D7  blocker-report raises an alarm for a breaker tripped over an hour ago,
//       and none for a younger one
//   D8  the frontier stops an overdue supervisor without tripping the breaker;
//       control: the same kill without settling trips it
//   D9  unattended-worker status lists blocked dependants with their reason
// Every case runs on fixtures in a temp dir. No claude process runs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-deferral-')));
const HOME = path.join(ROOT, 'home');
const CFG = path.join(HOME, '.claude');
fs.mkdirSync(CFG, { recursive: true });
const PROBE_OK = path.join(ROOT, 'probe-ok.json');
const GIB = 1024 ** 3;
fs.writeFileSync(PROBE_OK, JSON.stringify({ diskFreeBytes: 900 * GIB, diskTotalBytes: 1000 * GIB, commitFreeBytes: 64 * GIB }));
Object.assign(process.env, {
    HOME, USERPROFILE: HOME, CLAUDE_CONFIG_DIR: CFG, GIT_TERMINAL_PROMPT: '0', AUTODEV_LEDGER_LOCK_WAIT_MS: '300',
    AUTODEV_GATE_LOCK_PATH: path.join(ROOT, 'locks', 'full-gate.lock'), AUTODEV_CAPACITY_PROBE_FILE: PROBE_OK,
});
delete process.env.AUTODEV_HEADLESS;
delete process.env.AUTODEV_CAPACITY;
const env = { ...process.env };

const SCRIPTS = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const WR = path.join(SCRIPTS, 'worker-reconcile.js');
const UW = path.join(SCRIPTS, 'unattended-worker.js');
const uw = require(path.join(SCRIPTS, 'unattended-worker.js'));
const br = require(path.join(SCRIPTS, 'blocker-report.js'));
const capacity = require(path.join(SCRIPTS, 'capacity.js'));
const IMAGE = path.basename(process.execPath).toLowerCase();
const HOUR = 3600000;

let total = 0; let failed = 0;
function check(name, ok, observed = '') {
    total++; if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  (${String(observed).slice(0, 500)})`}`);
}
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const iso = (ms) => new Date(ms).toISOString();
const deadPid = () => spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
function cli(script, args) {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env, timeout: 120000, windowsHide: true });
    let json = null;
    try { json = JSON.parse((r.stdout || '').trim()); } catch { /* a crash */ }
    return { status: r.status, value: json && json.ok ? json.value : null, detail: (r.stdout || '').slice(0, 600) + (r.stderr || '').slice(0, 300) };
}

const BREAKER = 'crash breaker tripped for worker at 2026-11-03T23:56:47.646Z: pid 24216 (worker, reservation r-1, admitted 2026-11-03T23:35:56.272Z) '
    + 'died without a recorded settlement; automatic admission for worker stops until an operator runs `node capacity.js clear-breaker --class worker`';

const dir = path.join(ROOT, 'world');
const ledger = path.join(dir, 'unattended.json');
const headless = path.join(dir, 'headless.json');
write(ledger, JSON.stringify({ version: 1, records: [] }));
write(headless, JSON.stringify({ version: 1, records: [] }));
const tick = () => cli(WR, ['tick', '--live', '--wait', '--ledger', ledger, '--headless-ledger', headless,
    '--state-dir', path.join(dir, 'reconcile'), '--judge-state-dir', path.join(dir, 'judge')]);
const rec = (id) => readJson(ledger).records.find((r) => r.taskId === id);
const run = (code) => readJson(headless).records.filter((r) => r.code === code).pop();

/** A started headless attempt with its run record, plus a queued dependant. */
function attempt(code, log) {
    const startedAt = iso(Date.now() - 1000);
    const logFile = path.join(dir, code, 'worker.log');
    const reportFile = path.join(dir, code, 'REPORT.md');
    write(logFile, log);
    const hl = readJson(headless);
    hl.records.push({ code, pid: deadPid(), supervisorImage: IMAGE, startedAt, log: logFile, report: reportFile, configDir: null, state: 'running' });
    write(headless, JSON.stringify(hl, null, 2));
    const taskId = `worker-${code}`;
    const ul = readJson(ledger);
    ul.records.push({ taskId, slug: code, repo: dir, branch: `claude/${code}`, state: 'started', channel: 'headless', startedAt, launchedAt: startedAt,
        attemptId: crypto.randomUUID(), report: reportFile, queuedAt: iso(Date.now() - 5000),
        launch: { model: null, effort: null, permissionMode: 'bypassPermissions', configDir: null },
        headless: { code, startedAt, ledger: headless, version: 'test', keepTools: [] } });
    ul.records.push({ taskId: `${taskId}-next`, slug: `${code}-next`, repo: dir, state: 'queued', channel: 'headless', queuedAt: iso(Date.now()), after: [taskId] });
    write(ledger, JSON.stringify(ul, null, 2));
    return taskId;
}

const children = [];
try {
    // ------------------------------------------------------------ D1 to D4
    const deferredId = attempt('d1', `CAPACITY_WAIT=${BREAKER}\n\nCAPACITY_DEFERRED=${BREAKER}\nCLAUDE_EXIT=-1\n`);
    const failedId = attempt('d4', 'worker started\nCLAUDE_EXIT=1\n');
    const t = tick();
    const out = (id) => ((t.value && t.value.outcomes) || []).find((o) => o.taskId === id) || {};
    const d = rec(deferredId) || {};
    const last = Array.isArray(d.attempts) ? d.attempts[d.attempts.length - 1] : null;
    check('D1. a capacity-deferred run settles deferred, not unreported', (run('d1') || {}).result === 'deferred', JSON.stringify(run('d1')));
    check('D1. the task returns to queued with the attempt in its history', d.state === 'queued' && last && last.outcome === 'capacity-deferred',
        JSON.stringify({ state: d.state, attempts: d.attempts, outcome: out(deferredId) }));
    check('D1. it is not a failure: no runStatus, no verdict, a retry time ahead', d.runStatus === undefined && d.verdict === undefined
        && d.deferred && Date.parse(d.deferred.retryAfter) > Date.now() && /CAPACITY_DEFERRED|crash breaker/.test(d.deferred.reason || ''),
        JSON.stringify({ runStatus: d.runStatus, verdict: d.verdict, deferred: d.deferred }));
    const ready = cli(UW, ['ready', '--ledger', ledger]);
    const pend = (id) => ((ready.value && ready.value.pending) || []).find((x) => x.taskId === id);
    const blk = (id) => ((ready.value && ready.value.blocked) || []).find((x) => x.taskId === id);
    check('D2. a deferred task is not ready before its retry time, and says why', ready.value && !ready.value.ready.includes(deferredId)
        && pend(deferredId) && /deferred until/.test(pend(deferredId).reason), ready.detail);
    check('D3. its dependant names the deferral', pend(`${deferredId}-next`) && /deferred/.test(pend(`${deferredId}-next`).reason), ready.detail);
    const f = rec(failedId) || {};
    check('D4. control: exit 1 with no report still closes failed', f.state === 'closed' && f.runStatus === 'failed', JSON.stringify({ state: f.state, runStatus: f.runStatus }));
    check('D4. control: and its dependant is blocked with that reason', blk(`${failedId}-next`) && /failed/.test(blk(`${failedId}-next`).reason), ready.detail);

    // ------------------------------------------------------------ R1, R2
    // The field shape before this fix: a deferral settled unreported, closed failed, escalated.
    {
        const code = 'r1';
        const startedAt = iso(Date.now() - 60000);
        const hl = readJson(headless);
        hl.records.push({ code, pid: deadPid(), startedAt, log: path.join(dir, code, 'worker.log'), report: path.join(dir, code, 'REPORT.md'), state: 'settled',
            result: 'unreported', exit: -1, blocker: { status: 'supervisor', text: `CAPACITY_DEFERRED=${BREAKER}` } });
        write(headless, JSON.stringify(hl, null, 2));
        const ul = readJson(ledger);
        ul.records.push({ taskId: `worker-${code}`, slug: code, repo: dir, state: 'closed', channel: 'headless', queuedAt: iso(Date.now() - 120000), startedAt, launchedAt: startedAt,
            attemptId: 'a-r1', headless: { code, startedAt, ledger: headless }, runStatus: 'failed', settledAt: startedAt, settleReason: 'SETTLED: settled unreported',
            verdict: { decision: 'escalate', reason: 'the worker left no report', by: 'judge', at: startedAt } });
        ul.records.push({ taskId: `worker-${code}-next`, slug: `${code}-next`, repo: dir, state: 'queued', channel: 'headless', queuedAt: iso(Date.now()), after: [`worker-${code}`] });
        write(ledger, JSON.stringify(ul, null, 2));
    }
    const rq = cli(UW, ['requeue', '--task-id', 'worker-r1', '--reason', 'closed by the pre-fix deferral path', '--ledger', ledger]);
    const r1 = rec('worker-r1') || {};
    const r1last = Array.isArray(r1.attempts) ? r1.attempts[r1.attempts.length - 1] : {};
    check('R1. requeue returns a capacity-deferred closed record to queued, its verdict and run status kept in history',
        rq.status === 0 && r1.state === 'queued' && r1.verdict === undefined && r1.runStatus === undefined
        && r1last.outcome === 'capacity-deferred' && r1last.closed && r1last.closed.verdict && r1last.closed.verdict.decision === 'escalate', rq.detail + JSON.stringify(r1));
    const ready2 = cli(UW, ['ready', '--ledger', ledger, '--max-per-hour', '9']);
    check('R1. and it is ready to start again', ready2.value && ready2.value.ready.includes('worker-r1'), ready2.detail);
    const rq2 = cli(UW, ['requeue', '--task-id', failedId, '--reason', 'try', '--ledger', ledger]);
    check('R2. control: requeue refuses a run that exited 1 with no capacity deferral', rq2.status !== 0 && (rec(failedId) || {}).state === 'closed'
        && /not-deferred/.test(rq2.detail), rq2.detail);

    // ------------------------------------------------------------ D9
    const st = cli(UW, ['status', '--ledger', ledger]);
    const sb = ((st.value && st.value.blocked) || []).find((x) => x.taskId === `${failedId}-next`);
    check('D9. status lists a blocked dependant with its reason', sb && /failed/.test(sb.reason), st.detail.slice(0, 300));

    // ------------------------------------------------------------ D5, D6 (pure)
    const now = Date.parse('2026-11-05T12:00:00Z');
    const held = { taskId: 'c1', state: 'held', held: { at: '2026-11-03T08:13:14Z', reason: 'login refused: OAuth session expired' } };
    const p5 = uw.planStarts([held, { taskId: 'c2', state: 'queued', queuedAt: 'x', after: ['c1'] }], { now });
    const b5 = p5.blocked.find((x) => x.taskId === 'c2');
    check('D5. a held predecessor blocks its dependant, naming the hold and its reason', b5 && /held/.test(b5.reason) && /OAuth session expired/.test(b5.reason), JSON.stringify(p5));
    const p6 = uw.planStarts([{ taskId: 'c1', state: 'queued', queuedAt: 'x', deferred: { retryAfter: iso(now - 1000), reason: 'CAPACITY_DEFERRED' } }], { now });
    check('D6. a deferral past its retry time is ready again', p6.ready.includes('c1'), JSON.stringify(p6));

    // ------------------------------------------------------------ D7
    const base = path.join(ROOT, 'autodev');
    const ledgerFile = path.join(base, 'locks', 'full-gate.capacity.json');
    const withBreaker = (trippedMs) => write(ledgerFile, JSON.stringify({ schema: 1, reservations: [],
        classes: { worker: { breaker: { trippedUtc: iso(trippedMs), reservation: 'r-1', pid: 24216, why: 'pid 24216 died without a recorded settlement' } } } }));
    withBreaker(now - 2 * HOUR);
    const r7 = br.build(base, { now, days: 7 });
    check('D7. blocker-report raises an alarm for a breaker tripped two hours ago', Array.isArray(r7.alarms) && r7.alarms.length === 1
        && r7.alarms[0].cls === 'worker' && /^ALARM/.test(br.summaryLine(r7)), JSON.stringify(r7.alarms) + ' ' + br.summaryLine(r7));
    withBreaker(now - 10 * 60000);
    const r7b = br.build(base, { now, days: 7 });
    check('D7. control: no alarm for a breaker tripped ten minutes ago', Array.isArray(r7b.alarms) && r7b.alarms.length === 0, JSON.stringify(r7b.alarms));

    // ------------------------------------------------------------ D8
    const frontier = require(path.join(__dirname, 'frontier', 'run.js'));
    const capBase = capacity.defaultBase();
    // On POSIX the sleeper is an orphan that init reaps the moment it dies. A direct child stays a
    // zombie while this synchronous test blocks the event loop, and kill(pid, 0) reads a zombie as
    // alive, so both D8 checks failed on CI's Linux and macOS runners and passed on Windows.
    const sleeper = () => {
        if (process.platform === 'win32') {
            const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
            children.push(c);
            return c;
        }
        const out = spawnSync('sh', ['-c', `"${process.execPath}" -e "setTimeout(() => {}, 60000)" >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' });
        const pid = Number(String(out.stdout || '').trim());
        if (!(pid > 0)) throw new Error(`sleeper did not start: ${out.stderr || out.status}`);
        const c = { pid, kill: () => { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } };
        children.push(c);
        return c;
    };
    const plant = (pid) => write(capacity.ledgerPath(capBase), JSON.stringify({ schema: 1, reservations: [{ id: `r-${pid}`, pid, cls: 'worker', diskBytes: 1, commitBytes: 1, createdUtc: iso(Date.now()) }], classes: {} }));
    const gone = (pid) => { for (let i = 0; i < 80; i++) { try { process.kill(pid, 0); } catch { return true; } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } return false; };
    const a = sleeper();
    plant(a.pid);
    frontier.stopSupervisor(a.pid);
    const s8 = capacity.status();
    check('D8. the frontier stops an overdue supervisor without tripping the worker breaker', gone(a.pid) && s8.ledger && !(s8.ledger.classes.worker || {}).breaker
        && s8.ledger.reservations.length === 0, JSON.stringify(s8.ledger));
    const b = sleeper();
    plant(b.pid);
    b.kill();
    gone(b.pid);
    const s8b = capacity.status();
    check('D8. control: a kill without settling trips it', s8b.ledger && (s8b.ledger.classes.worker || {}).breaker, JSON.stringify(s8b.ledger));
} catch (e) {
    failed++;
    console.log(`FAIL crashed  ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
} finally {
    for (const c of children) { try { c.kill(); } catch { /* gone */ } }
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* a locked file on Windows; the OS temp cleaner owns it */ }
}
console.log(`capacity-deferral: ${total} checks, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
