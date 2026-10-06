#!/usr/bin/env node
/**
 * test-gate-recovery.js - drives tooling/gate-lock.js as a SUBPROCESS for the
 * recovery path: a red attempt is called the machine's fault (memory, disk,
 * port) only on evidence, re-admission needs a recovery config and two healthy
 * samples, keeps the original arrival, and stops after the limit.
 *
 * Each case runs the real wrapper against a synthetic tree whose gate:chain is
 * a scripted probe (chain.js) that follows a per-attempt plan: exit code,
 * output, and whether it logs a memory event at crash time. Memory events come
 * from AUTODEV_GATE_EVENTS_FIXTURE, the seam gate-recovery.js reads in place
 * of the System event log. The machine's real lock is never touched.
 *
 * PLANTED DEFECTS, each by an exact anchor in a copy of the subject tree:
 *   P9   a crash exit counts as memory without an event -> R1 and R3 go red
 *   P10  re-admission skips the clearance samples        -> R4 and R5 go red
 *   P11  no re-admission limit                           -> R6 goes red
 *   P12  a re-admission takes a new arrival              -> R7 goes red
 *   P13  re-admission without a recovery config          -> R8 goes red
 *   P14  the runner starts before its identity is journaled -> R1 goes red
 *   P15  infrastructure evidence from any step counts      -> R9 goes red
 *   P16  one healthy sample clears                         -> R10 goes red
 *   P17  an event after the attempt counts                 -> R11 goes red
 *   P18  a config that is not an object is read as one     -> R12 goes red
 *   P19  journal pruning deletes re-admission counters     -> R13 goes red
 *   P20  a runner never told to go runs anyway             -> R14 goes red
 *   P21  lingering chain processes do not keep the lane    -> R15 goes red
 *   P22  a first lease overwrites another live run's lease -> R16 goes red
 *   P23  the suite runner's step is judged as one step    -> R17 goes red
 *   P24  one failed suite's cause excuses every failed one -> R19 goes red
 *   P25  a receipt from before the attempt counts          -> R20 goes red
 *   P26  the runner writes output to a bare stream         -> R22 goes red
 *   P27  the record sent over IPC is ignored               -> R23 goes red
 *
 * Commit headroom comes from AUTODEV_GATE_HEADROOM_FIXTURE in every case, so
 * the memory scenarios clear the same way on every platform.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SUBJECT = path.join(__dirname, 'gate-lock.js');
const records = require(path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'gate-records.js'));
const ident = require(path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'gate-identity.js'));
const recovery = require(path.join(ROOT, 'tooling', 'gate-recovery.js'));
/** The queue library beside a (possibly mutant) gate-lock.js. */
const queueOf = (subject) => require(path.join(path.dirname(subject), '..', 'plugins', 'autodev-core', 'scripts', 'full-gate-queue.js'));

const kids = [];
const lingering = [];
function sleeper() {
    const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true });
    kids.push(c);
    return c.pid;
}
function killAll() {
    for (const c of kids) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    for (const pid of lingering) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}
let failed = 0;
let passed = 0;

function check(name, cond, detail) {
    if (cond) { passed++; console.log(`PASS  ${name}`); return; }
    failed++;
    console.log(`FAIL  ${name}`);
    if (detail) console.log(String(detail).split('\n').map((l) => '      ' + l).join('\n'));
}

const temps = [];
const mkTemp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };

/** The scripted chain. plan.json: [{ exit, event, print }], the last entry repeating. */
const CHAIN = `'use strict';
const fs = require('fs');
const plan = JSON.parse(fs.readFileSync('plan.json', 'utf8'));
let n = 0;
try { n = Number(fs.readFileSync('attempts.txt', 'utf8')) || 0; } catch {}
n++;
fs.writeFileSync('attempts.txt', String(n));
let lock = null;
const lockPath = process.env.AUTODEV_GATE_LOCK_PATH;
try { lock = fs.readFileSync(lockPath, 'utf8'); } catch {}
// What the records said when this chain's first instruction ran.
const stem = lockPath.replace(/\\.lock$/, '');
const runId = process.env.AUTODEV_GATE_RUN_ID;
let journaled = false;
let leased = false;
try { journaled = Boolean(JSON.parse(fs.readFileSync(stem + '.runs/' + runId + '.json', 'utf8')).chainRoot); } catch {}
try {
    for (const f of fs.readdirSync(stem + '.leases')) {
        if (!f.endsWith('.json')) continue;
        const v = JSON.parse(fs.readFileSync(stem + '.leases/' + f, 'utf8'));
        if (v.runId === runId && v.state === 'running') leased = true;
    }
} catch {}
fs.appendFileSync('locks.jsonl', JSON.stringify({ attempt: n, lock, runId, journaled, leased }) + '\\n');
const step = plan[Math.min(n, plan.length) - 1];
if (step.event) {
    const f = process.env.AUTODEV_GATE_EVENTS_FIXTURE;
    let j = { times: [] };
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    j.times.push(new Date(Date.now() + (step.event === 'after' ? 5000 : 0)).toISOString());
    fs.writeFileSync(f, JSON.stringify(j));
}
if (step.print) console.error(step.print);
if (step.linger) {
    const { spawn } = require('child_process');
    const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ' + step.linger + ')'], { stdio: 'ignore', detached: true, windowsHide: true });
    c.unref();
    fs.writeFileSync('linger.txt', String(c.pid));
    // Live long enough for a heartbeat to journal this process, the parent
    // the lingering one names.
    const until = Date.now() + 4000;
    while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}
if (step.sleep) {
    const until = Date.now() + step.sleep;
    while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}
fs.writeFileSync('done.txt', new Date().toISOString());
process.exitCode = step.exit;
`;

