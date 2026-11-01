#!/usr/bin/env node
'use strict';
/**
 * ledger-rotate.js - gzip the old lines of the append-only `*.jsonl` ledgers
 * under the autodev state dir, and keep the recent ones hot.
 *
 * WHY. events.jsonl, peer-sends.jsonl and their siblings only grow, and every
 * reader parses the whole file. A file the readers scan on every turn gets
 * slower each week for lines nobody asks about. Lines older than the window
 * move to a compressed archive beside the ledger, so the hot file stays small
 * and the history stays on disk.
 *
 * WHAT MOVES. A line moves when it is a JSON object with a timestamp field
 * (at, ts, timestamp, time, date, createdAt, created_at, startedAt, started_at,
 * recordedAt, sentAt, when) that parses and is older than --days (default 30).
 * The timestamp is an ISO date-time or an epoch number (seconds or
 * milliseconds). EVERYTHING ELSE STAYS HOT: a line with no timestamp, an
 * unparseable one, a line that is not JSON, a blank line, a timestamp in the
 * future. Rotation never has to understand a line to keep it, and a reader
 * that expects a malformed line keeps finding it.
 *
 * ARCHIVE NAMES. A moved line goes to `<name>.<YYYY-MM>.jsonl.gz`, the month
 * of the LINE's timestamp in UTC (`events.2026-09.jsonl.gz`). An archive is
 * never rewritten. When `<name>.<YYYY-MM>.jsonl.gz` already exists the new
 * lines go to `<name>.<YYYY-MM>.part2.jsonl.gz`, then part3, and so on. Each
 * archive is created exclusively (a hard link from a staged file), so a
 * second rotator that raced this one picks the next number instead of
 * overwriting. Readers of history concatenate every part; gzip members
 * concatenate, so `zcat events.2026-09*.jsonl.gz` reads them all.
 *
 * APPEND SAFETY. Each ledger is rotated under `<ledger>.write-lock`
 * (ledger-lock.js), the lock the ledger's own writers take. The order is
 * archive first, hot file second: a crash between them leaves a line in BOTH
 * places (a duplicate in history), never in neither. A failure replacing the
 * hot file removes the archives this run made. A writer that appends without
 * the lock cannot be excluded, so just before the replace the file is
 * re-measured and any bytes appended since the read are carried into the new
 * hot file. The rewrite is a temp file plus rename. A file that is shorter
 * than it was read refuses the rewrite.
 *
 * WHAT IT TOUCHES. Only `*.jsonl` files directly in the state dir
 * (--dir, else $AUTODEV_LEDGER_DIR, else `<config dir>/autodev`), not
 * subfolders and not the `.gz` archives. A file with no old line is not
 * rewritten, not even to normalise it.
 *
 *   node ledger-rotate.js [--dir DIR] [--days N] [--dry-run] [--file NAME]...
 *   node ledger-rotate.js --help
 *
 * `--dry-run` prints the counts and changes nothing. Exit 0 done, 2 when a
 * ledger could not be rotated (locked, unreadable, unwritable): the other
 * ledgers are still rotated and the failure is named.
 * Test seam: AUTODEV_LEDGER_NOW is an ISO time that replaces the clock.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { withLedgerLock, writeAtomic } = require('./ledger-lock.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const TS_FIELDS = ['at', 'ts', 'timestamp', 'time', 'date', 'createdAt', 'created_at', 'startedAt', 'started_at', 'recordedAt', 'sentAt', 'when'];
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const MAX_PARTS = 999;

function stateDir(env = process.env) {
    return path.resolve(env.AUTODEV_LEDGER_DIR || path.join(require('./claude-paths.js').configDir(env), 'autodev'));
}

/** Epoch ms of a value, or null. Epoch numbers: >= 1e12 is ms, >= 1e9 is seconds. */
function parseStamp(v) {
    if (typeof v === 'number' && Number.isFinite(v)) {
        if (v >= 1e12) return v;
        if (v >= 1e9) return v * 1000;
        return null;
    }
    if (typeof v === 'string' && ISO_LIKE.test(v.trim())) {
        const t = Date.parse(v.trim());
        return Number.isFinite(t) ? t : null;
    }
    return null;
}

/** The timestamp of one ledger line in epoch ms, or null when it has none. */
function lineStamp(line) {
    const text = line.trim();
    if (!text.startsWith('{')) return null;
    let o;
    try { o = JSON.parse(text); } catch { return null; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    for (const f of TS_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(o, f)) {
            const t = parseStamp(o[f]);
            if (t !== null) return t;
        }
    }
    return null;
}

const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

