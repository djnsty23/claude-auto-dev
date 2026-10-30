#!/usr/bin/env node
/**
 * capacity.js - atomic machine capacity admission for full gates, headless
 * workers, judges and archives (lifecycle.js asks before it writes one). A
 * library; it prints nothing on import and nothing on a no-op. The CLI only
 * reads the ledger or clears a crash breaker.
 *
 * WHY. Gates (full-gate-queue.js), headless workers (headless-worker.js) and
 * judges (brain-judge.js) each used to launch without reserving anything.
 * Several launches could each see enough free disk and memory and together
 * exhaust it. A full disk made workers exit 0 without writing results, and a
 * gate on an exhausted machine reads as a code failure.
 *
 * THE RULE. `admit()` runs under the machine's gate ADMISSION MUTEX (the one in
 * gate-records.js beside lane 1's lock), so the check and the reservation are
 * one step across processes. Under it, it probes, subtracts every outstanding
 * reservation, and admits only when
 *   free disk - outstanding disk on that volume - this request >= disk reserve
 *   free commit - outstanding commit - this request          >= commit reserve
 * A probe that throws, times out or returns a non-finite number is UNKNOWN, and
 * an unknown probe DEFERS. It never admits. `release()` and settlement are never
 * refused for capacity: they read no probe. The mutex is held for the probe,
 * under a second on Windows [measured 2026-10-13: 0.67 and 0.92 s], and only
 * when a launch is about to happen.
 *
 * THE LEDGER is `<lane 1 lock stem>.capacity.json` (default
 * `<home>/.claude/autodev/locks/full-gate.capacity.json`): every reservation
 * (id, pid, class, diskBytes, commitBytes, createdUtc) and per-class state.
 * Every read reclaims the reservations whose pid is dead. A reservation that
 * disappears that way is an admitted process that died WITHOUT a recorded
 * settlement, which trips that class's CRASH BREAKER: automatic admission and
 * re-admission for the class stop until an operator clears it
 * (`node capacity.js clear-breaker --class <cls>`), and every deferral names it.
 * An exit code alone never trips it and never diagnoses memory exhaustion.
 *
 * RESUME. After a deferral, a class is admitted again only after three
 * consecutive healthy samples at least 30 s apart. Every admit() call while the
 * class is recovering is a sample; an unhealthy one starts the count again.
 *
 * POLICY. Disk reserve = min(64 GiB, max(15 GiB, 10% of the volume)): the plugin
 * ships to laptops, and a flat 64 GiB would block every gate on a small disk.
 * Commit reserve = max(8 GiB, 1.5 x the measured p95 for the class) when the
 * config holds one, else 8 GiB. Overrides come from an optional JSON config
 * (`<stem>.capacity-config.json`, or the file AUTODEV_CAPACITY_CONFIG names):
 *   { "diskReserveBytes": N, "commitReserveBytes": N,
 *     "requests": { "gate": { "diskBytes": N, "commitBytes": N }, ... },
 *     "measured": { "gate": { "commitP95Bytes": N }, ... },
 *     "resumeSamples": N, "sampleSpacingMs": N }
 * A config that does not parse defers every admission: a threshold nobody can
 * read is not a threshold.
 *
 * ENVIRONMENT.
 *   AUTODEV_CAPACITY=off           admit always, without a reservation; the reason is in the result
 *   AUTODEV_CAPACITY_CONFIG=FILE   the config file
 *   AUTODEV_CAPACITY_WAIT_MS=N     how long a caller waits on a deferral before giving up (default 1800000)
 *   AUTODEV_CAPACITY_POLL_MS=N     how often a waiting caller asks again (default 30000)
 *   AUTODEV_GATE_LOCK_PATH=FILE    lane 1's lock, which places the ledger and the mutex
 * TEST SEAMS (suites only).
 *   AUTODEV_CAPACITY_PROBE_FILE=FILE  a JSON { diskFreeBytes, diskTotalBytes, commitFreeBytes } read in
 *                                     place of the probes; a value of null, "throw", "timeout" or "nan" is unknown
 *   AUTODEV_CAPACITY_SAMPLE_MS=N      the spacing between healthy samples, over the config
 *   AUTODEV_CAPACITY_TEST_PAUSE_MS=N  a pause inside the mutex, between the ledger read and its write
 * admit() and release() also take { now, probe, isAlive, isAliveFresh, snapshot } options for in-process suites.
 *
 *   node capacity.js status [--json]                 the ledger, read-only apart from reclaiming dead pids
 *   node capacity.js observe                         append one sample of admitted load against the reserves
 *   node capacity.js clear-breaker --class <cls>     an operator clears a tripped crash breaker
 *   node capacity.js --help
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const records = require(path.join(__dirname, 'gate-records.js'));

const GIB = 1024 * 1024 * 1024;
const CLASSES = ['gate', 'worker', 'judge', 'frontier', 'archive', 'verify'];

// Default request sizes per class, in bytes. They start conservative and are
// calibrated from observed peaks: once a class's peaks are measured, set
// `requests` (and `measured`) in the config rather than editing these.
const DEFAULT_REQUESTS = Object.freeze({
    gate: Object.freeze({ diskBytes: 6 * GIB, commitBytes: 6 * GIB }),
    worker: Object.freeze({ diskBytes: 2 * GIB, commitBytes: 2 * GIB }),
    judge: Object.freeze({ diskBytes: GIB / 2, commitBytes: 1 * GIB }),
    frontier: Object.freeze({ diskBytes: 2 * GIB, commitBytes: 4 * GIB }),
    // An archive asks for its own measured size (lifecycle.js passes diskBytes); this is the fallback.
    archive: Object.freeze({ diskBytes: 1 * GIB, commitBytes: GIB / 2 }),
    // A verify runs a task's acceptance checks outside the worker (worker-reconcile.js): a gate-sized share.
    verify: Object.freeze({ diskBytes: 4 * GIB, commitBytes: 4 * GIB }),
});
const DISK_RESERVE_MIN = 15 * GIB;
const DISK_RESERVE_MAX = 64 * GIB;
const DISK_RESERVE_SHARE = 0.10;
const COMMIT_RESERVE_MIN = 8 * GIB;
const COMMIT_P95_FACTOR = 1.5;
const RESUME_SAMPLES = 3;
const SAMPLE_SPACING_MS = 30000;
const PROBE_TIMEOUT_MS = 10000;
const MUTEX_TIMEOUT_MS = 30000;
const DEFAULT_WAIT_MS = 30 * 60000;
const DEFAULT_POLL_MS = 30000;

// ---------------------------------------------------------------------------
// Paths and settings.
// ---------------------------------------------------------------------------

function defaultBase(env = process.env) {
    return path.resolve(env.AUTODEV_GATE_LOCK_PATH || path.join(os.homedir(), '.claude', 'autodev', 'locks', 'full-gate.lock'));
}
function stem(base) { return /\.lock$/.test(base) ? base.replace(/\.lock$/, '') : base; }
function ledgerPath(base) { return `${stem(base)}.capacity.json`; }
function configPath(base, env = process.env) { return env.AUTODEV_CAPACITY_CONFIG ? path.resolve(env.AUTODEV_CAPACITY_CONFIG) : `${stem(base)}.capacity-config.json`; }

function isOff(env = process.env) {
    return String(env.AUTODEV_CAPACITY || '').trim().toLowerCase() === 'off';
}

function envMs(env, name, dflt) {
    const v = env[name];
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : dflt;
}
function waitMs(env = process.env) { return envMs(env, 'AUTODEV_CAPACITY_WAIT_MS', DEFAULT_WAIT_MS); }
function pollMs(env = process.env) { return Math.max(10, envMs(env, 'AUTODEV_CAPACITY_POLL_MS', DEFAULT_POLL_MS)); }

const gib = (b) => (Number.isFinite(b) ? `${(b / GIB).toFixed(1)} GiB` : String(b));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

// ---------------------------------------------------------------------------
// Probes. Each returns { ok: true, ... } or { ok: false, why }, never throws.
// ---------------------------------------------------------------------------

/** The nearest existing directory at or above `p`. */
function existingDir(p) {
    let d = path.resolve(p || os.homedir());
    for (let i = 0; i < 64; i++) {
        try { if (fs.statSync(d).isDirectory()) return d; } catch { /* go up */ }
        const up = path.dirname(d);
        if (up === d) break;
        d = up;
    }
    return d;
}