/**
 * A full disk under the chain runner, loaded through NODE_OPTIONS into every
 * node process of a scenario. Only the runner (argv --run-chain) is hit: its
 * writes to fd 1 and 2 throw ENOSPC, and with GATE_FAULT_SENTINEL so does its
 * sentinel. Node's SyncWriteStream calls fs.writeSync, so a bare
 * process.stdout.write to a file fails exactly as it did on the full disk.
 */
const FAULT = `'use strict';
if (process.argv.includes('--run-chain')) {
    const fs = require('fs');
    const full = (syscall) => Object.assign(new Error('ENOSPC: no space left on device, ' + syscall), { code: 'ENOSPC', syscall });
    const writeSync = fs.writeSync;
    fs.writeSync = function (fd, ...rest) {
        if (fd === 1 || fd === 2) throw full('write');
        return writeSync.call(this, fd, ...rest);
    };
    if (process.env.GATE_FAULT_SENTINEL) {
        const writeFileSync = fs.writeFileSync;
        fs.writeFileSync = function (file, ...rest) {
            if (typeof file === 'string' && file.endsWith('.exit')) throw full('open');
            return writeFileSync.call(this, file, ...rest);
        };
    }
}
`;

let bootCache = null;
const bootCacheFile = () => bootCache || (bootCache = path.join(mkTemp('grec-boot-'), 'boot.json'));

function fixture(plan, { events = { times: [] }, config = null, configText = null, scripts = null, headroom = [1e12] } = {}) {
    const dir = mkTemp('grec-tree-');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0', private: true,
        scripts: scripts || { gate: 'node gate-lock.js', 'gate:chain': 'node chain.js' } }, null, 2));
    fs.writeFileSync(path.join(dir, 'noisy.js'), "console.log('Error: ENOSPC: no space left on device (a message this step tests)');\n");
    fs.writeFileSync(path.join(dir, 'chain.js'), CHAIN);
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
    const lockDir = path.join(mkTemp('grec-home-'), 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, 'full-gate.lock');
    const eventsFile = path.join(lockDir, 'events.json');
    fs.writeFileSync(eventsFile, JSON.stringify(events));
    if (config) fs.writeFileSync(path.join(lockDir, 'full-gate.recovery.json'), JSON.stringify(config));
    if (configText !== null) fs.writeFileSync(path.join(lockDir, 'full-gate.recovery.json'), configText);
    // Commit headroom comes from this file on every platform, so clearance of
    // a memory cause is measured the same way on Linux, macOS and Windows.
    const headroomFile = path.join(lockDir, 'headroom.json');
    fs.writeFileSync(headroomFile, JSON.stringify({ samples: headroom }));
    return { dir, lockDir, lockPath, eventsFile, headroomFile };
}

const headroomReads = (fx) => { try { return Number(JSON.parse(fs.readFileSync(fx.headroomFile, 'utf8')).reads) || 0; } catch { return 0; } };

const CONFIG = { diskFloorBytes: 1, memoryHeadroomBytes: 0, sampleIntervalMs: 100, clearanceTimeoutMs: 3000, maxReadmissions: 2 };

function envFor(fx, extra = {}) {
    const env = Object.assign({}, process.env, {
        AUTODEV_GATE_LOCK_PATH: fx.lockPath,
        AUTODEV_GATE_LOCK_POLL_MS: '100',
        AUTODEV_GATE_LOCK_REPORT_MS: '100000',
        AUTODEV_GATE_BOOT_CACHE: bootCacheFile(),
        AUTODEV_GATE_EVENTS_FIXTURE: fx.eventsFile,
        AUTODEV_GATE_HEADROOM_FIXTURE: fx.headroomFile,
        AUTODEV_GATE_DESCENDANT_WAIT_MS: '3000',
    }, extra);
    for (const k of ['AUTODEV_GATE_LOCK', 'AUTODEV_GATE_LANES', 'AUTODEV_GATE_RECOVERY', 'AUTODEV_GATE_CLASS', 'AUTODEV_GATE_GO_WAIT_MS',
        'AUTODEV_GATE_TEST_PUBLISH_DELAY_MS', 'AUTODEV_GATE_HEARTBEAT_MS', 'AUTODEV_GATE_RUN_ID', 'AUTODEV_GATE_RUN_TOKEN']) if (!(k in extra)) delete env[k];
    return env;
}

function runGate(subject, fx, extra, ms = 120000) {
    return new Promise((resolve) => {
        const c = spawn(process.execPath, [subject, '--root', fx.dir], { env: envFor(fx, extra), windowsHide: true });
        let out = '';
        c.stdout.on('data', (d) => { out += d; });
        c.stderr.on('data', (d) => { out += d; });
        const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } out += `\n(test killed the wrapper after ${ms} ms)`; }, ms);
        c.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
    });
}

/**
 * runGate with the wrapper's output going to a file, as a redirected log
 * does: the runner inherits it, so its stdout is a SyncWriteStream over a
 * file. `doneAtExit` says whether the chain had finished when the wrapper exited.
 */
