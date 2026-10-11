#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rmw = require('./find-shared-rmw.js');
const { loadWriters, verdict } = require('./ledger-load.js');
const adapters = require('./ledger-load-adapters.js');

if (process.send) {
    let prepared;
    process.on('message', async (m) => {
        try {
            if (m.type === 'prepare') {
                prepared = m;
                process.send({ type: 'ready', cwd: fs.realpathSync(process.cwd()), pid: process.pid });
            } else if (m.type === 'go') {
                await adapters.write(prepared.fixture, prepared.id);
                process.disconnect();
            }
        } catch (e) { console.error(e.stack); process.exitCode = e.writerExit === 2 ? 2 : 1; process.disconnect(); }
    });
} else {
    (async () => {
        const population = rmw.ledgerWriters();
        assert.ok(population.length >= 11, 'ledger population unexpectedly empty or smaller than known controls');
        for (const writer of population) console.log(`LEDGER ${writer.file} [${writer.functions.join(', ')}]`);
        const missing = population.filter((writer, index) => !adapters.supports(writer.file)
            || process.argv.includes('--plant-unexercised') && index === 0);
        if (missing.length) {
            for (const writer of missing) console.log(`FAIL UNEXERCISED ${writer.file}`);
            process.exitCode = 1;
            return;
        }
        let failed = 0;
        let indeterminate = 0;
        let exercised = 0;
        for (const writer of population) {
            const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-load-'));
            try {
                const fixture = adapters.prepare(writer.file, cwd, 20);
                const run = await loadWriters({ worker: __filename, fixture });
                exercised++;
                let observed = [];
                try { observed = adapters.read(fixture); }
                catch (e) { console.log(`CORRUPT ${writer.file}: ${e.message}`); }
                const result = verdict(run, observed);
                console.log(`${result.state.toUpperCase()} ${writer.file} ready=${run.ready}/20 persisted=${result.persisted}/20 exits=${run.results.filter((r) => r.code === 0).length}/20 elapsedMs=${run.elapsedMs}`);
                for (const child of result.failures) console.log(JSON.stringify(child));
                if (result.state === 'indeterminate') indeterminate++;
                else if (!result.ok) failed++;
            } catch (e) { failed++; console.log(`FAIL ${writer.file}: ${e.stack}`); }
            finally { fs.rmSync(cwd, { recursive: true, force: true }); }
        }
        console.log(`POPULATION ${population.length} ledger writers, ${exercised} exercised, ${failed} failures, ${indeterminate} indeterminate`);
        process.exitCode = failed ? 1 : indeterminate ? 2 : 0;
    })().catch((e) => { console.error(e.stack); process.exitCode = 1; });
}