/** Free and total bytes on the volume holding `p`, and the volume's device id. */
function probeDisk(p) {
    try {
        const dir = existingDir(p);
        const s = fs.statfsSync(dir);
        const free = Number(s.bavail) * Number(s.bsize);
        const total = Number(s.blocks) * Number(s.bsize);
        if (num(free) === null || !(Number.isFinite(total) && total > 0)) return { ok: false, why: `statfs returned free ${free}, total ${total}` };
        let dev = null;
        try { dev = String(fs.statSync(dir).dev); } catch { /* no device id: counted against every reservation */ }
        return { ok: true, freeBytes: free, totalBytes: total, dev };
    } catch (e) { return { ok: false, why: `statfs failed (${e.code || e.message})` }; }
}

/**
 * Free commit headroom in bytes. Windows: FreeVirtualMemory (KiB) of
 * Win32_OperatingSystem, one short powershell call. Linux with strict
 * overcommit (vm.overcommit_memory=2): CommitLimit - Committed_AS. Linux in its
 * default modes does not enforce CommitLimit, and Committed_AS routinely
 * exceeds it on a healthy box, so there it reads MemAvailable + SwapFree.
 * Elsewhere, os.freemem().
 */
function probeCommit({ platform = process.platform, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    try {
        if (platform === 'win32') {
            const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
                '(Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).FreeVirtualMemory'],
            { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
            if (r.error) return { ok: false, why: r.error.code === 'ETIMEDOUT' ? `powershell timed out after ${timeoutMs} ms` : `powershell could not run (${r.error.code || r.error.message})` };
            if (r.status !== 0) return { ok: false, why: `powershell exited ${r.status}` };
            const s = String(r.stdout || '').trim();
            if (!/^\d+$/.test(s)) return { ok: false, why: 'FreeVirtualMemory is not a number' };
            const bytes = Number(s) * 1024;
            return num(bytes) !== null ? { ok: true, freeBytes: bytes, source: 'FreeVirtualMemory' } : { ok: false, why: 'FreeVirtualMemory is not finite' };
        }
        if (platform === 'linux') {
            const text = fs.readFileSync('/proc/meminfo', 'utf8');
            const kb = (k) => { const m = new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(text); return m ? Number(m[1]) * 1024 : NaN; };
            let strict = false;
            try { strict = fs.readFileSync('/proc/sys/vm/overcommit_memory', 'utf8').trim() === '2'; } catch { /* the default heuristic mode */ }
            const bytes = strict ? kb('CommitLimit') - kb('Committed_AS') : kb('MemAvailable') + kb('SwapFree');
            return Number.isFinite(bytes) ? { ok: true, freeBytes: bytes, source: strict ? 'CommitLimit - Committed_AS' : 'MemAvailable + SwapFree' } : { ok: false, why: '/proc/meminfo lacks the counters' };
        }
        const bytes = os.freemem();
        return num(bytes) !== null ? { ok: true, freeBytes: bytes, source: 'os.freemem' } : { ok: false, why: 'os.freemem is not finite' };
    } catch (e) { return { ok: false, why: `the commit probe threw (${e.code || e.message})` }; }
}

/** The test seam's probe: one file, every value checked as a real probe's would be. */
function fakeProbe(file) {
    let j;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
        const why = `the probe fixture is unreadable (${e.code || e.message})`;
        return { disk: { ok: false, why }, commit: { ok: false, why } };
    }
    const one = (v, label) => {
        if (v === 'throw') return { ok: false, why: `the ${label} probe threw (fixture)` };
        if (v === 'timeout') return { ok: false, why: `the ${label} probe timed out (fixture)` };
        const n = v === 'nan' ? NaN : v;
        return num(n) !== null ? { ok: true, freeBytes: n } : { ok: false, why: `the ${label} probe returned ${JSON.stringify(v)} (fixture)` };
    };
    const disk = one(j.diskFreeBytes, 'disk');
    if (disk.ok) {
        const total = j.diskTotalBytes;
        if (!(typeof total === 'number' && Number.isFinite(total) && total > 0)) return { disk: { ok: false, why: `the disk total is ${JSON.stringify(total)} (fixture)` }, commit: one(j.commitFreeBytes, 'commit') };
        Object.assign(disk, { totalBytes: total, dev: j.dev === undefined ? 'fixture' : j.dev });
    }
    return { disk, commit: one(j.commitFreeBytes, 'commit') };
}

