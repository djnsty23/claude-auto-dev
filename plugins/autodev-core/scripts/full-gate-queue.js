#!/usr/bin/env node
/**
 * full-gate-queue.js - a first-come ticket queue in front of the machine-wide
 * full-gate lock.
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
 *   20260926T132800123Z-0000073024.ticket   line 1 pid, line 2 what, line 3 arrival
 * Three rules make it first-come:
 *   1. Only the OLDEST LIVE ticket may take the lock. A newcomer that polls
 *      first after a release finds itself behind an older ticket and waits.
 *   2. A release HANDS the lock to the oldest live ticket. The lock is copied
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
 *   node full-gate-queue.js take    [--pid N] [--what TEXT]   one attempt: 0 holds the lock, 3 queued
 *   node full-gate-queue.js wait    [--pid N] [--what TEXT] [--timeout-ms N]   blocks until 0
 *   node full-gate-queue.js release [--pid N]                 0 released or handed over, 1 not ours
 *   node full-gate-queue.js status  [--json]                  read-only
 *   node full-gate-queue.js --help
 *
 * ENVIRONMENT (the lock variables are shared with the gate wrapper, so both
 * always name the same file):
 *   AUTODEV_GATE_LOCK_PATH=FILE        the lock (default <home>/.claude/autodev/locks/full-gate.lock)
 *   AUTODEV_GATE_LOCK_POLL_MS=N        wait's poll interval (default 5000)
 *   AUTODEV_GATE_LOCK_REPORT_MS=N      how often wait re-prints its place (default 180000)
 *   AUTODEV_GATE_QUEUE_STALE_MS=N      heartbeat age at which a ticket is dropped (default 600000)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TAG = 'full-gate-queue:';
const EXIT_QUEUED = 3;
const TICKET_RE = /^(\d{8}T\d{9}Z)-(\d{10})\.ticket$/;

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
    return { text, pid, what: (lines[1] || '').trim() || '(no description on line 2)' };
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
    msysPids = undefined;
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
                       what: (lines[1] || '').trim() || '(no description)' });
    }
    return { tickets, other };
}

/** Why a ticket no longer counts, or null when it does. */
function deadReason(t, staleMs, now) {
    if (isAlive(t.pid) === false) return `pid ${t.pid} is not running`;
    if (now - t.mtimeMs > staleMs) return `no heartbeat for ${Math.round((now - t.mtimeMs) / 1000)} s`;
    return null;
}

/** The queue with dead tickets removed from disk, oldest first. */
function liveQueue(queueDir, staleMs, log) {
    const now = Date.now();
    const live = [];
    for (const t of readTickets(queueDir).tickets) {
        const why = deadReason(t, staleMs, now);
        if (!why) { live.push(t); continue; }
        try { fs.unlinkSync(t.file); log(`${TAG} dropped the ticket of pid ${t.pid} (${why}); it said: ${t.what}`); } catch { /* another waiter dropped it first */ }
    }
    return live;
}

/** This pid's ticket, created on first call, heartbeat touched on every later one. */
function ensureTicket(queueDir, pid, what) {
    fs.mkdirSync(queueDir, { recursive: true });
    const own = readTickets(queueDir).tickets.find((t) => t.pid === pid);
    if (own) {
        const now = new Date();
        try { fs.utimesSync(own.file, now, now); return own.file; } catch { /* dropped under us: take a new place */ }
    }
    const d = new Date();
    const file = path.join(queueDir, `${stamp(d)}-${String(pid).padStart(10, '0')}.ticket`);
    tryCreate(file, `${pid}\n${what}\n${d.toISOString()}\n`);
    return file;
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

function takeOverStale(lockPath, judged, body, log) {
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
        if (now.text !== judged.text || isAlive(now.pid) !== false) return false;
        const aside = asideName(lockPath, 'stale');
        fs.renameSync(lockPath, aside);
        log(`${TAG} holder pid ${now.pid} is not running; moved its lock aside to ${path.basename(aside)} (it said: ${now.what})`);
        return tryCreate(lockPath, body);
    } finally {
        try { fs.unlinkSync(mutex); } catch { /* already gone */ }
    }
}

function lockBody(pid, what) {
    return `${pid}\n${what}, lock taken ${new Date().toISOString().slice(11, 16)}Z\n`;
}

/**
 * One attempt. Returns { acquired: true } once the lock names `pid`, else
 * { acquired: false, position, of, holder }. The one rule that makes the queue
 * first-come is the head check below: a ticket that is not the oldest live one
 * never touches the lock, however free it is.
 */
