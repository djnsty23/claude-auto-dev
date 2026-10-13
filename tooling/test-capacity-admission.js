#!/usr/bin/env node
/**
 * test-capacity-admission.js - capacity admission (plugins/autodev-core/scripts/capacity.js)
 * and its wiring into the gate queue (full-gate-queue.js).
 *
 * It prints exactly one line:
 *
 *   oversubscriptions=0 unknown_probe=DEFER queue_preserved=PASS settlement_allowed=PASS crash_breaker=PASS
 *
 * and any other value sets a nonzero exit code. Each field is a measurement:
 *   oversubscriptions   N real child processes race admit() against room for K;
 *                       the field is admitted minus K, floored at 0.
 *   unknown_probe       what admit() does when a probe cannot answer (null, throw,
 *                       timeout, NaN, a missing fixture, a probe function that
 *                       throws): DEFER, or ADMIT when any of them admitted. It also
 *                       reads FAIL when AUTODEV_CAPACITY=off does not admit, since
 *                       off is the one switch that admits without a probe.
 *   queue_preserved     a gate the probe defers keeps its ticket and its position,
 *                       nobody behind it takes the free lane, and it takes the lane
 *                       once three healthy samples 30 s apart have been read (the
 *                       resume rule, on an injected clock).
 *   settlement_allowed  release() frees a reservation while the probe throws and
 *                       the disk reads full, and the queue's release settles the
 *                       holder's reservation while it defers the next ticket.
 *   crash_breaker       a child killed while it holds a reservation trips its
 *                       class's breaker: the next admit is refused even with
 *                       room, other classes still admit, and only an operator
 *                       clear lets the class in again. A child that settles
 *                       before it exits trips nothing.
 *
 * Diagnostics go to stderr, and only for a field that did not pass. Every
 * ledger and lock lives in a temp directory: AUTODEV_GATE_LOCK_PATH points the
 * children at it, so the machine's real ledger is never read or written.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const CAP_PATH = path.join(SCRIPTS, 'capacity.js');

// Inherited switches would change what is measured: this suite sets its own.
for (const k of ['AUTODEV_CAPACITY', 'AUTODEV_CAPACITY_CONFIG', 'AUTODEV_CAPACITY_PROBE_FILE', 'AUTODEV_CAPACITY_SAMPLE_MS',
    'AUTODEV_CAPACITY_TEST_PAUSE_MS', 'AUTODEV_GATE_CLASS', 'AUTODEV_GATE_LANES']) delete process.env[k];

const cap = require(CAP_PATH);
const queue = require(path.join(SCRIPTS, 'full-gate-queue.js'));

const GIB = 1024 * 1024 * 1024;
const temps = [];
const children = [];
const problems = { oversubscriptions: [], unknown_probe: [], queue_preserved: [], settlement_allowed: [], crash_breaker: [] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkTemp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };
let checked = 0;
const note = (field, cond, why) => { checked++; if (!cond) problems[field].push(why); return Boolean(cond); };

function fixture() {
    const dir = mkTemp('cap-');
    const base = path.join(dir, 'full-gate.lock');
    const probeFile = path.join(dir, 'probe.json');
    const env = Object.assign({}, process.env, {
        AUTODEV_GATE_LOCK_PATH: base,
        AUTODEV_CAPACITY_PROBE_FILE: probeFile,
        AUTODEV_GATE_BOOT_CACHE: path.join(dir, 'boot.json'),
    });
    return { dir, base, probeFile, env };
}

/** Room for `k` requests of one GiB disk and one GiB commit, plus half a GiB. */
function roomFor(fx, k, each = GIB) {
    // A 100 GiB volume: its disk reserve is the 15 GiB floor. The commit reserve is 8 GiB.
    writeProbe(fx, { diskFreeBytes: 15 * GIB + k * each + GIB / 2, diskTotalBytes: 100 * GIB, commitFreeBytes: 8 * GIB + k * each + GIB / 2 });
}
function writeProbe(fx, p) { fs.writeFileSync(fx.probeFile, JSON.stringify(p)); }
function ledger(fx) {
    try { return JSON.parse(fs.readFileSync(cap.ledgerPath(fx.base), 'utf8')); } catch { return null; }
}

function sleeper() {
    const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true });
    children.push(c);
    return c.pid;
}