/** One sample of both probes for the volume holding `p`. */
function sample(p, env = process.env) {
    if (env.AUTODEV_CAPACITY_PROBE_FILE) return fakeProbe(env.AUTODEV_CAPACITY_PROBE_FILE);
    return { disk: probeDisk(p), commit: probeCommit() };
}

// ---------------------------------------------------------------------------
// Config and policy.
// ---------------------------------------------------------------------------

/** { config, why }: {} when absent, null when it cannot be read (which defers). */
function readConfig(base, env = process.env) {
    const file = configPath(base, env);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') return { config: {}, why: null };
        return { config: null, why: `the capacity config ${file} is unreadable (${e.code || e.message})` };
    }
    try {
        const c = JSON.parse(text);
        if (!c || typeof c !== 'object' || Array.isArray(c)) return { config: null, why: `the capacity config ${file} is not an object` };
        return { config: c, why: null };
    } catch (e) { return { config: null, why: `the capacity config ${file} is not JSON (${e.message})` }; }
}

function requestSize(cls, req, config) {
    const c = (config.requests && config.requests[cls]) || {};
    const d = DEFAULT_REQUESTS[cls];
    return {
        diskBytes: num(req.diskBytes) ?? num(c.diskBytes) ?? d.diskBytes,
        commitBytes: num(req.commitBytes) ?? num(c.commitBytes) ?? d.commitBytes,
    };
}

