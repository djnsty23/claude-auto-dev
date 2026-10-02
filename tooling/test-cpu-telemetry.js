#!/usr/bin/env node
// test-cpu-telemetry.js - drives tooling/cpu-telemetry.js and tooling/cpu-preload.js
// against real Node subprocesses.
//
// The question every budget suite now asks it is "how much CPU did the subject
// itself spend". The cases below pin the three ways an answer can be wrong:
//   - it reads wall time, so a sleeping subject looks expensive;
//   - it reads the parent's CPU, so a busy subject looks free;
//   - it reads a missing record as zero, so a killed subject looks free.
// Windows hands out CPU in 15.6 ms ticks, so every threshold here leaves at
// least four ticks of room on both sides.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const cpu = require('./cpu-telemetry.js');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  (' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) + ')'}`);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'adcpu-test-'));
const script = (name, body) => {
    const p = path.join(ROOT, name);
    fs.writeFileSync(p, body);
    return p;
};

// A subject that sleeps without spending CPU, and one that spends it.
const SLEEP_MS = 600;
const BURN_MS = 400;
const sleeper = script('sleep.js', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${SLEEP_MS});\n`);
const burner = script('burn.js', `const t = process.cpuUsage(); let x = 0; while ((() => { const u = process.cpuUsage(t); return (u.user + u.system) / 1000; })() < ${BURN_MS}) x++;\n`);
// A parent that sleeps while its Node child burns: the child's CPU is the subject's.
const parentOfBurner = script('parent.js',
    `const { spawnSync } = require('child_process');\n`
    + `const r = spawnSync(process.execPath, [${JSON.stringify(burner)}], { stdio: 'ignore' });\n`
    + `process.exitCode = r.status;\n`);
// A subject that dies before 'exit' runs, so it writes no record.
const killer = script('killed.js', `process.kill(process.pid, 'SIGKILL');\nsetTimeout(() => {}, 5000);\n`);

try {
    // 1. Sleep reads low, burn reads high: CPU, not wall time.
    {
        const t0 = Date.now();
        const r = cpu.spawnSyncCpu(process.execPath, [sleeper], { stdio: 'ignore', windowsHide: true });
        const wall = Date.now() - t0;
        const own = cpu.ownCpuMs(r.cpu);
        check('1. a subject sleeping ' + SLEEP_MS + ' ms reads under 150 CPU ms over the node floor',
            r.status === 0 && own.ms !== null && own.ms < 150 && wall >= SLEEP_MS, { own: own.ms, wall, status: r.status });
    }
    {
        const r = cpu.spawnSyncCpu(process.execPath, [burner], { stdio: 'ignore', windowsHide: true });
        check('1. a subject burning ' + BURN_MS + ' CPU ms reads at least ' + (BURN_MS - 60) + ' CPU ms',
            r.status === 0 && r.cpu.cpuMs !== null && r.cpu.cpuMs >= BURN_MS - 60, { cpuMs: r.cpu.cpuMs, processes: r.cpu.processes });
        check('1. and the measuring parent is not charged for it: the record is the child\'s own pid',
            r.cpu.rootSeen === true && r.cpu.processes === 1, r.cpu);
    }

    // 2. Node descendants are part of the subject.
    {
        const r = cpu.spawnSyncCpu(process.execPath, [parentOfBurner], { stdio: 'ignore', windowsHide: true });
        check('2. a sleeping parent whose Node child burns ' + BURN_MS + ' CPU ms reads the child\'s CPU too',
            r.status === 0 && r.cpu.cpuMs !== null && r.cpu.cpuMs >= BURN_MS - 60 && r.cpu.processes === 2, r.cpu);
    }

    // 3. Missing is not zero.
    {
        const r = cpu.spawnSyncCpu(process.execPath, [killer], { stdio: 'ignore', windowsHide: true });
        check('3. a subject killed before exit reads null, not zero',
            r.cpu.cpuMs === null && typeof r.cpu.why === 'string' && r.cpu.why.length > 0, r.cpu);
        check('3. and ownCpuMs carries the null through with a reason',
            cpu.ownCpuMs(r.cpu).ms === null && /record/.test(cpu.ownCpuMs(r.cpu).why), cpu.ownCpuMs(r.cpu));
    }
    {
        // A descendant's record without the root's is a partial sum, not a measurement.
        const dir = cpu.newDir();
        fs.writeFileSync(path.join(dir, 'child.json'), JSON.stringify({ pid: 999999, ppid: 1, user: 5000, system: 0 }));
        const c = cpu.collect(dir, 123456);
        check('3. records from descendants only, with the subject\'s own pid missing, read null', c.cpuMs === null && c.rootSeen === false, c);
        fs.writeFileSync(path.join(dir, 'torn.json'), '{"pid": 12');
        const c2 = cpu.collect(dir);
        check('3. an unreadable record makes the whole sum null', c2.cpuMs === null && c2.unreadable === 1, c2);
        const empty = cpu.collect(cpu.newDir());
        check('3. an empty record directory reads null', empty.cpuMs === null && empty.processes === 0, empty);
        const absent = cpu.collect(path.join(ROOT, 'no-such-dir'));
        check('3. a missing record directory reads null', absent.cpuMs === null, absent);
    }

    // 4. The environment: an existing NODE_OPTIONS survives under any spelling.
    {
        const env = cpu.envWithPreload({ node_options: '--max-old-space-size=64', PATH: 'x', [cpu.ENV_DIR]: 'stale' }, 'D');
        const keys = Object.keys(env).filter((k) => k.toUpperCase() === 'NODE_OPTIONS');
        check('4. one NODE_OPTIONS key, the old flags first and the preload after',
            keys.length === 1 && env.NODE_OPTIONS.startsWith('--max-old-space-size=64 --require "') && !env.NODE_OPTIONS.includes('\\'), env.NODE_OPTIONS);
        check('4. the record directory is the one asked for, not an inherited one', env[cpu.ENV_DIR] === 'D', env[cpu.ENV_DIR]);
    }

    // 5. measure(): sync, async and throwing callers all get process.env back.
    {
        const before = process.env.NODE_OPTIONS;
        const { value, cpu: c } = cpu.measure(() => require('child_process').spawnSync(process.execPath, [burner], { stdio: 'ignore' }));
        check('5. measure() around spawnSync reads the subject\'s CPU', value.status === 0 && c.cpuMs !== null && c.cpuMs >= BURN_MS - 60, c);
        check('5. and restores NODE_OPTIONS', process.env.NODE_OPTIONS === before && process.env[cpu.ENV_DIR] === undefined, process.env.NODE_OPTIONS);
    }
    {
        // A subject that starts a Node child, lets it finish, then dies by
        // signal: only the child's record exists. measure() with no rootPidOf
        // takes the pid off the spawnSync result, so this is null, not the
        // child's few ms minus the floor, which reads as 0.
        const parentThenKilled = script('child-then-killed.js',
            `require('child_process').spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });\nprocess.kill(process.pid, 'SIGKILL');\nsetTimeout(() => {}, 5000);\n`);
        const { value, cpu: c } = cpu.measure(() => require('child_process').spawnSync(process.execPath, [parentThenKilled], { stdio: 'ignore' }));
        check('5. measure() with no rootPidOf: a killed subject whose child left a record reads null, not zero',
            value.status !== 0 && c.processes >= 1 && c.cpuMs === null && cpu.ownCpuMs(c).ms === null, c);
    }
    {
        let threw = false;
        try { cpu.measure(() => { throw new Error('boom'); }); } catch { threw = true; }
        check('5. a throwing callback rethrows and still restores the environment', threw && process.env[cpu.ENV_DIR] === undefined);
    }
    const asyncCase = cpu.measure(() => new Promise((resolve) => {
        const ch = spawn(process.execPath, [burner], { stdio: 'ignore' });
        ch.on('close', (code) => resolve({ code, pid: ch.pid }));
    }), (v) => v.pid);
    check('5. measure() of a promise returns a promise', asyncCase && typeof asyncCase.then === 'function');
    asyncCase.then(({ value, cpu: c }) => {
        check('5. an async spawn inside measure() is measured, keyed to its own pid',
            value.code === 0 && c.cpuMs !== null && c.cpuMs >= BURN_MS - 60 && c.rootSeen === true, c);
        check('5. and the environment is restored after it settles', process.env[cpu.ENV_DIR] === undefined);
        finish();
    }, (e) => { check('5. async measure() settles', false, String(e)); finish(); });
} catch (e) {
    check('the suite ran to the end', false, e && e.stack);
    finish();
}

function finish() {
    // 6. The CLI returns on --help, which check-entrypoints relies on.
    const h = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'cpu-telemetry.js'), '--help'], { encoding: 'utf8', timeout: 20000 });
    check('6. cpu-telemetry.js --help exits 0 with usage', h.status === 0 && /usage:/.test(h.stdout), { status: h.status });
    const p = require('child_process').spawnSync(process.execPath, [cpu.PRELOAD, '--help'], { encoding: 'utf8', timeout: 20000 });
    check('6. cpu-preload.js --help exits 0 with usage', p.status === 0 && /usage/i.test(p.stdout), { status: p.status });
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp debris only */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
}