// ---------------------------------------------------------------------------
// A child that admits on a go file, holds until a done file, then settles.
// ---------------------------------------------------------------------------

const CHILD = `
'use strict';
const fs = require('fs');
const [capPath, goFile, doneFile, outFile, cls, settle] = process.argv.slice(2);
const cap = require(capPath);
const GIB = 1024 * 1024 * 1024;
const until = (f) => new Promise((r) => { const t = setInterval(() => { if (fs.existsSync(f)) { clearInterval(t); r(); } }, 10); });
(async () => {
    await until(goFile);
    const r = cap.admit({ cls, path: process.cwd(), diskBytes: GIB, commitBytes: GIB });
    fs.writeFileSync(outFile + '.tmp', JSON.stringify({ admitted: r.admitted, id: r.id || null, why: r.why || null }));
    fs.renameSync(outFile + '.tmp', outFile);
    await until(doneFile);
    if (r.admitted && settle === 'settle') cap.release(r.id);
})().catch((e) => { fs.writeFileSync(outFile, JSON.stringify({ admitted: false, error: String(e && e.stack || e) })); });
`;

function startChild(fx, name, { cls = 'worker', settle = 'settle', extraEnv = {} } = {}) {
    const script = path.join(fx.dir, 'child.js');
    if (!fs.existsSync(script)) fs.writeFileSync(script, CHILD);
    const go = path.join(fx.dir, 'go');
    const done = path.join(fx.dir, `done-${name}`);
    const out = path.join(fx.dir, `out-${name}.json`);
    const c = spawn(process.execPath, [script, CAP_PATH, go, done, out, cls, settle],
        { cwd: fx.dir, env: Object.assign({}, fx.env, extraEnv), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    children.push(c);
    const exited = new Promise((r) => c.on('exit', (code, sig) => r({ code, sig })));
    return { c, go, done, out, exited, err: () => err };
}

async function waitFor(pred, ms, step = 25) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await sleep(step); }
    return pred();
}
const readOut = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// ---------------------------------------------------------------------------
// oversubscriptions: N children race admit with room for K.
// ---------------------------------------------------------------------------

async function caseRace() {
    const N = 8, K = 3;
    const fx = fixture();
    roomFor(fx, K);
    // The pause sits between the ledger read and its write, inside the mutex:
    // without the mutex every child reads the empty ledger and all of them admit.
    const kids = [];
    for (let i = 0; i < N; i++) kids.push(startChild(fx, `r${i}`, { extraEnv: { AUTODEV_CAPACITY_TEST_PAUSE_MS: '150' } }));
    await sleep(800); // every child is up and polling for the go file
    fs.writeFileSync(kids[0].go, 'go');
    const all = await waitFor(() => kids.every((k) => fs.existsSync(k.out)), 60000);
    const outs = kids.map((k) => readOut(k.out));
    const admitted = outs.filter((o) => o && o.admitted).length;
    const held = (ledger(fx) || { reservations: [] }).reservations.length;
    for (const k of kids) fs.writeFileSync(k.done, 'done');
    await Promise.all(kids.map((k) => k.exited));
    const after = (ledger(fx) || { reservations: [] }).reservations.length;
    note('oversubscriptions', all, `only ${outs.filter(Boolean).length}/${N} children answered: ${kids.map((k) => k.err()).join(' | ').slice(0, 600)}`);
    note('oversubscriptions', admitted === K, `${admitted} of ${N} admitted with room for ${K}: ${JSON.stringify(outs.map((o) => o && (o.admitted ? 'admitted' : o.why || o.error)))}`);
    note('oversubscriptions', held === admitted, `the ledger held ${held} reservations for ${admitted} admissions`);
    note('oversubscriptions', after === 0, `${after} reservations left after every child settled`);
    return Math.max(0, admitted - K);
}

// ---------------------------------------------------------------------------
// unknown_probe: every way a probe can fail to answer defers; off admits.
// ---------------------------------------------------------------------------

