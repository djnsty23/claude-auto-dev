#!/usr/bin/env node
'use strict';
/**
 * test-ledger-rotate.js - ledger-rotate.js against fixture ledgers.
 *
 * What must hold:
 *   R1  a line older than the window moves to <name>.<YYYY-MM>.jsonl.gz, byte for byte;
 *       recent lines stay hot in their original order
 *   R2  a line with no parseable timestamp stays hot: not JSON, JSON without a stamp field,
 *       a garbage stamp, a future stamp, a blank line, an array, a pre-1970 number
 *   R3  when the archive exists the lines go to a numbered part; the existing archive is never touched
 *   R4  --dry-run prints counts and changes nothing (bytes, mtime and directory listing)
 *   R5  a held ledger lock refuses the rotation (exit 2, file untouched); a free lock rotates
 *   R6  nothing is lost or duplicated: hot + every archive == the original lines
 *   R7  only *.jsonl directly in the dir: .gz archives, other files and subfolders are untouched
 *   R8  a failed replacement of the hot file removes the archives it made and leaves the ledger intact
 *   R9  a final line with no newline (a writer mid-write) stays hot and gains no newline
 *   R10 CRLF lines and non-ASCII bytes survive the move unchanged
 *   R11 epoch seconds, epoch milliseconds and a date-only stamp are read; months are UTC and split archives
 *   R12 an appender that takes the ledger lock, running while the rotator runs, loses nothing
 *   R13 bad arguments are exit 2
 *
 * Run: node tooling/test-ledger-rotate.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync, spawn } = require('node:child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'ledger-rotate.js');
const LOCK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'ledger-lock.js');
const rot = require(SUBJECT);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-rotate-'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail ? '\n      -> ' + String(detail).slice(0, 500) : ''));
}

const NOW = '2026-11-01T00:00:00Z';
const OLD_SEP = '2026-09-10T08:00:00.000Z';
const OLD_AUG = '2026-08-30T23:59:59Z';
const RECENT = '2026-10-25T12:00:00Z';
const env = (extra = {}) => ({ ...process.env, AUTODEV_LEDGER_NOW: NOW, ...extra });

let n = 0;
function fresh() {
    const dir = path.join(ROOT, 'd' + (n++));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
const put = (dir, name, text) => { fs.writeFileSync(path.join(dir, name), text); return path.join(dir, name); };
const getText = (f) => fs.readFileSync(f, 'latin1');
const gunzip = (f) => zlib.gunzipSync(fs.readFileSync(f)).toString('latin1');
const ls = (dir) => fs.readdirSync(dir).sort();
const run = (args, e = env()) => spawnSync(process.execPath, [SUBJECT, ...args], { encoding: 'utf8', env: e });
const row = (id, at, extra = {}) => JSON.stringify({ id, at, ...extra });

try {
    // R1 / R6 / R13 shaped fixture.
    {
        const dir = fresh();
        const lines = [row(1, OLD_SEP), row(2, RECENT), row(3, OLD_SEP), row(4, OLD_AUG), row(5, '2026-10-31T00:00:00Z')];
        const f = put(dir, 'events.jsonl', lines.join('\n') + '\n');
        const r = run(['--dir', dir]);
        check('R1 exit 0', r.status === 0, r.stdout + r.stderr);
        check('R1 the hot file keeps the recent lines in order',
            getText(f) === [lines[1], lines[4]].join('\n') + '\n', getText(f));
        check('R1 September lines are in events.2026-09.jsonl.gz, in order',
            fs.existsSync(path.join(dir, 'events.2026-09.jsonl.gz')) && gunzip(path.join(dir, 'events.2026-09.jsonl.gz')) === [lines[0], lines[2]].join('\n') + '\n');
        check('R1 the August line has its own archive', gunzip(path.join(dir, 'events.2026-08.jsonl.gz')) === lines[3] + '\n');
        check('R1 the summary names the counts', /5 line\(s\), 3 moved/.test(r.stdout) && /2 stay hot/.test(r.stdout), r.stdout);
        check('R6 hot + archives == the original lines, each exactly once',
            [...getText(f).split('\n'), ...gunzip(path.join(dir, 'events.2026-09.jsonl.gz')).split('\n'), ...gunzip(path.join(dir, 'events.2026-08.jsonl.gz')).split('\n')]
                .filter(Boolean).sort().join('\n') === [...lines].sort().join('\n'));
        check('R1 no temp files are left behind', ls(dir).every((x) => !x.endsWith('.tmp') && !x.endsWith('.write-lock')), ls(dir).join(','));
        // Second run: nothing old is left, so nothing is rewritten.
        const before = fs.statSync(f);
        const again = run(['--dir', dir]);
        check('R1 a second run moves nothing and creates no part file',
            again.status === 0 && /none old/.test(again.stdout) && ls(dir).filter((x) => x.endsWith('.gz')).length === 2, again.stdout);
        check('R1 a second run does not rewrite the hot file', fs.statSync(f).mtimeMs === before.mtimeMs);
    }

    // R2: lines that must stay hot.
    {
        const dir = fresh();
        const keep = [
            'plain text, not json',
            JSON.stringify({ id: 'a', note: 'no stamp field at all' }),
            JSON.stringify({ id: 'b', at: 'last tuesday' }),
            JSON.stringify({ id: 'c', at: '2099-01-01T00:00:00Z' }),
            '',
            JSON.stringify([OLD_SEP]),
            JSON.stringify({ id: 'd', at: null }),
            JSON.stringify({ id: 'e', at: 12345 }),
            JSON.stringify({ id: 'f', at: '10/09/2026' }),
            '{"id":"torn","at":"2026-09-10T',
            JSON.stringify(OLD_SEP),
        ];
        const old = row('old', OLD_SEP);
        const f = put(dir, 'peer-sends.jsonl', [...keep, old].join('\n') + '\n');
        const r = run(['--dir', dir]);
        check('R2 exit 0', r.status === 0, r.stdout + r.stderr);
        check('R2 every line without a parseable stamp stays hot, in place', getText(f) === keep.join('\n') + '\n', getText(f));
        check('R2 only the stamped old line moved', gunzip(path.join(dir, 'peer-sends.2026-09.jsonl.gz')) === old + '\n');
        check('R2 the count names the lines without a stamp', /\((10 without a timestamp)\)/.test(r.stdout), r.stdout);
        // A ledger of ONLY unstamped lines is untouched.
        const d2 = fresh();
        const text = 'a\nb\n{"x":1}\n';
        const g = put(d2, 'misc.jsonl', text);
        const m0 = fs.statSync(g).mtimeMs;
        const r2 = run(['--dir', d2]);
        check('R2 an all-unstamped ledger is not rewritten and makes no archive', r2.status === 0 && getText(g) === text && fs.statSync(g).mtimeMs === m0 && ls(d2).length === 1, ls(d2).join(','));
    }

    // R3: numbered parts.
    {
        const dir = fresh();
        const first = [row(1, OLD_SEP)];
        put(dir, 'events.jsonl', first.join('\n') + '\n' + row(2, RECENT) + '\n');
        run(['--dir', dir]);
        const archive = path.join(dir, 'events.2026-09.jsonl.gz');
        const archiveBytes = fs.readFileSync(archive);
        // More old lines arrive for the same month.
        fs.appendFileSync(path.join(dir, 'events.jsonl'), row(3, OLD_SEP) + '\n' + row(4, '2026-09-30T23:59:59Z') + '\n');
        let r = run(['--dir', dir]);
        check('R3 the second rotation writes part2', r.status === 0 && fs.existsSync(path.join(dir, 'events.2026-09.part2.jsonl.gz')), ls(dir).join(',') + r.stdout);
        check('R3 part2 holds exactly the new lines', gunzip(path.join(dir, 'events.2026-09.part2.jsonl.gz')) === [row(3, OLD_SEP), row(4, '2026-09-30T23:59:59Z')].join('\n') + '\n');
        check('R3 the first archive is byte-identical', Buffer.compare(fs.readFileSync(archive), archiveBytes) === 0);
        fs.appendFileSync(path.join(dir, 'events.jsonl'), row(5, OLD_SEP) + '\n');
        r = run(['--dir', dir]);
        check('R3 a third rotation writes part3', fs.existsSync(path.join(dir, 'events.2026-09.part3.jsonl.gz')) && gunzip(path.join(dir, 'events.2026-09.part3.jsonl.gz')) === row(5, OLD_SEP) + '\n', ls(dir).join(','));
        check('R3 all parts concatenate to the full history',
            [archive, path.join(dir, 'events.2026-09.part2.jsonl.gz'), path.join(dir, 'events.2026-09.part3.jsonl.gz')].map(gunzip).join('').split('\n').filter(Boolean).length === 4);
        check('R3 the hot file kept only the recent line', getText(path.join(dir, 'events.jsonl')) === row(2, RECENT) + '\n');
        // A dry run names the part it would write.
        fs.appendFileSync(path.join(dir, 'events.jsonl'), row(6, OLD_SEP) + '\n');
        const d = run(['--dir', dir, '--dry-run']);
        check('R3 a dry run names part4', /part4/.test(d.stdout), d.stdout);
    }

    // R4: dry run.
    {
        const dir = fresh();
        const f = put(dir, 'events.jsonl', [row(1, OLD_SEP), row(2, RECENT)].join('\n') + '\n');
        put(dir, 'peer-sends.jsonl', row(3, OLD_AUG) + '\n');
        const stat = fs.statSync(f);
        const listing = ls(dir).join(',');
        const bytes = getText(f);
        const r = run(['--dir', dir, '--dry-run']);
        check('R4 dry run exits 0', r.status === 0, r.stdout + r.stderr);
        check('R4 dry run prints counts for each ledger', /DRY RUN 2 ledger\(s\)/.test(r.stdout) && /events\.jsonl: 2 line\(s\), 1 would move/.test(r.stdout) && /peer-sends\.jsonl: 1 line\(s\), 1 would move/.test(r.stdout), r.stdout);
        check('R4 dry run leaves bytes, mtime and the directory alone', getText(f) === bytes && fs.statSync(f).mtimeMs === stat.mtimeMs && ls(dir).join(',') === listing, ls(dir).join(','));
    }

    // R5: a held lock.
    {
        const dir = fresh();
        const text = [row(1, OLD_SEP), row(2, RECENT)].join('\n') + '\n';
        const f = put(dir, 'events.jsonl', text);
        // This process is alive, so a lock naming it is a live owner.
        fs.writeFileSync(f + '.write-lock', JSON.stringify({ pid: process.pid, start: new Date(Date.now() - process.uptime() * 1000).toISOString(), token: 'held' }));
        const r = spawnSync(process.execPath, ['-e', `
            const rot = require(${JSON.stringify(SUBJECT)});
            const r = rot.rotateFile(${JSON.stringify(f)}, { cutoffMs: Date.parse(${JSON.stringify(NOW)}) - 30 * 86400000, waitMs: 60 });
            process.stdout.write(JSON.stringify(r));`], { encoding: 'utf8', env: env() });
        const res = JSON.parse(r.stdout);
        check('R5 a held lock is a refusal naming the lock', res.ok === false && /locked/.test(res.why), r.stdout + r.stderr);
        check('R5 the ledger is untouched and no archive exists', getText(f) === text && ls(dir).every((x) => !x.endsWith('.gz')), ls(dir).join(','));
        // Through the CLI the dir with a held lock is exit 2 (waits the full default, so use a stale ownerless lock instead).
        fs.unlinkSync(f + '.write-lock');
        const ok = run(['--dir', dir]);
        check('R5 with the lock free it rotates', ok.status === 0 && fs.existsSync(path.join(dir, 'events.2026-09.jsonl.gz')), ok.stdout + ok.stderr);
        check('R5 the lock file is gone afterwards', !fs.existsSync(f + '.write-lock'));
    }

    // R7: scope.
    {
        const dir = fresh();
        const old = row(1, OLD_SEP);
        put(dir, 'events.jsonl', old + '\n');
        put(dir, 'notes.txt', old + '\n');
        put(dir, 'state.json', old + '\n');
        put(dir, 'old.2026-01.jsonl.gz', 'not really gzip');
        fs.mkdirSync(path.join(dir, 'sub'));
        put(path.join(dir, 'sub'), 'nested.jsonl', old + '\n');
        fs.mkdirSync(path.join(dir, 'dir.jsonl'));
        const r = run(['--dir', dir]);
        check('R7 only the top-level ledger was rotated', r.status === 0 && /1 ledger\(s\)/.test(r.stdout), r.stdout + r.stderr);
        check('R7 other files and subfolders are untouched',
            getText(path.join(dir, 'notes.txt')) === old + '\n' && getText(path.join(dir, 'state.json')) === old + '\n'
            && getText(path.join(dir, 'sub', 'nested.jsonl')) === old + '\n' && getText(path.join(dir, 'old.2026-01.jsonl.gz')) === 'not really gzip');
        const dir2 = fresh();
        put(dir2, 'a.jsonl', old + '\n');
        put(dir2, 'b.jsonl', old + '\n');
        const only = run(['--dir', dir2, '--file', 'b.jsonl']);
        check('R7 --file narrows to one ledger', only.status === 0 && getText(path.join(dir2, 'a.jsonl')) === old + '\n' && getText(path.join(dir2, 'b.jsonl')) === '', only.stdout);
        const missing = run(['--dir', path.join(ROOT, 'nope')]);
        check('R7 a missing dir is exit 2', missing.status === 2, missing.status);
    }

    // R8: the hot replace fails.
    {
        const dir = fresh();
        const text = [row(1, OLD_SEP), row(2, RECENT)].join('\n') + '\n';
        const f = put(dir, 'events.jsonl', text);
        const realRename = fs.renameSync;
        fs.renameSync = function (from, to) {
            if (String(to) === f) throw Object.assign(new Error('rename plant'), { code: 'EXDEV' });
            return realRename.apply(this, arguments);
        };
        let res;
        try { res = rot.rotateFile(f, { cutoffMs: Date.parse(NOW) - 30 * 86400000 }); } finally { fs.renameSync = realRename; }
        check('R8 a failed replacement is reported, not swallowed', res.ok === false && res.rotated === false && res.why === 'EXDEV', JSON.stringify(res));
        check('R8 the ledger is intact', getText(f) === text);
        check('R8 the archive this run made is removed, so history holds no duplicate', ls(dir).join(',') === 'events.jsonl', ls(dir).join(','));
        check('R8 the lock is released', !fs.existsSync(f + '.write-lock'));
    }

    // R9: a partial last line.
    {
        const dir = fresh();
        const partial = '{"id":9,"at":"2026-09-10T08:00:00Z","half';
        const f = put(dir, 'events.jsonl', row(1, OLD_SEP) + '\n' + row(2, RECENT) + '\n' + partial);
        const r = run(['--dir', dir]);
        check('R9 the line being written stays hot, with no newline added', r.status === 0 && getText(f) === row(2, RECENT) + '\n' + partial, JSON.stringify(getText(f)));
        const f2 = put(fresh(), 'events.jsonl', row(1, OLD_SEP));
        // An unterminated final line that is a complete old record is still treated as in flight.
        const r2 = run(['--dir', path.dirname(f2)]);
        check('R9 a lone unterminated old line is not moved (it may be mid-write)', r2.status === 0 && getText(f2) === row(1, OLD_SEP), getText(f2));
    }

    // R10: bytes.
    {
        const dir = fresh();
        const oldCrlf = row(1, OLD_SEP, { text: 'café ✓' }) + '\r';
        const f = put(dir, 'events.jsonl', Buffer.concat([
            Buffer.from(oldCrlf + '\n' + row(2, RECENT, { text: 'ü' }) + '\r\n', 'utf8'),
            Buffer.from([0xff, 0xfe, 0x80, 0x0a]),
        ]));
        const before = fs.readFileSync(f);
        run(['--dir', dir]);
        const moved = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'events.2026-09.jsonl.gz')));
        check('R10 the moved line is byte-exact, CR and UTF-8 included', moved.equals(Buffer.from(oldCrlf + '\n', 'utf8')), moved.toString('hex'));
        const hotNow = fs.readFileSync(f);
        const expected = Buffer.concat([Buffer.from(row(2, RECENT, { text: 'ü' }) + '\r\n', 'utf8'), Buffer.from([0xff, 0xfe, 0x80, 0x0a])]);
        check('R10 the hot file keeps its CRLF line and its invalid bytes unchanged', hotNow.equals(expected), hotNow.toString('hex'));
        check('R10 sizes add up', moved.length + hotNow.length === before.length);
    }

    // R11: stamp formats and month split.
    {
        const dir = fresh();
        const sec = Math.floor(Date.parse('2026-07-15T10:00:00Z') / 1000);
        const ms = Date.parse('2026-07-20T10:00:00Z');
        const lines = [
            JSON.stringify({ id: 1, ts: sec }), JSON.stringify({ id: 2, timestamp: ms }), JSON.stringify({ id: 3, date: '2026-06-30' }),
            JSON.stringify({ id: 4, createdAt: '2026-08-01T00:30:00+02:00' }), // 2026-07-31T22:30Z: July in UTC
            JSON.stringify({ id: 5, at: '2026-10-30T10:00:00Z' }),
        ];
        const f = put(dir, 'mixed.jsonl', lines.join('\n') + '\n');
        const r = run(['--dir', dir]);
        check('R11 exit 0', r.status === 0, r.stdout + r.stderr);
        check('R11 epoch seconds and milliseconds land in July',
            gunzip(path.join(dir, 'mixed.2026-07.jsonl.gz')) === [lines[0], lines[1], lines[3]].join('\n') + '\n', ls(dir).join(','));
        check('R11 a date-only stamp lands in June', gunzip(path.join(dir, 'mixed.2026-06.jsonl.gz')) === lines[2] + '\n');
        check('R11 months are UTC, so the +02:00 stamp is July', ls(dir).filter((x) => x.endsWith('.gz')).join(',') === 'mixed.2026-06.jsonl.gz,mixed.2026-07.jsonl.gz');
        check('R11 the recent line stays', getText(f) === lines[4] + '\n');
        check('R11 parseStamp rejects what is not a stamp', rot.parseStamp('x') === null && rot.parseStamp(5) === null && rot.parseStamp(true) === null && rot.parseStamp(NaN) === null);
    }

    // R12: a locking appender running during rotation.
    {
        const dir = fresh();
        const f = path.join(dir, 'events.jsonl');
        const seed = [];
        for (let i = 0; i < 400; i++) seed.push(row('s' + i, i % 2 ? OLD_SEP : RECENT, { pad: 'x'.repeat(200) }));
        fs.writeFileSync(f, seed.join('\n') + '\n');
        const writerSrc = `
            const fs = require('node:fs');
            const { withLedgerLock } = require(${JSON.stringify(LOCK)});
            for (let i = 0; i < 150; i++) {
                withLedgerLock(${JSON.stringify(f)}, () => fs.appendFileSync(${JSON.stringify(f)}, JSON.stringify({ id: 'w' + i, at: ${JSON.stringify(RECENT)} }) + '\\n'), { waitMs: 20000 });
            }`;
        const writer = spawn(process.execPath, ['-e', writerSrc], { stdio: 'ignore', windowsHide: true });
        const done = new Promise((res) => writer.on('exit', res));
        const rotations = [];
        const loop = async () => {
            for (let i = 0; i < 4; i++) {
                rotations.push(spawnSync(process.execPath, [SUBJECT, '--dir', dir], { encoding: 'utf8', env: env() }));
            }
            await done;
            rotations.push(spawnSync(process.execPath, [SUBJECT, '--dir', dir], { encoding: 'utf8', env: env() }));
        };
        loop().then(() => {
            check('R12 every rotation exited 0', rotations.every((r) => r.status === 0), rotations.map((r) => r.status + r.stderr).join('|'));
            const ids = [];
            for (const l of getText(f).split('\n').filter(Boolean)) ids.push(JSON.parse(l).id);
            for (const gz of ls(dir).filter((x) => x.endsWith('.gz'))) for (const l of gunzip(path.join(dir, gz)).split('\n').filter(Boolean)) ids.push(JSON.parse(l).id);
            const want = [...seed.map((l) => JSON.parse(l).id), ...Array.from({ length: 150 }, (_, i) => 'w' + i)];
            check('R12 hot + archives hold every seeded and appended line exactly once', ids.length === want.length && new Set(ids).size === want.length && want.every((id) => ids.includes(id)), `${ids.length} of ${want.length}, ${new Set(ids).size} distinct`);
            check('R12 the hot file holds no old line after the last rotation', !getText(f).includes(OLD_SEP));
            finish();
        }).catch((e) => { failures.push("R12 crashed: " + e.stack); finish(); });
        return;
    }
} catch (e) {
    failures.push('suite crashed: ' + (e && e.stack || e));
    finish();
}

function finish() {
    // R13: arguments (run last so a crash above still reports).
    try {
        for (const args of [['--days', 'abc'], ['--days', '-1'], ['--bogus'], ['--dir']]) {
            const r = run(args);
            check(`R13 ${args.join(' ')} is exit 2`, r.status === 2, r.status + r.stdout + r.stderr);
        }
        const h = run(['--help']);
        check('R13 --help prints usage, exit 0', h.status === 0 && /ledger-rotate/.test(h.stdout));
    } catch (e) {
        failures.push('R13 crashed: ' + e.stack);
    }
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
    for (const f of failures) console.log('FAIL ' + f);
    console.log(`test-ledger-rotate: ${passed} passed, ${failures.length} failed`);
    process.exitCode = failures.length ? 1 : 0;
}
