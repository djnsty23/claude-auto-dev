#!/usr/bin/env node
// cpu-telemetry.js - how much CPU a spawned Node subject spent, measured by the
// subject itself.
//
// WHY. Budget assertions in the suites used to read a wall clock around
// spawnSync. A wall clock charges the subject for every other process on the
// machine: a gate running beside another gate, or eight suites at once, turns
// the same hook from 40 ms into 400 ms without one instruction changing. CPU
// time is what the subject itself spent, so load moves it far less, and a
// regression (a loop that got hotter, a sync read of a large file) still moves
// it.
//
// HOW. tooling/cpu-preload.js rides in through NODE_OPTIONS and writes
// process.cpuUsage() to a private directory when each Node process exits. The
// subject and every Node descendant that inherits the environment report
// themselves; the sum is the measurement. The parent's own process.cpuUsage()
// around a blocking spawn would measure the parent waiting, which is close to
// zero whatever the child did.
//
// WHAT IT DOES NOT SEE. CPU spent in non-Node descendants (git, a shell, ps) is
// not counted, and neither is time spent waiting on them. Those are wall-clock
// questions, and a suite that asks one keeps its own watchdog for it.
//
// MISSING IS NOT ZERO. A subject killed before 'exit' writes no record. With no
// record, or with no record from the subject's own pid when it is known, the
// result is `cpuMs: null`, which a caller reports as not measured.
//
//   node tooling/cpu-telemetry.js --help
//   node tooling/cpu-telemetry.js --run <script.js> [args...]   # print its CPU ms

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PRELOAD = path.join(__dirname, 'cpu-preload.js');
const ENV_DIR = 'AUTODEV_CPU_TELEMETRY_DIR';

// NODE_OPTIONS reads a backslash inside quotes as an escape, so the path goes
// in with forward slashes, which Node accepts on Windows, and quoted for spaces.
const requireFlag = () => `--require "${PRELOAD.split(path.sep).join('/')}"`;

function newDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'adcpu'));
}

// A copy of baseEnv that loads the preload and names dir. Windows env names are
// case-insensitive, so an existing NODE_OPTIONS under any spelling is kept and
// extended rather than shadowed by a second key.
function envWithPreload(baseEnv, dir) {
    const env = {};
    let existing = '';
    for (const [k, v] of Object.entries(baseEnv || {})) {
        if (k.toUpperCase() === 'NODE_OPTIONS') { existing = v || ''; continue; }
        if (k.toUpperCase() === ENV_DIR) continue;
        env[k] = v;
    }
    env.NODE_OPTIONS = (existing ? existing + ' ' : '') + requireFlag();
    env[ENV_DIR] = dir;
    return env;
}

// Sum the records in dir. rootPid, when known, must be among them: a subject
// that was killed leaves only its descendants' records, and a partial sum is
// not a measurement of the subject.
function collect(dir, rootPid) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* an unreadable dir is no measurement */ }
    let micros = 0;
    let processes = 0;
    let unreadable = 0;
    let rootSeen = false;
    for (const n of names) {
        let r;
        try { r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { unreadable++; continue; }
        if (!r || !Number.isFinite(r.user) || !Number.isFinite(r.system)) { unreadable++; continue; }
        micros += r.user + r.system;
        processes++;
        if (rootPid !== undefined && rootPid !== null && r.pid === rootPid) rootSeen = true;
    }
    const rootKnown = rootPid !== undefined && rootPid !== null;
    const measured = processes > 0 && unreadable === 0 && (!rootKnown || rootSeen);
    return {
        cpuMs: measured ? micros / 1000 : null,
        processes,
        unreadable,
        rootSeen: rootKnown ? rootSeen : null,
        why: measured ? null
            : processes === 0 ? 'no CPU record was written (the subject did not reach exit, or the preload did not load)'
                : unreadable ? `${unreadable} CPU record(s) unreadable`
                    : `no record from the subject's own pid ${rootPid}`,
    };
}

function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp debris only */ }
}

