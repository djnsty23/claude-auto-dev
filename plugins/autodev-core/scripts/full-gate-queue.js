#!/usr/bin/env node
/**
 * full-gate-queue.js - a ticket queue in front of the machine-wide full-gate
 * lock: product gates first, harness gates after them, first come within each.
 *
 * WHY. One machine runs one full gate at a time, guarded by a lock file that
 * every session writes the same way: pid on line 1, what and where on line 2,
 * release by renaming it to `.released-HHMM` (UTC). The lock has no queue.
 * Whoever polls first after a release wins, whatever the arrival order.
 * `[measured 2026-09-26]` one session waited two and a half hours and lost the
 * lock twice, each time to a gate that had started waiting minutes before. Each
 * waiter polled every 60 s, so the order was the phase of the poll, not arrival.
 *
 * THE QUEUE. A directory beside the lock (`full-gate.queue/` for
 * `full-gate.lock`) holds one ticket per waiter. A ticket's file name is its
 * arrival time and pid, so a directory listing sorted by name is the queue:
 *   20260926T132800123Z-0000073024.ticket   line 1 pid, line 2 what, line 3 arrival, line 4 class
 * Three rules make it first-come within a class. CLASSES below sets the order
 * between classes, and "the front" is the first live ticket in that order:
 *   1. Only the ticket at the FRONT may take the lock. A newcomer that polls
 *      first after a release finds itself behind an older ticket and waits.
 *   2. A release HANDS the lock to the ticket at the front. The lock is copied
 *      to `.released-HHMM` and then replaced in place with the new holder's pid
 *      and description, so it never disappears while someone is queued and an
 *      exclusive-create poller outside the queue has no gap to win.
 *   3. A dead ticket is dropped. Dead means BOTH `tasklist` and `ps -p` failed
 *      to find the pid on Windows, because a waiter's pid may be an MSYS
 *      (Git Bash) pid that tasklist cannot see. A pid no probe could judge is
 *      treated as alive. A ticket whose heartbeat (its mtime, touched on every
 *      poll) is older than the stale window is dropped too: its pid may live on
 *      as an idle shell while nobody is waiting on it any more.
 *
 * CLASSES. Every ticket is a PRODUCT gate (the default) or a HARNESS gate
 * (`--class harness`, or AUTODEV_GATE_CLASS=harness). This plugin's own repo
 * gate passes it. `[measured 2026-09-23..10-01, 239 lock records]` A harness
 * gate held a lane for a median 93 min against 31 and 11 for the two busiest
 * product repos, and product gates waited 65 to 83 min behind two of them.
 *   - The front of a lane's queue is its oldest live product ticket. A harness
 *     ticket reaches the front only when no live product ticket waits there.
 *   - Harness gates hold at most lanes - 1 lanes, so one lane always stays open
 *     to product gates. On a one-lane machine the cap is that one lane, which a
 *     harness ticket takes only when no product ticket waits.
 *   - Nothing is preempted: a running holder keeps its lane, whatever its class.
 * The class is a `class <name>` line after line 2, in the ticket and in the
 * lock. A ticket or lock without one (written by an older version, or by hand)
 * is a product. An older version takes a free lock only as the OLDEST ticket,
 * so when such a ticket is at the front but not the oldest, the waiter that
 * finds the lane free hands it over as a release would. Otherwise the older
 * waiter and the harness ticket ahead of it would each wait for the other.
 *
 * WHAT IT NEVER DOES. Delete a lock, kill a process, or move a lock whose holder
 * any probe says is alive. A dead holder's lock is renamed to `.stale-HHMM`, and
 * only by the head of the queue, under the same `.takeover` file other lock
 * writers use.
 *
 * THE PID. `--pid` is the process that will RUN the gate and must outlive it,
 * because the lock names it and a dead holder's lock is taken over. It defaults
 * to this script's parent: the shell that invoked it. A shell that exits after
 * `wait` returns leaves a lock that names a dead pid, so run wait, the gate and
 * release inside one script.
 *
 * WHY NOT THE PROFILE DIR. The lock is per MACHINE, not per Claude profile: a
 * second profile's sessions gate on the same CPU. So the default path is under
 * the OS home directory, never CLAUDE_CONFIG_DIR.
 *
 * LANES. A machine may allow more than one full gate at a time. Lane 1 is the
 * lock itself; lane k is the same name with `-k` before `.lock`
 * (`full-gate-2.lock`), each with its own queue. The machine's lane count lives
 * in a file beside lane 1 (`full-gate.lanes`, written by the `lanes` command),
 * so one decision reaches every waiter. A waiter holds a ticket in every lane
 * and takes whichever lane it reaches the head of while that lane is free, then
 * leaves the other queues. `release` frees every lane whose lock names the pid.
 *
 *   node full-gate-queue.js take    [--pid N] [--what TEXT] [--class C]   one attempt: 0 holds a lane, 3 queued
 *   node full-gate-queue.js wait    [--pid N] [--what TEXT] [--class C] [--timeout-ms N]   blocks until 0
 *   node full-gate-queue.js release [--pid N]                 0 released or handed over, 1 not ours
 *   node full-gate-queue.js leave   [--pid N]                 0 no ticket of --pid is left, 1 one is
 *   node full-gate-queue.js status  [--json]                  read-only, every lane
 *   node full-gate-queue.js lanes   [N]                       print, or set, the machine's lane count
 *   node full-gate-queue.js --help
 *   --lanes N on take, wait, release, leave and status overrides the lane count for one call.
 *
 * LEAVE. A waiter stopped from outside (TaskStop, a closed terminal) can leave
 * its shell alive, and a live pid's ticket stays in every queue until its
 * heartbeat goes stale, ten minutes by default. `leave` removes that pid's
 * tickets from every lane at once. It never touches a lock: a pid that holds a
 * lane is told to run `release`. It runs for a pid that is not running too,
 * because a dead waiter's ticket is one of the tickets it exists to remove.
 *
 * OWNERSHIP RECORDS (gate-records.js, gate-identity.js). Every ticket and lock
 * this version writes ends with a `meta {json}` line that older versions skip:
 *   - The CLASS comes from the caller's checkout (`--repo DIR`, default the
 *     working directory): a tree carrying this marketplace's markers is a
 *     harness gate, and so is a directory git cannot name. `--class` and
 *     AUTODEV_GATE_CLASS may demote a product gate to harness, never promote.
 *   - The ADMISSION MUTEX beside lane 1 serialises ticket registration, the
 *     class and cap checks, acquisition, hand-over, fencing and leaving the
 *     other queues, so two waiters released at once cannot both pass the cap.
 *   - Every admission mints the next FENCING TOKEN. A release that carries
 *     --run-id and --token must match the lock's, so a late release from an
 *     earlier admission never frees a newer holder's lane.
 *   - The lock names the holder's run id, original ARRIVAL (its ticket's
 *     stamp, kept through hand-over), lane, admission time, and its OWNER: the
 *     native pid with its creation time, the boot it ran in, and an MSYS pid.
 *     A holder is judged by that identity and its execution journal (the chain
 *     root and every descendant seen), so a reused pid, a lock from an earlier
 *     boot and a launcher whose chain still runs are each read correctly. An
 *     answer no probe can give is unknown, and unknown is alive. A meta line
 *     that does not parse is unknown too, never vacant.
 *
 * ENVIRONMENT (the lock variables are shared with the gate wrapper, so both
 * always name the same file):
 *   AUTODEV_GATE_CLASS=product|harness take and wait's declared class (it can only demote; default product)
 *   AUTODEV_GATE_SNAPSHOT_MAX_AGE_MS=N how long a process snapshot is reused (default 30000)
 *   AUTODEV_GATE_BOOT_CACHE=FILE       where this boot's identity is cached (default beside lane 1)
 *   AUTODEV_GATE_LINEAGE_PATH=FILE     POSIX: each process's creator, per boot (default autodev-gate-lineage-<uid>.json in temp)
 *   AUTODEV_GATE_LANES=N               lane count, over the lanes file (default 1)
 *   AUTODEV_GATE_LOCK_PATH=FILE        lane 1's lock (default <home>/.claude/autodev/locks/full-gate.lock)
 *   AUTODEV_GATE_LOCK_POLL_MS=N        wait's poll interval (default 5000)
 *   AUTODEV_GATE_LOCK_REPORT_MS=N      how often wait re-prints its place (default 180000)
 *   AUTODEV_GATE_QUEUE_STALE_MS=N      heartbeat age at which a ticket is dropped (default 600000)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ident = require(path.join(__dirname, 'gate-identity.js'));
const records = require(path.join(__dirname, 'gate-records.js'));

const TAG = 'full-gate-queue:';
const EXIT_QUEUED = 3;
const MAX_POLL_ERRORS = 10;
const TICKET_RE = /^(\d{8}T\d{9}Z)-(\d{10})\.ticket$/;
const MAX_LANES = 8;
const PRODUCT = 'product';
const HARNESS = 'harness';
const CLASS_LINE_RE = /^class (product|harness)$/;

// ---------------------------------------------------------------------------
// Paths and small helpers.
// ---------------------------------------------------------------------------

function defaultLockPath() {
    return path.join(os.homedir(), '.claude', 'autodev', 'locks', 'full-gate.lock');
}

/** `full-gate.lock` -> `full-gate.queue`; any other name gets `.queue` appended. */
function queueDirFor(lockPath) {
    return /\.lock$/.test(lockPath) ? lockPath.replace(/\.lock$/, '.queue') : `${lockPath}.queue`;
}