function takeTurn({ lockPath, pid, what, staleMs, log }) {
    const queueDir = queueDirFor(lockPath);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const held = readLock(lockPath);
    if (held && held.pid === pid) {
        removeTicket(queueDir, pid);
        return { acquired: true, handedOver: true };
    }
    ensureTicket(queueDir, pid, what);
    const live = liveQueue(queueDir, staleMs, log);
    const mine = live.findIndex((t) => t.pid === pid);
    const queued = (holder) => ({ acquired: false, position: mine + 1, of: live.length, holder });
    if (mine !== 0) return queued(held);
    const body = lockBody(pid, what);
    let got = false;
    if (!held) got = tryCreate(lockPath, body);
    else if (held.pid !== null && isAlive(held.pid) === false) got = takeOverStale(lockPath, held, body, log);
    if (!got) return queued(readLock(lockPath));
    removeTicket(queueDir, pid);
    return { acquired: true, handedOver: false };
}

/**
 * Releases a lock `pid` holds. Hands it to the oldest live ticket when there is
 * one; otherwise renames it to `.released-HHMM` as the hand-written convention
 * does. Returns { released, to, aside, why }.
 */
function releaseLock({ lockPath, pid, staleMs, log }) {
    const held = readLock(lockPath);
    if (!held) return { released: false, why: `no lock at ${lockPath}; nothing to release` };
    if (held.pid !== pid) {
        return { released: false, why: `the lock names pid ${held.pid}, not ${pid}; left untouched (it says: ${held.what})` };
    }
    const queueDir = queueDirFor(lockPath);
    const live = liveQueue(queueDir, staleMs, log).filter((t) => t.pid !== pid);
    const aside = asideName(lockPath, 'released');
    const next = live[0];
    if (!next) {
        fs.renameSync(lockPath, aside);
        return { released: true, to: null, aside };
    }
    fs.copyFileSync(lockPath, aside, fs.constants.COPYFILE_EXCL);
    replaceInPlace(lockPath, lockBody(next.pid, `${next.what}, handed over by the queue`));
    try { fs.unlinkSync(next.file); } catch { /* its waiter saw the handoff first */ }
    return { released: true, to: next, aside };
}

