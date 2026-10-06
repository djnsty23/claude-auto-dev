#!/usr/bin/env node
/**
 * gate-lock.js - `npm run gate` takes the machine's full-gate lock itself.
 *
 * WHY. Many sessions share one machine and each runs the full gate (three full
 * suite passes, about 50 minutes) from its own worktree. A convention lock file
 * existed, written by hand, and only sessions briefed about it honoured it.
 * `[measured 2026-09-25]` five full gates ran at once beside the lock holder.
 * Concurrent gates make an ETIMEDOUT red meaningless and slow every run, so the
 * convention is now mechanism: `scripts.gate` runs this script, and this script
 * runs the chain in `scripts["gate:chain"]` while holding the lock.
 *
 * THE FILE FORMAT is the one sessions already write by hand, so a hand-written
 * lock and this script's lock exclude each other:
 *   line 1  the holder's pid (a Windows pid or an MSYS/Git-Bash pid)
 *   line 2  what is running and where
 *   release renames the file to `full-gate.lock.released-HHMM` (UTC).
 *
 * WHAT IT DOES. The lock is taken through autodev-core's full-gate-queue.js,
 * the same queue `full-gate-queue.js wait` uses, so a newcomer running
 * `npm run gate` never jumps a session already waiting. It queues as a HARNESS
 * gate: this repo's gate holds a lane for about an hour and a half, so it
 * waits behind every product gate and never takes the last lane open to them
 * (CLASSES in full-gate-queue.js). Its lock says `class harness` on line 3.
 *   1. Takes a ticket in the queue beside the lock, in every lane when the
 *      machine has more than one, and takes the first lane it heads while that
 *      lane is free (an atomic `wx` create).
 *   2. While a LIVE holder or an earlier ticket is ahead, waits, printing the
 *      holder's line 2 when it starts waiting and every few minutes after.
 *   3. If the holder is DEAD, renames the lock aside to `.stale-HHMM`, says so
 *      on one line, and acquires. It never deletes a lock and never kills a
 *      process. A holder it cannot judge (no pid on line 1, or no liveness
 *      probe could answer) is treated as alive: waiting is recoverable by hand,
 *      stealing a live gate's lock is not.
 *   4. Runs `npm run gate:chain`, then releases, whatever the outcome: to the
 *      next ticket when one waits, else by rename to `.released-HHMM`.
 *
 * EXIT STATUS. The chain's own exit code, exactly: 0, 1 and 2 stay three
 * states. A chain this script did not see finish (killed by a signal, a null
 * exit code, a spawn error, or this script interrupted) exits 2, INDETERMINATE,
 * never 0. One final line names the verdict and whether the chain finished.
 * `[measured 2026-09-25]` a Git Bash wrapper around a gate killed with
 * `taskkill /F /T` recorded `$?` as 0, so a killed chain read back as green.
 * On Windows a forced kill leaves exit code 1 and no signal, which reads
 * exactly like a red chain, so npm runs under a runner (this file with
 * --run-chain) that records npm's exit code in a temp sentinel only when it saw
 * npm exit. A runner killed mid-chain leaves no record, and that exits 2.
 *
 * WHY THE CHAIN MOVED to `scripts["gate:chain"]`. `npm run gate` has to take
 * the lock, so `scripts.gate` has to be this script. The lock cannot live
 * inside the chain: `&&` stops at a red step, so a release step at the end
 * would never run on red, and npm's `postgate` does not run on failure either.
 * `gate-fast.js` and `check-claude-md.js` read the chain through
 * `readGateChain()` below, so there is one definition of where it lives.
 *
 *   node tooling/gate-lock.js               # what `npm run gate` runs
 *   node tooling/gate-lock.js --root DIR    # run another tree's gate:chain
 *   node tooling/gate-lock.js --help
 *
 * ENVIRONMENT.
 *   AUTODEV_GATE_LOCK=0             skip the lock (CI, a one-session machine)
 *   AUTODEV_GATE_LOCK_PATH=FILE     lane 1's lock file (default <home>/.claude/autodev/locks/full-gate.lock)
 *   AUTODEV_GATE_LANES=N            lanes to wait on; else the `full-gate.lanes` file beside it, else 1
 *   AUTODEV_GATE_LOCK_POLL_MS=N     how often a waiter re-checks (default 5000)
 *   AUTODEV_GATE_LOCK_REPORT_MS=N   how often a waiter re-prints the holder (default 180000)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CHAIN_SCRIPT = 'gate:chain';
const TAG = 'gate-lock:';

// ---------------------------------------------------------------------------
// Where the chain lives. The one definition; gate-fast.js and
// check-claude-md.js import it.
// ---------------------------------------------------------------------------

/**
 * The gate chain string from a parsed package.json: `scripts["gate:chain"]`
 * when present, else `scripts.gate` (a tree that has no wrapper). Null when
 * neither is a string. A tree whose `gate` is the wrapper and whose chain was
 * removed yields the wrapper command as a one-step chain, which both readers
 * report loudly rather than passing.
 */
