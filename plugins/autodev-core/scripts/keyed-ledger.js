#!/usr/bin/env node
// keyed-ledger.js — one small file per key, for hook state that concurrent
// sessions write at the same moment.
//
// WHY NOT ONE SHARED JSON. Three Stop hooks kept their throttle state in one
// file each and updated it read-modify-write. `[measured 2026-09-22]` 20
// concurrent stop-brain-report runs on a 200-entry ledger left 1 of 220. Two
// things compound: the last writer wins, and a reader that catches a file
// mid-write fails to parse it, starts from `{}`, and then writes that empty
// object back over everybody. A fleet ends its turns together, so this is the
// ordinary case.
//
// THE SHAPE. `<file>.d/<sha1(key)>.json`, each written to a unique tmp name and
// renamed into place, so a reader sees the old entry or the new one and never
// half of either. Two sessions never share a key, so the only contention left
// is a session with itself.
//
// THE LEGACY FILE IS READ, NEVER WRITTEN. An entry recorded before this module
// existed is still found, so an upgrade does not look like a first sighting to
// every live session. Nothing writes the old file again, so nothing can wipe it.
//
// A PARSE FAILURE IS NOT AN EMPTY LEDGER. `read` reports `corrupt` separately
// from `absent`, and `writeUnlessCorrupt` refuses to write over bytes it could
// not read. Treating unreadable as empty is exactly the wipe described above.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const TMP_MAX_AGE_MS = 3600 * 1000;

// A rename on Windows fails with EPERM while another process holds either file
// open without delete sharing, for a moment: an antivirus scan of the file just
// written is the usual one. `[measured 2026-09-24]` 14 busy cores and 4
// concurrent runs of the module race: 43 EPERM renames over 12 runs, and 6 runs
// ended at 39 of 40 keys holding their last value, because write() swallowed
// the error and the key kept an older entry. graceful-fs retries the same codes
// for the same reason. The bound is 155 ms, which a Stop hook can afford.
const RENAME_RETRY_MS = [5, 10, 20, 40, 80];
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function renameWithRetry(from, to) {
    for (let i = 0; ; i++) {
        try {
            fs.renameSync(from, to);
            return;
        } catch (e) {
            if (i >= RENAME_RETRY_MS.length || !RENAME_RETRY_CODES.has(e && e.code)) throw e;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_MS[i]);
        }
    }
}

if (require.main === module) {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        console.log('keyed-ledger.js — library: one file per key under <ledger>.d/, tmp plus rename.\n'
            + 'Usage: node keyed-ledger.js --dump <ledger.json>   print every entry as JSON.');
        process.exit(0);
    }
    const i = process.argv.indexOf('--dump');
    if (i > 0 && process.argv[i + 1]) {
        console.log(JSON.stringify(readAll(process.argv[i + 1]), null, 2));
        process.exitCode = 0;
    } else {
        console.error('keyed-ledger.js: pass --dump <ledger.json> or --help');
        process.exitCode = 2;
    }
}

function dirFor(file) {
    return file + '.d';
}

function fileFor(file, key) {
    const h = crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 32);
    return path.join(dirFor(file), h + '.json');
}

function readLegacy(file) {
    try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
}

/**
 * The entry for `key`.
 *   { state: 'ok', entry }   found, in the per-key file or the legacy file
 *   { state: 'absent' }      nothing recorded
 *   { state: 'corrupt' }     the per-key file exists and does not parse
 */
function read(file, key) {
    let raw;
    try {
        raw = fs.readFileSync(fileFor(file, key), 'utf8');
    } catch (e) {
        if (e && e.code !== 'ENOENT') return { state: 'corrupt' };
        const legacy = readLegacy(file);
        const entry = legacy && legacy[key];
        return entry && typeof entry === 'object' ? { state: 'ok', entry, legacy: true } : { state: 'absent' };
    }
    try {
        const v = JSON.parse(raw);
        if (v && typeof v === 'object' && v.key === String(key) && v.value && typeof v.value === 'object') {
            return { state: 'ok', entry: v.value };
        }
    } catch { /* fall through */ }
    return { state: 'corrupt' };
}

/** Write `entry` under `key`. Returns true on success. Never throws. */
function write(file, key, entry, { maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
    const target = fileFor(file, key);
    const tmp = target + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    try {
        fs.mkdirSync(dirFor(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify({ key: String(key), value: entry }) + '\n');
        renameWithRetry(tmp, target);
    } catch {
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
        return false;
    }
    prune(file, maxAgeMs);
    return true;
}

/** `write`, unless `prior` (a result of `read`) says the stored bytes did not parse. */
function writeUnlessCorrupt(file, key, prior, entry, opts) {
    if (prior && prior.state === 'corrupt') return false;
    return write(file, key, entry, opts);
}

/** Drop entries older than maxAgeMs by mtime, and tmp files a crashed writer left. */
function prune(file, maxAgeMs) {
    const now = Date.now();
    let names;
    try {
        names = fs.readdirSync(dirFor(file));
    } catch {
        return;
    }
    for (const n of names) {
        const p = path.join(dirFor(file), n);
        const limit = n.endsWith('.tmp') ? TMP_MAX_AGE_MS : n.endsWith('.json') ? maxAgeMs : null;
        if (limit === null) continue;
        try {
            if (now - fs.statSync(p).mtimeMs > limit) fs.unlinkSync(p);
        } catch { /* a peer pruned it first */ }
    }
}

/** Every entry, legacy first and per-key files over it. For suites and --dump. */
function readAll(file) {
    const out = Object.assign({}, readLegacy(file) || {});
    let names = [];
    try { names = fs.readdirSync(dirFor(file)); } catch { /* no directory yet */ }
    for (const n of names) {
        if (!n.endsWith('.json')) continue;
        try {
            const v = JSON.parse(fs.readFileSync(path.join(dirFor(file), n), 'utf8'));
            if (v && typeof v.key === 'string' && v.value && typeof v.value === 'object') out[v.key] = v.value;
        } catch { /* a corrupt entry is skipped here and refused by writeUnlessCorrupt */ }
    }
    return out;
}

module.exports = { dirFor, fileFor, read, write, writeUnlessCorrupt, readAll, prune, RENAME_RETRY_MS };