function readStatus(lockPath, staleMs) {
    const queueDir = queueDirFor(lockPath);
    const held = readLock(lockPath);
    const now = Date.now();
    const { tickets, other } = readTickets(queueDir);
    return {
        lockPath,
        queueDir,
        holder: held ? { pid: held.pid, alive: held.pid === null ? null : isAlive(held.pid), what: held.what } : null,
        ticketFilesRead: tickets.length,
        otherFiles: other,
        queue: tickets.map((t) => ({
            pid: t.pid, arrived: t.arrived, heartbeatAgeS: Math.round((now - t.mtimeMs) / 1000),
            alive: isAlive(t.pid), dropReason: deadReason(t, staleMs, now), what: t.what,
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
    console.log(`usage: node full-gate-queue.js <take|wait|release|status> [options]

A first-come ticket queue in front of the machine-wide full-gate lock.
Only the oldest live ticket may take the lock, and a release hands the lock
straight to it, so a newcomer cannot jump the queue.

  take     one attempt. Exit 0: --pid holds the lock. Exit 3: queued, place printed.
  wait     take until the lock is held. Exit 0, or 3 when --timeout-ms runs out.
  release  hand the lock to the oldest live ticket, or rename it to
           .released-HHMM when nobody waits. Exit 1 when --pid does not hold it.
  status   the holder and the queue in order, read-only. --json for a machine.

  --pid N         the process that runs the gate and outlives it (default: the
                  parent shell). The lock and the ticket name this pid.
  --what TEXT     line 2 of the lock (default: branch, head and worktree).
  --timeout-ms N  wait only: give up after N ms and remove the ticket.

Typical use, all in ONE background script so the pid lives throughout:
  node full-gate-queue.js wait --pid "$PID" --what "..."
  AUTODEV_GATE_LOCK=0 npm run gate; code=$?
  node full-gate-queue.js release --pid "$PID"

env: AUTODEV_GATE_LOCK_PATH (default <home>/.claude/autodev/locks/full-gate.lock),
AUTODEV_GATE_LOCK_POLL_MS (5000), AUTODEV_GATE_LOCK_REPORT_MS (180000),
AUTODEV_GATE_QUEUE_STALE_MS (600000).`);
}

function parseArgs(argv) {
    const out = { cmd: null, pid: null, what: null, timeoutMs: null, json: false, help: false, bad: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') out.help = true;
        else if (a === '--json') out.json = true;
        else if (a === '--pid' || a === '--what' || a === '--timeout-ms') {
            const v = argv[++i];
            if (v === undefined) { out.bad = `${a} needs a value`; break; }
            if (a === '--what') out.what = v;
            else if (!/^\d+$/.test(v)) { out.bad = `${a} needs a whole number, got ${v}`; break; }
            else if (a === '--pid') out.pid = Number(v);
            else out.timeoutMs = Number(v);
        } else if (!out.cmd && !a.startsWith('-')) out.cmd = a;
        else { out.bad = `unknown argument ${a}`; break; }
    }
    return out;
}

function printStatus(s, json) {
    if (json) { console.log(JSON.stringify(s, null, 2)); return; }
    console.log(`lock:   ${s.lockPath}`);
    if (!s.holder) console.log('holder: none, the lock is free');
    else {
        const state = s.holder.alive === true ? 'alive' : s.holder.alive === false ? 'NOT running' : 'liveness unknown';
        console.log(`holder: pid ${s.holder.pid === null ? '(line 1 is not a pid)' : s.holder.pid} (${state}): ${s.holder.what}`);
    }
    console.log(`queue:  ${s.queue.length} ticket(s) in ${s.queueDir}` +
        (s.otherFiles ? `, plus ${s.otherFiles} file(s) that are not tickets` : ''));
    s.queue.forEach((t, i) => {
        const note = t.dropReason ? ` [will be dropped: ${t.dropReason}]` : '';
        console.log(`  ${i + 1}. pid ${t.pid}, arrived ${t.arrived}, heartbeat ${t.heartbeatAgeS} s ago${note}: ${t.what}`);
    });
}

function holderLine(h) {
    return h ? `pid ${h.pid}: ${h.what}` : 'nobody (free, but an older ticket goes first)';
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { help(); return; }
    if (args.bad || !['take', 'wait', 'release', 'status'].includes(args.cmd)) {
        console.error(`${TAG} ${args.bad || (args.cmd ? `unknown command ${args.cmd}` : 'no command given')}; see --help`);
        process.exitCode = 1;
        return;
    }
    const env = process.env;
    const lockPath = path.resolve(env.AUTODEV_GATE_LOCK_PATH || defaultLockPath());
    const staleMs = Math.max(1000, Number(env.AUTODEV_GATE_QUEUE_STALE_MS) || 600000);
    const pollMs = Math.max(50, Number(env.AUTODEV_GATE_LOCK_POLL_MS) || 5000);
    const reportMs = Math.max(0, Number(env.AUTODEV_GATE_LOCK_REPORT_MS) || 180000);
    const log = (line) => console.log(line);

    if (args.cmd === 'status') { printStatus(readStatus(lockPath, staleMs), args.json); return; }

    const pid = args.pid === null ? process.ppid : args.pid;
    if (isAlive(pid) === false) {
        console.error(`${TAG} pid ${pid} is not running, so it cannot hold or wait for the lock`);
        process.exitCode = 1;
        return;
    }

    if (args.cmd === 'release') {
        const r = releaseLock({ lockPath, pid, staleMs, log });
        if (!r.released) { console.error(`${TAG} ${r.why}`); process.exitCode = 1; return; }
        log(r.to
            ? `${TAG} released; the lock was handed to pid ${r.to.pid}, queued since ${r.to.arrived} (record ${path.basename(r.aside)})`
            : `${TAG} released to ${path.basename(r.aside)}; nobody was queued`);
        return;
    }

    const what = args.what || describe();
    const attempt = () => { resetProbes(); return takeTurn({ lockPath, pid, what, staleMs, log }); };

    if (args.cmd === 'take') {
        const r = attempt();
        if (r.acquired) { log(`${TAG} pid ${pid} holds ${lockPath}`); return; }
        log(`${TAG} queued: place ${r.position} of ${r.of}. Holder: ${holderLine(r.holder)}`);
        process.exitCode = EXIT_QUEUED;
        return;
    }

    // wait
    const started = Date.now();
    let lastKey = null;
    let lastReport = 0;
    let stopped = null;
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { stopped = s; });
    for (;;) {
        const r = attempt();
        if (r.acquired) {
            log(`${TAG} pid ${pid} holds ${lockPath} after ${Math.round((Date.now() - started) / 1000)} s`);
            return;
        }
        const key = `${r.position}/${r.of}/${r.holder ? r.holder.pid : '-'}`;
        if (key !== lastKey || Date.now() - lastReport >= reportMs) {
            log(`${TAG} waiting: place ${r.position} of ${r.of}. Holder: ${holderLine(r.holder)}`);
            lastKey = key;
            lastReport = Date.now();
        }
        const timedOut = args.timeoutMs !== null && Date.now() - started >= args.timeoutMs;
        if (stopped || timedOut) {
            removeTicket(queueDirFor(lockPath), pid);
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

module.exports = { takeTurn, releaseLock, readStatus, queueDirFor, defaultLockPath, isAlive, parseArgs };
