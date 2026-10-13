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
 * itself. On Windows it runs through the shell, where `npm` is `npm.cmd`, so
 * the pid a step record carries there is that cmd.exe, the step's parent.
 *
 * EVIDENCE. A red chain has to say which step stopped it, how, and what that
 * step printed last, and every later step has to read NOT RUN, never green or
 * absent. `runSteps` keeps a bounded tail of each step's output (TAIL_BYTES,
 * taken before the output is passed on, so a sink that fails with ENOSPC
 * cannot lose it), puts it in the end record of a step that did not pass, and
 * resolves with `evidence`: one ledger row per step of the chain
 * (`stepLedger`). `ledgerFromRecords` builds the same ledger from the step
 * records on disk, for a runner that died before it could report. A ledger
 * never says pass for a step nobody saw pass: a step with no record is UNKNOWN.
 */
'use strict';

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const UNSAFE = /[|;&<>`$'"\\()\r\n%!*?[\]{}~#]/;

/** The most of one step's output a ledger row keeps: its last TAIL_BYTES. */
const TAIL_BYTES = 4096;

const STATUS = Object.freeze({
    PASS: 'pass', FAIL: 'fail', NO_START: 'no-start', LOST: 'lost', NOT_RUN: 'not-run', UNKNOWN: 'unknown',
});

/** The last `max` bytes of everything pushed, and how many bytes were pushed. */
function createTail(max = TAIL_BYTES) {
    let buf = Buffer.alloc(0);
    let seen = 0;
    return {
        push(b) {
            const chunk = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
            seen += chunk.length;
            if (chunk.length >= max) { buf = Buffer.from(chunk.subarray(chunk.length - max)); return; }
            buf = Buffer.concat([buf, chunk]);
            if (buf.length > max) buf = buf.subarray(buf.length - max);
        },
        read() { return { text: buf.toString('utf8'), bytes: seen, truncated: seen > buf.length }; },
    };
}

/**
 * One row per step of `steps`, in order, from `ran`: what is known of each
 * step that started, { index, ended, exit, signal, error, tail, pid }. The
 * first step that did not pass stops the chain, as `&&` does, so every step
 * after it is NOT_RUN. A step with no record before any stop is UNKNOWN, and
 * so is every step after it: nothing saw it run, and nothing saw it not run.
 * `interrupted` names the signal that stopped the chain between steps.
 */
function stepLedger(steps, ran, { interrupted = null } = {}) {
    const list = Array.isArray(steps) ? steps : [];
    const of = list.length;
    const known = Array.isArray(ran) ? ran : [];
    let stop = null;
    let unknown = null;
    return list.map((step, i) => {
        const index = i + 1;
        const r = known.filter((x) => x && x.index === index).pop() || null;
        const row = { index, of, step, status: null, exit: null, signal: null, pid: r ? r.pid ?? null : null, tail: null, why: '' };
        if (stop) return { ...row, status: STATUS.NOT_RUN, why: `step ${stop.index} ${stop.how}` };
        if (unknown) return { ...row, status: STATUS.UNKNOWN, why: `no record, and step ${unknown} before it had none` };
        if (!r) {
            if (interrupted) {
                stop = { index, how: `was never started: the chain was interrupted by ${interrupted}` };
                return { ...row, status: STATUS.NOT_RUN, why: `the chain was interrupted by ${interrupted}` };
            }
            unknown = index;
            return { ...row, status: STATUS.UNKNOWN, why: 'no record that it started' };
        }
        const tail = r.tail || null;
        if (r.error && !r.ended) { stop = { index, how: 'could not start' }; return { ...row, status: STATUS.NO_START, tail, why: `could not start: ${r.error}` }; }
        if (!r.ended) { stop = { index, how: 'was lost' }; return { ...row, status: STATUS.LOST, tail, why: 'started and recorded no end' }; }
        const exit = Number.isInteger(r.exit) ? r.exit : null;
        const signal = r.signal || null;
        if (exit === 0 && !signal && !r.error) return { ...row, status: STATUS.PASS, exit: 0 };
        stop = { index, how: 'failed' };
        const how = r.error ? `error ${r.error}` : signal ? `killed by ${signal}` : exit === null ? 'no exit code' : `exit ${exit}`;
        return { ...row, status: STATUS.FAIL, exit, signal, tail, why: how };
    });
}

/**
 * The ledger from gate-records.js readSteps() output, for a run whose runner
 * did not report. Absent or unreadable records make every step UNKNOWN.
 */
function ledgerFromRecords(stepsRead, steps) {
    const list = Array.isArray(steps) ? steps : [];
    if (!stepsRead || stepsRead.state !== 'ok') {
        const why = !stepsRead ? 'no step records were read'
            : stepsRead.state === 'absent' ? 'the step records are missing'
                : `the step records are unreadable (${stepsRead.error || stepsRead.state})`;
        return list.map((step, i) => ({ index: i + 1, of: list.length, step, status: STATUS.UNKNOWN, exit: null, signal: null, pid: null, tail: null, why }));
    }
    const ran = stepsRead.steps.map((s) => ({ index: s.index, ended: s.ended, exit: s.exit, signal: s.signal, pid: s.pid, tail: s.tail || null }));
    return stepLedger(list, ran);
}

const SHOUT = { pass: 'pass', fail: 'FAIL', 'no-start': 'NO START', lost: 'LOST', 'not-run': 'NOT RUN', unknown: 'UNKNOWN' };

/** "steps 6-13", "step 13". */
function span(rows) {
    const a = rows[0].index;
    const b = rows[rows.length - 1].index;
    return a === b ? `step ${a}` : `steps ${a}-${b}`;
}

/**
 * One sentence for a verdict line: the step that stopped the chain, how, and
 * which steps did not run. Null when every step passed.
 */
function summarizeLedger(ledger) {
    if (!Array.isArray(ledger) || !ledger.length) return null;
    const bad = ledger.find((r) => r.status !== STATUS.PASS);
    if (!bad) return null;
    const of = ledger.length;
    const notRun = ledger.filter((r) => r.status === STATUS.NOT_RUN);
    const unknown = ledger.filter((r) => r.status === STATUS.UNKNOWN && r !== bad);
    const parts = [`step ${bad.index} of ${of} (${bad.step}) ${SHOUT[bad.status] || bad.status}${bad.why ? `: ${bad.why}` : ''}`];
    if (notRun.length) parts.push(`${span(notRun)} of ${of} NOT RUN`);
    if (unknown.length) parts.push(`${span(unknown)} of ${of} UNKNOWN`);
    return parts.join('; ');
}

/** The ledger as log lines: every step, and the output tail of the one that stopped the chain. */
function formatEvidence(ledger, prefix = 'gate-steps:') {
    if (!Array.isArray(ledger)) return [];
    const count = (st) => ledger.filter((r) => r.status === st).length;
    const stopped = ledger.length - count(STATUS.PASS) - count(STATUS.NOT_RUN) - count(STATUS.UNKNOWN);
    const out = [`${prefix} evidence for ${ledger.length} step(s): ${count(STATUS.PASS)} pass, ${stopped} stopped the chain, `
        + `${count(STATUS.NOT_RUN)} NOT RUN, ${count(STATUS.UNKNOWN)} UNKNOWN`];
    for (const r of ledger) {
        out.push(`${prefix}   step ${r.index} of ${r.of} ${SHOUT[r.status] || r.status}${r.status !== STATUS.PASS && r.why ? ` (${r.why})` : ''}: ${r.step}`);
        if (r.tail && r.status !== STATUS.PASS) {
            const t = r.tail;
            const kept = Buffer.byteLength(t.text);
            out.push(`${prefix}     its output, last ${kept} of ${t.bytes} byte(s)${t.truncated ? ', TRUNCATED' : ''}${t.bytes === 0 ? ': it printed nothing' : ':'}`);
            if (t.bytes) for (const l of t.text.split(/\r?\n/).slice(-40)) out.push(`${prefix}     | ${l}`);
        }
    }
    return out;
}

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
 * `onData` may throw too (a full disk under a redirected log); the error goes
 * to `onDataError`, and the chunk is already in the step's tail. `done` also
 * carries `evidence`, the ledger of every step (stepLedger).
 */
function runSteps({ root, steps, env = process.env, record = () => {}, onData = () => {}, onRecordError = () => {}, onDataError = () => {} }) {
    let current = null;
    let stopped = null;
    const ran = [];
    const safeRecord = (e) => { try { record(e); } catch (err) { onRecordError(err, e); } };
    // The tail first: a sink that throws must not cost the step its evidence.
    const take = (tail, stream) => (b) => {
        tail.push(b);
        try { onData(b, stream); } catch (err) { try { onDataError(err, stream); } catch { /* the tail is kept */ } }
    };
    const runOne = (step, index) => new Promise((resolve) => {
        const opts = { cwd: root, env: stepEnv(root, env), stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true };
        let child;
        try {
            child = process.platform === 'win32'
                ? spawn(step, { ...opts, shell: true })
                : spawn(step.split(/\s+/)[0], step.split(/\s+/).slice(1), opts);
        } catch (e) {
            ran.push({ index, ended: false, exit: null, signal: null, error: e.message, pid: null, tail: null });
            resolve({ exit: null, signal: null, error: e.message });
            return;
        }
        current = child;
        const base = { index, of: steps.length, step, pid: child.pid ?? null };
        const tail = createTail();
        const row = { index, ended: false, exit: null, signal: null, error: null, pid: base.pid, tail: null };
        ran.push(row);
        safeRecord({ event: 'start', ...base, startUtc: new Date().toISOString() });
        let error = null;
        child.stdout.on('data', take(tail, 'stdout'));
        child.stderr.on('data', take(tail, 'stderr'));
        child.on('error', (e) => { error = e.message; });
        child.on('close', (code, signal) => {
            current = null;
            const exit = error ? null : typeof code === 'number' ? code : signal ? signalExit(signal) : null;
            const passed = !error && code === 0 && !signal;
            Object.assign(row, { ended: true, exit: typeof code === 'number' ? code : null, signal: signal || null, error, tail: passed ? null : tail.read() });
            safeRecord({ event: 'end', ...base, endUtc: new Date().toISOString(), exit: typeof code === 'number' ? code : null,
                         signal: signal || null, ...(error ? { error } : {}), ...(row.tail ? { tail: row.tail } : {}) });
            resolve({ exit, signal: signal || null, error });
        });
    });
    const finish = (out) => ({ ...out, evidence: stepLedger(steps, ran, { interrupted: stopped }) });
    const done = (async () => {
        for (let i = 0; i < steps.length; i++) {
            if (stopped) return finish({ exit: signalExit(stopped), failed: null, interrupted: stopped });
            const r = await runOne(steps[i], i + 1);
            if (r.error || r.exit === null) return finish({ exit: null, failed: { index: i + 1, step: steps[i], ...r }, interrupted: stopped });
            if (r.exit !== 0) return finish({ exit: r.exit, failed: { index: i + 1, step: steps[i], ...r }, interrupted: stopped });
        }
        return finish({ exit: 0, failed: null, interrupted: stopped });
    })();
    const kill = (sig) => {
        stopped = stopped || sig;
        if (current) { try { current.kill(sig); } catch { /* gone */ } }
    };
    return { done, kill };
}

module.exports = {
    splitChain, runSteps, stepEnv, signalExit,
    TAIL_BYTES, STATUS, createTail, stepLedger, ledgerFromRecords, summarizeLedger, formatEvidence,
};