/**
 * Split a ledger's text (decoded as latin1, so every byte survives the round
 * trip). { hot: string[], old: Map<month, string[]>, counts }. Lines keep their
 * exact bytes (a trailing \r included). The final newline is not a line. When
 * the text does not end in a newline its last line may still be being written:
 * it stays hot whatever its timestamp says.
 */
function partition(text, cutoffMs) {
    const rows = text.split('\n');
    const complete = rows[rows.length - 1] === '';
    if (complete) rows.pop();
    const hot = [];
    const old = new Map();
    const counts = { total: rows.length, old: 0, hot: 0, unstamped: 0 };
    rows.forEach((line, i) => {
        const t = lineStamp(line);
        if (t === null) counts.unstamped++;
        const pending = !complete && i === rows.length - 1;
        if (t !== null && t < cutoffMs && !pending) {
            const m = monthOf(t);
            if (!old.has(m)) old.set(m, []);
            old.get(m).push(line);
            counts.old++;
        } else {
            hot.push(line);
            counts.hot++;
        }
    });
    return { hot, old, counts, complete };
}

/** Create `target` with `data` only if it does not exist: true when created. */
function createExclusive(target, data) {
    const tmp = `${target}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(tmp, data);
        try { fs.linkSync(tmp, target); return true; } catch (e) {
            if (e.code === 'EEXIST') return false;
            // No hard links on this volume: an exclusive create, then the bytes.
            let fd;
            try { fd = fs.openSync(target, 'wx'); } catch (e2) { if (e2.code === 'EEXIST') return false; throw e2; }
            try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
            return true;
        }
    } finally {
        try { fs.unlinkSync(tmp); } catch { /* linked or never written */ }
    }
}

/** The archive name for a month: the plain name, then part2, part3, ... */
function archiveName(base, month, part) {
    return part === 1 ? `${base}.${month}.jsonl.gz` : `${base}.${month}.part${part}.jsonl.gz`;
}

/** Write `lines` as a new archive for the month; returns the file name. Never overwrites. */
function writeArchive(dir, base, month, lines) {
    const data = zlib.gzipSync(Buffer.from(lines.join('\n') + '\n', 'latin1'));
    for (let part = 1; part <= MAX_PARTS; part++) {
        const name = archiveName(base, month, part);
        if (createExclusive(path.join(dir, name), data)) return name;
    }
    throw Object.assign(new Error(`more than ${MAX_PARTS} archive parts for ${base} ${month}`), { code: 'TOO_MANY_PARTS' });
}

/** The first archive name a write would use now (for a dry run). */
function nextArchiveName(dir, base, month) {
    for (let part = 1; part <= MAX_PARTS; part++) {
        const name = archiveName(base, month, part);
        if (!fs.existsSync(path.join(dir, name))) return name;
    }
    return archiveName(base, month, MAX_PARTS + 1);
}

/**
 * Rotate one ledger. Returns { file, ok, rotated, counts, perMonth, archives, why }.
 * `dryRun` measures and changes nothing.
 */
function rotateFile(file, { cutoffMs, dryRun = false, waitMs = 10000 } = {}) {
    const dir = path.dirname(file);
    const base = path.basename(file, '.jsonl');
    const result = { file, ok: true, rotated: false, counts: null, perMonth: {}, archives: [], why: null };
    const body = () => {
        const buf = fs.readFileSync(file);
        const part = partition(buf.toString('latin1'), cutoffMs);
        result.counts = part.counts;
        result.perMonth = Object.fromEntries([...part.old].map(([m, ls]) => [m, ls.length]));
        if (part.counts.old === 0) return;
        if (dryRun) {
            result.archives = [...part.old.keys()].sort().map((m) => nextArchiveName(dir, base, m));
            return;
        }
        const made = [];
        try {
            for (const m of [...part.old.keys()].sort()) made.push(writeArchive(dir, base, m, part.old.get(m)));
            let hot = Buffer.from(part.hot.join('\n') + (part.hot.length && part.complete ? '\n' : ''), 'latin1');
            // Bytes a writer that takes no lock appended since the read belong to the hot file.
            let seen = buf.length;
            for (let pass = 0; ; pass++) {
                const size = fs.statSync(file).size;
                if (size < seen) throw Object.assign(new Error('the ledger shrank while it was being rotated'), { code: 'SHRANK' });
                if (size === seen) break;
                if (pass >= 5) throw Object.assign(new Error('the ledger kept growing while it was being rotated'), { code: 'GREW' });
                const tail = Buffer.alloc(size - seen);
                const fd = fs.openSync(file, 'r');
                try { fs.readSync(fd, tail, 0, tail.length, seen); } finally { fs.closeSync(fd); }
                hot = Buffer.concat([hot, tail]);
                seen = size;
            }
            writeAtomic(file, hot);
        } catch (e) {
            for (const name of made) { try { fs.unlinkSync(path.join(dir, name)); } catch { /* already gone */ } }
            throw e;
        }
        result.rotated = true;
        result.archives = made;
    };
    try {
        if (dryRun) body();
        else withLedgerLock(file, body, { waitMs });
    } catch (e) {
        result.ok = false;
        result.rotated = false;
        result.archives = [];
        result.why = e.code === 'LEDGER_LOCKED' ? `locked (${e.why || 'held'})` : (e.code || e.message);
    }
    return result;
}

/** Every `*.jsonl` directly in `dir`, optionally narrowed to `only` names. */
function ledgersIn(dir, only = []) {
    const names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') && !n.endsWith('.tmp'));
    const picked = only.length ? names.filter((n) => only.includes(n)) : names;
    return picked.filter((n) => { try { return fs.statSync(path.join(dir, n)).isFile(); } catch { return false; } }).sort();
}

const USAGE = [
    'ledger-rotate.js - gzip the old lines of the autodev *.jsonl ledgers',
    '',
    '  node ledger-rotate.js [--dir DIR] [--days N] [--dry-run] [--file NAME]...',
    '',
    '  --dir DIR    the ledger dir (default $AUTODEV_LEDGER_DIR, else <config dir>/autodev)',
    '  --days N     lines older than N days move (default 30)',
    '  --file NAME  only this ledger (repeatable); default every *.jsonl in the dir',
    '  --dry-run    print the counts, change nothing',
    '',
    'Lines with no parseable timestamp stay in the hot file. Archives are <name>.<YYYY-MM>.jsonl.gz,',
    'then <name>.<YYYY-MM>.part2.jsonl.gz when one exists. Exit 0 done, 2 a ledger could not be rotated.',
].join('\n');

function parseArgs(argv) {
    const a = { dir: null, days: 30, dryRun: false, files: [] };
    for (let i = 0; i < argv.length; i++) {
        const v = argv[i];
        if (v === '--dry-run') a.dryRun = true;
        else if (v === '--dir') a.dir = argv[++i];
        else if (v === '--days') a.days = Number(argv[++i]);
        else if (v === '--file') a.files.push(argv[++i]);
        else if (v === '--help' || v === '-h') a.help = true;
        else throw new Error(`unrecognised argument: ${v}`);
    }
    if (!Number.isFinite(a.days) || a.days < 0) throw new Error('--days needs a number of days, 0 or more');
    if (a.dir === undefined || a.files.includes(undefined)) throw new Error('a flag is missing its value');
    return a;
}

function main(argv, env = process.env) {
    let a;
    try { a = parseArgs(argv); } catch (e) {
        process.stderr.write(`ledger-rotate: ${e.message}\n`);
        return 2;
    }
    if (a.help) { process.stdout.write(USAGE + '\n'); return 0; }
    const dir = a.dir ? path.resolve(a.dir) : stateDir(env);
    let names;
    try { names = ledgersIn(dir, a.files); } catch (e) {
        process.stderr.write(`ledger-rotate: cannot list ${dir} (${e.code || e.message})\n`);
        return 2;
    }
    const nowMs = env.AUTODEV_LEDGER_NOW && Number.isFinite(Date.parse(env.AUTODEV_LEDGER_NOW)) ? Date.parse(env.AUTODEV_LEDGER_NOW) : Date.now();
    const cutoffMs = nowMs - a.days * DAY_MS;
    const out = [`ledger-rotate: ${a.dryRun ? 'DRY RUN ' : ''}${names.length} ledger(s) in ${dir}, lines older than ${a.days} day(s) (before ${new Date(cutoffMs).toISOString()})`];
    let failed = 0;
    for (const name of names) {
        const r = rotateFile(path.join(dir, name), { cutoffMs, dryRun: a.dryRun });
        if (!r.ok) {
            failed++;
            out.push(`  ${name}: NOT rotated: ${r.why}`);
            continue;
        }
        const c = r.counts;
        const months = Object.entries(r.perMonth || {}).sort().map(([m, n]) => `${m}: ${n}`).join(', ');
        out.push(c.old === 0
            ? `  ${name}: ${c.total} line(s), none old, ${c.unstamped} without a timestamp`
            : `  ${name}: ${c.total} line(s), ${c.old} ${a.dryRun ? 'would move' : 'moved'} to ${r.archives.join(', ')} (${months}), ${c.hot} stay hot (${c.unstamped} without a timestamp)`);
    }
    process.stdout.write(out.join('\n') + '\n');
    return failed ? 2 : 0;
}

module.exports = { stateDir, parseStamp, lineStamp, partition, rotateFile, ledgersIn, archiveName, TS_FIELDS };

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}