function runGateToFile(subject, fx, extra, ms = 120000) {
    const file = path.join(fx.lockDir, 'gate-output.txt');
    const fd = fs.openSync(file, 'w');
    return new Promise((resolve) => {
        const c = spawn(process.execPath, [subject, '--root', fx.dir], { env: envFor(fx, extra), stdio: ['ignore', fd, fd], windowsHide: true });
        fs.closeSync(fd);
        let killed = '';
        const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } killed = `\n(test killed the wrapper after ${ms} ms)`; }, ms);
        c.on('close', (code) => {
            clearTimeout(t);
            const doneAtExit = fs.existsSync(path.join(fx.dir, 'done.txt'));
            let out = '';
            try { out = fs.readFileSync(file, 'utf8'); } catch { /* never written */ }
            resolve({ code, out: out + killed, doneAtExit });
        });
    });
}

/** The fixture's one run journal, or null. */
const journalOf = (fx) => {
    const dir = records.runsDir(fx.lockPath);
    const runs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('readmit-')) : [];
    return runs.length ? records.readRun(fx.lockPath, runs[0].replace(/\.json$/, '')).value : null;
};

const attempts = (fx) => { try { return Number(fs.readFileSync(path.join(fx.dir, 'attempts.txt'), 'utf8')); } catch { return 0; } };
const locksSeen = (fx) => {
    try { return fs.readFileSync(path.join(fx.dir, 'locks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; }
};
const metaOf = (text) => (text ? records.parseMeta(text.split(/\r?\n/)).meta : null);
const hourAgo = () => new Date(Date.now() - 3600000).toISOString();
const CRASH = { exit: 134, event: false };
const CRASH_LOGGED = { exit: 134, event: true };

// ---------------------------------------------------------------------------
// Scenarios: each returns [name, ok, detail] rows.
// ---------------------------------------------------------------------------

/** R1: a crash exit with no memory event stands as a failure; the lease and journal are written. */
async function r1CrashNoEvent(subject) {
    const fx = fixture([CRASH]);
    // The parent publishes 1.5 s late on purpose: only the go handshake keeps
    // the chain from starting before its records exist.
    const r = await runGate(subject, fx, { AUTODEV_GATE_TEST_PUBLISH_DELAY_MS: '1500' });
    const seen = locksSeen(fx);
    const leases = records.readLeases(fx.lockPath);
    const runs = fs.existsSync(records.runsDir(fx.lockPath)) ? fs.readdirSync(records.runsDir(fx.lockPath)).filter((n) => n.endsWith('.json') && !n.startsWith('readmit-')) : [];
    const journal = runs.length ? records.readRun(fx.lockPath, runs[0].replace(/\.json$/, '')).value : null;
    const lease = leases[0] && leases[0].value;
    return [
        ['R1: exit 134 with no event 2004 stays 134, a FAIL', r.code === 134 && /verdict FAIL/.test(r.out), `exit=${r.code}\n${r.out}`],
        ['R1: one attempt', attempts(fx) === 1, `attempts=${attempts(fx)}`],
        ['R1: one lease, released, naming the run, token and worktree', leases.length === 1 && lease && lease.state === 'released' &&
            typeof lease.runId === 'string' && Number.isInteger(lease.token) && typeof lease.worktree === 'string', JSON.stringify(leases)],
        ['R1: the run journal records the attempt and its chain root', Boolean(journal) && Array.isArray(journal.attempts) &&
            journal.attempts.length === 1 && journal.attempts[0].exit === 134 && Boolean(journal.chainRoot), JSON.stringify(journal)],
        ['R1: the chain\'s first instruction already saw its journaled root and its running lease', seen.length === 1 &&
            seen[0].journaled === true && seen[0].leased === true, JSON.stringify(seen)],
    ];
}

/** R2: a crash exit with event 2004 inside the attempt is INDETERMINATE (exit 2). */
async function r2CrashWithEvent(subject) {
    const fx = fixture([CRASH_LOGGED]);
    const r = await runGate(subject, fx);
    return [
        ['R2: exit 134 with event 2004 in the attempt exits 2, INDETERMINATE', r.code === 2 && /event 2004/.test(r.out), `exit=${r.code}\n${r.out}`],
        ['R2: no config, so one attempt only', attempts(fx) === 1 && /no recovery config/.test(r.out), `attempts=${attempts(fx)}\n${r.out}`],
    ];
}

/** R3: an event outside the attempt's window is not evidence. */
async function r3EventOutside(subject) {
    const fx = fixture([CRASH], { events: { times: [hourAgo()] } });
    const r = await runGate(subject, fx);
    return [['R3: an event an hour before the attempt leaves exit 134 a FAIL', r.code === 134 && /verdict FAIL/.test(r.out), `exit=${r.code}\n${r.out}`]];
}

/** R4: ENOSPC with the disk persistently under the floor: exit 2 after one attempt, never re-admitted. */
async function r4DiskPersistent(subject) {
    const fx = fixture([{ exit: 1, print: "Error: ENOSPC: no space left on device, write 'out.bin'" }],
        { config: { ...CONFIG, diskFloorBytes: 1e18 } });
    const r = await runGate(subject, fx);
    return [
        ['R4: ENOSPC under the floor exits 2', r.code === 2 && /ENOSPC/.test(r.out), `exit=${r.code}\n${r.out}`],
        ['R4: one attempt: the disk never clears, so no re-admission', attempts(fx) === 1 && /not clear within/.test(r.out), `attempts=${attempts(fx)}\n${r.out}`],
    ];
}

/** R5: EADDRINUSE on a port that stays taken: exit 2 after one attempt. */
async function r5PortPersistent(subject) {
    const server = net.createServer();
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const port = server.address().port;
    try {
        const fx = fixture([{ exit: 1, print: `Error: listen EADDRINUSE: address already in use 127.0.0.1:${port}` }], { config: CONFIG });
        const r = await runGate(subject, fx);
        return [
            ['R5: EADDRINUSE on a port still taken exits 2', r.code === 2 && new RegExp(`port ${port}`).test(r.out), `exit=${r.code}\n${r.out}`],
            ['R5: one attempt: the port never frees, so no re-admission', attempts(fx) === 1 && /not clear within/.test(r.out), `attempts=${attempts(fx)}\n${r.out}`],
        ];
    } finally { server.close(); }
}

/** R6: a memory crash every time: two re-admissions, then exit 2 with the limit named. */
async function r6Limit(subject) {
    const fx = fixture([CRASH_LOGGED, CRASH_LOGGED, CRASH_LOGGED, { exit: 0 }], { config: CONFIG });
    const r = await runGate(subject, fx, {}, 180000);
    return [
        ['R6: exactly three attempts (one plus two re-admissions)', attempts(fx) === 3, `attempts=${attempts(fx)}\n${r.out}`],
        ['R6: exit 2, naming the re-admission limit', r.code === 2 && /re-admission limit reached \(2 of 2/.test(r.out), `exit=${r.code}\n${r.out}`],
    ];
}

/** R7: a re-admission that then passes exits 0 and keeps the first arrival. */
async function r7KeepsArrival(subject) {
    const fx = fixture([CRASH_LOGGED, { exit: 0 }], { config: CONFIG });
    const r = await runGate(subject, fx, {}, 120000);
    const seen = locksSeen(fx).map((s) => metaOf(s.lock));
    const a = seen.map((m) => (m ? m.arrival : null));
    return [
        ['R7: two attempts, exit 0', r.code === 0 && attempts(fx) === 2, `exit=${r.code} attempts=${attempts(fx)}\n${r.out}`],
        ['R7: the second admission has a later token', seen.length === 2 && seen[0] && seen[1] && seen[1].token > seen[0].token, JSON.stringify(seen)],
        ['R7: both admissions record the same arrival', a.length === 2 && Boolean(a[0]) && a[0] === a[1], JSON.stringify(a)],
    ];
}

/** R8: without a recovery config a memory crash is reported, never retried. */
async function r8NoConfig(subject) {
    const fx = fixture([CRASH_LOGGED, { exit: 0 }]);
    const r = await runGate(subject, fx);
    return [['R8: no config: exit 2 after one attempt', r.code === 2 && attempts(fx) === 1, `exit=${r.code} attempts=${attempts(fx)}\n${r.out}`]];
}

/** R9: ENOSPC printed by an earlier step that passed is not the cause of a later step's failure. */
async function r9OtherStep(subject) {
    const fx = fixture([{ exit: 1 }], {
        config: { ...CONFIG, diskFloorBytes: 1e18 },
        scripts: { gate: 'node gate-lock.js', 'gate:chain': 'npm run noisy && npm run red', noisy: 'node noisy.js', red: 'node chain.js' },
    });
    const r = await runGate(subject, fx);
    return [['R9: a FAIL in a later step stays a FAIL (exit 1), whatever an earlier step printed',
        r.code === 1 && /verdict FAIL/.test(r.out) && /ENOSPC/.test(r.out) && attempts(fx) === 1, `exit=${r.code} attempts=${attempts(fx)}\n${r.out}`]];
}

/** R10: clearance needs two healthy samples IN A ROW: healthy, unhealthy, healthy, healthy is four samples. */
async function r10TwoInARow(subject) {
    const fx = fixture([CRASH_LOGGED, { exit: 0 }], { config: { ...CONFIG, memoryHeadroomBytes: 1 }, headroom: [1e12, 0, 1e12, 1e12] });
    const r = await runGate(subject, fx);
    return [
        ['R10: re-admitted once and green', r.code === 0 && attempts(fx) === 2, `exit=${r.code} attempts=${attempts(fx)}\n${r.out}`],
        ['R10: four headroom samples before the re-admission (the unhealthy one reset the count)', headroomReads(fx) === 4, `reads=${headroomReads(fx)}\n${r.out}`],
    ];
}

/** R11: an event 2004 logged after the attempt ended is not evidence about it. */
async function r11EventAfter(subject) {
    const fx = fixture([{ exit: 134, event: 'after' }]);
    const r = await runGate(subject, fx);
    return [['R11: an event 5 s after the attempt leaves exit 134 a FAIL', r.code === 134 && /verdict FAIL/.test(r.out), `exit=${r.code}\n${r.out}`]];
}

/** R12: a recovery config that is valid JSON but not an object disables retry and never changes a verdict. */
async function r12ConfigNull(subject) {
    const red = fixture([{ exit: 1 }], { configText: 'null' });
    const rr = await runGate(subject, red);
    const mem = fixture([CRASH_LOGGED, { exit: 0 }], { configText: 'null' });
    const rm = await runGate(subject, mem);
    return [
        ['R12: a plain red under a null config stays exit 1, a FAIL', rr.code === 1 && /verdict FAIL/.test(rr.out), `exit=${rr.code}\n${rr.out}`],
        ['R12: a memory crash under a null config exits 2 after one attempt, naming the config as not an object', rm.code === 2 &&
            attempts(mem) === 1 && /not a JSON object/.test(rm.out), `exit=${rm.code} attempts=${attempts(mem)}\n${rm.out}`],
    ];
}

/** R13: a re-admission counter older than the journal pruning age still counts. */
async function r13CounterSurvivesPrune(subject) {
    const fx = fixture([CRASH_LOGGED, { exit: 0 }], { config: CONFIG });
    const counter = recovery.counterFile(records.runsDir(fx.lockPath), ident.canonicalPath(fx.dir), 'no-head');
    fs.mkdirSync(path.dirname(counter), { recursive: true });
    fs.writeFileSync(counter, JSON.stringify({ count: 2, worktree: 'x', head: 'no-head' }));
    const old = new Date(Date.now() - 20 * 86400000);
    fs.utimesSync(counter, old, old);
    const r = await runGate(subject, fx);
    return [['R13: a 20-day-old counter at the limit still stops re-admission', r.code === 2 && attempts(fx) === 1 &&
        /re-admission limit reached \(2 of 2/.test(r.out) && fs.existsSync(counter), `exit=${r.code} attempts=${attempts(fx)}\n${r.out}`]];
}

/** R14: a runner never told to go does not run the chain. */
function r14NoGo(subject) {
    const fx = fixture([{ exit: 0 }]);
    const sentinel = path.join(fx.lockDir, 'runner.exit');
    const r = spawnSync(process.execPath, [subject, '--run-chain', '--root', fx.dir, '--sentinel', sentinel, '--run-id', 'run-r14', '--token', '1', '--wait-go'],
        { env: envFor(fx, { AUTODEV_GATE_GO_WAIT_MS: '500' }), encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return [['R14: without go the runner exits 2, runs no chain and writes no record', r.status === 2 && attempts(fx) === 0 && !fs.existsSync(sentinel),
        `exit=${r.status} attempts=${attempts(fx)}\n${r.stdout}${r.stderr}`]];
}

/** R15: a chain process that outlives the wait keeps the lane: the lock stays and is judged alive. */
async function r15Lingering(subject) {
    const fx = fixture([{ exit: 1, linger: 20000 }]);
    const r = await runGate(subject, fx, { AUTODEV_GATE_DESCENDANT_WAIT_MS: '1000', AUTODEV_GATE_HEARTBEAT_MS: '200' });
    let linger = null;
    try { linger = Number(fs.readFileSync(path.join(fx.dir, 'linger.txt'), 'utf8')); } catch { /* not started */ }
    if (linger) lingering.push(linger);
    const lock = records.readLaneLock(fx.lockPath);
    let judged = null;
    try { judged = queueOf(subject).readLaneLocks(fx.lockPath, envFor(fx))[0]; } catch (e) { judged = { error: e.message }; }
    const lease = records.readLeases(fx.lockPath)[0];
    return [
        ['R15: the attempt is a FAIL (exit 1)', r.code === 1, `exit=${r.code}\n${r.out}`],
        ['R15: the lock stays, naming the run', Boolean(lock) && Boolean(lock.meta) && Boolean(linger), `${lock ? lock.text : '(no lock)'} linger=${linger}`],
        ['R15: a waiter judges the lane held', Boolean(judged) && judged.alive === true, JSON.stringify(judged)],
        ['R15: the lease says lingering and names the process', Boolean(lease) && lease.value && lease.value.state === 'lingering' &&
            Array.isArray(lease.value.lingering) && lease.value.lingering.some((p) => p.pid === linger), JSON.stringify(lease)],
    ];
}

/** R16: a worktree whose lease belongs to another live run is not gated twice. */
async function r16LeaseHeld(subject) {
    const fx = fixture([{ exit: 0 }]);
    const pid = sleeper();
    const owner = ident.identityOf(pid, { snap: ident.snapshot({ maxAgeMs: 0 }) });
    const key = ident.pathKey(ident.canonicalPath(fx.dir));
    records.writeJsonAtomic(records.leasePath(fx.lockPath, key), { schema: 1, runId: 'run-other', token: 1, worktree: fx.dir, owner, state: 'running' });
    const r = await runGate(subject, fx);
    return [['R16: exit 2 without running the chain, naming the other run', r.code === 2 && attempts(fx) === 0 && /run-other holds this worktree/.test(r.out),
        `exit=${r.code} attempts=${attempts(fx)}\n${r.out}`]];
}

// ---------------------------------------------------------------------------
// The suite runner's step: every suite runs inside one npm step (`test`), so
// evidence counts only per failed suite, read through the coverage receipt.
// ---------------------------------------------------------------------------

/** A stand-in for tooling/test-all.js: suites.json lists { label, state, print }; it echoes each, writes each log and publishes a receipt. */
const RUNNER = `'use strict';
const fs = require('fs');
const path = require('path');
const spec = JSON.parse(fs.readFileSync('suites.json', 'utf8'));
const store = process.env.AUTODEV_COVERAGE_STORE;
const runDir = path.join(store, 'runs', 'run-' + process.pid);
fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
const startedAt = new Date().toISOString();
const outcomes = [];
for (const s of spec.suites) {
    console.log('=== ' + s.label + ' ===');
    if (s.print) console.error(s.print);
    const log = 'logs/' + s.label + '.log';
    fs.writeFileSync(path.join(runDir, log), (s.print || 'no output') + String.fromCharCode(10));
    outcomes.push({ label: s.label, state: s.state, reason: null, status: s.state === 'pass' ? 0 : 1, signal: null, ms: 1, log });
}
const failed = outcomes.some((o) => o.state === 'fail');
if (spec.publish) {
    fs.writeFileSync(path.join(store, 'receipt.json'), JSON.stringify({ schema: 1, runId: 'run-' + process.pid, root: spec.root, runDir,
        startedAt, finishedAt: new Date().toISOString(), outcomes, treeInert: { state: 'pass' }, verdict: failed ? 'fail' : 'pass' }));
}
process.exitCode = failed ? 1 : 0;
`;
const receiptsLib = require(path.join(ROOT, 'tooling', 'coverage-receipt.js'));
const ENOSPC_LINE = "Error: ENOSPC: no space left on device, write 'out.bin'";

/** A tree whose gate:chain is `npm test`, and `test` runs the stand-in runner. The disk floor is out of reach, so ENOSPC is always confirmable. */
function runnerFixture(suites, { publish = true, stale = null } = {}) {
    const fx = fixture([{ exit: 0 }], { config: { ...CONFIG, diskFloorBytes: 1e18 },
        scripts: { gate: 'node gate-lock.js', 'gate:chain': 'npm test', test: 'node tooling/test-all.js' } });
    fs.mkdirSync(path.join(fx.dir, 'tooling'), { recursive: true });
    fs.writeFileSync(path.join(fx.dir, 'tooling', 'test-all.js'), RUNNER);
    fx.store = mkTemp('grec-cov-');
    const root = receiptsLib.canonicalRoot(fx.dir);
    fs.writeFileSync(path.join(fx.dir, 'suites.json'), JSON.stringify({ suites, publish, root }));
    if (stale) {
        // A receipt an earlier run left: its one failed suite did print ENOSPC.
        const runDir = path.join(fx.store, 'runs', 'stale');
        fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
        fs.writeFileSync(path.join(runDir, 'logs', `${stale}.log`), `${ENOSPC_LINE}\n`);
        fs.writeFileSync(path.join(fx.store, 'receipt.json'), JSON.stringify({ schema: 1, runId: 'stale', root, runDir, startedAt: hourAgo(), finishedAt: hourAgo(),
            outcomes: [{ label: stale, state: 'fail', log: `logs/${stale}.log` }], treeInert: { state: 'pass' }, verdict: 'fail' }));
    }
    return fx;
}
const runRunner = (subject, fx) => runGate(subject, fx, { AUTODEV_COVERAGE_STORE: fx.store });

/** R17: a passing suite that prints ENOSPC does not excuse another suite's failure in the same step. */
async function r17RunnerPassingNoise(subject) {
    const fx = runnerFixture([{ label: 'test-noisy', state: 'pass', print: ENOSPC_LINE }, { label: 'test-red', state: 'fail', print: 'FAIL  an assertion' }]);
    const r = await runRunner(subject, fx);
    return [['R17: a passing suite printed ENOSPC and another suite failed on its own: exit 1, a FAIL',
        r.code === 1 && /verdict FAIL/.test(r.out) && /ENOSPC/.test(r.out) && /\(test-red\) do not all carry one confirmed machine cause/.test(r.out), `exit=${r.code}\n${r.out}`]];
}

/** R18: the one failed suite printed ENOSPC in its own log, under the floor: INDETERMINATE. */
async function r18RunnerOwnLog(subject) {
    const fx = runnerFixture([{ label: 'test-ok', state: 'pass' }, { label: 'test-full', state: 'fail', print: ENOSPC_LINE }]);
    const r = await runRunner(subject, fx);
    return [['R18: the only failed suite printed ENOSPC itself: exit 2, naming it',
        r.code === 2 && /ENOSPC in every failed suite \(test-full\)/.test(r.out), `exit=${r.code}\n${r.out}`]];
}

/** R19: two failed suites, only one with ENOSPC: the other one's failure stands. */
async function r19RunnerMixed(subject) {
    const fx = runnerFixture([{ label: 'test-full', state: 'fail', print: ENOSPC_LINE }, { label: 'test-red', state: 'fail', print: 'FAIL  an assertion' }]);
    const r = await runRunner(subject, fx);
    return [['R19: one failed suite printed ENOSPC, another failed on its own: exit 1, a FAIL',
        r.code === 1 && /verdict FAIL/.test(r.out) && /\(test-full, test-red\) do not all carry/.test(r.out), `exit=${r.code}\n${r.out}`]];
}

/** R20: this attempt published no receipt, and an earlier run's receipt is not evidence. */
async function r20RunnerStale(subject) {
    const fx = runnerFixture([{ label: 'test-noisy', state: 'pass', print: ENOSPC_LINE }, { label: 'test-red', state: 'fail', print: 'FAIL  an assertion' }],
        { publish: false, stale: 'test-red' });
    const r = await runRunner(subject, fx);
    return [['R20: an earlier run\'s receipt naming ENOSPC leaves this attempt\'s exit 1 a FAIL',
        r.code === 1 && /verdict FAIL/.test(r.out) && /not published inside this attempt/.test(r.out), `exit=${r.code}\n${r.out}`]];
}

/**
 * R22, R23: the runner's output goes to a full disk (measured 2026-10-03:
 * the write threw from the 'data' handler, the runner died, and the chain ran
 * unsupervised). The runner must keep supervising, record npm's exit, and
 * name ENOSPC as the machine cause. R23 loses the sentinel too, so the record
 * can only arrive over the IPC channel.
 */
async function enospcOutput(subject, id, sentinelToo) {
    const fx = fixture([{ exit: 1, print: 'chain step output', sleep: 3000 }], { config: { ...CONFIG, diskFloorBytes: 1e18 } });
    const fault = path.join(fx.lockDir, 'fault.js');
    fs.writeFileSync(fault, FAULT);
    const r = await runGateToFile(subject, fx, {
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require "${fault.replace(/\\/g, '/')}"`].filter(Boolean).join(' '),
        ...(sentinelToo ? { GATE_FAULT_SENTINEL: '1' } : {}),
    });
    const journal = journalOf(fx);
    const a = journal && Array.isArray(journal.attempts) ? journal.attempts[0] : null;
    const rec = a && a.record;
    const shown = JSON.stringify(a);
    const rows = [
        [`${id}: a full disk under the runner's output exits 2, INDETERMINATE, naming ENOSPC and not a lost exit`,
            r.code === 2 && /ENOSPC/.test(r.out) && !/without recording/.test(r.out), `exit=${r.code}\n${r.out}`],
        [`${id}: the runner kept supervising: the chain had finished when the gate exited, after one attempt`,
            r.doneAtExit && attempts(fx) === 1, `doneAtExit=${r.doneAtExit} attempts=${attempts(fx)}`],
        [`${id}: the journal holds npm's exit 1 and a disk cause`, Boolean(rec) && rec.exit === 1 && Boolean(a.cause) && a.cause.kind === 'disk', shown],
        [`${id}: the record names the failed write and its step, and carries ENOSPC as output evidence`, Boolean(rec) &&
            Array.isArray(rec.outputFaults) && rec.outputFaults.some((f) => f.code === 'ENOSPC' && f.step === rec.lastStep) &&
            Array.isArray(rec.infra) && rec.infra.some((h) => h.kind === 'ENOSPC' && h.source === 'output'), shown],
    ];
    if (sentinelToo) rows.push([`${id}: the record came over IPC and says the sentinel could not be written`, Boolean(rec) && rec.sentinelError === 'ENOSPC', shown]);
    return rows;
}
const r22OutputFull = (subject) => enospcOutput(subject, 'R22', false);
const r23OutputAndSentinelFull = (subject) => enospcOutput(subject, 'R23', true);

/** R21: the real gate's first step is the one the per-suite rule guards. */
function r21RealRunnerStep() {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const first = String(pkg.scripts['gate:chain'] || '').split('&&')[0].trim();
    return [['R21: the real gate:chain starts with `npm test`, and its `test` step is recognised as the suite runner',
        first === 'npm test' && recovery.runsSuiteRunner(ROOT, 'test') === true, `first=${first} runner=${recovery.runsSuiteRunner(ROOT, 'test')}`]];
}

// ---------------------------------------------------------------------------
// Plants: a copy of the subject tree with one anchor replaced.
// ---------------------------------------------------------------------------

function mutant(id, rel, edits) {
    const root = mkTemp(`grec-${id}-`);
    const files = ['tooling/gate-lock.js', 'tooling/gate-recovery.js', 'tooling/coverage-receipt.js',
        'plugins/autodev-core/scripts/full-gate-queue.js', 'plugins/autodev-core/scripts/gate-identity.js', 'plugins/autodev-core/scripts/gate-records.js'];
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
    const only = process.env.GATE_RECOVERY_ONLY ? process.env.GATE_RECOVERY_ONLY.split(',') : null;
    const want = (id) => !only || only.includes(id);
    const real = { R1: r1CrashNoEvent, R2: r2CrashWithEvent, R3: r3EventOutside, R4: r4DiskPersistent,
                   R5: r5PortPersistent, R6: r6Limit, R7: r7KeepsArrival, R8: r8NoConfig, R9: r9OtherStep,
                   R10: r10TwoInARow, R11: r11EventAfter, R12: r12ConfigNull, R13: r13CounterSurvivesPrune, R14: r14NoGo,
                   R15: r15Lingering, R16: r16LeaseHeld, R17: r17RunnerPassingNoise, R18: r18RunnerOwnLog, R19: r19RunnerMixed,
                   R20: r20RunnerStale, R21: async () => r21RealRunnerStep(), R22: r22OutputFull, R23: r23OutputAndSentinelFull };
    for (const [id, fn] of Object.entries(real)) if (want(id)) for (const [n, ok, d] of await fn(SUBJECT)) check(n, ok, d);

    const plants = [
        ['P9', 'a crash exit is memory without an event', 'tooling/gate-recovery.js',
            [["const memoryConfirmed = ev.status === 'found';", 'const memoryConfirmed = true;']],
            async (s) => [...await r1CrashNoEvent(s), ...await r3EventOutside(s)], ['R1', 'R3']],
        ['P10', 're-admission skips the clearance samples', 'tooling/gate-lock.js',
            [['const clear = await recovery.awaitClearance(c.cause, cfg.config, root, rec.endUtc, { env, log });', "const clear = { cleared: true, why: 'planted' };"]],
            async (s) => [...await r4DiskPersistent(s), ...await r5PortPersistent(s)], ['R4', 'R5']],
        ['P11', 'no re-admission limit', 'tooling/gate-lock.js',
            [['if (spent >= cfg.config.maxReadmissions) {', 'if (false) {'],
             ['recovery.spendReadmission(counter, worktree, head, cfg.config.maxReadmissions)', 'recovery.spendReadmission(counter, worktree, head, Infinity)']],
            (s) => r6Limit(s), ['R6']],
        ['P12', 'a re-admission takes a new arrival', 'tooling/gate-lock.js',
            [['admit(Number.isFinite(Date.parse(arrival)) ? Date.parse(arrival) : null);', 'admit(null);'],
             ['arrival = arrival || own.meta.arrival;', 'arrival = own.meta.arrival;']], (s) => r7KeepsArrival(s), ['R7']],
        ['P13', 're-admission without a recovery config', 'tooling/gate-recovery.js',
            [["return { config: null, file, why: e.code === 'ENOENT' ? 'no recovery config, so no automatic re-admission' : `the recovery config is unreadable (${e.code})` };",
              "return { config: { diskFloorBytes: 1, memoryHeadroomBytes: 0, sampleIntervalMs: 100, clearanceTimeoutMs: 3000, maxReadmissions: 2 }, file, why: null };"]],
            (s) => r8NoConfig(s), ['R8']],
        ['P14', 'the runner starts before its identity is recorded', 'tooling/gate-lock.js',
            [['    if (waitGo) {', '    if (false) {']], (s) => r1CrashNoEvent(s), ['R1']],
        ['P15', 'evidence from any step counts', 'tooling/gate-recovery.js',
            [['const hits = rec.lastStep ? all.filter((h) => h.step === rec.lastStep) : all;', 'const hits = all;']], (s) => r9OtherStep(s), ['R9']],
        ['P16', 'one healthy sample clears', 'tooling/gate-recovery.js',
            [['if (healthy >= 2) return', 'if (healthy >= 1) return']], (s) => r10TwoInARow(s), ['R10']],
        ['P17', 'an event after the attempt counts', 'tooling/gate-recovery.js',
            [['        const end = rec.endUtc;', '        const end = new Date(Date.parse(rec.endUtc) + 10000).toISOString();']], (s) => r11EventAfter(s), ['R11']],
        ['P18', 'a config that is not an object is read as one', 'tooling/gate-recovery.js',
            [["    if (!j || typeof j !== 'object' || Array.isArray(j)) return { config: null, file, why: 'the recovery config is not a JSON object' };\n", '']],
            (s) => r12ConfigNull(s), ['R12']],
        ['P19', 'journal pruning deletes re-admission counters', 'plugins/autodev-core/scripts/gate-records.js',
            [["        if (name.startsWith('readmit-')) continue;\n", '']], (s) => r13CounterSurvivesPrune(s), ['R13']],
        ['P20', 'a runner never told to go runs anyway', 'tooling/gate-lock.js',
            [['        if (!go) {', '        if (false) {']], (s) => r14NoGo(s), ['R14']],
        ['P21', 'lingering chain processes do not keep the lane', 'tooling/gate-lock.js',
            [['        if (lingering.length) keepLane = lingering;\n', '']], (s) => r15Lingering(s), ['R15']],
        ['P22', 'a first lease overwrites another live run\'s lease', 'plugins/autodev-core/scripts/gate-records.js',
            [['            if (live !== false) {', '            if (false) {']], (s) => r16LeaseHeld(s), ['R16']],
        ['P23', 'the suite runner\'s step is judged as one step', 'tooling/gate-recovery.js',
            [["return typeof s === 'string' && /\\btest-all\\.js\\b/.test(s);", 'return false;']], (s) => r17RunnerPassingNoise(s), ['R17']],
        ['P24', 'one failed suite\'s cause excuses every failed one', 'tooling/gate-recovery.js',
            [["const enospc = rows.every((r) => r.hits.some((h) => h.kind === 'ENOSPC'));", "const enospc = rows.some((r) => r.hits.some((h) => h.kind === 'ENOSPC'));"]],
            (s) => r19RunnerMixed(s), ['R19']],
        ['P25', 'a receipt from before the attempt counts', 'tooling/gate-recovery.js',
            [[' || started < from || finished > to) {', ') {']], (s) => r20RunnerStale(s), ['R20']],
        ['P26', 'the runner writes the chain\'s output to a bare stream', 'tooling/gate-lock.js',
            [["        onData: (b, stream) => { scan.feed(b); (stream === 'stderr' ? toStderr : toStdout)(b); },", "        onData: (b, stream) => { (stream === 'stderr' ? process.stderr : process.stdout).write(b); scan.feed(b); },"]],
            (s) => r22OutputFull(s), ['R22']],
        ['P27', 'the record sent over IPC is ignored', 'tooling/gate-lock.js',
            [['const rec = readSentinel(sentinel, runId, token) || sent;', 'const rec = readSentinel(sentinel, runId, token);']],
            (s) => r23OutputAndSentinelFull(s), ['R23']],
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
        killAll();
        for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* a child may hold it */ } }
        console.log(`\n${passed} passed, ${failed} failed`);
        if (failed) { console.log(`${failed} gate-recovery check(s) failed`); process.exitCode = 1; } else console.log('all gate-recovery checks passed');
    });