// Run fn with the preload in process.env, so any spawn inside it that inherits
// or spreads process.env is measured. Returns { value, cpu }, or a Promise of
// it when fn returns one. rootPidOf(value) may name the subject's pid.
function measure(fn, rootPidOf) {
    const dir = newDir();
    const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, [ENV_DIR]: process.env[ENV_DIR] };
    const patched = envWithPreload({ NODE_OPTIONS: saved.NODE_OPTIONS }, dir);
    const restore = () => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    };
    const finish = (value) => {
        const pid = rootPidOf ? rootPidOf(value) : undefined;
        const cpu = collect(dir, pid);
        cleanup(dir);
        return { value, cpu };
    };
    process.env.NODE_OPTIONS = patched.NODE_OPTIONS;
    process.env[ENV_DIR] = dir;
    let value;
    try {
        value = fn();
    } catch (e) {
        restore();
        cleanup(dir);
        throw e;
    }
    if (value && typeof value.then === 'function') {
        // Restored only once the promise settles, so an async spawn inside it
        // still sees the preload when it starts.
        return value.then((v) => { restore(); return finish(v); }, (e) => { restore(); cleanup(dir); throw e; });
    }
    restore();
    return finish(value);
}

// spawnSync with the preload. Returns spawnSync's result with `cpu` added.
function spawnSyncCpu(command, args, options) {
    const dir = newDir();
    const o = Object.assign({}, options);
    o.env = envWithPreload(o.env || process.env, dir);
    const res = spawnSync(command, args, o);
    res.cpu = collect(dir, res.pid || undefined);
    cleanup(dir);
    return res;
}

// The CPU an empty Node script costs under the same preload: the floor every
// subject pays before its first line. Min of `runs`, or null if none measured.
let emptyScript = null;
function baseline(runs, env) {
    if (!emptyScript || !fs.existsSync(emptyScript)) {
        emptyScript = path.join(newDir(), 'empty.js');
        fs.writeFileSync(emptyScript, '');
    }
    const got = [];
    for (let i = 0; i < (runs || 3); i++) {
        const r = spawnSyncCpu(process.execPath, [emptyScript], { env: env || process.env, input: '', windowsHide: true });
        if (r.cpu.cpuMs !== null) got.push(r.cpu.cpuMs);
    }
    return got.length ? Math.min(...got) : null;
}

// A measurement's CPU over the empty-node floor: the subject's own work, which
// is what a budget is about. The floor is measured once per process and kept.
// { ms: null, why } when either side has no record.
let cachedBase;
function ownCpuMs(cpuResult) {
    if (!cpuResult || cpuResult.cpuMs === null) return { ms: null, why: cpuResult ? cpuResult.why : 'no measurement' };
    if (cachedBase === undefined) cachedBase = baseline(3);
    if (cachedBase === null) return { ms: null, why: 'the empty-node baseline left no CPU record' };
    return { ms: Math.max(0, cpuResult.cpuMs - cachedBase), cpuMs: cpuResult.cpuMs, baseMs: cachedBase, why: null };
}

module.exports = { PRELOAD, ENV_DIR, newDir, envWithPreload, collect, measure, spawnSyncCpu, baseline, ownCpuMs };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const at = argv.indexOf('--run');
    if (at === -1 || argv.includes('--help')) {
        console.log('usage: node tooling/cpu-telemetry.js --run <script.js> [args...]\n'
            + 'Runs the script under the CPU preload and prints the CPU milliseconds it and its Node descendants spent.');
    } else {
        const rest = argv.slice(at + 1);
        if (!rest.length) {
            console.error('--run needs a script');
            process.exitCode = 2;
        } else {
            const r = spawnSyncCpu(process.execPath, rest, { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
            const base = baseline(3);
            console.log(JSON.stringify({ status: r.status, cpuMs: r.cpu.cpuMs, processes: r.cpu.processes, why: r.cpu.why, emptyNodeCpuMs: base }));
            process.exitCode = r.cpu.cpuMs === null ? 2 : 0;
        }
    }
}