/** Lane k's lock: lane 1 is `base`, lane 2 of `full-gate.lock` is `full-gate-2.lock`. */
function lanePath(base, k) {
    if (k <= 1) return base;
    return /\.lock$/.test(base) ? base.replace(/\.lock$/, `-${k}.lock`) : `${base}-${k}`;
}

function lanePaths(base, count) {
    return Array.from({ length: count }, (_, i) => lanePath(base, i + 1));
}

/** `full-gate.lock` -> `full-gate.lanes`: the machine's lane count, one number. */
function lanesFileFor(base) {
    return /\.lock$/.test(base) ? base.replace(/\.lock$/, '.lanes') : `${base}.lanes`;
}

function parseLanes(v) {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return n >= 1 && n <= MAX_LANES ? n : null;
}

/**
 * The lane count and where it came from: a --lanes flag, then
 * AUTODEV_GATE_LANES, then the lanes file, then 1. A value that is not a whole
 * number from 1 to MAX_LANES is skipped and named in `notes`, never guessed at.
 */
function laneCount(base, env, flag) {
    const notes = [];
    if (flag !== null && flag !== undefined) return { count: flag, source: '--lanes', notes };
    if (env.AUTODEV_GATE_LANES !== undefined && env.AUTODEV_GATE_LANES !== '') {
        const n = parseLanes(env.AUTODEV_GATE_LANES);
        if (n) return { count: n, source: 'AUTODEV_GATE_LANES', notes };
        notes.push(`AUTODEV_GATE_LANES=${env.AUTODEV_GATE_LANES} is not 1 to ${MAX_LANES}; ignored`);
    }
    const file = lanesFileFor(base);
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
        if (e.code !== 'ENOENT') notes.push(`${path.basename(file)} unreadable (${e.code}); ignored`);
    }
    if (text !== null) {
        const n = parseLanes(text);
        if (n) return { count: n, source: path.basename(file), notes };
        notes.push(`${path.basename(file)} does not hold 1 to ${MAX_LANES}; ignored`);
    }
    return { count: 1, source: 'default', notes };
}

function parseClass(v) {
    const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
    return s === PRODUCT || s === HARNESS ? s : null;
}

/**
 * The class take and wait queue as: --class, then AUTODEV_GATE_CLASS, then
 * product. An env value that is neither class is named in `note` and the
 * ticket queues as a product, the class every older version queued as.
 */
function gateClass(env, flag) {
    if (flag) return { cls: flag, note: null };
    const raw = env.AUTODEV_GATE_CLASS;
    if (raw === undefined || raw === '') return { cls: PRODUCT, note: null };
    const cls = parseClass(raw);
    return cls ? { cls, note: null } : { cls: PRODUCT, note: `AUTODEV_GATE_CLASS=${raw} is not product or harness, so it queued as product` };
}

/**
 * The `class <name>` line after line 2 of a ticket or a lock. `classed` is
 * false when there is none: an older version or a hand-written file, read as a
 * product.
 */
function classOf(lines) {
    for (const line of lines.slice(2)) {
        const m = CLASS_LINE_RE.exec(line.trim());
        if (m) return { cls: m[1], classed: true };
    }
    return { cls: PRODUCT, classed: false };
}

/** The order a lane serves its tickets: products, then harness, each in arrival (name) order. */
function servingOrder(tickets) {
    return [...tickets.filter((t) => t.cls === PRODUCT), ...tickets.filter((t) => t.cls === HARNESS)];
}

/** How many lanes harness gates may hold at once: all but one, and the one lane of a one-lane machine. */
function harnessCap(laneCount) {
    return Math.max(1, laneCount - 1);
}

/**
 * Null when a harness gate may take `lockPath`, else { held, cap, lanes }:
 * taking it would put harness gates on more than `cap` lanes. A lane counts
 * when its holder says `class harness` and is not known to be dead, so a
 * holder no probe could judge counts. `lockPath` itself never counts: whoever
 * takes it replaces its holder.
 */
function harnessReserve(lockPaths, lockPath) {
    const held = lockPaths.filter((lp) => {
        if (lp === lockPath) return false;
        const h = readLock(lp);
        return Boolean(h) && h.cls === HARNESS && holderAlive(h, lockPaths[0]) !== false;
    }).length;
    const cap = harnessCap(lockPaths.length);
    return held + 1 > cap ? { held, cap, lanes: lockPaths.length } : null;
}

/** Why a free lane is not given to the harness ticket at the front, in one phrase. */
function reservedLine(r) {
    return `kept for product gates: harness gates already hold ${r.held} of ${r.lanes} lane(s), the most they may`;
}

/** HHMM in UTC, the suffix the hand-written convention uses. */
function hhmm(d = new Date()) {
    return d.toISOString().slice(11, 16).replace(':', '');
}

/** Fixed-width, so a name sort is a time sort: 20260926T132800123Z. */
function stamp(d = new Date()) {
    return d.toISOString().replace(/[-:.]/g, '');
}

