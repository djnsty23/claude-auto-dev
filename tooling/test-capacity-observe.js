#!/usr/bin/env node
'use strict';
// test-capacity-observe.js: the capacity window's breach writer. `capacity.js observe`
// samples admitted load against the reserves and appends one row per run to
// `<stem>.capacity-observe.jsonl`. A breach is free disk or commit under its reserve
// while a reservation is outstanding, and the CLI exits 1 on one.
//
// Every run is a subprocess of the real CLI. AUTODEV_GATE_LOCK_PATH puts the ledger and
// the observation log in a temp dir, and AUTODEV_CAPACITY_PROBE_FILE feeds the probe.
// A reservation is held by a live child that admitted through the real admit().

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CAP = path.resolve(__dirname, '../plugins/autodev-core/scripts/capacity.js');
const GIB = 1024 * 1024 * 1024;
let ran = 0;
let failed = 0;
function check(name, cond, detail) {
    ran++;
    if (cond) { console.log(`ok ${name}`); return; }
    failed++;
    console.log(`FAIL ${name}${detail ? `: ${String(detail).slice(0, 600)}` : ''}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-observe-'));
const base = path.join(root, 'locks', 'full-gate.lock');
const log = path.join(root, 'locks', 'full-gate.capacity-observe.jsonl');
const probe = path.join(root, 'probe.json');
const env = { ...process.env, AUTODEV_GATE_LOCK_PATH: base, AUTODEV_CAPACITY_PROBE_FILE: probe, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, 'claude') };
for (const k of ['AUTODEV_CAPACITY', 'AUTODEV_CAPACITY_CONFIG', 'AUTODEV_CAPACITY_SAMPLE_MS', 'AUTODEV_GATE_CLASS']) delete env[k];
const setProbe = (o) => fs.writeFileSync(probe, JSON.stringify({ diskTotalBytes: 100 * GIB, dev: 'vol-a', ...o }));
const observe = () => spawnSync(process.execPath, [CAP, 'observe'], { env, encoding: 'utf8', timeout: 30000 });
const rows = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const last = () => rows().slice(-1)[0] || {};

function holder() {
    const body = `const cap = require(${JSON.stringify(CAP)});
const r = cap.admit({ cls: 'gate', path: ${JSON.stringify(root)}, diskBytes: ${GIB}, commitBytes: ${GIB} });
console.log(r.admitted ? 'admitted ' + r.reservation.id : 'refused ' + r.why);
process.stdin.on('data', () => {}); process.stdin.on('end', () => { if (r.admitted) cap.release(r.reservation.id); });
`;
    const file = path.join(root, 'holder.js');
    fs.writeFileSync(file, body);
    const child = spawn(process.execPath, [file], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    // Listen for exit at spawn: a holder that dies early (a broken admit) has already
    // exited by the time the suite releases it, and a listener added then never fires.
    const exited = new Promise((res) => child.on('exit', res));
    return new Promise((resolve) => {
        let out = '';
        child.stdout.on('data', (d) => { out += d; if (/\n/.test(out)) resolve({ child, out, exited }); });
        exited.then(() => resolve({ child, out, exited }));
    });
}

// Red until the last line says otherwise, so a pending await that drains the event loop
// exits 1 instead of 0.
process.exitCode = 1;
(async () => {
    let held = null;
    try {
        setProbe({ diskFreeBytes: 60 * GIB, commitFreeBytes: 40 * GIB });
        let r = observe();
        check('nothing reserved and room: exit 0, one row, no breach', r.status === 0 && rows().length === 1 && last().breach === false && last().idleShort === false && last().reservations === 0, r.stdout + r.stderr);
        check('the row carries the sampled numbers', last().volumes && last().volumes[0].freeBytes === 60 * GIB && last().commitFreeBytes === 40 * GIB && last().commitReserveBytes === 8 * GIB, JSON.stringify(last()));

        setProbe({ diskFreeBytes: 5 * GIB, commitFreeBytes: 40 * GIB });
        r = observe();
        check('short with nothing reserved is idleShort, never a breach, exit 0', r.status === 0 && last().breach === false && last().idleShort === true && /disk .*5\.0 GiB free, under the 15\.0 GiB reserve/.test(last().why), r.stdout + JSON.stringify(last()));

        setProbe({ diskFreeBytes: 60 * GIB, commitFreeBytes: 40 * GIB });
        held = await holder();
        check('a live child holds a reservation through the real admit()', /^admitted /.test(held.out), held.out);

        r = observe();
        check('reserved with room: no breach, the reservation and its class are counted', r.status === 0 && last().breach === false && last().reservations === 1 && (last().classes || []).join() === 'gate', r.stdout + JSON.stringify(last()));

        setProbe({ diskFreeBytes: 5 * GIB, commitFreeBytes: 40 * GIB });
        r = observe();
        check('reserved and disk under its reserve: BREACH, exit 1, the why names disk', r.status === 1 && /BREACH/.test(r.stdout) && last().breach === true && /^disk .*under the 15\.0 GiB reserve/.test(last().why), r.stdout + JSON.stringify(last()));

        setProbe({ diskFreeBytes: 60 * GIB, commitFreeBytes: 2 * GIB });
        r = observe();
        check('reserved and commit under its reserve: BREACH naming commit', r.status === 1 && last().breach === true && /^commit 2\.0 GiB free, under the 8\.0 GiB reserve/.test(last().why), r.stdout + JSON.stringify(last()));

        fs.writeFileSync(probe, JSON.stringify({ diskFreeBytes: 'throw', commitFreeBytes: 'throw' }));
        r = observe();
        check('an unreadable probe is unknown, never a breach, exit 0', r.status === 0 && last().breach === false && /disk at .*threw/.test(last().unknown || '') && /commit .*threw/.test(last().unknown || ''), r.stdout + JSON.stringify(last()));

        check('every run appended exactly one row', rows().length === 6, rows().length);

        held.child.stdin.end();
        await held.exited;
        held = null;
        setProbe({ diskFreeBytes: 5 * GIB, commitFreeBytes: 40 * GIB });
        r = observe();
        check('after the holder released, the same shortfall is idleShort again', r.status === 0 && last().reservations === 0 && last().breach === false && last().idleShort === true, r.stdout + JSON.stringify(last()));

        fs.rmSync(path.dirname(log), { recursive: true, force: true });
        fs.mkdirSync(path.dirname(log), { recursive: true });
        fs.mkdirSync(log);
        r = observe();
        check('an unwritable observation log exits 2 and says so', r.status === 2 && /could not be written/.test(r.stderr), r.stdout + r.stderr);
    } catch (e) {
        failed++;
        console.log(`FAIL the suite crashed: ${e.stack || e}`);
    } finally {
        if (held) { try { held.child.kill(); } catch { /* already gone */ } }
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log(`\ncapacity observe: ${ran - failed}/${ran} checks passed`);
    process.exitCode = failed ? 1 : 0;
})();
