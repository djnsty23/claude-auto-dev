#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const tool = path.resolve(__dirname, '../plugins/autodev-core/scripts/ledger-temp-sweep.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-sweep-'));
let passed = 0;
try {
    const ledger = path.join(root, 'workers.[1].json');
    const now = Date.now();
    const files = ['workers.[1].json.old-id.tmp', 'workers.[1].json.fresh-id.tmp',
        'unrelated.tmp', 'workers.X1X.json.old-id.tmp', 'workers.[1].json.tmp',
        'workers.[1].json..tmp', 'workers.[1].json.old-id.tmp.backup', 'workers.[1].json'];
    for (const name of files) fs.writeFileSync(path.join(root, name), name);
    for (const name of files.filter((n) => !n.includes('fresh-id'))) {
        fs.utimesSync(path.join(root, name), new Date(now - 3600001), new Date(now - 3600001));
    }
    const directory = ledger + '.directory.tmp';
    fs.mkdirSync(directory);
    fs.utimesSync(directory, new Date(0), new Date(0));
    const sweep = require(tool).sweepLedgerTemps;
    assert.equal(typeof sweep, 'function');
    const result = sweep(ledger, { now });
    assert.deepEqual(result.removed, [files[0]]);
    assert.equal(fs.existsSync(path.join(root, files[0])), false);
    passed++;
    for (const name of files.slice(1)) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), name);
    assert.equal(fs.statSync(directory).isDirectory(), true);
    passed++;
    const boundary = ledger + '.boundary.tmp';
    fs.writeFileSync(boundary, 'boundary');
    fs.utimesSync(boundary, new Date(now - 3600000), new Date(now - 3600000));
    sweep(ledger, { now });
    assert.equal(fs.existsSync(boundary), true);
    passed++;
    const r = spawnSync(process.execPath, [tool, '--ledger', ledger], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).ledgers.length, 1);
    assert.equal(fs.readFileSync(ledger + '.fresh-id.tmp', 'utf8'), files[1]);
    assert.equal(fs.readFileSync(path.join(root, 'unrelated.tmp'), 'utf8'), 'unrelated.tmp');
    passed++;
    const bad = spawnSync(process.execPath, [tool], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    passed++;
    const worker = path.resolve(__dirname, '../plugins/autodev-core/scripts/unattended-worker.js');
    const workerLedger = path.join(root, 'unattended-workers.json');
    fs.writeFileSync(workerLedger, JSON.stringify({ version: 1, records: [{ taskId: 'probe', state: 'queued' }] }));
    const orphan = workerLedger + '.orphan-id.tmp';
    fs.writeFileSync(orphan, '');
    fs.utimesSync(orphan, new Date(0), new Date(0));
    const retired = spawnSync(process.execPath, [worker, 'retire', '--task-id', 'probe', '--ledger', workerLedger], { encoding: 'utf8' });
    assert.equal(retired.status, 0, retired.stdout + retired.stderr);
    assert.equal(fs.existsSync(orphan), false, 'a real ledger write must sweep its orphan temp');
    passed++;
    console.log(`PASS ${passed}/${passed} temp sweep checks, stale exact match removed, fresh and unrelated files survive`);
} catch (e) {
    console.error(`FAIL temp sweep after ${passed} checks: ${e.stack}`);
    process.exitCode = 1;
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