function stampToIso(s) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(s);
    return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z` : null;
}

/** `<lock>.<kind>-HHMM`, or `-HHMM-2`, `-3`... when that name is taken. Never clobbers. */
function asideName(lockPath, kind) {
    const base = `${lockPath}.${kind}-${hhmm()}`;
    if (!fs.existsSync(base)) return base;
    for (let i = 2; i < 1000; i++) {
        const p = `${base}-${i}`;
        if (!fs.existsSync(p)) return p;
    }
    return `${base}-${process.pid}-${Date.now()}`;
}

/** Atomic exclusive create. true = ours now, false = it already exists. */
function tryCreate(file, body) {
    let fd;
    try {
        fd = fs.openSync(file, 'wx');
    } catch (e) {
        if (e.code === 'EEXIST') return false;
        throw e;
    }
    try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
    return true;
}

function readLock(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
    }
    const lines = text.split(/\r?\n/);
    const first = (lines[0] || '').trim();
    const pid = /^\d+$/.test(first) ? Number(first) : null;
    return { text, pid, what: (lines[1] || '').trim() || '(no description on line 2)', cls: classOf(lines).cls, ...records.parseMeta(lines) };
}

/**
 * Replaces `file` with `body` without the file ever being absent: a temp file
 * renamed over it. Windows refuses the rename while a reader has the file open,
 * so it retries briefly, then falls back to an in-place write, which can be
 * read half-written but never leaves the lock missing.
 */
function replaceInPlace(file, body) {
    const tmp = `${file}.handoff-${process.pid}`;
    fs.writeFileSync(tmp, body);
    for (let i = 0; i < 40; i++) {
        try { fs.renameSync(tmp, file); return; } catch (e) {
            if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
    }
    fs.writeFileSync(file, body);
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
}

// ---------------------------------------------------------------------------
// Liveness. On Windows a pid is alive if ANY probe finds it (a signal-0 open,
// ps, tasklist): a waiter or holder may have written its MSYS pid. It is dead
// only when both tasklist and ps ran and neither listed it. Returns true,
// false, or null when no probe could answer; every caller treats null as alive.
// ---------------------------------------------------------------------------

let psCommand; // resolved once: 'ps' on PATH, Git's bundled ps.exe, or null

function resolvePs() {
    if (psCommand !== undefined) return psCommand;
    psCommand = null;
    const probe = spawnSync('ps', ['-p', String(process.pid)], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (!probe.error) { psCommand = 'ps'; return psCommand; }
    // Run from PowerShell, PATH often lacks Git's usr/bin. Git knows where it
    // lives: <git>/mingw64/libexec/git-core -> <git>/usr/bin/ps.exe.
    const ex = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (!ex.error && ex.status === 0) {
        const candidate = path.resolve(ex.stdout.trim(), '..', '..', '..', 'usr', 'bin', 'ps.exe');
        if (fs.existsSync(candidate)) psCommand = candidate;
    }
    return psCommand;
}

const aliveCache = new Map();

/** Liveness answers are cached per attempt; a waiter re-asks on every poll. */
function resetProbes() {
    aliveCache.clear();
    holderCache.clear();
    msysPids = undefined;
    ident.forgetMsys();
}

function isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (pid === process.pid) return true;
    if (aliveCache.has(pid)) return aliveCache.get(pid);
    const answer = probeAlive(pid);
    aliveCache.set(pid, answer);
    return answer;
}

/**
 * Every MSYS pid, from one `ps -e` per attempt: a waiter probes the holder and
 * every ticket on each poll, and one listing costs what one `ps -p` does.
 * Null when ps could not run.
 */
let msysPids;

function msysPidSet() {
    if (msysPids !== undefined) return msysPids;
    msysPids = null;
    const ps = resolvePs();
    if (!ps) return msysPids;
    const p = spawnSync(ps, ['-e'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (p.error || p.status !== 0) return msysPids;
    msysPids = new Set((p.stdout || '').split(/\r?\n/).map((l) => l.trim().split(/\s+/)[0]).filter((s) => /^\d+$/.test(s)));
    return msysPids;
}

function probeAlive(pid) {
    // A signal-0 probe answers for a native pid in microseconds. On Windows
    // it asks the same process table tasklist reads, so a hit is enough; a miss
    // is NOT a verdict there, because the pid may be an MSYS one.
    try { process.kill(pid, 0); return true; } catch (e) {
        if (e.code === 'EPERM') return true;
        if (process.platform !== 'win32') return false;
    }
    const msys = msysPidSet();
    const psRan = msys !== null;
    const found = psRan && msys.has(String(pid));
    if (found) return true;
    // tasklist is slow (about half a second a call on a busy box), so it runs
    // only for a pid neither probe above could find.
    const t = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const tasklistRan = !t.error && t.status === 0;
    if (tasklistRan && new RegExp(`^"[^"]*","${pid}"`, 'm').test(t.stdout || '')) return true;
    // Dead only when BOTH pid tables were asked. Without ps an MSYS pid cannot
    // be seen at all, and "cannot see it" is not "it is dead".
    return tasklistRan && psRan ? false : null;
}

// ---------------------------------------------------------------------------
// Judging a holder by its ownership record. A lock with no meta line (an older
// version, or written by hand) keeps the pid probe above. A lock with one is
// judged by its owner's identity and its execution journal: a different boot is
// dead; the owner's pid created at the recorded time, its MSYS pid, its chain
// root or any descendant is alive; anything no probe can settle is unknown.
// A "dead" answer from a reused snapshot is confirmed against a fresh one.
// ---------------------------------------------------------------------------

const holderCache = new Map();
let bootCached;

function snapshotMaxAgeMs() {
    const n = Number(process.env.AUTODEV_GATE_SNAPSHOT_MAX_AGE_MS);
    return Number.isFinite(n) && n >= 0 ? n : 30000;
}

/** This boot's identity, cached per process and in a file per boot. Null when no probe answered. */
function bootNow(base) {
    if (bootCached !== undefined) return bootCached;
    try { bootCached = ident.bootIdentity({ cacheFile: process.env.AUTODEV_GATE_BOOT_CACHE || records.bootCachePath(base) }); } catch { bootCached = null; }
    return bootCached;
}

function judgeMeta(meta, base, maxAgeMs) {
    const owner = meta.owner;
    let execution = null;
    let journalUnreadable = false;
    if (meta.runId) {
        const r = records.readRun(base, meta.runId);
        if (r.state === 'ok') execution = r.value;
        else if (r.state === 'malformed') journalUnreadable = true;
    }
    const recordsExecution = Boolean(execution && (execution.chainRoot || (Array.isArray(execution.descendants) && execution.descendants.length)));
    if (!owner.startUtc && !owner.msysPid) {
        // An identity recorded without a creation time (a hand-over to a
        // waiter whose ticket had none): the boot and the pid probe decide
        // for the owner. A dead owner whose journal names processes is still
        // judged by them below: it may have started a chain that runs on.
        const boot = bootNow(base);
        if (owner.bootId && boot && owner.bootId !== boot.id) return { alive: false, why: 'it was written in an earlier boot' };
        const a = isAlive(owner.pid);
        if (a === true) return { alive: true, why: `pid ${owner.pid} answers a liveness probe` };
        if (journalUnreadable) return { alive: null, why: 'its execution journal cannot be read' };
        if (!recordsExecution) return { alive: a, why: a === false ? `pid ${owner.pid} is not running` : `pid ${owner.pid} cannot be probed` };
    }
    const snap = ident.snapshot({ maxAgeMs });
    const boot = snap.ok ? snap.boot : bootNow(base);
    return ident.judgeExecution({ owner, execution, journalUnreadable, snap, boot, msys: ident.msysTable(), legacyAlive: isAlive });
}

/**
 * Is the gate a lock names still running? true, false, or null (unknown,
 * which every caller treats as alive). `base` is lane 1's lock.
 */
function holderAlive(held, base) {
    if (!held) return false;
    if (held.malformed) return null;
    const meta = held.meta;
    if (!meta || !meta.owner || typeof meta.owner !== 'object' || !Number.isInteger(meta.owner.pid)) {
        if (meta) return null;
        return held.pid === null ? null : isAlive(held.pid);
    }
    if (meta.owner.pid === process.pid) return true;
    if (holderCache.has(held.text)) return holderCache.get(held.text).alive;
    let j;
    try {
        j = judgeMeta(meta, base, snapshotMaxAgeMs());
        if (j.alive === false && snapshotMaxAgeMs() > 0) { ident.forgetMsys(); j = judgeMeta(meta, base, 0); }
    } catch (e) { j = { alive: null, why: `the judgement threw (${e.message})` }; }
    holderCache.set(held.text, j);
    return j.alive;
}

/** Why holderAlive answered as it did, for status lines. */
function holderWhy(held) {
    const j = held && holderCache.get(held.text);
    return j ? j.why : null;
}

/** True only when the holder is known not to be running. */
function holderDead(held, base) {
    return Boolean(held) && holderAlive(held, base) === false;
}