function diskReserve(totalBytes, config = {}) {
    const set = num(config.diskReserveBytes);
    if (set !== null) return set;
    return Math.min(DISK_RESERVE_MAX, Math.max(DISK_RESERVE_MIN, DISK_RESERVE_SHARE * totalBytes));
}

function commitReserve(cls, config = {}) {
    const set = num(config.commitReserveBytes);
    if (set !== null) return set;
    const p95 = num(config.measured && config.measured[cls] && config.measured[cls].commitP95Bytes);
    return p95 === null ? COMMIT_RESERVE_MIN : Math.max(COMMIT_RESERVE_MIN, COMMIT_P95_FACTOR * p95);
}

/** The decision for one request against one sample and the outstanding reservations: { ok, why, numbers }. */
function evaluate({ cls, size, probe, reservations, config = {} }) {
    const unknown = [];
    if (!probe || !probe.disk || !probe.disk.ok) unknown.push(`disk (${probe && probe.disk ? probe.disk.why : 'no probe'})`);
    if (!probe || !probe.commit || !probe.commit.ok) unknown.push(`commit (${probe && probe.commit ? probe.commit.why : 'no probe'})`);
    if (unknown.length) return { ok: false, unknown: true, why: `capacity probe unknown: ${unknown.join('; ')}; an unknown probe defers` };
    const dev = probe.disk.dev;
    const sameVolume = (r) => dev === null || dev === undefined || r.dev === null || r.dev === undefined || r.dev === dev;
    const outDisk = reservations.filter(sameVolume).reduce((s, r) => s + (num(r.diskBytes) || 0), 0);
    const outCommit = reservations.reduce((s, r) => s + (num(r.commitBytes) || 0), 0);
    const dRes = diskReserve(probe.disk.totalBytes, config);
    const cRes = commitReserve(cls, config);
    const diskLeft = probe.disk.freeBytes - outDisk - size.diskBytes;
    const commitLeft = probe.commit.freeBytes - outCommit - size.commitBytes;
    const numbers = { diskFreeBytes: probe.disk.freeBytes, diskOutstandingBytes: outDisk, diskRequestBytes: size.diskBytes, diskReserveBytes: dRes,
        commitFreeBytes: probe.commit.freeBytes, commitOutstandingBytes: outCommit, commitRequestBytes: size.commitBytes, commitReserveBytes: cRes };
    const short = [];
    if (diskLeft < dRes) short.push(`disk ${gib(probe.disk.freeBytes)} free - ${gib(outDisk)} reserved - ${gib(size.diskBytes)} asked = ${gib(diskLeft)}, under the ${gib(dRes)} reserve`);
    if (commitLeft < cRes) short.push(`commit ${gib(probe.commit.freeBytes)} free - ${gib(outCommit)} reserved - ${gib(size.commitBytes)} asked = ${gib(commitLeft)}, under the ${gib(cRes)} reserve`);
    return short.length ? { ok: false, why: `capacity short for ${cls}: ${short.join('; ')}`, numbers } : { ok: true, why: null, numbers };
}

// ---------------------------------------------------------------------------
// The ledger.
// ---------------------------------------------------------------------------

function defaultIsAlive(pid) {
    // Lazily: full-gate-queue.js requires this file. Its probe sees MSYS pids
    // too, which a plain signal-0 probe would call dead. Unknown (null) is alive.
    return require(path.join(__dirname, 'full-gate-queue.js')).isAlive(pid);
}

function defaultIsAliveFresh(pid) {
    return require(path.join(__dirname, 'full-gate-queue.js')).isAliveFresh(pid);
}

/**
 * The liveness probe every ledger read and the mutex use. A "dead" from the
 * caller's probe is confirmed on fresh tables before it reclaims a reservation:
 * full-gate-queue caches its `ps -e` listing per process, so in any process
 * that probed before an MSYS pid was born, that pid reads dead while `ps -p`
 * still sees it, and the class's breaker trips on a healthy run
 * [measured 2026-10-30: a live Git Bash pid tripped the gate breaker].
 */
