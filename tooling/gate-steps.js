/**
 * gate-steps.js - runs the gate chain one step at a time, so each step's end
 * is recorded as it happens. A library for tooling/gate-lock.js's runner; it
 * prints nothing on import.
 *
 * WHY. `npm run gate:chain` is one `&&` chain under one npm. When that tree
 * dies, only the chain's overall exit (or no exit at all) survives.
 * `[measured 2026-10-06]` a detached `npm run gate` lost its process tree mid
 * check:suites with no exit line and no kill in any log, and nothing said
 * which step was running. So the runner splits the chain it reads through
 * `readGateChain()` on `&&`, runs each step itself, and appends a start line
 * before a step can do any work and an end line (exit code or signal) when it
 * ends, through `gate-records.js appendStep`. A start line with no end line is
 * the step the tree died in.
 *
 * SAME VERDICT AS THE CHAIN. Steps run in order and the first red one stops
 * the rest, as `&&` does. The runner's exit is that step's exit, or 0. A step
 * killed by a signal exits 128 plus the signal number, as the shell reports
 * it to npm. A step that cannot start, like npm itself not starting before,
 * gives no exit at all (null), which the runner reads as not finished. A chain this file cannot split safely (any `||`, `;`, `|`,
 * a redirect, a quote, a substitution) runs whole as `npm run gate:chain`,
 * recorded as one step, so a chain shape this does not understand still runs
 * exactly as it did.
 *
 * EACH STEP runs as npm would run it: in the tree's root, with the tree's
 * node_modules/.bin first on PATH. On POSIX it is spawned without a shell
 * (no step this accepts needs one), so a forwarded signal reaches the step
 * itself. On Windows it runs through the shell, where `npm` is `npm.cmd`.
 */
'use strict';

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const UNSAFE = /[|;&<>`$'"\\()\r\n%!*?[\]{}~#]/;

/**
 * The chain's steps, or null when it is not a plain `a && b && c` chain whose
 * every step is a command and its words.
 */
function splitChain(chain) {
    if (typeof chain !== 'string' || !chain.trim()) return null;
    const steps = chain.split('&&').map((s) => s.trim());
    if (steps.some((s) => !s || UNSAFE.test(s))) return null;
    return steps;
}

/** `env` with `<root>/node_modules/.bin` first on PATH, as `npm run` puts it. */
function stepEnv(root, env) {
    const out = { ...env };
    const key = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    out[key] = [path.join(root, 'node_modules', '.bin'), out[key]].filter(Boolean).join(path.delimiter);
    return out;
}

/** The exit a shell reports for a child killed by `signal`. */
function signalExit(signal) {
    const n = os.constants.signals[signal];
    return Number.isInteger(n) ? 128 + n : 1;
}

/**
 * Runs `steps` in order. Returns { done, kill }: `done` resolves with
 * { exit, failed, interrupted } (exit null when a step could not start) where `failed` is the step that stopped the
 * chain (or null) and `interrupted` the signal `kill` forwarded (or null), and
 * `kill(sig)` forwards a signal to the step that is running and starts no more.
 *
 *   record({ event: 'start', index, of, step, pid, startUtc })   before the step can work
 *   record({ event: 'end', index, of, step, pid, endUtc, exit, signal })
 *   onData(buffer, stream)   every chunk the step prints
 *
 * `record` may throw; the error goes to `onRecordError` and the step runs on.
 */
function runSteps({ root, steps, env = process.env, record = () => {}, onData = () => {}, onRecordError = () => {} }) {
    let current = null;
    let stopped = null;
    const safeRecord = (e) => { try { record(e); } catch (err) { onRecordError(err, e); } };
    const runOne = (step, index) => new Promise((resolve) => {
        const opts = { cwd: root, env: stepEnv(root, env), stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true };
        let child;
        try {
            child = process.platform === 'win32'
                ? spawn(step, { ...opts, shell: true })
                : spawn(step.split(/\s+/)[0], step.split(/\s+/).slice(1), opts);
        } catch (e) { resolve({ exit: null, signal: null, error: e.message }); return; }
        current = child;
        const base = { index, of: steps.length, step, pid: child.pid ?? null };
        safeRecord({ event: 'start', ...base, startUtc: new Date().toISOString() });
        let error = null;
        child.stdout.on('data', (b) => onData(b, 'stdout'));
        child.stderr.on('data', (b) => onData(b, 'stderr'));
        child.on('error', (e) => { error = e.message; });
        child.on('close', (code, signal) => {
            current = null;
            const exit = error ? null : typeof code === 'number' ? code : signal ? signalExit(signal) : null;
            safeRecord({ event: 'end', ...base, endUtc: new Date().toISOString(), exit: typeof code === 'number' ? code : null,
                         signal: signal || null, ...(error ? { error } : {}) });
            resolve({ exit, signal: signal || null, error });
        });
    });
    const done = (async () => {
        for (let i = 0; i < steps.length; i++) {
            if (stopped) return { exit: signalExit(stopped), failed: null, interrupted: stopped };
            const r = await runOne(steps[i], i + 1);
            if (r.error || r.exit === null) return { exit: null, failed: { index: i + 1, step: steps[i], ...r }, interrupted: stopped };
            if (r.exit !== 0) return { exit: r.exit, failed: { index: i + 1, step: steps[i], ...r }, interrupted: stopped };
        }
        return { exit: 0, failed: null, interrupted: stopped };
    })();
    const kill = (sig) => {
        stopped = stopped || sig;
        if (current) { try { current.kill(sig); } catch { /* gone */ } }
    };
    return { done, kill };
}

module.exports = { splitChain, runSteps, stepEnv, signalExit };