// ---------------------------------------------------------------------------
// The queue.
// ---------------------------------------------------------------------------

/** Every ticket in arrival order, parsed. Files that are not tickets are counted, never touched. */
function readTickets(queueDir) {
    let names;
    try { names = fs.readdirSync(queueDir); } catch (e) {
        if (e.code === 'ENOENT') return { tickets: [], other: 0 };
        throw e;
    }
    const tickets = [];
    let other = 0;
    for (const name of names.sort()) {
        const m = TICKET_RE.exec(name);
        if (!m) { other++; continue; }
        const file = path.join(queueDir, name);
        let text = '';
        let mtimeMs = 0;
        try { text = fs.readFileSync(file, 'utf8'); mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
        const lines = text.split(/\r?\n/);
        tickets.push({ file, name, pid: Number(m[2]), arrived: stampToIso(m[1]), mtimeMs,
                       what: (lines[1] || '').trim() || '(no description)', ...classOf(lines), ...records.parseMeta(lines) });
    }
    return { tickets, other };
}

/**
 * Why a ticket no longer counts, or null when it does. `boot` is this boot's
 * identity or null; a ticket written in another boot is dead whatever its pid.
 */
function deadReason(t, staleMs, now, boot = null) {
    if (boot && t.meta && t.meta.bootId && t.meta.bootId !== boot.id) return 'it was written in an earlier boot';
    if (isAlive(t.pid) === false) return `pid ${t.pid} is not running`;
    if (now - t.mtimeMs > staleMs) return `no heartbeat for ${Math.round((now - t.mtimeMs) / 1000)} s`;
    return null;
}

/** The queue with dead tickets removed from disk, oldest first. */
function liveQueue(queueDir, staleMs, log, base = null) {
    const now = Date.now();
    const live = [];
    const all = readTickets(queueDir).tickets;
    const boot = base && all.some((t) => t.meta && t.meta.bootId) ? bootNow(base) : null;
    for (const t of all) {
        const why = deadReason(t, staleMs, now, boot);
        if (!why) { live.push(t); continue; }
        try { fs.unlinkSync(t.file); log(`${TAG} dropped the ticket of pid ${t.pid} (${why}); it said: ${t.what}`); } catch { /* another waiter dropped it first */ }
    }
    return live;
}

/**
 * This pid's ticket, created on first call, heartbeat touched on every later
 * one. The class is written once, at creation: a waiter keeps its class.
 */
function ensureTicket(queueDir, pid, what, cls, meta = null, arrivedMs = null) {
    fs.mkdirSync(queueDir, { recursive: true });
    const own = readTickets(queueDir).tickets.find((t) => t.pid === pid);
    if (own) {
        const now = new Date();
        try { fs.utimesSync(own.file, now, now); return own; } catch { /* dropped under us: take a new place */ }
    }
    // A re-admitted run keeps its original arrival: its ticket is named by it.
    const d = Number.isFinite(arrivedMs) ? new Date(arrivedMs) : new Date();
    const file = path.join(queueDir, `${stamp(d)}-${String(pid).padStart(10, '0')}.ticket`);
    const metaText = meta ? `${records.metaLine({ ...meta, arrival: d.toISOString() })}\n` : '';
    tryCreate(file, `${pid}\n${what}\n${d.toISOString()}\nclass ${cls}\n${metaText}`);
    return readTickets(queueDir).tickets.find((t) => t.file === file) || { file, pid, arrived: d.toISOString(), meta: null };
}

function removeTicket(queueDir, pid) {
    for (const t of readTickets(queueDir).tickets) {
        if (t.pid === pid) { try { fs.unlinkSync(t.file); } catch { /* already gone */ } }
    }
}

// ---------------------------------------------------------------------------
// Taking a dead holder's lock, serialised by the takeover file the gate wrapper
// also uses, so two writers that both judged the holder dead cannot move each
// other's fresh lock.
// ---------------------------------------------------------------------------

function takeOverStale(lockPath, judged, body, log, base = lockPath) {
    const mutex = `${lockPath}.takeover`;
    if (!tryCreate(mutex, `${process.pid}\n`)) {
        const m = readLock(mutex);
        if (m && m.pid !== null && isAlive(m.pid) === false) {
            try { fs.unlinkSync(mutex); } catch { /* another waiter removed it first */ }
        }
        return false;
    }
    try {
        const now = readLock(lockPath);
        if (!now) return tryCreate(lockPath, body);
        if (now.text !== judged.text || holderAlive(now, base) !== false) return false;
        const aside = asideName(lockPath, 'stale');
        records.renameRetry(lockPath, aside);
        const why = holderWhy(now);
        log(`${TAG} holder pid ${now.pid} is not running${why ? ` (${why})` : ''}; moved its lock aside to ${path.basename(aside)} (it said: ${now.what})`);
        return tryCreate(lockPath, body);
    } finally {
        try { fs.unlinkSync(mutex); } catch { /* already gone */ }
    }
}

function lockBody(pid, what, cls, meta = null) {
    return `${pid}\n${what}, lock taken ${new Date().toISOString().slice(11, 16)}Z\nclass ${cls}\n${meta ? `${records.metaLine(meta)}\n` : ''}`;
}

/** A caller's own lock body (line 1 to 3) with the meta line appended. */
function withMeta(body, meta) {
    const lines = String(body).split(/\r?\n/).filter((l, i, a) => !(i === a.length - 1 && l === '') && !l.startsWith('meta '));
    return `${lines.join('\n')}\n${records.metaLine(meta)}\n`;
}

/** The arrival a lock records: its ticket's stamp, which survives hand-over and re-admission. */
function arrivalOf(ticket) {
    return ticket.arrived;
}

/** A run id: unique, and safe as a file name. */
function mintRunId(pid) {
    return `${stamp()}-${pid}-${Math.random().toString(36).slice(2, 8)}`;
}

const ADMISSION_TIMEOUT_MS = 30000;

/** Runs fn() under the machine's admission mutex beside lane 1 (re-entrant). */
function admitted(lockPaths, fn) {
    return records.withAdmission(lockPaths[0], fn, { timeoutMs: ADMISSION_TIMEOUT_MS, isDead: (p) => isAlive(p) === false });
}

/** Test seam: a pause inside the admission mutex, after the cap check, to widen a race window. */
function testPause() {
    const ms = Number(process.env.AUTODEV_GATE_TEST_ADMIT_PAUSE_MS) || 0;
    if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(ms, 60000));
}

/**
 * The meta a lock records for the ticket it admits. `owner` is a full
 * identity when the caller could take one, else the ticket's own.
 */
function admissionMeta({ ticket, lockPath, lockPaths, cls, owner, runId }) {
    const tm = (ticket && ticket.meta) || {};
    return {
        runId: runId || tm.runId || null,
        token: records.mintToken(lockPaths[0]),
        lane: lockPaths.indexOf(lockPath) + 1,
        admittedUtc: new Date().toISOString(),
        arrival: ticket ? arrivalOf(ticket) : null,
        cls,
        owner: owner || tm.owner || (ticket ? { pid: ticket.pid, startUtc: null, bootId: (bootNow(lockPaths[0]) || {}).id || null } : null),
        repo: tm.repo || null,
    };
}

/** The identity to record for `pid`, from a snapshot no older than the reuse window. */
function ownerIdentity(pid) {
    try { return ident.identityOf(pid, { snap: ident.snapshot({ maxAgeMs: snapshotMaxAgeMs() }) }); } catch { return null; }
}

/**
 * Why a release carrying `runId` and `token` may not free `held`, or null when
 * it may. A lock with no meta line (an older writer) is matched by pid alone.
 */