function defaultSnapshot() {
    require(path.join(__dirname, 'full-gate-queue.js')).freshSnapshot();
}

/**
 * Each call is one ledger read, and it starts a fresh snapshot of the pid
 * tables on its first probe: an "alive" cached by an earlier read in the same
 * process hid that pid's later death for the life of the process
 * [measured 2026-10-30, Codex probe cached-alive-then-dead]. Within the read a
 * "dead" is still confirmed on fresh tables. An injected isAlive brings its
 * own cache, so it is reset only by an injected `snapshot`.
 */
function livenessFor(opts) {
    const first = opts.isAlive || defaultIsAlive;
    const fresh = opts.isAliveFresh || defaultIsAliveFresh;
    const snapshot = opts.snapshot || (opts.isAlive ? null : defaultSnapshot);
    let started = false;
    return (pid) => {
        if (!started) {
            started = true;
            if (snapshot) snapshot();
        }
        const alive = first(pid);
        return alive === false ? fresh(pid) : alive;
    };
}

function emptyLedger() { return { schema: 1, reservations: [], classes: {} }; }

function classState(ledger, cls) {
    if (!ledger.classes[cls] || typeof ledger.classes[cls] !== 'object') ledger.classes[cls] = {};
    return ledger.classes[cls];
}

/**
 * Reads the ledger and reclaims every reservation whose pid is dead, tripping
 * that class's breaker. Call only under the mutex. { ledger, changed, malformed, why }.
 */
function loadLedger(base, { isAlive, nowIso }) {
    const r = records.readJson(ledgerPath(base));
    if (r.state === 'malformed') return { ledger: null, malformed: true, why: `the capacity ledger ${ledgerPath(base)} is unreadable (${r.error})` };
    const ledger = r.state === 'ok' ? r.value : emptyLedger();
    if (!Array.isArray(ledger.reservations) || !ledger.classes || typeof ledger.classes !== 'object' || Array.isArray(ledger.classes)) {
        return { ledger: null, malformed: true, why: `the capacity ledger ${ledgerPath(base)} has no reservations list` };
    }
    const reclaimed = [];
    ledger.reservations = ledger.reservations.filter((res) => {
        let alive;
        try { alive = isAlive(res.pid); } catch { alive = null; }
        // Reclaimed only on proof of death: a pid no probe could judge is alive.
        if (alive !== false) return true;
        reclaimed.push(res);
        return false;
    });
    for (const res of reclaimed) {
        const cs = classState(ledger, res.cls);
        if (!cs.breaker) {
            cs.breaker = { trippedUtc: nowIso, reservation: res.id, pid: res.pid,
                why: `pid ${res.pid} (${res.cls}, reservation ${res.id}, admitted ${res.createdUtc}) died without a recorded settlement` };
        }
    }
    return { ledger, changed: reclaimed.length > 0, malformed: false };
}

function saveLedger(base, ledger) { records.writeJsonAtomic(ledgerPath(base), ledger); }

function breakerLine(cls, b) {
    return `crash breaker tripped for ${cls} at ${b.trippedUtc}: ${b.why}; automatic admission for ${cls} stops until an operator runs `
        + `\`node capacity.js clear-breaker --class ${cls}\``;
}

function testPause(env) {
    const ms = Number(env.AUTODEV_CAPACITY_TEST_PAUSE_MS) || 0;
    if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(ms, 60000));
}

function mintId(pid) { return `${new Date().toISOString().replace(/[-:.]/g, '')}-${pid}-${Math.random().toString(36).slice(2, 8)}`; }

function underMutex(base, isAlive, fn) {
    return records.withAdmission(base, fn, { timeoutMs: MUTEX_TIMEOUT_MS, isDead: (p) => isAlive(p) === false });
}

/**
 * Admits `req` ({ cls, path, diskBytes?, commitBytes?, pid?, note? }) or defers
 * it. Returns { admitted: true, id, probe } or { admitted: false, why, probe,
 * breaker?, unknown?, resuming? }. Never throws: a fault defers, naming it.
 * Options: base, env, now (ms clock), probe (fn(path) -> sample), isAlive.
 */