function caseUnknown() {
    let anyAdmitted = false;
    const fx = fixture();
    const good = { diskFreeBytes: 500 * GIB, diskTotalBytes: 1000 * GIB, commitFreeBytes: 500 * GIB };
    const variants = [
        ['disk null', { ...good, diskFreeBytes: null }],
        ['disk throws', { ...good, diskFreeBytes: 'throw' }],
        ['commit times out', { ...good, commitFreeBytes: 'timeout' }],
        ['commit NaN', { ...good, commitFreeBytes: 'nan' }],
        ['commit missing', { diskFreeBytes: good.diskFreeBytes, diskTotalBytes: good.diskTotalBytes }],
        ['disk total missing', { diskFreeBytes: good.diskFreeBytes, commitFreeBytes: good.commitFreeBytes }],
    ];
    for (const [label, p] of variants) {
        writeProbe(fx, p);
        const r = cap.admit({ cls: 'worker', path: fx.dir }, { base: fx.base, env: fx.env });
        if (r.admitted) { anyAdmitted = true; cap.release(r.id, { base: fx.base, env: fx.env }); }
        note('unknown_probe', !r.admitted && r.unknown === true, `${label}: ${JSON.stringify({ admitted: r.admitted, unknown: r.unknown, why: r.why })}`);
    }
    const missing = cap.admit({ cls: 'worker', path: fx.dir }, { base: fx.base, env: { ...fx.env, AUTODEV_CAPACITY_PROBE_FILE: path.join(fx.dir, 'absent.json') } });
    if (missing.admitted) anyAdmitted = true;
    note('unknown_probe', !missing.admitted, `a missing probe fixture admitted: ${missing.why}`);
    const thrower = cap.admit({ cls: 'worker', path: fx.dir }, { base: fx.base, env: fx.env, probe: () => { throw new Error('probe exploded'); } });
    if (thrower.admitted) anyAdmitted = true;
    note('unknown_probe', !thrower.admitted, 'a probe function that throws admitted');
    // A malformed config defers too: a policy nobody can read is not a policy.
    const cfgFile = path.join(fx.dir, 'bad-config.json');
    fs.writeFileSync(cfgFile, '{ not json');
    writeProbe(fx, good);
    const badCfg = cap.admit({ cls: 'worker', path: fx.dir }, { base: fx.base, env: { ...fx.env, AUTODEV_CAPACITY_CONFIG: cfgFile } });
    if (badCfg.admitted) anyAdmitted = true;
    note('unknown_probe', !badCfg.admitted, 'a malformed capacity config admitted');

    // The real probes, read only: each answers { ok } or { ok: false, why } and never throws.
    const realDisk = cap.probeDisk(path.join(fx.dir, 'not', 'made', 'yet'));
    note('unknown_probe', realDisk.ok === true && realDisk.freeBytes >= 0 && realDisk.totalBytes > 0,
        `the real disk probe did not read the nearest existing directory: ${JSON.stringify(realDisk)}`);
    const realCommit = cap.probeCommit();
    note('unknown_probe', realCommit.ok === true ? realCommit.freeBytes >= 0 : typeof realCommit.why === 'string',
        `the real commit probe gave no answer: ${JSON.stringify(realCommit)}`);
    const otherCommit = cap.probeCommit({ platform: 'sunos' });
    note('unknown_probe', otherCommit.ok === true && otherCommit.source === 'os.freemem', `an unlisted platform did not read os.freemem: ${JSON.stringify(otherCommit)}`);
    note('unknown_probe', cap.pollMs({ AUTODEV_CAPACITY_POLL_MS: '1' }) === 10 && cap.pollMs({}) >= 10, 'the poll interval is not floored at 10 ms');

    // AUTODEV_CAPACITY=off admits always, without a reservation, probe or no probe.
    const fxOff = fixture();
    writeProbe(fxOff, { diskFreeBytes: 'throw', diskTotalBytes: 1, commitFreeBytes: 'throw' });
    const off = cap.admit({ cls: 'gate', path: fxOff.dir }, { base: fxOff.base, env: { ...fxOff.env, AUTODEV_CAPACITY: 'off' } });
    const offOk = note('unknown_probe', off.admitted === true && off.id === null && ledger(fxOff) === null,
        `AUTODEV_CAPACITY=off did not admit without a reservation: ${JSON.stringify(off)}`);
    const offRel = cap.release(off.id, { base: fxOff.base, env: { ...fxOff.env, AUTODEV_CAPACITY: 'off' } });
    note('unknown_probe', offRel.released === false && ledger(fxOff) === null, `releasing an off admission wrote a ledger: ${JSON.stringify(offRel)}`);
    const offBreaker = cap.breakerFor('gate', { base: fxOff.base, env: { ...fxOff.env, AUTODEV_CAPACITY: 'off' } });
    note('unknown_probe', offBreaker === null, 'breakerFor answered a breaker with capacity off');
    if (anyAdmitted) return 'ADMIT';
    return problems.unknown_probe.length || !offOk ? 'FAIL' : 'DEFER';
}