function fenceMismatch(held, runId, token) {
    const fenced = (token !== null && token !== undefined) || Boolean(runId);
    if (held.malformed && fenced) return `the lock's meta line cannot be read (${held.fault || 'malformed'}), so run ${runId || '(any)'} token ${token === null || token === undefined ? '(none)' : token} cannot be matched; left untouched`;
    if (!held.meta || !fenced) return null;
    // A run id alone fences too: a late release from an earlier run of the
    // same pid must not free a later run's admission.
    const tokenOff = token !== null && token !== undefined && held.meta.token !== token;
    const runOff = Boolean(runId) && Boolean(held.meta.runId) && held.meta.runId !== runId;
    if (tokenOff || runOff) {
        return `the lock now belongs to run ${held.meta.runId} with token ${held.meta.token}, not run ${runId || '(any)'} token ${token}; left untouched`;
    }
    return null;
}

/**
 * Does a lock naming `pid` belong to this caller? A lock from another run of
 * the same pid number is foreign only when creation times prove it is another
 * process; without that proof it is ours, as before ownership records.
 */
function namesUs(held, pid, runId) {
    if (!held || held.pid !== pid || held.malformed) return false;
    const m = held.meta;
    if (!m || !runId || !m.runId || m.runId === runId) return true;
    const start = m.owner && m.owner.startUtc;
    if (!start) return true;
    return ownStartMatches(pid, start);
}

function ownStartMatches(pid, start) {
    const me = ownerIdentity(pid);
    return !me || !me.startUtc || me.startUtc === start;
}

/**
 * The compatibility hand-over (CLASSES in the header). `live` is in serving
 * order and the lane is open. When the ticket at the front has no class line
 * and is not the oldest, an older version behind it would never take the lane,
 * so the lock is written naming the front's pid, which every version reads as
 * handed to it. Skipped when the front already holds a lane. True when the
 * lock now names the front.
 */
function handToOlderVersion({ lockPath, lockPaths, live, held, log }) {
    const front = live[0];
    const oldest = live.reduce((a, t) => (t.name < a.name ? t : a));
    if (front.classed || front === oldest) return false;
    if (lockPaths.some((lp) => { const h = readLock(lp); return Boolean(h) && h.pid === front.pid; })) return false;
    const meta = admissionMeta({ ticket: front, lockPath, lockPaths, cls: front.cls });
    const body = lockBody(front.pid, `${front.what}, handed over by the queue`, front.cls, meta);
    if (!(held ? takeOverStale(lockPath, held, body, log, lockPaths[0]) : tryCreate(lockPath, body))) return false;
    try { fs.unlinkSync(front.file); } catch { /* its waiter saw the handoff first */ }
    log(`${TAG} handed the free lock to pid ${front.pid}: its ticket has no class line, and a version without classes takes a lock only as the oldest ticket`);
    return true;
}

/**
 * One attempt. Returns { acquired: true } once the lock names `pid`, else
 * { acquired: false, position, of, holder, reserved? }. The rule that orders
 * the queue is the front check below: a ticket that is not first in serving
 * order never takes the lock, however free it is. A harness ticket at the
 * front is still refused a lane its class may not hold (`reserved`). The
 * whole attempt runs under the admission mutex, so the cap check and the
 * create it permits are one step.
 */
function takeTurn({ lockPath, lockPaths = [lockPath], pid, what, cls = PRODUCT, body: givenBody, staleMs, log, runId = null, repo = null, arrivedMs = null }) {
    return admitted(lockPaths, () => {
        const queueDir = queueDirFor(lockPath);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        const held = readLock(lockPath);
        if (namesUs(held, pid, runId)) {
            removeTicket(queueDir, pid);
            return { acquired: true, handedOver: true };
        }
        const boot = bootNow(lockPaths[0]);
        const own = ensureTicket(queueDir, pid, what, cls,
            { runId: runId || mintRunId(pid), cls, bootId: boot ? boot.id : null, owner: { pid, startUtc: null, bootId: boot ? boot.id : null }, repo }, arrivedMs);
        const live = servingOrder(liveQueue(queueDir, staleMs, log, lockPaths[0]));
        const mine = live.findIndex((t) => t.pid === pid);
        const queued = (holder, extra) => ({ acquired: false, position: mine + 1, of: live.length, holder, ...extra });
        const open = () => !held || holderDead(held, lockPaths[0]);
        if (mine > 0 && !live[0].classed && open() && handToOlderVersion({ lockPath, lockPaths, live, held, log })) {
            return queued(readLock(lockPath));
        }
        if (mine !== 0) return queued(held);
        if (!open()) return queued(held);
        const reserved = live[0].cls === HARNESS ? harnessReserve(lockPaths, lockPath) : null;
        if (reserved) return queued(held, { reserved });
        testPause();
        const owner = ownerIdentity(pid);
        const ticket = live[0];
        const meta = admissionMeta({ ticket, lockPath, lockPaths, cls: ticket.cls, owner, runId: runId || (own.meta && own.meta.runId) });
        const body = givenBody ? withMeta(givenBody, meta) : lockBody(pid, what, ticket.cls, meta);
        const got = held ? takeOverStale(lockPath, held, body, log, lockPaths[0]) : tryCreate(lockPath, body);
        if (!got) return queued(readLock(lockPath));
        removeTicket(queueDir, pid);
        return { acquired: true, handedOver: false, token: meta.token, runId: meta.runId };
    });
}

/**
 * Releases a lock `pid` holds. Hands it to the ticket at the front of serving
 * order when there is one its class may give the lane to. Otherwise it renames
 * the lock to `.released-HHMM` as the hand-written convention does. `lockPaths` is every
 * lane, for the harness cap. With `token` (and `runId`), the lock must carry
 * the same ones: a release from an earlier admission frees nothing. Returns
 * { released, to, aside, reserved, waiting, fenced, why }: `reserved` and
 * `waiting` say a harness ticket waits that the cap kept out.
 */
function releaseLock({ lockPath, lockPaths = [lockPath], pid, staleMs, log, runId = null, token = null }) {
    return admitted(lockPaths, () => {
        const held = readLock(lockPath);
        if (!held) return { released: false, why: `no lock at ${lockPath}; nothing to release` };
        if (held.pid !== pid) {
            return { released: false, why: `the lock names pid ${held.pid}, not ${pid}; left untouched (it says: ${held.what})` };
        }
        const fence = fenceMismatch(held, runId, token);
        if (fence) return { released: false, fenced: true, why: fence };
        const queueDir = queueDirFor(lockPath);
        const live = servingOrder(liveQueue(queueDir, staleMs, log, lockPaths[0]).filter((t) => t.pid !== pid));
        const aside = asideName(lockPath, 'released');
        const next = live[0];
        const reserved = next && next.cls === HARNESS ? harnessReserve(lockPaths, lockPath) : null;
        testPause();
        if (!next || reserved) {
            records.renameRetry(lockPath, aside);
            return { released: true, to: null, aside, reserved, waiting: reserved ? next : null };
        }
        fs.copyFileSync(lockPath, aside, fs.constants.COPYFILE_EXCL);
        const meta = admissionMeta({ ticket: next, lockPath, lockPaths, cls: next.cls });
        replaceInPlace(lockPath, lockBody(next.pid, `${next.what}, handed over by the queue`, next.cls, meta));
        try { fs.unlinkSync(next.file); } catch { /* its waiter saw the handoff first */ }
        return { released: true, to: next, aside, token: meta.token };
    });
}

/** Removes `pid`'s ticket from each of these lanes' queues. */
function leaveQueues(lockPaths, pid) {
    if (!lockPaths.length) return;
    admitted(lockPaths, () => { for (const lp of lockPaths) removeTicket(queueDirFor(lp), pid); });
}

/**
 * Releases every lane whose lock names `pid`, except `keep`. More than one only
 * after a race: a release that read a queue just before the waiter left it can
 * still hand that lane over. `lockPaths` is every lane, so the harness cap
 * counts the kept one too. Returns one releaseLock result per lane released.
 * With `token`, only a lane carrying that token (and `runId`) is released; a
 * refused one is returned with `fenced`.
 */
