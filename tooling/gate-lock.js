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
 * the same first-come queue `full-gate-queue.js wait` uses, so a newcomer
 * running `npm run gate` never jumps a session already waiting.
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

const queue = require(path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'full-gate-queue.js'));

const STALE_MS = 600000;
const MAX_POLL_ERRORS = 10;

function lockDisabled(env) {
    const v = String(env.AUTODEV_GATE_LOCK || '').trim().toLowerCase();
    return v === '0' || v === 'off' || v === 'false' || v === 'no';
}

/** Why a queued waiter cannot go yet, for the waiting line. */
function whyWaiting(r) {
    const h = r.holder;
    const ahead = r.position - 1;
    const behind = ahead > 0 ? ` (place ${r.position} of ${r.of} in its queue)` : '';
    if (!h) return `free, but ${ahead} waiter(s) arrived first${behind}`;
    if (h.pid === null) {
        return `line 1 is not a pid, so its holder cannot be checked; move it aside by hand if nobody holds it${behind}`;
    }
    const alive = queue.isAlive(h.pid);
    return (alive === null
        ? `cannot tell whether pid ${h.pid} is alive (no liveness probe answered)`
        : `held by live pid ${h.pid}`) + behind;
}

/**
 * Resolves the lane lock once it names this process, or null if stopped while
 * waiting. Each poll takes a turn in every lane's queue (`takeAnyLane`), which
 * also refreshes this process's tickets. A transient filesystem error is
 * retried; MAX_POLL_ERRORS in a row reject.
 */
