#!/usr/bin/env node
/**
 * session-pile.js — how many live Desktop sessions are working on one repo.
 *
 * Read by the SessionStart hook, so it has a budget. [measured 2026-09-13] a
 * full parse of the session store was 733 records, 86.8 MB, 633 ms. Two cheap
 * filters bring that down without changing the answer the hook needs:
 *
 *   - mtime: a record not written in `windowDays` belongs to a session nobody
 *     touched recently. The warning is about the working pile, not the attic.
 *   - substring: the app writes minified JSON, so `"isArchived":false` must
 *     appear before a record is worth parsing. The same needle the sweep's
 *     --archive-orphaned relies on.
 *
 * Returns null, never 0, when the store cannot be read: an unreadable store is
 * not an empty pile, and the hook must say nothing rather than "0 sessions".
 *
 * Usage: node session-pile.js [repoRoot]   prints { count, scanned, ms } as JSON
 */
'use strict';
const fs = require('fs');
const path = require('path');

function storeDir() {
    if (process.env.SESSION_SWEEP_STORE) return process.env.SESSION_SWEEP_STORE;
    let base;
    if (process.platform === 'win32' && process.env.APPDATA) base = process.env.APPDATA;
    else if (process.platform === 'darwin') base = path.join(process.env.HOME || '', 'Library', 'Application Support');
    else base = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
    return path.join(base, 'Claude', 'claude-code-sessions');
}

const norm = (p) => {
    let r = path.resolve(String(p));
    if (process.platform === 'win32') r = r.toLowerCase();
    return r.replace(/[\\/]+$/, '');
};

/**
 * Read only the head of a record and pull out the four fields this needs.
 *
 * [measured 2026-09-13] the full-parse version took 307-462 ms on a real store,
 * nearly all of it reading and parsing large snapshot fields at the END of each
 * record. The app writes the scalar fields first. When a field is not found in
 * the head, fall back to a full parse rather than guess: a layout change must
 * cost time, never a wrong count.
 */
const HEAD_BYTES = 8192;
function readHead(file) {
    const fd = fs.openSync(file, 'r');
    let head;
    try {
        const buf = Buffer.alloc(HEAD_BYTES);
        head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0));
    } finally { fs.closeSync(fd); }
    const str = (key) => {
        const m = new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*")`).exec(head);
        return m ? JSON.parse(m[1]) : undefined;
    };
    const arch = /"isArchived":(true|false)/.exec(head);
    const origin = str('originCwd');
    if (!arch || (origin === undefined && str('cwd') === undefined)) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    return { isArchived: arch[1] === 'true', originCwd: origin, cwd: str('cwd'), cliSessionId: str('cliSessionId') };
}

/**
 * @param {string} repoRoot   main checkout root the sessions were started from
 * @param {object} [opts]     { windowDays = 14, excludeCliSessionId, store }
 * @returns {{count:number, scanned:number, ms:number} | null}
 */
function countLivePile(repoRoot, opts = {}) {
    const t0 = Date.now();
    const store = opts.store || storeDir();
    const cutoff = Date.now() - (opts.windowDays == null ? 14 : opts.windowDays) * 86400000;
    const want = norm(repoRoot);
    let count = 0;
    let scanned = 0;
    try { fs.readdirSync(store); } catch { return null; }

    const walk = (dir, depth) => {
        if (depth > 4) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full, depth + 1); continue; }
            if (!e.isFile() || !/^local_.*\.json$/.test(e.name)) continue;
            scanned++;
            try {
                if (fs.statSync(full).mtimeMs < cutoff) continue;
                const rec = readHead(full);
                if (!rec || rec.isArchived !== false) continue;
                if (opts.excludeCliSessionId && rec.cliSessionId === opts.excludeCliSessionId) continue;
                const origin = rec.originCwd || rec.cwd;
                if (origin && norm(origin) === want) count++;
            } catch { /* unreadable record: skip it, it is one record */ }
        }
    };
    walk(store, 0);
    return { count, scanned, ms: Date.now() - t0 };
}

module.exports = { countLivePile, storeDir };

if (require.main === module) {
    const arg = process.argv[2];
    if (arg === '--help' || arg === '-h') {
        // A probe asking what this is must not scan the store.
        console.log('session-pile.js [repoRoot]: count live Desktop sessions started from repoRoot in the last 14 days. Prints JSON.');
    } else {
        console.log(JSON.stringify(countLivePile(arg || process.cwd())));
    }
}