function readGateChain(pkg) {
    const s = pkg && pkg.scripts;
    if (!s || typeof s !== 'object') return null;
    if (typeof s[CHAIN_SCRIPT] === 'string') return s[CHAIN_SCRIPT];
    if (typeof s.gate === 'string') return s.gate;
    return null;
}

// ---------------------------------------------------------------------------
// The lock, through the machine's queue. autodev-core's full-gate-queue.js
// owns the lock format, the ticket queue beside it, lanes, liveness and stale
// takeover, so this wrapper and a `full-gate-queue.js wait` take turns in one
// first-come order. Before the queue this wrapper polled the lock itself, and
// whoever polled first after a release won, whatever its place.
// ---------------------------------------------------------------------------

const SCRIPTS = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const queue = require(path.join(SCRIPTS, 'full-gate-queue.js'));
const ident = require(path.join(SCRIPTS, 'gate-identity.js'));
const records = require(path.join(SCRIPTS, 'gate-records.js'));
const recovery = require('./gate-recovery.js');
const gateSteps = require('./gate-steps.js');

const STALE_MS = 600000;
const MAX_POLL_ERRORS = 10;
const GATE_CLASS = queue.HARNESS;

function lockDisabled(env) {
    const v = String(env.AUTODEV_GATE_LOCK || '').trim().toLowerCase();
    return v === '0' || v === 'off' || v === 'false' || v === 'no';
}

/** Why a queued waiter cannot go yet, for the waiting line. */
function whyWaiting(r) {
    const h = r.holder;
    const ahead = r.position - 1;
    const behind = ahead > 0 ? ` (place ${r.position} of ${r.of} in its queue)` : '';
    if (r.reserved) return `free, but ${queue.reservedLine(r.reserved)}`;
    if (!h) return `free, but ${ahead} waiter(s) go first${behind}`;
    if (h.pid === null) {
        return `line 1 is not a pid, so its holder cannot be checked; move it aside by hand if nobody holds it${behind}`;
    }
    const alive = h.meta || h.malformed ? queue.holderAlive(h, r.lockPath) : queue.isAlive(h.pid);
    return (alive === null
        ? `cannot tell whether pid ${h.pid} is alive (${queue.holderWhy(h) || 'no liveness probe answered'})`
        : `held by live pid ${h.pid}`) + behind;
}

/**
 * Resolves the lane lock once it names this process, or null if stopped while
 * waiting. Each poll takes a turn in every lane's queue (`takeAnyLane`), which
 * also refreshes this process's tickets. A transient filesystem error is
 * retried; MAX_POLL_ERRORS in a row reject.
 */
function acquire(lockPaths, body, what, opts) {
    const { pollMs, reportMs, log, isStopped, runId, arrivedMs = null } = opts;
    const pid = process.pid;
    let lastReport = 0;
    let lastSeen = null;
    let errors = 0;
    return new Promise((resolve, reject) => {
        const attempt = () => {
            if (isStopped()) { queue.leaveQueues(lockPaths, pid); resolve(null); return; }
            try {
                queue.resetProbes();
                const r = queue.takeAnyLane({ lockPaths, pid, what, cls: GATE_CLASS, body, staleMs: STALE_MS, log, runId, arrivedMs });
                errors = 0;
                if (r.acquired) { resolve(r.lockPath); return; }
                const seen = `${r.lockPath}|${r.position}|${r.holder ? r.holder.text : ''}|${r.reserved ? 'reserved' : ''}`;
                const now = Date.now();
                if (seen !== lastSeen || now - lastReport >= reportMs) {
                    const says = r.holder ? r.holder.what : '(no lock)';
                    log(`${TAG} waiting for ${r.lockPath}: ${whyWaiting({ ...r, lockPath: lockPaths[0] })}. Holder says: ${says}`);
                    lastReport = now;
                    lastSeen = seen;
                }
            } catch (e) {
                errors++;
                log(`${TAG} queue poll failed (${e.code || e.message}), attempt ${errors} of ${MAX_POLL_ERRORS}`);
                if (errors >= MAX_POLL_ERRORS) { queue.leaveQueues(lockPaths, pid); reject(e); return; }
            }
            setTimeout(attempt, pollMs);
        };
        attempt();
    });
}

/**
 * Releases every lane that names this process and carries `token`: to the
 * next queued waiter when there is one, else by rename to `.released-HHMM`.
 * Touches nothing not ours, and nothing a later admission owns.
 */