function admit(req, opts = {}) {
    const env = opts.env || process.env;
    const cls = req && req.cls;
    if (!CLASSES.includes(cls)) return { admitted: false, why: `unknown capacity class ${JSON.stringify(cls)}; one of ${CLASSES.join(', ')}`, probe: null };
    if (isOff(env)) return { admitted: true, id: null, off: true, why: 'AUTODEV_CAPACITY=off: admitted without a reservation', probe: null };
    const base = opts.base || defaultBase(env);
    const now = opts.now || Date.now;
    const isAlive = livenessFor(opts);
    const probeFn = opts.probe || ((p) => sample(p, env));
    const cfg = readConfig(base, env);
    if (!cfg.config) return { admitted: false, why: `${cfg.why}; admission defers until it parses`, probe: null };
    const config = cfg.config;
    const samples = num(config.resumeSamples) || RESUME_SAMPLES;
    const spacing = envMs(env, 'AUTODEV_CAPACITY_SAMPLE_MS', num(config.sampleSpacingMs) ?? SAMPLE_SPACING_MS);
    const size = requestSize(cls, req, config);
    const pid = Number.isInteger(req.pid) && req.pid > 0 ? req.pid : process.pid;
    try {
        return underMutex(base, isAlive, () => {
            const nowMs = now();
            const nowIso = new Date(nowMs).toISOString();
            const l = loadLedger(base, { isAlive, nowIso });
            if (l.malformed) return { admitted: false, why: `${l.why}; admission defers until it is repaired`, probe: null };
            const ledger = l.ledger;
            const cs = classState(ledger, cls);
            if (cs.breaker) {
                if (l.changed) saveLedger(base, ledger);
                return { admitted: false, breaker: cs.breaker, why: breakerLine(cls, cs.breaker), probe: null };
            }
            const probe = probeFn(req.path);
            const d = evaluate({ cls, size, probe, reservations: ledger.reservations, config });
            testPause(env);
            if (!d.ok) {
                if (!cs.deferredUtc) cs.deferredUtc = nowIso;
                cs.healthy = [];
                cs.lastWhy = d.why;
                saveLedger(base, ledger);
                return { admitted: false, why: d.why, unknown: Boolean(d.unknown), probe, numbers: d.numbers || null };
            }
            if (cs.deferredUtc) {
                const healthy = Array.isArray(cs.healthy) ? cs.healthy : [];
                const last = healthy.length ? Date.parse(healthy[healthy.length - 1]) : NaN;
                if (!Number.isFinite(last) || nowMs - last >= spacing) healthy.push(nowIso);
                cs.healthy = healthy;
                if (healthy.length < samples) {
                    saveLedger(base, ledger);
                    return { admitted: false, resuming: true, probe, numbers: d.numbers,
                        why: `${cls} was deferred at ${cs.deferredUtc} (${cs.lastWhy || 'capacity'}); it resumes after ${samples} consecutive healthy samples ${Math.round(spacing / 1000)} s apart, ${healthy.length} so far` };
                }
                delete cs.deferredUtc;
                delete cs.lastWhy;
                cs.healthy = [];
            }
            const res = { id: mintId(pid), pid, cls, diskBytes: size.diskBytes, commitBytes: size.commitBytes, dev: probe.disk.dev ?? null,
                path: req.path ? path.resolve(req.path) : null, createdUtc: nowIso, ...(req.note ? { note: String(req.note).slice(0, 200) } : {}) };
            ledger.reservations.push(res);
            saveLedger(base, ledger);
            return { admitted: true, id: res.id, reservation: res, probe, numbers: d.numbers };
        });
    } catch (e) {
        return { admitted: false, why: `capacity admission failed (${e.code || e.message}), so it defers`, probe: null };
    }
}

/**
 * Removes reservation `id`: the settlement. Never refused for capacity, since
 * no probe is read. An id already gone counts as released. Never throws.
 */
function release(id, opts = {}) {
    if (!id) return { released: false, why: 'no reservation to release' };
    const env = opts.env || process.env;
    const base = opts.base || defaultBase(env);
    const isAlive = livenessFor(opts);
    const now = opts.now || Date.now;
    try {
        return underMutex(base, isAlive, () => {
            const l = loadLedger(base, { isAlive, nowIso: new Date(now()).toISOString() });
            if (l.malformed) return { released: false, why: l.why };
            const before = l.ledger.reservations.length;
            l.ledger.reservations = l.ledger.reservations.filter((r) => r.id !== id);
            const found = l.ledger.reservations.length < before;
            if (found || l.changed) saveLedger(base, l.ledger);
            return { released: true, why: found ? null : 'it was not in the ledger (already released or reclaimed)' };
        });
    } catch (e) {
        return { released: false, why: `capacity release failed (${e.code || e.message})` };
    }
}