function releaseLanes({ lockPaths, pid, staleMs, log, keep = null, runId = null, token = null }) {
    return admitted(lockPaths, () => {
        const out = [];
        for (const lp of lockPaths) {
            if (lp === keep) continue;
            const held = readLock(lp);
            if (held && held.pid === pid) out.push({ lockPath: lp, ...releaseLock({ lockPath: lp, lockPaths, pid, staleMs, log, runId, token }) });
        }
        return out;
    });
}

/**
 * One attempt over every lane. A lane lock that already names `pid` (a queue
 * release handed it over) is held. Otherwise it takes a turn in each lane in
 * order and stops at the first it acquires. Having acquired one, it leaves
 * every other queue and hands on any other lane a racing release gave it, so a
 * waiter never sits on two lanes. Returns { acquired, lockPath, token, runId }
 * or, queued, the lane where it stands best (a lane kept from its class first
 * among equal places, since that is the one that would otherwise be free):
 * { acquired: false, lockPath, position, of, holder, reserved?, lanes }.
 */
function takeAnyLane({ lockPaths, pid, what, cls = PRODUCT, body, staleMs, log, runId = null, repo = null, arrivedMs = null }) {
    return admitted(lockPaths, () => {
        const settle = (lockPath, r) => {
            const others = lockPaths.filter((p) => p !== lockPath);
            leaveQueues(others, pid);
            releaseLanes({ lockPaths, keep: lockPath, pid, staleMs, log });
            const now = readLock(lockPath);
            const m = now && now.meta;
            if (m && m.owner && m.owner.pid === pid && !m.owner.startUtc) {
                // Handed over with the ticket's identity, which has no creation
                // time: record the full one now that this waiter holds the lane.
                const owner = ownerIdentity(pid);
                if (owner && owner.startUtc) replaceInPlace(lockPath, withMeta(now.text, { ...m, owner }));
            }
            const after = readLock(lockPath);
            return { ...r, acquired: true, lockPath, token: after && after.meta ? after.meta.token : null, runId: after && after.meta ? after.meta.runId : null };
        };
        for (const lp of lockPaths) {
            const held = readLock(lp);
            if (namesUs(held, pid, runId)) return settle(lp, { handedOver: true });
        }
        const queued = [];
        for (const lane of lockPaths) {
            const r = takeTurn({ lockPath: lane, lockPaths, pid, what, cls, body, staleMs, log, runId, repo, arrivedMs });
            if (r.acquired) return settle(lane, r);
            queued.push({ ...r, lockPath: lane });
        }
        const best = queued.slice().sort((a, b) => a.position - b.position || Number(Boolean(b.reserved)) - Number(Boolean(a.reserved)))[0];
        return { ...best, lanes: queued };
    });
}

/** One lane, read-only: its holder and its queue in serving order, each with its class. */
function readStatus(lockPath, staleMs, base = lockPath) {
    const queueDir = queueDirFor(lockPath);
    const held = readLock(lockPath);
    const now = Date.now();
    const { tickets, other } = readTickets(queueDir);
    const boot = tickets.some((t) => t.meta && t.meta.bootId) ? bootNow(base) : null;
    const alive = held ? holderAlive(held, base) : null;
    return {
        lockPath,
        queueDir,
        holder: held ? { pid: held.pid, alive, why: holderWhy(held), class: held.cls, what: held.what,
                         malformed: held.malformed || undefined, meta: held.meta || undefined } : null,
        ticketFilesRead: tickets.length,
        otherFiles: other,
        queue: servingOrder(tickets).map((t) => ({
            pid: t.pid, class: t.cls, arrived: t.arrived, heartbeatAgeS: Math.round((now - t.mtimeMs) / 1000),
            alive: isAlive(t.pid), dropReason: deadReason(t, staleMs, now, boot), what: t.what,
            runId: t.meta ? t.meta.runId : undefined,
        })),
    };
}

// ---------------------------------------------------------------------------
// Describing a run on line 2 when --what is not given.
// ---------------------------------------------------------------------------

