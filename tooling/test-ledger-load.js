#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadWriters, verdict } = require('./ledger-load.js');

// This deliberately broken writer exists only in the suite. All children read
// the same snapshot before the barrier, then replace it one at a time by token.
// The controlled interleaving proves lost updates without relying on torn JSON.
if (process.send) {
    let fixture, id, snapshot;
    process.on('message', (m) => {
        if (m.type === 'prepare') {
            ({ fixture, id } = m);
            snapshot = JSON.parse(fs.readFileSync(fixture.file, 'utf8'));
            process.send({ type: 'ready', cwd: fs.realpathSync(process.cwd()), pid: process.pid });
        } else if (m.type === 'go') {
            const turn = path.join(fixture.cwd, 'turn');
            const until = Date.now() + 30000;
            while (fs.readFileSync(turn, 'utf8') !== id) {
                if (Date.now() > until) throw new Error('negative control turn was not reached');
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
            }
            snapshot[id] = true;
            fs.writeFileSync(fixture.file, JSON.stringify(snapshot));
            fs.writeFileSync(turn, String(Number(id) + 1));
            process.disconnect();
        }
    });
} else {
    (async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-negative-'));
        try {
            const file = path.join(cwd, 'ledger.json');
            fs.writeFileSync(file, '{}');
            fs.writeFileSync(path.join(cwd, 'turn'), '0');
            const run = await loadWriters({ worker: __filename, fixture: { cwd, file } });
            const result = verdict(run, Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))));
            console.log(`NONATOMIC population=${run.count} ready=${run.ready} exits=${run.results.filter((r) => r.code === 0).length}/${run.count} persisted=${result.persisted}/${result.expected}`);
            assert.equal(run.results.every((r) => r.code === 0), true, JSON.stringify(result.failures));
            assert.equal(run.ready, 20);
            assert.equal(run.released, true);
            assert.equal(run.timedOut, false);
            assert.equal(result.persisted, 1);
            if (process.argv.includes('--plant-nonatomic')) {
                assert.equal(result.ok, true, 'lost writes must fail the same load verdict');
            }
            assert.equal(result.ok, false);
            assert.equal(verdict({ ...run, released: false }, run.results.map((r) => r.id)).ok, false);
            assert.equal(verdict({ ...run, results: run.results.map((r) => ({ ...r, code: 2 })) }, []).state, 'indeterminate');
            console.log('PASS negative control caught lost writes and an unreleased population');
        } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
    })().catch((e) => { console.error(e.stack); process.exitCode = 1; });
}