/** The ledger after reclaiming dead pids: { ledger, why, path }. */
function status(opts = {}) {
    const env = opts.env || process.env;
    const base = opts.base || defaultBase(env);
    const isAlive = livenessFor(opts);
    const now = opts.now || Date.now;
    try {
        return underMutex(base, isAlive, () => {
            const l = loadLedger(base, { isAlive, nowIso: new Date(now()).toISOString() });
            if (l.malformed) return { ledger: null, why: l.why, path: ledgerPath(base) };
            if (l.changed) saveLedger(base, l.ledger);
            return { ledger: l.ledger, why: null, path: ledgerPath(base) };
        });
    } catch (e) { return { ledger: null, why: `the capacity ledger could not be read (${e.code || e.message})`, path: ledgerPath(base) }; }
}

/** The tripped breaker for `cls` ({ ...breaker, why }), or null. Off means never tripped. */
function breakerFor(cls, opts = {}) {
    if (isOff(opts.env || process.env)) return null;
    const s = status(opts);
    const b = s.ledger && s.ledger.classes[cls] && s.ledger.classes[cls].breaker;
    return b ? { ...b, why: breakerLine(cls, b) } : null;
}

/** An operator clears `cls`'s breaker: { cleared, why, was }. */
function clearBreaker(cls, opts = {}) {
    if (!CLASSES.includes(cls)) return { cleared: false, why: `unknown capacity class ${JSON.stringify(cls)}; one of ${CLASSES.join(', ')}` };
    const env = opts.env || process.env;
    const base = opts.base || defaultBase(env);
    const isAlive = livenessFor(opts);
    try {
        return underMutex(base, isAlive, () => {
            const l = loadLedger(base, { isAlive, nowIso: new Date().toISOString() });
            if (l.malformed) return { cleared: false, why: l.why };
            const cs = classState(l.ledger, cls);
            const was = cs.breaker || null;
            delete cs.breaker;
            saveLedger(base, l.ledger);
            return { cleared: Boolean(was), why: was ? null : `${cls} had no tripped breaker`, was };
        });
    } catch (e) { return { cleared: false, why: `could not clear (${e.code || e.message})` }; }
}

/**
 * One observation of admitted load against the reserves, appended to
 * `<stem>.capacity-observe.jsonl`. A BREACH is a sample taken while at least one
 * reservation is outstanding in which free disk on a reserved volume, or free
 * commit, is under its reserve: the admitted runs together took the machine past
 * the capacity admission promised to keep. Below the reserve with nothing
 * reserved is load that admission never saw, recorded as `idleShort`, never a
 * breach. A probe that cannot read is `unknown`, also never a breach. Returns the
 * row, or { row: null, why } when it could not be written.
 */
function observe(opts = {}) {
    const env = opts.env || process.env;
    const base = opts.base || defaultBase(env);
    const now = opts.now || Date.now;
    const s = status(opts);
    if (!s.ledger) return { row: null, why: s.why };
    const cfg = readConfig(base, env);
    const config = cfg.config || {};
    const reservations = s.ledger.reservations;
    const paths = [path.dirname(base), ...reservations.map((r) => r.path).filter(Boolean)];
    const seen = new Set();
    const volumes = [];
    let commit = null;
    for (const p of paths) {
        const smp = (opts.probe || ((x) => sample(x, env)))(p);
        if (!commit) commit = smp.commit;
        const key = smp.disk && smp.disk.ok ? String(smp.disk.dev) : `unknown:${p}`;
        if (seen.has(key)) continue;
        seen.add(key);
        volumes.push({ path: path.resolve(p), dev: smp.disk && smp.disk.ok ? smp.disk.dev : null, disk: smp.disk });
    }
    const unknown = volumes.filter((v) => !v.disk || !v.disk.ok).map((v) => `disk at ${v.path} (${v.disk ? v.disk.why : 'no probe'})`);
    if (!commit || !commit.ok) unknown.push(`commit (${commit ? commit.why : 'no probe'})`);
    const cRes = commitReserve('gate', config);
    const short = [];
    for (const v of volumes.filter((x) => x.disk && x.disk.ok)) {
        const dRes = diskReserve(v.disk.totalBytes, config);
        if (v.disk.freeBytes < dRes) short.push({ what: 'disk', path: v.path, dev: v.dev, freeBytes: v.disk.freeBytes, reserveBytes: dRes });
    }
    if (commit && commit.ok && commit.freeBytes < cRes) short.push({ what: 'commit', freeBytes: commit.freeBytes, reserveBytes: cRes });
    const reservedOn = (x) => x.what === 'commit' ? reservations.length > 0
        : reservations.some((r) => r.dev === null || r.dev === undefined || x.dev === null || String(r.dev) === String(x.dev));
    const breaches = short.filter(reservedOn);
    const row = {
        at: new Date(now()).toISOString(),
        reservations: reservations.length,
        classes: [...new Set(reservations.map((r) => r.cls))].sort(),
        volumes: volumes.map((v) => ({ path: v.path, freeBytes: v.disk && v.disk.ok ? v.disk.freeBytes : null, totalBytes: v.disk && v.disk.ok ? v.disk.totalBytes : null })),
        commitFreeBytes: commit && commit.ok ? commit.freeBytes : null,
        commitReserveBytes: cRes,
        unknown: unknown.length ? unknown.join('; ') : null,
        breach: breaches.length > 0,
        idleShort: short.length > 0 && !breaches.length,
        why: short.length ? short.map((x) => `${x.what}${x.path ? ` at ${x.path}` : ''} ${gib(x.freeBytes)} free, under the ${gib(x.reserveBytes)} reserve`).join('; ') : null,
    };
    try {
        fs.mkdirSync(path.dirname(base), { recursive: true });
        fs.appendFileSync(`${stem(base)}.capacity-observe.jsonl`, JSON.stringify(row) + '\n');
    } catch (e) { return { row: null, why: `the observation could not be written (${e.code || e.message})` }; }
    return { row, why: null };
}

