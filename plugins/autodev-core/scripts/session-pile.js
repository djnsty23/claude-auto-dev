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
 *   - head: the scalar fields sit in the first 8 KB, so only that is read.
 *
 * [measured 2026-09-24] 1,222 records, 589 inside the window, and the sync
 * count took 588-643 ms. The head reads were 344 ms and the full parses 146 ms:
 * 31 records, all archived, were pretty-printed ("isArchived": true, with a
 * space), so a head pattern with no whitespace missed every one of them and
 * read 39 MB instead. The patterns now allow whitespace, and the hook uses
 * countLivePileAsync, which reads the heads a few at a time. The sync count
 * stays as the reference its suite compares the async one against.
 *
 * Returns null, never 0, when the store cannot be read: an unreadable store is
 * not an empty pile, and the hook must say nothing rather than "0 sessions".
 *
 * Usage: node session-pile.js [repoRoot]   prints { count, scanned, fullParses, ms } as JSON
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
 * cost time, never a wrong count. JSON allows whitespace around the colon,
 * and a pretty-printed record has it, so the patterns do too.
 */
const HEAD_BYTES = 8192;
function parseHead(head) {
    const str = (key) => {
        const m = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(head);
        return m ? JSON.parse(m[1]) : undefined;
    };
    const arch = /"isArchived"\s*:\s*(true|false)/.exec(head);
    const origin = str('originCwd');
    if (!arch || (origin === undefined && str('cwd') === undefined)) return null;
    return { isArchived: arch[1] === 'true', originCwd: origin, cwd: str('cwd'), cliSessionId: str('cliSessionId') };
}

// `tally.fullParses` counts the records whose head did not answer, so a
// layout change shows up as a number instead of only as time.
function readHead(file, tally) {
    const fd = fs.openSync(file, 'r');
    let head;
    try {
        const buf = Buffer.alloc(HEAD_BYTES);
        head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0));
    } finally { fs.closeSync(fd); }
    const rec = parseHead(head);
    if (rec) return rec;
    tally.fullParses++;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function readHeadAsync(file, tally) {
    const fh = await fs.promises.open(file, 'r');
    let head;
    try {
        const buf = Buffer.alloc(HEAD_BYTES);
        const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
        head = buf.toString('utf8', 0, bytesRead);
    } finally { await fh.close(); }
    const rec = parseHead(head);
    if (rec) return rec;
    tally.fullParses++;
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
}

// Every record file under the store, or null when the store cannot be read.
function listRecords(store) {
    try { fs.readdirSync(store); } catch { return null; }
    const files = [];
    const walk = (dir, depth) => {
        if (depth > 4) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full, depth + 1); continue; }
            if (e.isFile() && /^local_.*\.json$/.test(e.name)) files.push(full);
        }
    };
    walk(store, 0);
    return files;
}

function setup(repoRoot, opts) {
    const cutoff = Date.now() - (opts.windowDays == null ? 14 : opts.windowDays) * 86400000;
    const want = norm(repoRoot);
    const counts = (rec) => {
        if (!rec || rec.isArchived !== false) return false;
        if (opts.excludeCliSessionId && rec.cliSessionId === opts.excludeCliSessionId) return false;
        const origin = rec.originCwd || rec.cwd;
        return !!origin && norm(origin) === want;
    };
    return { cutoff, counts };
}

/**
 * @param {string} repoRoot   main checkout root the sessions were started from
 * @param {object} [opts]     { windowDays = 14, excludeCliSessionId, store }
 * @returns {{count:number, scanned:number, fullParses:number, ms:number} | null}
 */
function countLivePile(repoRoot, opts = {}) {
    const t0 = Date.now();
    const files = listRecords(opts.store || storeDir());
    if (files === null) return null;
    const { cutoff, counts } = setup(repoRoot, opts);
    const tally = { fullParses: 0 };
    let count = 0;
    for (const file of files) {
        try {
            if (fs.statSync(file).mtimeMs < cutoff) continue;
            if (counts(readHead(file, tally))) count++;
        } catch { /* unreadable record: skip it, it is one record */ }
    }
    return { count, scanned: files.length, fullParses: tally.fullParses, ms: Date.now() - t0 };
}

/**
 * The same answer as countLivePile, reading `opts.parallel` records at a time
 * (default 16). A bound, not Promise.all over the store: one open handle per
 * record would meet a 256-descriptor limit as EMFILE, and the catch below
 * would then drop those records from the count without a word.
 *
 * @returns {Promise<{count:number, scanned:number, fullParses:number, ms:number} | null>}
 */
async function countLivePileAsync(repoRoot, opts = {}) {
    const t0 = Date.now();
    const files = listRecords(opts.store || storeDir());
    if (files === null) return null;
    const { cutoff, counts } = setup(repoRoot, opts);
    const tally = { fullParses: 0 };
    let count = 0;
    let next = 0;
    const worker = async () => {
        while (next < files.length) {
            const file = files[next++];
            try {
                if ((await fs.promises.stat(file)).mtimeMs < cutoff) continue;
                if (counts(await readHeadAsync(file, tally))) count++;
            } catch { /* unreadable record: skip it, it is one record */ }
        }
    };
    const width = Math.max(1, Math.min(files.length, Number.isInteger(opts.parallel) ? opts.parallel : 16));
    await Promise.all(Array.from({ length: width }, worker));
    return { count, scanned: files.length, fullParses: tally.fullParses, ms: Date.now() - t0 };
}

module.exports = { countLivePile, countLivePileAsync, parseHead, storeDir };

if (require.main === module) {
    const arg = process.argv[2];
    if (arg === '--help' || arg === '-h') {
        // A probe asking what this is must not scan the store.
        console.log('session-pile.js [repoRoot]: count live Desktop sessions started from repoRoot in the last 14 days. Prints JSON.');
    } else {
        console.log(JSON.stringify(countLivePile(arg || process.cwd())));
    }
}
