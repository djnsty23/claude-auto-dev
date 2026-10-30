#!/usr/bin/env node
/**
 * test-capacity-liveness.js - capacity.js reclaims a reservation, and trips its
 * class's crash breaker, only when its pid is dead on FRESH tables.
 *
 * The defect it plants [measured 2026-10-30]: full-gate-queue.js caches its
 * `ps -e` listing per process, and only its own CLI resets it. A process that
 * probed liveness once, then read the ledger after a Git Bash shell reserved
 * capacity, judged that shell's MSYS pid dead (tasklist cannot see it and the
 * stale listing predates it), reclaimed the reservation and tripped the gate
 * breaker while `ps -p` still listed the shell. Every later gate on the machine
 * was refused until an operator cleared it.
 *
 * Cases:
 *   L1  a "dead" from the caller's probe is confirmed by the fresh probe: alive keeps the reservation
 *   L2  dead on both probes is still reclaimed, and trips the breaker
 *   L3  the fresh probe runs only on a "dead" answer
 *   L4  a live shell's pid, born after this process cached its pid tables, is not reclaimed
 *   L5  the same kind of pid, once its shell exited, is reclaimed and trips the breaker
 * L4 and L5 use real processes and the default probes: an MSYS bash on Windows
 * (skipped when Git's bash.exe is absent), sh elsewhere.
 *
 * Every ledger lives in a temp directory named by AUTODEV_GATE_LOCK_PATH, so the
 * machine's real ledger is never read or written.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
for (const k of ['AUTODEV_CAPACITY', 'AUTODEV_CAPACITY_CONFIG', 'AUTODEV_CAPACITY_PROBE_FILE']) delete process.env[k];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-live-'));
process.env.AUTODEV_GATE_LOCK_PATH = path.join(root, 'full-gate.lock');
process.env.AUTODEV_GATE_BOOT_CACHE = path.join(root, 'boot.json');

const cap = require(path.join(SCRIPTS, 'capacity.js'));
const queue = require(path.join(SCRIPTS, 'full-gate-queue.js'));

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];
function check(label, ok, detail) {
    if (ok) { pass++; console.log(`PASS  ${label}`); return; }
    fail++;
    failures.push(label);
    console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`);
}

let caseNo = 0;
/** A fresh ledger holding one gate reservation for `pid`; returns its base. */
function plant(pid) {
    const dir = path.join(root, `case-${++caseNo}`);
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, 'full-gate.lock');
    fs.writeFileSync(cap.ledgerPath(base), JSON.stringify({ schema: 1, classes: {},
        reservations: [{ id: `r${caseNo}`, pid, cls: 'gate', diskBytes: 1, commitBytes: 1, createdUtc: new Date().toISOString() }] }));
    return base;
}
function readBack(base, opts = {}) {
    const s = cap.status({ base, ...opts });
    const ledger = s.ledger || { reservations: [], classes: {} };
    const breaker = ledger.classes.gate && ledger.classes.gate.breaker;
    return { kept: ledger.reservations.length, breaker: breaker ? breaker.why : null, why: s.why };
}
const show = (r) => `kept ${r.kept}, breaker ${r.breaker || 'none'}${r.why ? `, ${r.why}` : ''}`;

/** A shell that prints its own pid ($$, the MSYS pid under Git Bash) and lives until its stdin closes. */
function startShell(shellExe) {
    return new Promise((resolve, reject) => {
        const child = spawn(shellExe, ['-c', 'echo $$; read x'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        let out = '';
        const timer = setTimeout(() => reject(new Error('the shell printed no pid in 15 s')), 15000);
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.stdout.on('data', (d) => {
            out += d;
            const m = /^(\d+)\s/.exec(out);
            if (m) { clearTimeout(timer); resolve({ child, pid: Number(m[1]) }); }
        });
    });
}
function stopShell(sh) {
    return new Promise((resolve) => {
        if (sh.child.exitCode !== null) { resolve(); return; }
        sh.child.on('exit', () => resolve());
        sh.child.stdin.end();
    });
}
function psSees(shellExe, pid) {
    const r = spawnSync(shellExe, ['-c', `ps -p ${pid} >/dev/null 2>&1 && echo yes || echo no`], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return (r.stdout || '').trim() === 'yes';
}

function shellExe() {
    if (process.platform !== 'win32') return 'sh';
    const ex = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
    const bash = !ex.error && ex.status === 0 ? path.resolve(ex.stdout.trim(), '..', '..', '..', 'usr', 'bin', 'bash.exe') : null;
    return bash && fs.existsSync(bash) ? bash : null;
}

async function main() {
    const somePid = 424242;
    {
        const r = readBack(plant(somePid), { isAlive: () => false, isAliveFresh: () => true });
        check('L1. a cached "dead" that the fresh probe calls alive keeps the reservation and trips nothing',
            r.kept === 1 && !r.breaker, show(r));
    }
    {
        const r = readBack(plant(somePid), { isAlive: () => false, isAliveFresh: () => false });
        check('L2. dead on both probes is reclaimed and trips the gate breaker',
            r.kept === 0 && Boolean(r.breaker) && r.breaker.includes(String(somePid)), show(r));
    }
    {
        let freshCalls = 0;
        const r = readBack(plant(somePid), { isAlive: () => true, isAliveFresh: () => { freshCalls++; return false; } });
        check('L3. an "alive" answer is not re-probed', r.kept === 1 && !r.breaker && freshCalls === 0, `${show(r)}, fresh probe asked ${freshCalls} times`);
    }

    const sh = shellExe();
    if (!sh) {
        skipped += 2;
        console.log('SKIP  L4, L5. live and dead MSYS pids: no Git bash.exe on this host');
    } else {
        // Cache this process's pid tables BEFORE the shell exists, as a waiter
        // or worker that probed earlier would have.
        queue.isAlive(1);
        const live = await startShell(sh);
        try {
            const seen = psSees(sh, live.pid);
            const r = readBack(plant(live.pid));
            check(`L4. a live shell pid ${live.pid} that ps -p ${seen ? 'sees' : 'DOES NOT see'}, born after the cached tables, is not reclaimed`,
                seen && r.kept === 1 && !r.breaker, show(r));
        } finally { await stopShell(live); }

        const gone = await startShell(sh);
        await stopShell(gone);
        const deadline = Date.now() + 15000;
        while (psSees(sh, gone.pid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 250));
        const r = readBack(plant(gone.pid));
        check(`L5. an exited shell pid ${gone.pid} is reclaimed and trips the gate breaker`,
            r.kept === 0 && Boolean(r.breaker), show(r));
    }

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
    console.log(`subject: capacity.js status() over ${caseNo} planted ledgers, three with injected probes and `
        + `${caseNo - 3} with the default probes against real ${sh ? path.basename(sh) : 'shell'} processes.`);
    if (fail) console.log(`failed: ${failures.join(' | ')}`);
    process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
    console.error(`test-capacity-liveness: ${e && e.stack ? e.stack : e}`);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exitCode = 2;
});