module.exports = {
    observe,
    CLASSES, DEFAULT_REQUESTS, GIB, DISK_RESERVE_MIN, DISK_RESERVE_MAX, COMMIT_RESERVE_MIN, RESUME_SAMPLES, SAMPLE_SPACING_MS,
    admit, release, status, breakerFor, clearBreaker, sample, probeDisk, probeCommit, evaluate, diskReserve, commitReserve,
    requestSize, ledgerPath, configPath, defaultBase, isOff, waitMs, pollMs,
};

// ---------------------------------------------------------------------------
// CLI. process.exitCode, not process.exit(), so piped output drains.
// ---------------------------------------------------------------------------

function help() {
    console.log([
        'usage: node capacity.js status [--json]',
        '       node capacity.js observe     (one sample of admitted load against the reserves)',
        '       node capacity.js clear-breaker --class <gate|worker|judge|frontier|archive|verify>',
        '',
        'Machine capacity admission for gates, headless workers, judges and verifies. status lists',
        'the reservations and each class\'s deferral and crash breaker. clear-breaker is the',
        'operator\'s step after an admitted process died without settling its reservation.',
    ].join('\n'));
}

if (require.main === module) {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    if (!cmd || argv.includes('--help') || argv.includes('-h')) help();
    else if (cmd === 'status') {
        const s = status();
        if (!s.ledger) { console.error(`capacity: ${s.why}`); process.exitCode = 1; } else if (argv.includes('--json')) console.log(JSON.stringify(s.ledger, null, 2));
        else {
            console.log(`capacity: ${s.ledger.reservations.length} reservation(s) in ${s.path}`);
            for (const r of s.ledger.reservations) console.log(`  ${r.id} ${r.cls} pid ${r.pid}: disk ${gib(r.diskBytes)}, commit ${gib(r.commitBytes)}, since ${r.createdUtc}`);
            for (const [cls, c] of Object.entries(s.ledger.classes)) {
                if (c.breaker) console.log(`  ${breakerLine(cls, c.breaker)}`);
                if (c.deferredUtc) console.log(`  ${cls} deferred since ${c.deferredUtc}, ${(c.healthy || []).length} healthy sample(s): ${c.lastWhy || ''}`);
            }
        }
    } else if (cmd === 'observe') {
        const r = observe();
        if (!r.row) { console.error(`capacity: ${r.why}`); process.exitCode = 2; } else {
            const v = r.row;
            console.log(`capacity: observed ${v.reservations} reservation(s): ${v.breach ? `BREACH ${v.why}` : v.unknown ? `probe unknown: ${v.unknown}` : v.idleShort ? `short with nothing reserved: ${v.why}` : 'inside the reserves'}`);
            if (v.breach) process.exitCode = 1;
        }
    } else if (cmd === 'clear-breaker') {
        const k = argv.indexOf('--class');
        const cls = k >= 0 ? argv[k + 1] : undefined;
        const r = clearBreaker(cls);
        if (r.cleared) console.log(`capacity: cleared the ${cls} breaker (${r.was.why})`);
        else { console.error(`capacity: nothing cleared: ${r.why}`); process.exitCode = 1; }
    } else { console.error(`capacity: unknown command ${cmd}; see --help`); process.exitCode = 1; }
}