function acquire(lockPaths, body, what, opts) {
    const { pollMs, reportMs, log, isStopped } = opts;
    const pid = process.pid;
    let lastReport = 0;
    let lastSeen = null;
    let errors = 0;
    return new Promise((resolve, reject) => {
        const attempt = () => {
            if (isStopped()) { queue.leaveQueues(lockPaths, pid); resolve(null); return; }
            try {
                queue.resetProbes();
                const r = queue.takeAnyLane({ lockPaths, pid, what, body, staleMs: STALE_MS, log });
                errors = 0;
                if (r.acquired) { resolve(r.lockPath); return; }
                const seen = `${r.lockPath}|${r.position}|${r.holder ? r.holder.text : ''}`;
                const now = Date.now();
                if (seen !== lastSeen || now - lastReport >= reportMs) {
                    const says = r.holder ? r.holder.what : '(no lock)';
                    log(`${TAG} waiting for ${r.lockPath}: ${whyWaiting(r)}. Holder says: ${says}`);
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
 * Releases every lane that names this process: to the next queued waiter when
 * there is one, else by rename to `.released-HHMM`. Touches nothing not ours.
 */
function release(lockPaths, log, { quiet = false } = {}) {
    queue.resetProbes();
    const done = queue.releaseLanes({ lockPaths, pid: process.pid, staleMs: STALE_MS, log });
    for (const r of done) {
        if (r.to) log(`${TAG} lock handed to queued pid ${r.to.pid} (${r.to.what}); record kept as ${path.basename(r.aside)}`);
        else log(`${TAG} lock released to ${path.basename(r.aside)}`);
    }
    if (done.length || quiet) return;
    const held = queue.readLock(lockPaths[0]);
    if (!held) { log(`${TAG} lock already gone at release; nothing renamed`); return; }
    log(`${TAG} the lock now names pid ${held.pid}, not this process (${process.pid}); left it untouched`);
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

/** The sentinel's code, or null when absent or malformed. Removes our own temp file. */
function readSentinel(file) {
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
    try { fs.unlinkSync(file); } catch { /* temp file, best effort */ }
    return /^\d+\s*$/.test(text) ? Number(text.trim()) : null;
}

/**
 * Runner mode: run `npm run gate:chain`, and write npm's exit code to the
 * sentinel only when npm exited with a code and no signal. Anything else, or
 * this process being killed, leaves no sentinel.
 */
function runChainChild(root, sentinel) {
    const opts = { cwd: root, stdio: 'inherit', windowsHide: true };
    // One command string with shell on Windows (npm is npm.cmd there, and an
    // args array with shell:true is deprecated); no shell on POSIX, so a
    // forwarded signal reaches npm itself.
    const npm = process.platform === 'win32'
        ? spawn(`npm run ${CHAIN_SCRIPT}`, { ...opts, shell: true })
        : spawn('npm', ['run', CHAIN_SCRIPT], opts);
    const forward = (sig) => { try { npm.kill(sig === 'SIGBREAK' ? 'SIGTERM' : sig); } catch { /* gone */ } };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    if (process.platform === 'win32') signals.push('SIGBREAK');
    for (const s of signals) process.on(s, () => forward(s));
    npm.on('error', (e) => { console.error(`${TAG} could not start npm: ${e.message}`); process.exitCode = 2; });
    npm.on('exit', (code, signal) => {
        if (typeof code === 'number' && !signal) {
            try { fs.writeFileSync(sentinel, `${code}\n`); } catch { /* the parent reads a missing record as not finished */ }
            process.exitCode = code;
        } else {
            process.exitCode = 2;
        }
    });
}

function label(exit) {
    if (exit === 0) return 'PASS';
    if (exit === 2) return 'INDETERMINATE';
    return 'FAIL';
}

// ---------------------------------------------------------------------------
// main. process.exitCode, not process.exit(), on every normal path so piped
// output drains.
// ---------------------------------------------------------------------------

function help() {
    console.log('usage: node tooling/gate-lock.js [--root DIR]');
    console.log('');
    console.log('What `npm run gate` runs. Queues for the machine-wide full-gate lock');
    console.log('(first come, first served, through autodev-core full-gate-queue.js; moves');
    console.log('a dead holder\'s lock aside to .stale-HHMM), runs `npm run gate:chain`,');
    console.log('hands the lock to the next waiter or renames it to .released-HHMM, and');
    console.log('exits with the chain\'s own exit code. A chain it did not see finish exits 2.');
    console.log('');
    console.log('env: AUTODEV_GATE_LOCK=0 skips the lock; AUTODEV_GATE_LOCK_PATH overrides');
    console.log('its path (default <home>/.claude/autodev/locks/full-gate.lock);');
    console.log('AUTODEV_GATE_LANES=N waits on N lanes (default: the full-gate.lanes file, else 1).');
}

function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) { help(); return; }
    const val = (flag) => { const k = argv.indexOf(flag); return k >= 0 && argv[k + 1] ? argv[k + 1] : null; };
    const root = path.resolve(val('--root') || path.join(__dirname, '..'));
    if (argv.includes('--run-chain')) {
        const sentinel = val('--sentinel');
        if (!sentinel) { console.error(`${TAG} --run-chain needs --sentinel FILE`); process.exitCode = 2; return; }
        runChainChild(root, sentinel);
        return;
    }
    const env = process.env;
    const log = (line) => console.log(line);
    const base = path.resolve(env.AUTODEV_GATE_LOCK_PATH || queue.defaultLockPath());
    const pollMs = Math.max(50, Number(env.AUTODEV_GATE_LOCK_POLL_MS) || 5000);
    const reportMs = Math.max(0, Number(env.AUTODEV_GATE_LOCK_REPORT_MS) || 180000);
    const useLock = !lockDisabled(env);

    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { /* reported below */ }
    if (!pkg || !pkg.scripts || typeof pkg.scripts[CHAIN_SCRIPT] !== 'string') {
        console.error(`${TAG} ${path.join(root, 'package.json')} has no scripts["${CHAIN_SCRIPT}"] to run.`);
        console.error(`${TAG} verdict INDETERMINATE (exit 2), the chain did NOT run; no lock was taken`);
        process.exitCode = 2;
        return;
    }

    let held = false;
    let released = false;
    let lockPaths = [base];
    let child = null;
    let interrupted = null;
    let done = false;

    // Leaves every queue and frees any lane naming this process. It runs when
    // nothing is held too: a signal can land between a lane being handed over
    // and this process seeing it, and a waiter's tickets must not outlive it.
    const releaseOnce = () => {
        if (!useLock || released) return;
        released = true;
        try {
            queue.leaveQueues(lockPaths, process.pid);
            release(lockPaths, log, { quiet: !held });
        } catch (e) { log(`${TAG} could not release ${base}: ${e.message}`); }
        held = false;
    };
    const finish = (outcome) => {
        if (done) return;
        done = true;
        releaseOnce();
        const v = verdict(outcome);
        const how = v.finished ? 'the chain finished' : 'the chain did NOT finish';
        log(`${TAG} verdict ${label(v.exit)} (exit ${v.exit}), ${how}: ${v.why}`);
        process.exitCode = v.exit;
    };

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

    const runChain = () => {
        if (interrupted) return;
        // The chain runs under a runner (this file, --run-chain) that records
        // npm's exit code in a sentinel file only when it SAW npm exit. On
        // Windows a forced kill leaves exit code 1 and no signal, which looks
        // exactly like a red chain; a killed runner writes no sentinel, so the
        // difference stays visible.
        const sentinel = path.join(os.tmpdir(), `gate-lock-${process.pid}-${Date.now()}.exit`);
        child = spawn(process.execPath, [__filename, '--run-chain', '--root', root, '--sentinel', sentinel],
            { cwd: root, stdio: 'inherit', windowsHide: true });
        log(`${TAG} chain pid ${child.pid}: npm run ${CHAIN_SCRIPT}`);
        child.on('error', (e) => finish({ spawnError: e.message }));
        child.on('exit', (code, signal) => {
            const recorded = readSentinel(sentinel);
            finish({ code, signal, interrupted, recorded });
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
    const body = `${process.pid}\n${what}\n`;
    acquire(lockPaths, body, what, { pollMs, reportMs, log, isStopped: () => Boolean(interrupted) })
        .then((lane) => {
            if (!lane) return;
            held = true;
            log(`${TAG} lock taken: ${lane} (pid ${process.pid})`);
            runChain();
        })
        .catch((e) => {
            log(`${TAG} could not take ${base}: ${e.message}`);
            finish({ spawnError: `lock error (${e.code || e.message})` });
        });
}

module.exports = { readGateChain, CHAIN_SCRIPT, isAlive: queue.isAlive, verdict };

if (require.main === module) main();