// ---------------------------------------------------------------------------
// settlement_allowed: release with the probe failing and the disk full.
// ---------------------------------------------------------------------------

function caseSettlement() {
    const fx = fixture();
    roomFor(fx, 2);
    const a = cap.admit({ cls: 'worker', path: fx.dir, diskBytes: GIB, commitBytes: GIB }, { base: fx.base, env: fx.env });
    note('settlement_allowed', a.admitted, `the setup admission was refused: ${a.why}`);
    // The disk is full and the commit probe throws: a release must still land.
    writeProbe(fx, { diskFreeBytes: 0, diskTotalBytes: 100 * GIB, commitFreeBytes: 'throw' });
    const r = cap.release(a.id, { base: fx.base, env: fx.env, probe: () => { throw new Error('probe down'); } });
    const left = (ledger(fx) || { reservations: [{}] }).reservations.length;
    note('settlement_allowed', r.released === true && left === 0, `release under a full disk and a failing probe: ${JSON.stringify(r)}, ${left} left`);
    // Twice is harmless: an id already gone counts as released.
    const again = cap.release(a.id, { base: fx.base, env: fx.env });
    note('settlement_allowed', again.released === true, `a second release was refused: ${JSON.stringify(again)}`);
    // And the full disk still refuses a new admission, so the release was not an admit in disguise.
    const blocked = cap.admit({ cls: 'worker', path: fx.dir }, { base: fx.base, env: fx.env });
    note('settlement_allowed', !blocked.admitted, 'a full disk admitted after the release');
}

// ---------------------------------------------------------------------------
// queue_preserved: a deferred gate keeps its ticket and its place.
// ---------------------------------------------------------------------------

function snapshotEnv(vars) {
    const was = {};
    for (const k of Object.keys(vars)) { was[k] = process.env[k]; process.env[k] = vars[k]; }
    return () => { for (const k of Object.keys(was)) { if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]; } };
}