function git(args) {
    const r = spawnSync('git', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return !r.error && r.status === 0 ? r.stdout.trim() : '';
}

function describe() {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown-branch';
    const head = git(['rev-parse', '--short=7', 'HEAD']) || 'unknown-head';
    const top = git(['rev-parse', '--show-toplevel']) || process.cwd();
    return `npm run gate, branch ${branch}, head ${head}, worktree ${path.basename(top)}, queued ${new Date().toISOString().slice(11, 16)}Z`;
}

// ---------------------------------------------------------------------------
// CLI. process.exitCode, not process.exit(), so piped output drains.
// ---------------------------------------------------------------------------

function help() {
    console.log(`usage: node full-gate-queue.js <take|wait|release|leave|status|lanes> [options]

A ticket queue in front of the machine-wide full-gate lock. Product gates go
first, harness gates after them, first come within each class. Only the
ticket at the front may take a lane's lock, and a release hands the lock
straight to it, so a newcomer cannot jump its class. Harness gates hold at
most lanes - 1 lanes (the one lane, on a one-lane machine), so one lane stays
open to product gates. A running holder is never preempted.

  take     one attempt. Exit 0: --pid holds a lane. Exit 3: queued, place printed.
  wait     take until a lane is held. Exit 0, or 3 when --timeout-ms runs out.
  release  hand each lane --pid holds to the ticket at its front, or rename the
           lock to .released-HHMM when nobody it may go to waits. Exit 1 when
           it holds none.
  leave    remove --pid's ticket from every lane's queue, for a waiter stopped
           from outside whose shell lives on. Never touches a lock. Exit 0 when
           no ticket of --pid is left, 1 when one could not be removed.
  status   every lane's holder and queue in order, read-only. --json for a machine.
  lanes    print the machine's lane count; "lanes N" sets it (1 to ${MAX_LANES}).

  --pid N         the process that runs the gate and outlives it (default: the
                  parent shell). The lock and the ticket name this pid.
  --what TEXT     line 2 of the lock (default: branch, head and worktree).
  --class C       take and wait: product (default) or harness. It can only
                  demote: the class comes from the checkout (--repo), and a
                  checkout of this plugin's repo, or one git cannot name, is
                  a harness gate whatever this says.
  --repo DIR      take and wait: the checkout the gate runs in (default: the
                  working directory).
  --run-id ID     take, wait and release: this run's id, recorded in the
                  ticket and the lock (default: minted, or the ticket's).
  --token N       release only: free a lane only while its lock carries this
                  fencing token (and --run-id), so a late release from an
                  earlier admission frees nothing.
  --timeout-ms N  wait only: give up after N ms and remove the tickets.
  --lanes N       this call only: use N lanes instead of the machine's count.

Lane 1 is the lock; lane k is <name>-k.lock beside it, with its own queue.
A waiter queues in every lane and takes the first it reaches the head of.

When \`npm run gate\` takes the lock itself (tooling/gate-lock.js), run it
alone: it queues through this script. Otherwise, in ONE background script
so the pid lives throughout:
  node full-gate-queue.js wait --pid "$PID" --what "..."
  AUTODEV_GATE_LOCK=0 npm run gate; code=$?
  node full-gate-queue.js release --pid "$PID"

env: AUTODEV_GATE_LOCK_PATH (lane 1; default <home>/.claude/autodev/locks/full-gate.lock),
AUTODEV_GATE_CLASS (product or harness, under --class),
AUTODEV_GATE_LANES (over the lanes file), AUTODEV_GATE_LOCK_POLL_MS (5000),
AUTODEV_GATE_LOCK_REPORT_MS (180000), AUTODEV_GATE_QUEUE_STALE_MS (600000).`);
}

function parseArgs(argv) {
    const out = { cmd: null, arg: null, pid: null, what: null, cls: null, timeoutMs: null, lanes: null, json: false, help: false, bad: null,
                  repo: null, runId: null, token: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') out.help = true;
        else if (a === '--json') out.json = true;
        else if (['--pid', '--what', '--timeout-ms', '--lanes', '--class', '--repo', '--run-id', '--token'].includes(a)) {
            const v = argv[++i];
            if (v === undefined) { out.bad = `${a} needs a value`; break; }
            if (a === '--what') out.what = v;
            else if (a === '--repo') out.repo = v;
            else if (a === '--run-id') {
                if (!/^[A-Za-z0-9._-]{1,120}$/.test(v)) { out.bad = `--run-id needs letters, digits, dot, dash or underscore, got ${v}`; break; }
                out.runId = v;
            } else if (a === '--token') {
                if (!/^\d+$/.test(v)) { out.bad = `--token needs a whole number, got ${v}`; break; }
                out.token = Number(v);
            }
            else if (a === '--class') {
                out.cls = parseClass(v);
                if (out.cls === null) { out.bad = `--class needs product or harness, got ${v}`; break; }
            } else if (a === '--lanes') {
                out.lanes = parseLanes(v);
                if (out.lanes === null) { out.bad = `--lanes needs a whole number from 1 to ${MAX_LANES}, got ${v}`; break; }
            } else if (!/^\d+$/.test(v)) { out.bad = `${a} needs a whole number, got ${v}`; break; }
            else if (a === '--pid') out.pid = Number(v);
            else out.timeoutMs = Number(v);
        } else if (!out.cmd && !a.startsWith('-')) out.cmd = a;
        else if (out.cmd === 'lanes' && out.arg === null && !a.startsWith('-')) out.arg = a;
        else { out.bad = `unknown argument ${a}`; break; }
    }
    return out;
}

function printLane(s, k, count) {
    const label = count > 1 ? `lane ${k}: ` : '';
    console.log(`${label}lock:   ${s.lockPath}`);
    if (!s.holder) console.log(`${label}holder: none, the lock is free`);
    else {
        const state = s.holder.alive === true ? 'alive' : s.holder.alive === false ? 'NOT running' : 'liveness unknown';
        const m = s.holder.meta;
        const run = m ? `, run ${m.runId}, token ${m.token}, arrived ${m.arrival}` : s.holder.malformed ? ', its meta line does not parse' : '';
        console.log(`${label}holder: pid ${s.holder.pid === null ? '(line 1 is not a pid)' : s.holder.pid} (${state}, ${s.holder.class}${run}): ${s.holder.what}`);
        if (s.holder.why) console.log(`${label}judged: ${s.holder.why}`);
    }
    console.log(`${label}queue:  ${s.queue.length} ticket(s) in ${s.queueDir}, in the order they are served` +
        (s.otherFiles ? `, plus ${s.otherFiles} file(s) that are not tickets` : ''));
    s.queue.forEach((t, i) => {
        const note = t.dropReason ? ` [will be dropped: ${t.dropReason}]` : '';
        console.log(`  ${i + 1}. pid ${t.pid}, ${t.class}, arrived ${t.arrived}, heartbeat ${t.heartbeatAgeS} s ago${note}: ${t.what}`);
    });
}

function printStatus(s, json) {
    if (json) { console.log(JSON.stringify(s, null, 2)); return; }
    console.log(`lanes:  ${s.laneCount} (from ${s.laneSource})`);
    console.log(`order:  product gates first, then harness, first come within each. Harness gates hold at most ${s.harnessCap} of ${s.laneCount} lane(s)`);
    for (const n of s.notes) console.log(`note:   ${n}`);
    s.lanes.forEach((lane, i) => printLane(lane, i + 1, s.laneCount));
}

function holderLine(r) {
    if (r.reserved) return `nobody (free, but ${reservedLine(r.reserved)})`;
    return r.holder ? `pid ${r.holder.pid}: ${r.holder.what}` : 'nobody (free, but a ticket ahead goes first)';
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { help(); return; }
    if (args.bad || !['take', 'wait', 'release', 'leave', 'status', 'lanes'].includes(args.cmd)) {
        console.error(`${TAG} ${args.bad || (args.cmd ? `unknown command ${args.cmd}` : 'no command given')}; see --help`);
        process.exitCode = 1;
        return;
    }
    const env = process.env;
    const base = path.resolve(env.AUTODEV_GATE_LOCK_PATH || defaultLockPath());
    const staleMs = Math.max(1000, Number(env.AUTODEV_GATE_QUEUE_STALE_MS) || 600000);
    const pollMs = Math.max(50, Number(env.AUTODEV_GATE_LOCK_POLL_MS) || 5000);
    const reportMs = Math.max(0, Number(env.AUTODEV_GATE_LOCK_REPORT_MS) || 180000);
    const log = (line) => console.log(line);

    if (args.cmd === 'lanes') {
        const file = lanesFileFor(base);
        if (args.arg !== null) {
            const n = parseLanes(args.arg);
            if (n === null) { console.error(`${TAG} lanes needs a whole number from 1 to ${MAX_LANES}, got ${args.arg}`); process.exitCode = 1; return; }
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, `${n}\n`);
            log(`${TAG} ${n} lane(s) on this machine, written to ${file}`);
            return;
        }
        const lc = laneCount(base, env, null);
        log(`${TAG} ${lc.count} lane(s), from ${lc.source}`);
        for (const n of lc.notes) log(`${TAG} note: ${n}`);
        return;
    }

    const lanes = laneCount(base, env, args.lanes);
    const lockPaths = lanePaths(base, lanes.count);
    const inLane = (lp) => (lanes.count > 1 ? ` (lane ${lockPaths.indexOf(lp) + 1} of ${lanes.count})` : '');

    if (args.cmd === 'status') {
        printStatus({ laneCount: lanes.count, laneSource: lanes.source, harnessCap: harnessCap(lanes.count), notes: lanes.notes,
                      lanes: lockPaths.map((lp) => readStatus(lp, staleMs, base)) }, args.json);
        return;
    }

    if (args.cmd === 'leave') {
        // Before the liveness check: a dead waiter's ticket is one leave exists to remove.
        const leaving = args.pid === null ? process.ppid : args.pid;
        const count = () => lockPaths.map((lp) => readTickets(queueDirFor(lp)).tickets.filter((t) => t.pid === leaving).length);
        const before = count();
        leaveQueues(lockPaths, leaving);
        const after = count();
        const sum = (a) => a.reduce((x, y) => x + y, 0);
        const removed = sum(before) - sum(after);
        log(removed
            ? `${TAG} removed ${removed} ticket(s) of pid ${leaving} from ${before.filter((n) => n).length} of ${lockPaths.length} lane(s)`
            : `${TAG} pid ${leaving} had no ticket in any of ${lockPaths.length} lane(s); nothing to remove`);
        lockPaths.forEach((lp) => {
            const held = readLock(lp);
            if (held && held.pid === leaving) log(`${TAG} note: pid ${leaving} still holds ${lp}${inLane(lp)}. leave never releases a lock: run release --pid ${leaving}`);
        });
        if (removed && isAlive(leaving) !== false) log(`${TAG} note: pid ${leaving} is running. A wait still running for it takes a new ticket, at the back, on its next poll`);
        if (sum(after)) {
            console.error(`${TAG} ${sum(after)} ticket(s) of pid ${leaving} could not be removed`);
            process.exitCode = 1;
        }
        return;
    }

    const pid = args.pid === null ? process.ppid : args.pid;
    if (isAlive(pid) === false) {
        console.error(`${TAG} pid ${pid} is not running, so it cannot hold or wait for the lock`);
        process.exitCode = 1;
        return;
    }

    if (args.cmd === 'release') {
        const held = releaseLanes({ lockPaths, pid, staleMs, log, runId: args.runId, token: args.token });
        if (!held.length) {
            // Nothing names this pid: report why from lane 1, as a single-lane release would.
            console.error(`${TAG} ${releaseLock({ lockPath: base, lockPaths, pid, staleMs, log }).why}`);
            process.exitCode = 1;
            return;
        }
        for (const r of held) {
            if (r.fenced) { console.error(`${TAG} not released${inLane(r.lockPath)}: ${r.why}`); process.exitCode = 1; continue; }
            if (r.to) log(`${TAG} released${inLane(r.lockPath)}; the lock was handed to ${r.to.cls} pid ${r.to.pid}, queued since ${r.to.arrived} (record ${path.basename(r.aside)})`);
            else if (r.reserved) log(`${TAG} released${inLane(r.lockPath)} to ${path.basename(r.aside)} and not handed to harness pid ${r.waiting.pid}, because the lane is ${reservedLine(r.reserved)}`);
            else log(`${TAG} released${inLane(r.lockPath)} to ${path.basename(r.aside)}; nobody was queued`);
        }
        return;
    }

    const what = args.what || describe();
    const declared = gateClass(env, args.cls);
    if (declared.note) log(`${TAG} note: ${declared.note}`);
    // --repo names the checkout the gate is for, but cannot vouch for the
    // caller: a harness checkout that runs the CLI stays harness whatever
    // product it names. The caller's own directory counts when git can name it.
    let repo = ident.repoIdentity(path.resolve(args.repo || process.cwd()));
    if (args.repo && !repo.harness) {
        const caller = ident.repoIdentity(process.cwd());
        if (caller.resolved && caller.harness) repo = { ...caller, why: `the caller's checkout is the harness (${caller.why}), whatever --repo names` };
    }
    const cls = repo.harness ? HARNESS : declared.cls;
    if (repo.harness && declared.cls === PRODUCT) log(`${TAG} note: queued as harness, not product: ${repo.why}`);
    const repoMeta = { worktree: repo.worktree, commonDir: repo.commonDir, origin: repo.origin, derivedClass: repo.harness ? HARNESS : PRODUCT };
    const attempt = () => { resetProbes(); return takeAnyLane({ lockPaths, pid, what, cls, staleMs, log, runId: args.runId, repo: repoMeta }); };

    if (args.cmd === 'take') {
        const r = attempt();
        if (r.acquired) { log(`${TAG} pid ${pid} holds ${r.lockPath}${r.token ? ` (run ${r.runId}, token ${r.token})` : ''}`); return; }
        log(`${TAG} queued: place ${r.position} of ${r.of}${inLane(r.lockPath)} as ${cls}. Holder: ${holderLine(r)}`);
        process.exitCode = EXIT_QUEUED;
        return;
    }

    // wait
    const started = Date.now();
    let lastKey = null;
    let lastReport = 0;
    let stopped = null;
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { stopped = s; });
    let errors = 0;
    for (;;) {
        let r;
        try {
            r = attempt();
            errors = 0;
        } catch (e) {
            // Windows refuses a read while another process renames the file
            // (EPERM, EBUSY). One failed poll must not cost the waiter its place,
            // so it retries; only a run of failures gives the ticket up.
            errors++;
            log(`${TAG} poll failed (${e.code || e.message}), attempt ${errors} of ${MAX_POLL_ERRORS}`);
            if (errors >= MAX_POLL_ERRORS) {
                try { leaveQueues(lockPaths, pid); } catch { /* the heartbeat expires them anyway */ }
                console.error(`${TAG} gave up after ${errors} failed polls; lock NOT taken`);
                process.exitCode = 1;
                return;
            }
            await new Promise((res) => setTimeout(res, pollMs));
            continue;
        }
        if (r.acquired) {
            log(`${TAG} pid ${pid} holds ${r.lockPath} after ${Math.round((Date.now() - started) / 1000)} s${r.token ? ` (run ${r.runId}, token ${r.token})` : ''}`);
            return;
        }
        const key = `${r.lockPath}/${r.position}/${r.of}/${r.holder ? r.holder.pid : '-'}/${r.reserved ? 'reserved' : ''}`;
        if (key !== lastKey || Date.now() - lastReport >= reportMs) {
            log(`${TAG} waiting: place ${r.position} of ${r.of}${inLane(r.lockPath)} as ${cls}. Holder: ${holderLine(r)}`);
            lastKey = key;
            lastReport = Date.now();
        }
        const timedOut = args.timeoutMs !== null && Date.now() - started >= args.timeoutMs;
        if (stopped || timedOut) {
            leaveQueues(lockPaths, pid);
            log(`${TAG} gave up (${stopped || `--timeout-ms ${args.timeoutMs}`}); ticket removed, lock NOT taken`);
            process.exitCode = stopped ? 2 : EXIT_QUEUED;
            return;
        }
        await new Promise((res) => setTimeout(res, pollMs));
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(`${TAG} ${e && e.stack ? e.stack : e}`);
        process.exitCode = 1;
    });
}

