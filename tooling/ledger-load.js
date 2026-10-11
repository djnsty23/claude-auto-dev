'use strict';
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

/** Release real child processes only after every writer reports its cwd and readiness. */
async function loadWriters({ worker, fixture, count = 20, timeoutMs = 60000 }) {
    if (!Number.isInteger(count) || count < 2) throw new Error('load population must be at least two');
    const cwd = fs.realpathSync(fixture.cwd);
    const children = [];
    let ready = 0;
    let released = false;
    let timedOut = false;
    const started = Date.now();
    const results = Array.from({ length: count }, (_, i) => new Promise((resolve) => {
        const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(cwd, 'profile') };
        const child = fork(worker, [], { cwd, env, windowsHide: true, silent: true });
        const row = { id: String(i), stdout: '', stderr: '', code: null, ready: false };
        children.push({ child, row });
        child.stdout.on('data', (d) => { row.stdout += d; });
        child.stderr.on('data', (d) => { row.stderr += d; });
        child.on('error', (e) => { row.stderr += e.message; });
        child.on('message', (msg) => {
            if (msg.type !== 'ready' || row.ready) return;
            if (msg.cwd !== cwd || msg.pid !== child.pid) {
                row.stderr += 'worker identity mismatch';
                return;
            }
            row.ready = true;
            ready++;
            if (ready === count) {
                released = true;
                for (const c of children) c.child.send({ type: 'go' });
            }
        });
        child.on('close', (code, signal) => { row.code = code; row.signal = signal; resolve(row); });
        child.send({ type: 'prepare', id: row.id, fixture });
    }));
    const timer = setTimeout(() => {
        timedOut = true;
        for (const { child, row } of children) {
            if (row.ready && child.exitCode === null) child.kill();
            else if (child.connected) child.disconnect();
        }
    }, timeoutMs);
    try {
        const settled = await Promise.all(results);
        return { count, ready, released, timedOut, elapsedMs: Date.now() - started,
            results: settled };
    } finally { clearTimeout(timer); }
}

/** Both successful subprocess exits and every distinct expected effect are required. */
function verdict(run, observed) {
    const expected = run.results.map((r) => r.id);
    const persisted = expected.filter((id) => observed.includes(id));
    const failures = run.results.filter((r) => r.code !== 0 || r.stderr);
    const indeterminate = run.timedOut || run.results.some((r) => r.code === 2);
    const ok = !indeterminate && run.released && run.ready === run.count
        && failures.length === 0 && persisted.length === run.count;
    return { ok, state: ok ? 'pass' : indeterminate ? 'indeterminate' : 'fail',
        expected: run.count, persisted: persisted.length, failures, timedOut: run.timedOut };
}
module.exports = { loadWriters, verdict };