async function caseQueue() {
    const fx = fixture();
    const lockPath = fx.base;
    const lockPaths = [lockPath];
    // The queue calls capacity with process.env, so the seams go there for this case.
    const restore = snapshotEnv({ AUTODEV_CAPACITY_PROBE_FILE: fx.probeFile, AUTODEV_CAPACITY_SAMPLE_MS: '40', AUTODEV_GATE_BOOT_CACHE: path.join(fx.dir, 'boot.json') });
    try {
        const A = sleeper(), B = sleeper(), C = sleeper();
        await sleep(300);
        const capacity = { cls: 'gate', path: fx.dir };
        const log = (m) => { problems._log = (problems._log || []).concat(m); };
        const turn = (pid, arrivedMs) => { queue.resetProbes(); return queue.takeTurn({ lockPath, lockPaths, pid, what: `test ${pid}`, staleMs: 600000, log, arrivedMs, capacity }); };
        roomFor(fx, 2, cap.DEFAULT_REQUESTS.gate.diskBytes);
        const h = turn(A, 1000);
        note('queue_preserved', h.acquired, `the holder did not acquire: ${JSON.stringify(h)}`);
        const held = queue.readLock(lockPath);
        const capId = held && held.meta && held.meta.capacityId;
        note('queue_preserved', Boolean(capId), 'the lock meta carries no capacityId');
        const w1 = turn(B, 2000), w2 = turn(C, 3000);
        note('queue_preserved', !w1.acquired && w1.position === 1 && !w2.acquired && w2.position === 2,
            `waiters not queued 1 and 2: ${JSON.stringify([w1.position, w2.position])}`);

        // The machine runs short. The holder releases: its reservation settles,
        // the front ticket is deferred, and the lane is freed, not handed on.
        writeProbe(fx, { diskFreeBytes: GIB, diskTotalBytes: 100 * GIB, commitFreeBytes: 'throw' });
        queue.resetProbes();
        const rel = queue.releaseLock({ lockPath, lockPaths, pid: A, staleMs: 600000, log });
        note('queue_preserved', rel.released && rel.to === null && rel.capacity && rel.waiting && rel.waiting.pid === B,
            `release did not defer the front ticket: ${JSON.stringify({ released: rel.released, to: rel.to && rel.to.pid, capacity: Boolean(rel.capacity), waiting: rel.waiting && rel.waiting.pid })}`);
        const afterRel = (ledger(fx) || { reservations: [{}] }).reservations.length;
        note('settlement_allowed', rel.released && afterRel === 0, `the queue's release left ${afterRel} reservations while the probe failed`);

        // Nobody behind the deferred ticket takes the free lane, and nobody moves.
        for (let i = 0; i < 3; i++) {
            const c2 = turn(C, 3000);
            note('queue_preserved', !c2.acquired && c2.position === 2, `the second waiter moved or took the lane: ${JSON.stringify({ acquired: c2.acquired, position: c2.position })}`);
            const b2 = turn(B, 2000);
            note('queue_preserved', !b2.acquired && b2.position === 1 && b2.capacity, `the deferred ticket lost its place: ${JSON.stringify({ acquired: b2.acquired, position: b2.position })}`);
            await sleep(60);
        }
        const tickets = fs.readdirSync(queue.queueDirFor(lockPath)).filter((f) => !f.startsWith('.'));
        note('queue_preserved', tickets.length === 2, `tickets while deferred: ${JSON.stringify(tickets)}`);

        // Healthy again: the front resumes only after three samples, and C never jumps it.
        roomFor(fx, 2, cap.DEFAULT_REQUESTS.gate.diskBytes);
        let got = null, polls = 0;
        for (; polls < 12 && !got; polls++) {
            const c3 = turn(C, 3000);
            note('queue_preserved', !c3.acquired, 'the second waiter took the lane during the resume');
            const b3 = turn(B, 2000);
            if (b3.acquired) got = polls + 1;
            await sleep(60);
        }
        note('queue_preserved', got === 3, `the deferred ticket acquired on healthy poll ${got}, not the third`);
        const c4 = turn(C, 3000);
        note('queue_preserved', !c4.acquired && c4.position === 1, `after the handoff the second waiter is not first: ${JSON.stringify({ acquired: c4.acquired, position: c4.position })}`);
        queue.resetProbes();
        queue.releaseLock({ lockPath, lockPaths, pid: B, staleMs: 600000, log });
        queue.leaveQueues(lockPaths, C);
        const ownLock = queue.readLock(lockPath);
        if (ownLock && ownLock.pid === C) { queue.resetProbes(); queue.releaseLock({ lockPath, lockPaths, pid: C, staleMs: 600000, log }); }
    } finally { restore(); }
}

// The resume rule on an injected clock: three healthy samples at least 30 s
// apart, and an unhealthy one in between starts the count again.
function caseResume() {
    const fx = fixture();
    const env = { ...fx.env };
    delete env.AUTODEV_CAPACITY_PROBE_FILE;
    let t = Date.parse('2026-10-13T10:00:00Z');
    let healthy = false;
    const probe = () => ({
        disk: { ok: true, freeBytes: healthy ? 500 * GIB : GIB, totalBytes: 1000 * GIB, dev: 1 },
        commit: { ok: true, freeBytes: 500 * GIB },
    });
    const ask = (dt) => { t += dt; return cap.admit({ cls: 'gate', path: fx.dir }, { base: fx.base, env, now: () => t, probe }); };
    const steps = [];
    const s = (dt, h, want) => { healthy = h; const r = ask(dt); steps.push(`${h ? 'ok' : 'short'}+${dt / 1000}s=${r.admitted ? 'A' : r.resuming ? 'R' : 'D'}`); return note('queue_preserved', (r.admitted ? 'A' : r.resuming ? 'R' : 'D') === want, `resume step ${steps.length}: ${steps.join(' ')}`) && r; };
    s(0, false, 'D');
    s(1000, true, 'R');
    s(10000, true, 'R'); // too soon: not a new sample
    s(20000, true, 'R'); // 30 s after the first: sample two
    s(15000, false, 'D'); // short again: the count restarts
    s(1000, true, 'R');
    s(30000, true, 'R');
    const last = s(30000, true, 'A');
    if (last && last.id) cap.release(last.id, { base: fx.base, env });
    note('queue_preserved', ledger(fx) && ledger(fx).classes.gate && !ledger(fx).classes.gate.deferredUtc, 'the deferral was not cleared after resuming');
}