function release(lockPaths, log, { quiet = false, runId = null, token = null } = {}) {
    queue.resetProbes();
    const done = queue.releaseLanes({ lockPaths, pid: process.pid, staleMs: STALE_MS, log, runId, token });
    for (const r of done) {
        if (r.fenced) log(`${TAG} lock NOT released: ${r.why}`);
        else if (r.to) log(`${TAG} lock handed to queued pid ${r.to.pid} (${r.to.what}); record kept as ${path.basename(r.aside)}`);
        else log(`${TAG} lock released to ${path.basename(r.aside)}${r.reserved ? ` and not handed to harness pid ${r.waiting.pid}, because the lane is ${queue.reservedLine(r.reserved)}` : ''}`);
    }
    if (!done.length && !quiet) {
        const held = queue.readLock(lockPaths[0]);
        if (!held) log(`${TAG} lock already gone at release; nothing renamed`);
        else log(`${TAG} the lock now names pid ${held.pid}, not this process (${process.pid}); left it untouched`);
    }
    return stillOurs(lockPaths, runId, token) === null;
}

/** The first lane whose lock still names this process with `runId` and `token`, or null. */
function stillOurs(lockPaths, runId, token) {
    for (const lp of lockPaths) {
        let held = null;
        try { held = queue.readLock(lp); } catch { return lp; }
        if (held && held.pid === process.pid && (!held.meta || (held.meta.runId === runId && (token === null || held.meta.token === token)))) return lp;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Describing this run on line 2.
// ---------------------------------------------------------------------------

function git(root, args) {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return !r.error && r.status === 0 ? r.stdout.trim() : '';
}

function describe(root) {
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown-branch';
    const head = git(root, ['rev-parse', '--short=7', 'HEAD']) || 'unknown-head';
    const top = git(root, ['rev-parse', '--show-toplevel']) || root;
    const started = new Date().toISOString().slice(0, 16) + 'Z';
    return `npm run gate (gate-lock.js), branch ${branch}, head ${head}, worktree ${path.basename(top)}, started ${started}`;
}

// ---------------------------------------------------------------------------
// The verdict. Only a numeric exit code with no signal counts as finished.
// ---------------------------------------------------------------------------

/**
 * `recorded` is the runner's sentinel: npm's exit code, written only when the
 * runner saw npm exit. `undefined` means the caller had no runner (unit use),
 * `null` means the runner left no record, so it did not see the chain end.
 */
function verdict({ code, signal, interrupted, spawnError, recorded }) {
    if (spawnError) return { exit: 2, finished: false, why: `the chain could not run: ${spawnError}` };
    if (interrupted) return { exit: 2, finished: false, why: `gate-lock was interrupted by ${interrupted}` };
    if (signal) return { exit: 2, finished: false, why: `the chain was killed by ${signal}` };
    if (code === null || code === undefined) return { exit: 2, finished: false, why: 'the chain exited with no exit code' };
    if (recorded === null) {
        return { exit: 2, finished: false,
                 why: `the chain runner exited ${code} without recording npm's exit (killed, e.g. taskkill /F)` };
    }
    if (recorded !== undefined && recorded !== code) {
        return { exit: 2, finished: false, why: `npm exited ${recorded} but the chain runner exited ${code}` };
    }
    return { exit: code, finished: true, why: `the chain exited ${code}` };
}

/**
 * The runner's record of one attempt, or null when absent, malformed, or
 * written for another run or token. Removes our own temp file.
 */
function readSentinel(file, runId, token) {
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
    try { fs.unlinkSync(file); } catch { /* temp file, best effort */ }
    let rec;
    try { rec = JSON.parse(text); } catch { return null; }
    if (!rec || typeof rec !== 'object' || !Number.isInteger(rec.exit) || rec.runId !== runId || rec.token !== token) return null;
    return rec;
}

/**
 * Runner mode: run the gate chain one step at a time (gate-steps.js), pass its
 * output through while scanning it for infrastructure markers, and write a
 * record of the attempt (run id, token, times, the chain's exit, the markers,
 * the step that stopped it) only when every step it ran ended by itself. A
 * forwarded signal, or this process being killed, leaves none. With
 * `recordsBase`, each step's start and end go to the run's step records as
 * they happen, so a tree that dies mid-step still names the step.
 */
function runChainChild(root, sentinel, runId, token, waitGo = false, recordsBase = null) {
    // With --wait-go the parent records this runner's identity before any work
    // starts, then creates <sentinel>.go: a chain too short for one process
    // snapshot is still journaled. A parent that never says go (it died, or it
    // could not publish the records) means nothing vouches for this run, so
    // the chain does not start: exit 2, no record, after GO_WAIT_MS.
    if (waitGo) {
        const waitMs = goWaitMs(process.env);
        const until = Date.now() + waitMs;
        let go = false;
        while (!(go = fs.existsSync(`${sentinel}.go`)) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        try { fs.unlinkSync(`${sentinel}.go`); } catch { /* never written, or already gone */ }
        if (!go) {
            console.error(`${TAG} the gate never said go within ${waitMs} ms (its identity, journal and lease are unpublished); the chain did NOT run`);
            process.exitCode = 2;
            return;
        }
    }
    const startUtc = new Date().toISOString();
    const env = { ...process.env, AUTODEV_GATE_RUN_ID: runId || '', AUTODEV_GATE_RUN_TOKEN: token === null ? '' : String(token) };
    // The chain runs one step at a time (gate-steps.js), each step's start and
    // end appended to the run's step records when a records base is given. A
    // chain it cannot split runs whole as `npm run gate:chain`, one step.
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { /* the parent checked it; whole chain below */ }
    const list = chainSteps(pkg);
    const worktree = ident.canonicalPath(root);
    let recordFault = false;
    const record = recordsBase && runId
        ? (e) => records.appendStep(recordsBase, runId, { ...e, token, worktree, runnerPid: process.pid })
        : () => {};
    const scan = recovery.createScanner();
    // npm printed this header first when it ran the whole chain, so output
    // before any step's own header is attributed to the chain, as it was.
    scan.feed(Buffer.from(`> ${(pkg && pkg.name) || 'tree'}@${(pkg && pkg.version) || '0.0.0'} ${CHAIN_SCRIPT}\n`));
    const run = gateSteps.runSteps({
        root, steps: list, env, record,
        onData: (b, stream) => { (stream === 'stderr' ? process.stderr : process.stdout).write(b); scan.feed(b); },
        onRecordError: (e) => {
            if (recordFault) return;
            recordFault = true;
            console.error(`${TAG} step records not written (${e.code || e.message}); a death mid-step will not name its step`);
        },
    });
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    if (process.platform === 'win32') signals.push('SIGBREAK');
    for (const s of signals) process.on(s, () => run.kill(s === 'SIGBREAK' ? 'SIGTERM' : s));
    run.done.then((r) => {
        // A chain stopped by a forwarded signal, or a step that never started,
        // did not finish: no record.
        if (r.interrupted) { process.exitCode = 2; return; }
        if (r.exit === null) {
            console.error(`${TAG} could not start step ${r.failed.index} (${r.failed.step}): ${r.failed.error || 'no exit code'}`);
            process.exitCode = 2;
            return;
        }
        const rec = { schema: 1, runId, token, originPid: process.ppid, runnerPid: process.pid, startUtc,
                      endUtc: new Date().toISOString(), exit: r.exit, signal: null, infra: scan.hits(), lastStep: scan.lastStep(),
                      failedStep: r.failed ? { index: r.failed.index, step: r.failed.step, signal: r.failed.signal } : null };
        try { fs.writeFileSync(sentinel, `${JSON.stringify(rec)}\n`); } catch { /* the parent reads a missing record as not finished */ }
        process.exitCode = r.exit;
    }, (e) => { console.error(`${TAG} the step launcher failed: ${e.message}`); process.exitCode = 2; });
}

/** The chain's steps, read through readGateChain(), or the whole chain as one npm step when it cannot be split. */
function chainSteps(pkg) {
    return gateSteps.splitChain(readGateChain(pkg)) || [`npm run ${CHAIN_SCRIPT}`];
}

const GO_WAIT_MS = 60000;

/** The runner's wait for go: GO_WAIT_MS, or AUTODEV_GATE_GO_WAIT_MS (a test seam). */
function goWaitMs(env) {
    const n = Number(env.AUTODEV_GATE_GO_WAIT_MS);
    return env.AUTODEV_GATE_GO_WAIT_MS && Number.isFinite(n) && n >= 0 ? n : GO_WAIT_MS;
}

function label(exit) {
    if (exit === 0) return 'PASS';
    if (exit === 2) return 'INDETERMINATE';
    return 'FAIL';
}

// ---------------------------------------------------------------------------
// The execution: a lease on the worktree, a journal of the chain's processes,
// a heartbeat that keeps both current, and a wait for the chain's descendants
// before the lane is given up. A waiter judges this gate by these records, so
// a gate whose launcher died while its chain runs on keeps its lane.
// ---------------------------------------------------------------------------

function nowIso() { return new Date().toISOString(); }

function freshSnapshot() {
    try { return ident.snapshot({ maxAgeMs: 0 }); } catch (e) { return { ok: false, why: e.message }; }
}

/** Every live process of the chain: descendants of its root or of anything journaled. */
function liveOfChain(chainRoot, journal, snap) {
    if (!snap.ok || !chainRoot) return [];
    const roots = [chainRoot, ...((journal && journal.descendants) || [])];
    const live = ident.liveDescendants(roots, snap).filter((p) => p.pid !== process.pid);
    for (const r of roots.slice(1)) if (ident.recordLive(r, snap) && !live.some((p) => p.pid === r.pid)) live.push(snap.procs.get(r.pid));
    return live;
}

// ---------------------------------------------------------------------------
// main. process.exitCode, not process.exit(), on every normal path so piped
// output drains.
// ---------------------------------------------------------------------------

function help() {
    console.log('usage: node tooling/gate-lock.js [--root DIR]');
    console.log('');
    console.log('What `npm run gate` runs. Queues for the machine-wide full-gate lock as a');
    console.log('harness gate behind every product gate (autodev-core full-gate-queue.js),');
    console.log('moves a dead holder\'s lock aside to .stale-HHMM, runs `npm run gate:chain`,');
    console.log('hands the lock to the next waiter or renames it to .released-HHMM, and');
    console.log('exits with the chain\'s own exit code. A chain it did not see finish exits 2.');
    console.log('A failure with machine evidence (memory event, disk floor, taken port) exits');
    console.log('2, and queues again only under a recovery config (tooling/gate-recovery.js).');
    console.log('');
    console.log('env: AUTODEV_GATE_LOCK=0 skips the lock; AUTODEV_GATE_LOCK_PATH overrides');
    console.log('its path (default <home>/.claude/autodev/locks/full-gate.lock);');
    console.log('AUTODEV_GATE_LANES=N waits on N lanes (default: the full-gate.lanes file, else 1);');
    console.log('AUTODEV_GATE_RECOVERY=FILE names the recovery config;');
    console.log('AUTODEV_GATE_HEARTBEAT_MS (30000), AUTODEV_GATE_DESCENDANT_WAIT_MS (15000).');
}

function envMs(env, name, dflt, min = 0) {
    const n = Number(env[name]);
    return Number.isFinite(n) && n >= min && env[name] !== undefined && env[name] !== '' ? n : dflt;
}

function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) { help(); return; }
    const val = (flag) => { const k = argv.indexOf(flag); return k >= 0 && argv[k + 1] ? argv[k + 1] : null; };
    const root = path.resolve(val('--root') || path.join(__dirname, '..'));
    if (argv.includes('--run-chain')) {
        const sentinel = val('--sentinel');
        if (!sentinel) { console.error(`${TAG} --run-chain needs --sentinel FILE`); process.exitCode = 2; return; }
        const tok = val('--token');
        runChainChild(root, sentinel, val('--run-id'), tok === null || tok === 'none' ? null : Number(tok), argv.includes('--wait-go'), val('--records'));
        return;
    }
    const env = process.env;
    const log = (line) => console.log(line);
    const base = path.resolve(env.AUTODEV_GATE_LOCK_PATH || queue.defaultLockPath());
    const pollMs = Math.max(50, Number(env.AUTODEV_GATE_LOCK_POLL_MS) || 5000);
    const reportMs = Math.max(0, Number(env.AUTODEV_GATE_LOCK_REPORT_MS) || 180000);
    const heartbeatMs = envMs(env, 'AUTODEV_GATE_HEARTBEAT_MS', 30000, 50);
    const descendantWaitMs = envMs(env, 'AUTODEV_GATE_DESCENDANT_WAIT_MS', 15000);
    const useLock = !lockDisabled(env);

    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { /* reported below */ }
    if (!pkg || !pkg.scripts || typeof pkg.scripts[CHAIN_SCRIPT] !== 'string') {
        console.error(`${TAG} ${path.join(root, 'package.json')} has no scripts["${CHAIN_SCRIPT}"] to run.`);
        console.error(`${TAG} verdict INDETERMINATE (exit 2), the chain did NOT run; no lock was taken`);
        process.exitCode = 2;
        return;
    }

    const runId = `${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const worktree = ident.canonicalPath(root);
    const leaseKey = ident.pathKey(worktree);
    let held = false;
    let released = false;
    let lockPaths = [base];
    let lane = null;
    let token = null;
    let previousToken = null;
    let arrival = null;
    let owner = null;
    let chainRoot = null;
    let child = null;
    let interrupted = null;
    let done = false;
    let heartbeat = null;
    let attempt = 0;

    // Is another run's lease on this worktree still running? Judged like a
    // lane holder: its owner and its journaled execution. Unknown is alive.
    const leaseLive = (v) => {
        if (!v || !v.owner) return null;
        const snap = freshSnapshot();
        let execution = null;
        let journalUnreadable = false;
        if (v.runId) {
            const r = records.readRun(base, v.runId);
            if (r.state === 'ok') execution = r.value;
            else if (r.state === 'malformed') journalUnreadable = true;
        }
        return ident.judgeExecution({ owner: v.owner, execution, journalUnreadable, snap, boot: snap.ok ? snap.boot : null,
            msys: ident.msysTable(), legacyAlive: queue.isAlive }).alive;
    };
    /** Publishes the lease. True when written; the reason is logged when not. */
    const writeLease = (state, extra = {}, renew = true) => {
        if (!useLock || token === null) return false;
        try {
            const r = records.writeLease(base, leaseKey, {
                runId, token, worktree, lane, owner, execution: { chainRoot }, heartbeatUtc: nowIso(), state, attempt, ...extra,
            }, { expect: renew ? { runId, token } : null, isDead: (p) => queue.isAlive(p) === false, isLive: leaseLive });
            if (!r.written) log(`${TAG} lease not written (${state}): ${r.why}`);
            return r.written;
        } catch (e) { log(`${TAG} lease not written (${state}): ${e.message}`); return false; }
    };
    const journal = (mutate) => {
        if (!useLock) return null;
        try { return records.updateRun(base, runId, mutate); } catch (e) { log(`${TAG} run journal not written: ${e.message}`); return null; }
    };
    const readJournal = () => { const r = records.readRun(base, runId); return r.state === 'ok' ? r.value : null; };

    // Leaves every queue and frees any lane naming this process and token. It
    // runs when nothing is held too: a signal can land between a lane being
    // handed over and this process seeing it, and a waiter's tickets must not
    // outlive it.
    // True when no lane names this run any more.
    const releaseNow = ({ quiet }) => {
        let freed = false;
        try {
            queue.leaveQueues(lockPaths, process.pid);
            freed = release(lockPaths, log, { quiet, runId, token });
        } catch (e) { log(`${TAG} could not release ${base}: ${e.message}`); }
        held = false;
        return freed;
    };
    // Processes of the chain that outlived the wait: while any runs, the lane
    // is NOT given up. The lock stays, naming this run, and its journal names
    // them, so a waiter judges the lane held until they exit, then takes it as
    // a dead holder's.
    let keepLane = null;
    const releaseOnce = () => {
        if (!useLock || released) return;
        released = true;
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        if (keepLane) { writeLease('lingering', { lingering: keepLane.map((p) => ({ pid: p.pid, startUtc: p.startUtc })) }); return; }
        releaseNow({ quiet: !held });
        writeLease('released');
    };
    const finishWith = (v) => {
        if (done) return;
        done = true;
        releaseOnce();
        const how = v.finished ? 'the chain finished' : 'the chain did NOT finish';
        log(`${TAG} verdict ${label(v.exit)} (exit ${v.exit}), ${how}: ${v.why}`);
        process.exitCode = v.exit;
    };
    const finish = (outcome) => finishWith(verdict(outcome));

    // Last resort: a synchronous release on any exit path the handlers missed.
    process.on('exit', () => { releaseOnce(); });
    process.on('uncaughtException', (e) => {
        log(`${TAG} internal error: ${e && e.stack ? e.stack : e}`);
        finish({ spawnError: `gate-lock itself threw (${e && e.message})` });
        process.exit(2);
    });

    const onSignal = (sig) => {
        if (interrupted) return;
        interrupted = sig;
        log(`${TAG} received ${sig}`);
        if (!child) { finish({ interrupted: sig }); process.exit(2); return; }
        try { child.kill(sig === 'SIGBREAK' ? 'SIGTERM' : sig); } catch { /* already gone */ }
        // The child's exit event finishes the run. If it never comes, do not
        // hold the machine's lock for a chain nobody is watching.
        setTimeout(() => { finish({ interrupted: sig }); process.exit(2); }, 10000).unref();
    };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    if (process.platform === 'win32') signals.push('SIGBREAK');
    for (const s of signals) process.on(s, () => onSignal(s));

    /**
     * Waits until the chain has no live process, or the wait runs out.
     * { live, unknown }: the processes still running (journaled as
     * descendants), and why exit could not be established, or null.
     */
    const waitForDescendants = async () => {
        if (!useLock) return { live: [], unknown: null };
        if (!chainRoot) return { live: [], unknown: 'the chain root was never recorded' };
        const until = Date.now() + descendantWaitMs;
        for (;;) {
            const snap = freshSnapshot();
            const live = snap.ok ? liveOfChain(chainRoot, readJournal(), snap) : [];
            if (snap.ok && !live.length) return { live: [], unknown: null };
            if (Date.now() >= until) {
                if (!snap.ok) return { live: [], unknown: `no process snapshot (${snap.why})` };
                journal((j) => ({ ...j, descendants: records.mergeDescendants(j.descendants, live, nowIso(), undefined, snap) }));
                log(`${TAG} ${live.length} process(es) of the chain still run after ${descendantWaitMs} ms: ${live.slice(0, 5).map((p) => p.pid).join(', ')}`);
                return { live, unknown: null };
            }
            await new Promise((r) => setTimeout(r, 1000));
        }
    };

    /** After an attempt: classify, maybe queue again, else finish. */
    const afterAttempt = async (outcome, rec) => {
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        const v = verdict(outcome);
        // A chain that did not finish names the step it was in, from the
        // step records the runner appended as each step started and ended.
        const lost = useLock && !v.finished ? recovery.lostStep(records.readSteps(base, runId)) : null;
        if (lost) v.why = `${v.why}; ${lost.why}`;
        const after = await waitForDescendants();
        const lingering = after.live;
        if (lingering.length) keepLane = lingering;
        // A config that cannot be read disables re-admission; it never changes
        // the attempt's own verdict.
        let cfg;
        try { cfg = useLock ? recovery.readRecoveryConfig(base, env) : { config: null, why: 'the lock is skipped' }; } catch (e) {
            cfg = { config: null, why: `the recovery config could not be read (${e.message}), so no automatic re-admission` };
        }
        const floor = cfg.config ? cfg.config.diskFloorBytes : recovery.DEFAULT_DISK_FLOOR;
        let c;
        try { c = await recovery.classify({ v, rec, root, diskFloorBytes: floor, env }); } catch (e) { c = { ...v, cause: null, why: `${v.why} (classification threw: ${e.message})` }; }
        journal((j) => ({ ...j, attempts: [...(j.attempts || []), { attempt, token, exit: c.exit, finished: c.finished, why: c.why, cause: c.cause, record: rec,
            lostStep: lost ? { index: lost.index, step: lost.step, pid: lost.pid, startUtc: lost.startUtc } : null }] }));
        const keptWhy = lingering.length ? `; the lane stays held by this run's record while ${lingering.length} process(es) of the chain run (${lingering.slice(0, 5).map((p) => p.pid).join(', ')})` : '';
        if (!c.cause || interrupted) { finishWith({ ...c, why: `${c.why}${keptWhy}` }); return; }
        log(`${TAG} attempt ${attempt} is INDETERMINATE: ${c.why}`);
        if (!cfg.config) { finishWith({ ...c, why: `${c.why}; ${cfg.why}${keptWhy}` }); return; }
        if (lingering.length) { finishWith({ ...c, why: `${c.why}; not queued again${keptWhy}` }); return; }
        if (after.unknown) { finishWith({ ...c, why: `${c.why}; not queued again: whether the chain's processes exited is unknown (${after.unknown})` }); return; }
        const head = git(root, ['rev-parse', 'HEAD']) || 'no-head';
        const counter = recovery.counterFile(records.runsDir(base), worktree, head);
        const spent = recovery.readmissionsSpent(counter);
        if (spent >= cfg.config.maxReadmissions) {
            finishWith({ ...c, why: `${c.why}; re-admission limit reached (${spent} of ${cfg.config.maxReadmissions} for this worktree and head)` });
            return;
        }
        writeLease('awaiting-clearance');
        const clear = await recovery.awaitClearance(c.cause, cfg.config, root, rec.endUtc, { env, log });
        if (!clear.cleared || interrupted) { finishWith({ ...c, why: `${c.why}; ${clear.why}` }); return; }
        // The limit is checked again and spent in one step under the worktree
        // mutex: a second wrapper on this worktree and head cannot spend the
        // same re-admission.
        let spend;
        try {
            spend = records.withWorktreeMutex(base, leaseKey, () => recovery.spendReadmission(counter, worktree, head, cfg.config.maxReadmissions),
                { isDead: (p) => queue.isAlive(p) === false });
        } catch (e) { spend = { spent: false, count: null, why: e.message }; }
        if (!spend.spent) {
            finishWith({ ...c, why: `${c.why}; re-admission limit reached (${spend.count === null ? spend.why : `${spend.count} of ${cfg.config.maxReadmissions}`} for this worktree and head)` });
            return;
        }
        log(`${TAG} ${clear.why}; queueing again (re-admission ${spend.count} of ${cfg.config.maxReadmissions}), keeping arrival ${arrival}`);
        writeLease('requeued');
        if (!releaseNow({ quiet: false })) {
            finishWith({ ...c, why: `${c.why}; not queued again: the lane could not be released, so a re-admission would run under the old token` });
            return;
        }
        previousToken = token;
        admit(Number.isFinite(Date.parse(arrival)) ? Date.parse(arrival) : null);
    };

    const runChain = () => {
        if (interrupted) return;
        attempt++;
        // The chain runs under a runner (this file, --run-chain) that records
        // npm's exit code in a sentinel file only when it SAW npm exit. On
        // Windows a forced kill leaves exit code 1 and no signal, which looks
        // exactly like a red chain; a killed runner writes no sentinel, so the
        // difference stays visible.
        const sentinel = path.join(os.tmpdir(), `gate-lock-${process.pid}-${Date.now()}.exit`);
        child = spawn(process.execPath, [__filename, '--run-chain', '--root', root, '--sentinel', sentinel,
            '--run-id', runId, '--token', token === null ? 'none' : String(token), ...(useLock ? ['--wait-go', '--records', base] : [])],
            { cwd: root, stdio: 'inherit', windowsHide: true });
        log(`${TAG} chain pid ${child.pid}: npm run ${CHAIN_SCRIPT}${useLock ? ` (run ${runId}, token ${token}, attempt ${attempt})` : ''}`);
        if (useLock) {
            const delay = envMs(env, 'AUTODEV_GATE_TEST_PUBLISH_DELAY_MS', 0);
            if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
            const snap = freshSnapshot();
            chainRoot = snap.ok && snap.procs.get(child.pid) ? { pid: child.pid, startUtc: snap.procs.get(child.pid).startUtc, ppid: process.pid } : null;
            if (!chainRoot) log(`${TAG} the chain root's identity could not be recorded (${snap.ok ? `pid ${child.pid} is not in the snapshot` : snap.why})`);
            const journaled = journal((j) => ({ ...j, token, chainRoot, owner, descendants: j.descendants || [] }));
            const leased = writeLease('running');
            // No go without both records: a runner nothing vouches for never
            // starts its chain (it exits 2 after its wait), and this attempt
            // reads as not finished.
            if (!journaled || !leased) {
                log(`${TAG} the run journal or the worktree lease could not be published; the runner is not told to start`);
                try { child.kill(); } catch { /* gone */ }
            } else {
                try { fs.writeFileSync(`${sentinel}.go`, ''); } catch (e) { log(`${TAG} could not signal the runner (${e.code || e.message}); it will not start`); try { child.kill(); } catch { /* gone */ } }
            }
            heartbeat = setInterval(() => {
                const s = freshSnapshot();
                if (s.ok && chainRoot) {
                    const live = liveOfChain(chainRoot, readJournal(), s);
                    journal((j) => ({ ...j, descendants: records.mergeDescendants(j.descendants, live, nowIso(), undefined, s) }));
                }
                writeLease('running');
            }, heartbeatMs);
            heartbeat.unref();
        }
        child.on('error', (e) => finish({ spawnError: e.message }));
        child.on('exit', (code, signal) => {
            child = null;
            const rec = readSentinel(sentinel, runId, token);
            const outcome = { code, signal, interrupted, recorded: rec ? rec.exit : null };
            afterAttempt(outcome, rec).catch((e) => finish({ spawnError: `gate-lock could not settle the attempt (${e.message})` }));
        });
    };

    if (!useLock) {
        log(`${TAG} lock skipped (AUTODEV_GATE_LOCK=${env.AUTODEV_GATE_LOCK})`);
        runChain();
        return;
    }

    const lanes = queue.laneCount(base, env, null);
    lockPaths = queue.lanePaths(base, lanes.count);
    for (const note of lanes.notes) log(`${TAG} ${note}`);
    if (lanes.count > 1) log(`${TAG} ${lanes.count} lanes (from ${lanes.source}); taking whichever frees first`);
    const what = describe(root);
    const body = `${process.pid}\n${what}\nclass ${GATE_CLASS}\n`;
    records.pruneRuns(base);

    // Admission: take a lane, then confirm the lock is this run's own before
    // anything starts under it, and publish the lease before the chain.
    const admit = (arrivedMs) => {
        released = false;
        acquire(lockPaths, body, what, { pollMs, reportMs, log, isStopped: () => Boolean(interrupted), runId, arrivedMs })
            .then((got) => {
                if (!got) return;
                held = true;
                lane = got;
                const own = queue.confirmOwnership({ lockPath: got, lockPaths, pid: process.pid, runId });
                if (!own.ok) {
                    held = false;
                    finishWith({ exit: 2, finished: false, why: `the lock at ${got} is not this run's (${own.why}); the chain did NOT run` });
                    return;
                }
                if (previousToken !== null && !(own.meta.token > previousToken)) {
                    token = own.meta.token;
                    finishWith({ exit: 2, finished: false, why: `the re-admission carries token ${own.meta.token}, not one later than ${previousToken}; the chain did NOT run again` });
                    return;
                }
                token = own.meta.token;
                arrival = arrival || own.meta.arrival;
                owner = own.meta.owner || null;
                log(`${TAG} lock taken: ${got} (pid ${process.pid}) run ${runId} token ${token}${own.adopted ? ", adopted from a lock without a record" : ""}`);
                if (!writeLease('admitted', {}, false)) {
                    finishWith({ exit: 2, finished: false, why: 'the worktree lease could not be published (see the line above); the chain did NOT run' });
                    return;
                }
                runChain();
            })
            .catch((e) => {
                log(`${TAG} could not take ${base}: ${e.message}`);
                finish({ spawnError: `lock error (${e.code || e.message})` });
            });
    };
    admit(null);
}

module.exports = { readGateChain, CHAIN_SCRIPT, isAlive: queue.isAlive, verdict };

if (require.main === module) main();