/**
 * After a take, the caller confirms the lock is its own run's before starting
 * anything: { ok, meta, adopted, why }. A lock naming `pid` with no meta line
 * (written by an older version on its behalf) is adopted: given a token and
 * the caller's identity. A lock carrying another run id, or a meta line that
 * does not parse, is not the caller's, and nothing may start under it.
 */
function confirmOwnership({ lockPath, lockPaths = [lockPath], pid, runId }) {
    return admitted(lockPaths, () => {
        const now = readLock(lockPath);
        if (!now || now.pid !== pid) return { ok: false, why: now ? `the lock names pid ${now.pid}, not ${pid}` : 'the lock is gone' };
        if (now.malformed) return { ok: false, why: 'the lock\'s meta line does not parse' };
        if (now.meta) {
            if (now.meta.runId === runId && Number.isInteger(now.meta.token)) return { ok: true, meta: now.meta, adopted: false };
            return { ok: false, why: `the lock carries run ${now.meta.runId} token ${now.meta.token}, not run ${runId}` };
        }
        const meta = { runId, token: records.mintToken(lockPaths[0]), lane: lockPaths.indexOf(lockPath) + 1, admittedUtc: new Date().toISOString(),
                       arrival: null, cls: now.cls, owner: ownerIdentity(pid), repo: null };
        replaceInPlace(lockPath, withMeta(now.text, meta));
        return { ok: true, meta, adopted: true };
    });
}

/**
 * Readers for other tools (the build-output reaper): every lane's lock with its
 * judged liveness, and every lane's tickets, both read-only. `base` is lane 1.
 */
function readLaneLocks(base, env = process.env) {
    return lanePaths(base, laneCount(base, env, null).count).map((lockPath, i) => {
        let lock = null;
        let unreadable = null;
        try { lock = readLock(lockPath); } catch (e) { unreadable = e.code || e.message; }
        return { lane: i + 1, lockPath, lock, unreadable, alive: lock ? holderAlive(lock, base) : null, why: lock ? holderWhy(lock) : null };
    });
}

function readLaneTickets(base, env = process.env) {
    return lanePaths(base, laneCount(base, env, null).count).map((lockPath, i) => ({ lane: i + 1, lockPath, tickets: readTickets(queueDirFor(lockPath)).tickets }));
}

/** The lease key and record for a worktree directory. */
function leaseFor(base, dir) {
    const key = ident.pathKey(ident.canonicalPath(dir));
    return { key, ...records.readLease(base, key) };
}

module.exports = {
    takeTurn, takeAnyLane, releaseLock, releaseLanes, leaveQueues, readStatus, readLock, resetProbes,
    queueDirFor, lanePath, lanePaths, lanesFileFor, laneCount, defaultLockPath, isAlive, parseArgs,
    reservedLine, HARNESS, PRODUCT, holderAlive, holderWhy, admitted, bootNow, confirmOwnership,
    readLaneLocks, readLaneTickets, leaseFor, readLeases: records.readLeases, withWorktreeMutex: records.withWorktreeMutex,
};