// ---------------------------------------------------------------------------
// crash_breaker: a holder that dies unsettled stops re-admission for its class.
// ---------------------------------------------------------------------------

async function caseBreaker() {
    const fx = fixture();
    roomFor(fx, 6);
    const crash = startChild(fx, 'crash', { cls: 'worker', settle: 'never' });
    const tidy = startChild(fx, 'tidy', { cls: 'judge', settle: 'settle' });
    await sleep(800);
    fs.writeFileSync(crash.go, 'go');
    await waitFor(() => fs.existsSync(crash.out) && fs.existsSync(tidy.out), 30000);
    const co = readOut(crash.out), to = readOut(tidy.out);
    note('crash_breaker', co && co.admitted && to && to.admitted, `setup admissions: ${JSON.stringify([co, to])}`);
    // The tidy child settles and exits; the crash child is killed holding its reservation.
    fs.writeFileSync(tidy.done, 'done');
    await tidy.exited;
    crash.c.kill('SIGKILL');
    await crash.exited;
    await sleep(200);
    queue.resetProbes();
    const opts = { base: fx.base, env: fx.env };
    const again = cap.admit({ cls: 'worker', path: fx.dir }, opts);
    note('crash_breaker', !again.admitted && again.breaker && again.breaker.pid === crash.c.pid,
        `the worker class was re-admitted after a crash: ${JSON.stringify({ admitted: again.admitted, breaker: again.breaker || null, why: again.why })}`);
    if (again.admitted) cap.release(again.id, opts);
    queue.resetProbes();
    const replay = cap.admit({ cls: 'worker', path: fx.dir }, opts);
    note('crash_breaker', !replay.admitted && replay.breaker, 'a second admit replayed past the breaker');
    if (replay.admitted) cap.release(replay.id, opts);
    const l = ledger(fx) || { reservations: [{}], classes: {} };
    note('crash_breaker', l.reservations.length === 0, `the dead holder's reservation was not reclaimed: ${l.reservations.length} left`);
    note('crash_breaker', !(l.classes.judge && l.classes.judge.breaker), 'a child that settled before exiting tripped the breaker');
    const other = cap.admit({ cls: 'judge', path: fx.dir }, opts);
    note('crash_breaker', other.admitted, `another class was refused by the worker breaker: ${other.why}`);
    if (other.admitted) cap.release(other.id, opts);
    const b = cap.breakerFor('worker', opts);
    note('crash_breaker', b && /clear-breaker/.test(b.why), 'breakerFor does not name the operator step');
    const cleared = cap.clearBreaker('worker', opts);
    const after = cap.admit({ cls: 'worker', path: fx.dir }, opts);
    note('crash_breaker', cleared.cleared && after.admitted, `after an operator clear: ${JSON.stringify({ cleared: cleared.cleared, admitted: after.admitted, why: after.why })}`);
    if (after.admitted) cap.release(after.id, opts);
}

// ---------------------------------------------------------------------------

async function main() {
    const over = await caseRace();
    const unknown = caseUnknown();
    caseSettlement();
    await caseQueue();
    caseResume();
    await caseBreaker();
    const pf = (k) => (problems[k].length ? 'FAIL' : 'PASS');
    const line = `oversubscriptions=${problems.oversubscriptions.length && over === 0 ? 'FAIL' : over} unknown_probe=${unknown} `
        + `queue_preserved=${pf('queue_preserved')} settlement_allowed=${pf('settlement_allowed')} crash_breaker=${pf('crash_breaker')}`;
    return line;
}

const WANT = 'oversubscriptions=0 unknown_probe=DEFER queue_preserved=PASS settlement_allowed=PASS crash_breaker=PASS';

main().then((line) => {
    process.stdout.write(`${checked} checks\n${line}\n`);
    if (line !== WANT) {
        for (const [k, v] of Object.entries(problems)) {
            if (k === '_log' || !v.length) continue;
            for (const why of v) process.stderr.write(`${k}: ${why}\n`);
        }
        process.exitCode = 1;
    }
}, (e) => {
    process.stdout.write(`oversubscriptions=FAIL unknown_probe=FAIL queue_preserved=FAIL settlement_allowed=FAIL crash_breaker=FAIL\n`);
    process.stderr.write(`the suite crashed: ${e && e.stack || e}\n`);
    process.exitCode = 1;
}).finally(() => {
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});
