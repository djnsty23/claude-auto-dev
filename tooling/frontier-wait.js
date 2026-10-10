'use strict';
// Four observed runtimes allow for scheduling and the start, finish and save
// phases of a detached batch. A signal ends the wait immediately.
function waitForState(read, ready, samples, opts = {}) {
    if (!samples.length || samples.some(ms => !Number.isFinite(ms) || ms <= 0)) {
        throw new Error('wait requires positive runtime measurements');
    }
    const now = opts.now || (() => performance.now());
    const pause = opts.pause || (ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
    const pollMs = opts.pollMs || 250;
    const budgetMs = Math.ceil(Math.max(...samples) * 4);
    const started = now();
    let value;
    for (;;) {
        value = read();
        if (ready(value)) return { value, elapsedMs: now() - started, budgetMs };
        if (now() - started >= budgetMs) break;
        pause(Math.min(pollMs, budgetMs - (now() - started)));
    }
    throw new Error(`wait timed out after ${budgetMs} ms from ${samples.length} runtime measurements, last=${JSON.stringify(value)}`);
}
module.exports = { waitForState };
