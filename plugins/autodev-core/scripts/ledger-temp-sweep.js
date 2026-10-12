#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const MAX_AGE_MS = 60 * 60 * 1000;

/** Sweep only this ledger's sibling temp files, never a directory tree. */
function sweepLedgerTemps(ledger, { now = Date.now() } = {}) {
    if (typeof ledger !== 'string' || !ledger || !Number.isFinite(now)) throw new TypeError('a ledger path and finite clock are required');
    const file = path.resolve(ledger);
    const dir = path.dirname(file);
    const base = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp('^' + base + '\\.[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*\\.tmp$');
    const result = { removed: [], errors: [] };
    let names;
    try { names = fs.readdirSync(dir); } catch (e) {
        if (e.code !== 'ENOENT') result.errors.push({ code: e.code });
        return result;
    }
    for (const name of names) {
        if (!pattern.test(name)) continue;
        const target = path.join(dir, name);
        try {
            const st = fs.lstatSync(target);
            // Whole milliseconds: on Linux a stamped mtime reads back a fraction of a millisecond
            // off, so a file exactly MAX_AGE_MS old read as older about half the time.
            if (!st.isFile() || now - Math.round(st.mtimeMs) <= MAX_AGE_MS) continue;
            fs.unlinkSync(target);
            result.removed.push(name);
        } catch (e) {
            if (e.code !== 'ENOENT') result.errors.push({ name, code: e.code });
        }
    }
    return result;
}

function main(argv) {
    if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
        console.log('ledger-temp-sweep.js --ledger <file> [--ledger <file> ...]\nRemoves only matching sibling temp files older than one hour. Exit 2 for invalid arguments.');
        return 0;
    }
    const ledgers = [];
    for (let i = 0; i < argv.length; i += 2) {
        if (argv[i] !== '--ledger' || !argv[i + 1] || argv[i + 1].startsWith('--')) return 2;
        ledgers.push(argv[i + 1]);
    }
    if (!ledgers.length) return 2;
    const results = ledgers.map((file) => ({ file, ...sweepLedgerTemps(file) }));
    console.log(JSON.stringify({ ledgers: results }));
    return results.some((r) => r.errors.length) ? 1 : 0;
}

if (require.main === module) {
    try { process.exitCode = main(process.argv.slice(2)); }
    catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { sweepLedgerTemps, MAX_AGE_MS, main };
