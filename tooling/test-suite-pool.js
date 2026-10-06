#!/usr/bin/env node
// test-suite-pool.js - drives tooling/test-all-pool.js, the optional executor
// test-all.js loads to run suites several at a time.
//
// What a broken pool looks like, and which case catches it:
//   - more than N at once, or one at a time when N was asked   -> concurrency
//   - a serial suite overlapping anything                     -> barrier, and the
//     real-process cases: two suites writing one shared file, two binding one port
//   - a suite dropped or run twice                            -> population
//   - resolving while a suite still runs (validate would start early) -> settle
//   - a failed suite's result lost or rewritten               -> aggregation, and
//     the end-to-end run of the real test-all.js, which must exit 1
//   - a suite's log printed cut short                         -> full log
//   - pooling on by default, or past the manifest             -> default serial,
//     unknown, changed and malformed manifests
//   - the reviewed manifest losing a known serial seed        -> manifest cases
//
// Every case runs in temp directories; the real tree is only read.
// Run: node tooling/test-suite-pool.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const TOOLING = __dirname;
const pool = require('./test-all-pool.js');
const SUBJECT = require.resolve('./test-all-pool.js');

const results = [];
const check = (label, ok, detail) => {
    results.push({ label, ok: !!ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : '\n      ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`);
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-pool-'));
// The run directory a fake runOne writes its logs into, as test-all.js does.
const LOGS = fs.mkdtempSync(path.join(TMP, 'runlogs-'));
fs.mkdirSync(path.join(LOGS, 'logs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sink = () => {
    const chunks = [];
    const w = (c) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); return Buffer.isBuffer(c) ? c.length : Buffer.byteLength(String(c)); };
    w.text = () => Buffer.concat(chunks).toString('utf8');
    return w;
};

// A fake runOne that records overlap. Each item's ms says how long it "runs".
function recorder(opts) {
    const o = opts || {};
    const rec = { active: 0, max: 0, calls: [], events: [], pending: 0 };
    rec.runOne = async (item, opt) => {
        rec.calls.push(item.label);
        rec.active++; rec.pending++;
        rec.max = Math.max(rec.max, rec.active);
        rec.events.push({ t: 'start', label: item.label, activeAfter: rec.active, echo: !opt || opt.echo !== false });
        await sleep(item.ms === undefined ? 20 : item.ms);
        rec.active--; rec.pending--;
        rec.events.push({ t: 'end', label: item.label });
        if (o.reject && o.reject === item.label) throw new Error('runOne broke');
        fs.writeFileSync(path.join(LOGS, 'logs', item.label + '.log'), `${item.label} output\n`);
        return { label: item.label, state: item.state || 'pass', reason: null, log: 'logs/' + item.label + '.log' };
    };
    return rec;
}

// A manifest file in TMP marking each label parallel or serial, with hashes of
// suite files written beside it.
function fixtureManifest(dir, modes) {
    const suites = {};
    for (const [label, mode] of Object.entries(modes)) {
        const file = path.join(dir, label + '.js');
        if (!fs.existsSync(file)) fs.writeFileSync(file, `// fixture ${label}\n`);
        suites[label + '.js'] = { isolation: mode, reason: 'fixture', sha256: pool.hashFile(file) };
    }
    const m = path.join(dir, 'suite-isolation.json');
    fs.writeFileSync(m, JSON.stringify({ schema: 1, suites }));
    return m;
}

async function main() {
    // ---- pool size -------------------------------------------------------
    check('unset means serial (size 1)', pool.poolSize({}).size === 1);
    check('AUTODEV_TEST_POOL=4 means 4', pool.poolSize({ AUTODEV_TEST_POOL: '4' }).size === 4);
    const big = pool.poolSize({ AUTODEV_TEST_POOL: '32' });
    check('a size above 8 is held to 8, with a warning', big.size === 8 && /cap/.test(big.warning || ''), big);
    const junk = pool.poolSize({ AUTODEV_TEST_POOL: 'eight' });
    check('a non-number is serial, with a warning', junk.size === 1 && !!junk.warning, junk);
    check('0 is serial', pool.poolSize({ AUTODEV_TEST_POOL: '0' }).size === 1);

    // ---- default serial: identical to test-all.js runSerial ---------------
    {
        const dir = fs.mkdtempSync(path.join(TMP, 'serial-'));
        const labels = ['test-a', 'test-b', 'test-c', 'test-d'];
        const manifest = fixtureManifest(dir, Object.fromEntries(labels.map((l) => [l, 'parallel'])));
        const rec = recorder();
        const out = sink();
        const err = sink();
        const got = await pool.runSuites(labels.map((label) => ({ label })), rec.runOne, { env: {}, manifest, dir, out, err, noLogs: false });
        check('pool unset: one suite at a time even when all are parallel', rec.max === 1, rec.max);
        check('pool unset: results in discovery order, one each', got.map((r) => r.label).join() === labels.join(), got.map((r) => r.label));
        check('pool unset: prints the same === headers runSerial prints, nothing else', out.text() === labels.map((l) => `\n=== ${l} ===\n`).join('') && err.text() === '', { out: out.text(), err: err.text() });
        check('pool unset: every suite echoes its own output', rec.events.filter((e) => e.t === 'start').every((e) => e.echo));
    }

    // ---- concurrency cap -------------------------------------------------
    {
        const dir = fs.mkdtempSync(path.join(TMP, 'cap-'));
        const labels = Array.from({ length: 20 }, (_, i) => `test-p${String(i).padStart(2, '0')}`);
        const manifest = fixtureManifest(dir, Object.fromEntries(labels.map((l) => [l, 'parallel'])));
        const rec = recorder();
        const got = await pool.runSuites(labels.map((label) => ({ label, ms: 40 })), rec.runOne,
            { env: { AUTODEV_TEST_POOL: '8' }, manifest, dir, out: sink(), err: sink(), noLogs: false, runDir: LOGS });
        check('pool 8: never more than 8 suites at once (a ninth worker is a defect)', rec.max <= 8, rec.max);
        check('pool 8: does reach 8 at once on 20 parallel suites', rec.max === 8, rec.max);
        check('pool 8: every suite ran exactly once', rec.calls.length === 20 && new Set(rec.calls).size === 20, rec.calls);
        check('pool 8: results come back in discovery order', got.map((r) => r.label).join() === labels.join(), got.map((r) => r.label));
        const rec32 = recorder();
        await pool.runSuites(labels.map((label) => ({ label, ms: 30 })), rec32.runOne,
            { env: { AUTODEV_TEST_POOL: '32' }, manifest, dir, out: sink(), err: sink(), noLogs: false, runDir: LOGS });
        check('pool 32 asked: still never more than 8 at once', rec32.max === 8, rec32.max);
    }

    // ---- serial barrier, population, settle, aggregation --------------------
    {
        const dir = fs.mkdtempSync(path.join(TMP, 'barrier-'));
        const modes = { 'test-a': 'parallel', 'test-b': 'parallel', 'test-c': 'parallel', 'test-s': 'serial', 'test-d': 'parallel', 'test-e': 'parallel', 'test-f': 'parallel' };
        const manifest = fixtureManifest(dir, modes);
        const items = Object.keys(modes).map((label) => ({ label, ms: label === 'test-s' ? 60 : 50, state: label === 'test-d' ? 'fail' : 'pass' }));
        const rec = recorder();
        let settledWithPending = null;
        const got = await pool.runSuites(items, rec.runOne, { env: { AUTODEV_TEST_POOL: '4' }, manifest, dir, out: sink(), err: sink(), noLogs: false, runDir: LOGS })
            .then((r) => { settledWithPending = rec.pending; return r; });
        const ev = rec.events;
        const sStart = ev.findIndex((e) => e.t === 'start' && e.label === 'test-s');
        const sEnd = ev.findIndex((e) => e.t === 'end' && e.label === 'test-s');
        const before = ['test-a', 'test-b', 'test-c'];
        check('barrier: the serial suite starts alone (nothing else running)', sStart >= 0 && ev[sStart].activeAfter === 1, ev[sStart]);
        check('barrier: every suite before it has ended when it starts',
            before.every((l) => ev.findIndex((e) => e.t === 'end' && e.label === l) < sStart), ev.map((e) => e.t + ':' + e.label));
        check('barrier: nothing after it starts until it ends',
            ev.slice(sStart + 1, sEnd).every((e) => e.t !== 'start'), ev.map((e) => e.t + ':' + e.label));
        check('barrier: the serial suite runs with its output echoed live', ev[sStart] && ev[sStart].echo === true);
        check('barrier: parallel suites run with echo off (their log is printed whole)', ev.filter((e) => e.t === 'start' && e.label !== 'test-s').every((e) => !e.echo));
        check('barrier: parallel suites before it did overlap each other', rec.max >= 2, rec.max);
        check('population: every suite ran exactly once', rec.calls.length === items.length && new Set(rec.calls).size === items.length, rec.calls);
        check('population: one result per suite, in discovery order', got.map((r) => r.label).join() === items.map((i) => i.label).join(), got.map((r) => r.label));
        check('settle: runSuites resolves only after every suite has ended (validate runs next)', settledWithPending === 0, settledWithPending);
        const d = got.find((r) => r.label === 'test-d');
        check('aggregation: a failed suite comes back failed, unchanged', !!d && d.state === 'fail', d);
    }

    // ---- a runOne that rejects: no early resolve, no invented result ------
    {
        const dir = fs.mkdtempSync(path.join(TMP, 'reject-'));
        const modes = { 'test-a': 'parallel', 'test-b': 'parallel', 'test-c': 'parallel' };
        const manifest = fixtureManifest(dir, modes);
        const rec = recorder({ reject: 'test-a' });
        const err = sink();
        let pendingAtSettle = null;
        const got = await pool.runSuites(Object.keys(modes).map((label) => ({ label, ms: label === 'test-a' ? 5 : 60 })), rec.runOne,
            { env: { AUTODEV_TEST_POOL: '3' }, manifest, dir, out: sink(), err, noLogs: false, runDir: LOGS })
            .then((r) => { pendingAtSettle = rec.pending; return r; });
        check('reject: the others still finish before runSuites resolves', pendingAtSettle === 0, pendingAtSettle);
        check('reject: no result is invented for the suite whose runOne threw (test-all reruns it and fails the pool)',
            got.map((r) => r.label).join() === 'test-b,test-c', got.map((r) => r.label));
        check('reject: said by name', /test-a: runOne broke/.test(err.text()), err.text());
    }

    // ---- a log that cannot be printed: the rest run serially, output live ----
    {
        const dir = fs.mkdtempSync(path.join(TMP, 'nolog-'));
        const labels = ['test-a', 'test-b', 'test-c', 'test-d', 'test-e'];
        const manifest = fixtureManifest(dir, Object.fromEntries(labels.map((l) => [l, 'parallel'])));
        const events = [];
        const runOne = async (item, opt) => {
            events.push({ label: item.label, echo: !opt || opt.echo !== false });
            await sleep(item.label === 'test-a' ? 5 : 60);
            return { label: item.label, state: 'pass', log: item.label === 'test-a' ? 'logs/never-written.log' : null };
        };
        const err = sink();
        const got = await pool.runSuites(labels.map((label) => ({ label })), runOne,
            { env: { AUTODEV_TEST_POOL: '2' }, manifest, dir, out: sink(), err, noLogs: false, runDir: LOGS });
        check('lost log: said by name', /test-a: its log could not be read/.test(err.text()), err.text());
        check('lost log: suites started after it run with their output live', events.slice(2).every((e) => e.echo), events);
        const own = got.filter((r) => r.label !== 'test-all-pool');
        check('lost log: every suite still ran once', own.length === 5 && new Set(own.map((r) => r.label)).size === 5, got.map((r) => r.label));
        const row = got.find((r) => r.label === 'test-all-pool');
        check('lost log: the pool returns a failed row of its own, so the run cannot pass', got.length === 6 && !!row && row.state === 'fail' && /test-a/.test(row.reason), got);
        check('lost log: the delivered verdicts are kept unchanged', own.every((r) => r.state === 'pass'), own);
    }

    // ---- a lost log through aggregation: a cut write fails the run ------------
    {
        const dir = fs.mkdtempSync(path.join(TMP, 'cutwrite-'));
        const manifest = fixtureManifest(dir, { 'test-a': 'parallel', 'test-b': 'parallel' });
        const rec = recorder();
        const cutOut = (c) => (Buffer.isBuffer(c) ? Math.max(0, c.length - 1) : Buffer.byteLength(String(c)));
        const got = await pool.runSuites([{ label: 'test-a' }, { label: 'test-b' }], rec.runOne,
            { env: { AUTODEV_TEST_POOL: '2' }, manifest, dir, out: cutOut, err: sink(), noLogs: false, runDir: LOGS });
        check('aggregation: a log printed short makes the pool return a failed row', got.some((r) => r.label === 'test-all-pool' && r.state === 'fail'), got);
    }

    // ---- no run directory: serial before any suite starts silent -------------
    {
        const dir = fs.mkdtempSync(path.join(TMP, 'norundir-'));
        const manifest = fixtureManifest(dir, { 'test-a': 'parallel', 'test-b': 'parallel', 'test-c': 'parallel' });
        const rec = recorder();
        const err = sink();
        await pool.runSuites(['test-a', 'test-b', 'test-c'].map((label) => ({ label })), rec.runOne,
            { env: { AUTODEV_TEST_POOL: '4' }, manifest, dir, out: sink(), err, noLogs: false, runDir: null });
        check('no run directory (the coverage store failed): every suite runs serial with its output live',
            rec.max === 1 && rec.events.filter((e) => e.t === 'start').every((e) => e.echo) && /keeps no suite logs/.test(err.text()), { max: rec.max, err: err.text() });
    }

    // ---- manifest decides, and only an unchanged reviewed suite runs parallel --
    {
        const dir = fs.mkdtempSync(path.join(TMP, 'manifest-'));
        const manifest = fixtureManifest(dir, { 'test-a': 'parallel', 'test-b': 'parallel', 'test-c': 'serial' });
        fs.writeFileSync(path.join(dir, 'test-b.js'), '// edited after review\n');
        fs.writeFileSync(path.join(dir, 'test-u.js'), '// new suite\n');
        const loaded = pool.loadManifest(manifest);
        const plan = pool.classify(['test-a', 'test-b', 'test-c', 'test-u'].map((label) => ({ label })), loaded.suites, dir);
        const mode = (l) => plan.find((p) => p.item.label === l);
        check('manifest: an unchanged parallel suite is parallel', mode('test-a').mode === 'parallel');
        check('manifest: a suite changed since review runs serial', mode('test-b').mode === 'serial' && mode('test-b').why === 'changed', mode('test-b'));
        check('manifest: a reviewed serial suite runs serial', mode('test-c').mode === 'serial' && mode('test-c').why === 'reviewed');
        check('manifest: a suite not in the manifest runs serial', mode('test-u').mode === 'serial' && mode('test-u').why === 'unknown');
        for (const [name, body] of [['missing', null], ['not JSON', '{'], ['wrong schema', '{"schema":2,"suites":{}}']]) {
            const f = path.join(dir, 'bad-' + name.replace(/ /g, '-') + '.json');
            if (body !== null) fs.writeFileSync(f, body);
            const l = pool.loadManifest(f);
            check(`manifest ${name}: empty, so every suite runs serial, and the reason is given`, l.suites.size === 0 && !!l.error, l.error);
        }
        const partial = path.join(dir, 'partial.json');
        fs.writeFileSync(partial, JSON.stringify({ schema: 1, suites: { 'test-a.js': { isolation: 'parallel', reason: '', sha256: pool.hashFile(path.join(dir, 'test-a.js')) } } }));
        check('manifest: an entry without a reason is not trusted', pool.loadManifest(partial).suites.size === 0);
        const mixed = path.join(dir, 'mixed.json');
        fs.writeFileSync(mixed, JSON.stringify({ schema: 1, suites: {
            'test-a.js': { isolation: 'parallel', reason: 'fixture', sha256: pool.hashFile(path.join(dir, 'test-a.js')) },
            'test-c.js': { isolation: 'sideways', reason: 'fixture', sha256: 'x' },
        } }));
        const ml = pool.loadManifest(mixed);
        check('manifest: one malformed entry beside a valid one empties the whole manifest', ml.suites.size === 0 && /malformed/.test(ml.error || ''), ml.error);
        const badAccepted = path.join(dir, 'bad-accepted.json');
        fs.writeFileSync(badAccepted, JSON.stringify({ schema: 1, suites: {
            'test-a.js': { isolation: 'parallel', reason: 'fixture', accepted: 'git-write', sha256: pool.hashFile(path.join(dir, 'test-a.js')) } } }));
        check('manifest: an "accepted" that is not a list of strings is malformed', pool.loadManifest(badAccepted).suites.size === 0);

        // The hash is of the bytes on disk: checked against an independent
        // sha256, and a CRLF rewrite of the same text must read as changed.
        const crlfDir = fs.mkdtempSync(path.join(TMP, 'crlf-'));
        const crlfFile = path.join(crlfDir, 'test-crlf.js');
        const lf = Buffer.from('// line one\n// line two\n');
        fs.writeFileSync(crlfFile, lf);
        const oracle = require('crypto').createHash('sha256').update(lf).digest('hex');
        check('hash: equals an independent sha256 of the raw bytes', pool.hashFile(crlfFile) === oracle, { got: pool.hashFile(crlfFile), oracle });
        const crlfManifest = fixtureManifest(crlfDir, { 'test-crlf': 'parallel' });
        fs.writeFileSync(crlfFile, Buffer.from(lf.toString('utf8').replace(/\n/g, '\r\n')));
        const cp = pool.classify([{ label: 'test-crlf' }], pool.loadManifest(crlfManifest).suites, crlfDir)[0];
        check('hash: the same suite rewritten with CRLF line ends reads as changed and runs serial', cp.mode === 'serial' && cp.why === 'changed', cp);
        const rec = recorder();
        await pool.runSuites(['test-a', 'test-u'].map((label) => ({ label })), rec.runOne,
            { env: { AUTODEV_TEST_POOL: '4' }, manifest: path.join(dir, 'bad-missing.json'), dir, out: sink(), err: sink(), noLogs: false, runDir: LOGS });
        check('manifest missing with the pool on: still one at a time', rec.max === 1, rec.max);
        const recNo = recorder();
        const errNo = sink();
        await pool.runSuites(['test-a'].map((label) => ({ label })), recNo.runOne,
            { env: { AUTODEV_TEST_POOL: '4' }, manifest, dir, out: sink(), err: errNo, noLogs: true });
        check('--no-receipt with the pool on: serial, because no log is kept to print whole', recNo.events[0].echo === true && /no-receipt/.test(errNo.text()), errNo.text());
    }

    // ---- the reviewed manifest in the tree ----------------------------------
    {
        const loaded = pool.loadManifest(path.join(TOOLING, pool.MANIFEST_FILE));
        check('tree manifest: loads with no malformed entry', !loaded.error, loaded.error);
        for (const seed of ['test-validate.js', 'test-runner-guard.js', 'test-no-private-names.js']) {
            const e = loaded.suites.get(seed);
            check(`tree manifest: known repo writer ${seed} is serial`, !!e && e.isolation === 'serial', e);
        }
        const discovered = require('./coverage-receipt.js').discoverSuites(TOOLING);
        const plan = pool.classify(discovered.map((f) => ({ label: f.replace(/\.js$/, '') })), loaded.suites);
        const n = (pred) => plan.filter(pred).length;
        console.log(`      population: ${plan.length} suites, ${n((p) => p.mode === 'parallel')} parallel, ${n((p) => p.mode === 'serial')} serial, `
            + `${n((p) => p.why === 'unknown')} not in the manifest, ${n((p) => p.why === 'changed')} changed since review`);
        // Every parallel entry was reviewed against the audit. A signal the review
        // did not list in "accepted" (read by hand) is a review that is wrong.
        const unreviewed = (manifestSuites, dir) => {
            const bad = [];
            for (const [name, e] of manifestSuites) {
                if (e.isolation !== 'parallel') continue;
                let src;
                try { src = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
                if (pool.hashFile(path.join(dir, name)) !== e.sha256) continue;
                const acc = new Set(e.accepted || []);
                const sig = pool.auditSource(src).filter((s) => !acc.has(s));
                if (sig.length) bad.push(`${name}: ${sig.join('; ')}`);
            }
            return bad;
        };
        const hard = unreviewed(loaded.suites, TOOLING);
        check('tree manifest: every audit signal of a parallel suite was accepted by hand', hard.length === 0, hard);
        // The guard itself: a parallel suite re-hashed after gaining a global git
        // config write, or a child given the real profile, must trip it.
        const gdir = fs.mkdtempSync(path.join(TMP, 'guard-'));
        for (const [label, body] of [
            ['test-gglobal', "spawnSync('git', ['config', '--global', 'user.name', 'x']);\n"],
            ['test-profile', "const HOME = fixture;\nspawnSync(process.execPath, ['plugins/x.js'], { env: process.env });\n"],
        ]) fs.writeFileSync(path.join(gdir, label + '.js'), body);
        const gm = pool.loadManifest(fixtureManifest(gdir, { 'test-gglobal': 'parallel', 'test-profile': 'parallel' })).suites;
        const caught = unreviewed(gm, gdir);
        check('tree manifest guard: a re-hashed parallel suite writing global git config is caught', caught.some((l) => /test-gglobal.*git-global/.test(l)), caught);
        check('tree manifest guard: a child handed process.env is caught despite a HOME override elsewhere', caught.some((l) => /test-profile.*process\.env unchanged/.test(l)), caught);
    }

    // ---- the auditor reads source, not filenames ----------------------------
    {
        const a = pool.auditSource;
        check('audit: a write under a path built from __dirname is a repo write',
            a("const ROOT = path.resolve(__dirname, '..');\nconst P = path.join(ROOT, 'x.md');\nfs.writeFileSync(P, 'x');").some((s) => s.startsWith('repo-write')));
        check('audit: a write under a temp dir is not',
            !a("const T = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));\nfs.writeFileSync(path.join(T, 'a'), 'x');").some((s) => s.startsWith('repo-write')));
        check('audit: listen on a fixed port is flagged', a("server.listen(8123, '127.0.0.1');").some((s) => s.startsWith('fixed-port')));
        check('audit: listen on port 0 is not', !a("server.listen(0, '127.0.0.1');").some((s) => s.startsWith('fixed-port')));
        check('audit: git commit is a git write', a("spawnSync('git', ['commit', '-m', 'x'], { cwd: dir });").some((s) => s.startsWith('git-write')));
        check('audit: a glob inside a string does not hide the code after it',
            a("const G = 'plugins/*/hooks';\nconst ROOT = path.resolve(__dirname, '..');\nfs.writeFileSync(path.join(ROOT, 'y'), '');").some((s) => s.startsWith('repo-write')));
        check('audit: a commented-out write is not a signal',
            !a("const ROOT = path.resolve(__dirname, '..');\n// fs.writeFileSync(path.join(ROOT, 'y'), '');").some((s) => s.startsWith('repo-write')));
        check('audit: copying a temp file INTO the repo is a repo write (the destination is read)',
            a("const ROOT = path.resolve(__dirname, '..');\nconst T = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));\nfs.copyFileSync(path.join(T, 'a'), path.join(ROOT, 'b'));").some((s) => s.startsWith('repo-write')));
        check('audit: renaming a temp file into the repo is a repo write',
            a("const ROOT = path.resolve(__dirname, '..');\nfs.renameSync(tmpFile, path.join(ROOT, 'b'));").some((s) => s.startsWith('repo-write')));
        check('audit: copying a repo file out to a temp dir is still read as touching the repo',
            a("const ROOT = path.resolve(__dirname, '..');\nfs.copyFileSync(path.join(ROOT, 'a'), path.join(T, 'b'));").some((s) => s.startsWith('repo-write')));
        check('audit: copying between two temp paths is not a repo write',
            !a("const T = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));\nfs.copyFileSync(path.join(T, 'a'), path.join(T, 'b'));").some((s) => s.startsWith('repo-write')));
        check('audit: git config --global is a git-global signal', a("spawnSync('git', ['config', '--global', 'user.name', 'x']);").some((s) => s.startsWith('git-global')));
        check('audit: a child given process.env unchanged is a profile signal, whatever else overrides HOME',
            a("const env = { HOME: dir };\nspawn(process.execPath, [f], { env: process.env });").some((s) => /process\.env unchanged/.test(s)));
        check('audit: a child given a copy with overrides is not',
            !a("spawn(process.execPath, [f], { env: { ...process.env, HOME: dir } });").some((s) => /process\.env unchanged/.test(s)));
        check('audit: driving test-all.js is a nested runner', a("spawnSync(process.execPath, [path.join(__dirname, 'test-all.js')]);").some((s) => s.startsWith('nested-runner')));
    }

    // ---- real processes: a serial barrier keeps shared resources apart -------
    // Two "repo writers" that each create one shared file, hold it, and fail if
    // it is already there; two binders of one fixed port. Run serial, all pass.
    // Marked parallel (the bypass), they collide and fail.
    {
        const dir = fs.mkdtempSync(path.join(TMP, 'real-'));
        const shared = path.join(dir, 'shared-repo');
        fs.mkdirSync(shared);
        const port = await new Promise((resolve) => {
            const s = require('net').createServer();
            s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
        });
        // Exclusive create: of two overlapping writers exactly one gets EEXIST.
        const writer = `const fs=require('fs'),p=require('path').join(${JSON.stringify(shared)},'fixture.md');
try{fs.writeFileSync(p,'x',{flag:'wx'});setTimeout(()=>{fs.rmSync(p,{force:true});},400);}
catch(e){console.log('another writer is mid-run: '+e.code);process.exitCode=1;}`;
        const binder = `const s=require('net').createServer();s.on('error',(e)=>{console.log(e.code);process.exitCode=1;});
s.listen(${port},'127.0.0.1',()=>setTimeout(()=>s.close(),400));`;
        const bodies = { 'test-w1': writer, 'test-w2': writer, 'test-b1': binder, 'test-b2': binder };
        for (const [l, b] of Object.entries(bodies)) fs.writeFileSync(path.join(dir, l + '.js'), b);
        const runOne = (item) => new Promise((resolve) => {
            const c = spawn(process.execPath, [path.join(dir, item.label + '.js')], { stdio: 'ignore', windowsHide: true });
            c.on('close', (code) => {
                fs.writeFileSync(path.join(LOGS, 'logs', item.label + '.log'), `exit ${code}\n`);
                resolve({ label: item.label, state: code === 0 ? 'pass' : 'fail', status: code, log: 'logs/' + item.label + '.log' });
            });
        });
        // modes: label -> parallel or serial; only the named labels run.
        const run = async (modes) => pool.runSuites(Object.keys(modes).map((label) => ({ label })), runOne, {
            env: { AUTODEV_TEST_POOL: '4' }, dir, out: sink(), err: sink(), noLogs: false, runDir: LOGS,
            manifest: fixtureManifest(dir, modes),
        });
        const verdicts = (rs) => rs.map((r) => r.label + ':' + r.state);
        const serial = await run({ 'test-w1': 'serial', 'test-w2': 'serial', 'test-b1': 'serial', 'test-b2': 'serial' });
        check('real processes, serial: two repo writers and two fixed-port binders all pass',
            serial.length === 4 && serial.every((r) => r.state === 'pass'), verdicts(serial));
        // Each resource across a parallel-to-serial barrier: the serial one must
        // wait for the parallel one still holding the file or the port.
        const wBarrier = await run({ 'test-w1': 'parallel', 'test-w2': 'serial' });
        check('real processes, barrier: a serial writer after a parallel writer waits for it and both pass',
            wBarrier.length === 2 && wBarrier.every((r) => r.state === 'pass'), verdicts(wBarrier));
        const bBarrier = await run({ 'test-b1': 'parallel', 'test-b2': 'serial' });
        check('real processes, barrier: a serial binder after a parallel binder waits for it and both pass',
            bBarrier.length === 2 && bBarrier.every((r) => r.state === 'pass'), verdicts(bBarrier));
        // Separate controls, so a port collision cannot stand in for a writer
        // collision: each pair alone, overlapping, must fail.
        const wControl = await run({ 'test-w1': 'parallel', 'test-w2': 'parallel' });
        check('control: two writers overlapping really do collide (the writer fixture can fail)',
            wControl.some((r) => r.state === 'fail'), verdicts(wControl));
        const bControl = await run({ 'test-b1': 'parallel', 'test-b2': 'parallel' });
        check('control: two binders overlapping really do collide (the binder fixture can fail)',
            bControl.some((r) => r.state === 'fail'), verdicts(bControl));
    }

    // ---- end to end through the real test-all.js -----------------------------
    // A copy of the runner and its helpers in a temp tooling dir, with fixture
    // suites, a stub validate.js and a private coverage store.
    {
        const root = fs.mkdtempSync(path.join(TMP, 'e2e-'));
        const tdir = path.join(root, 'tooling');
        fs.mkdirSync(tdir);
        // The copy set follows the runner's own local requires, so a helper added
        // to test-all.js or anything it loads cannot go missing from the fixture.
        const copySet = new Set();
        const pending = ['test-all.js', 'test-all-pool.js'];
        while (pending.length) {
            const f = pending.pop();
            if (copySet.has(f)) continue;
            copySet.add(f);
            const src = fs.readFileSync(path.join(TOOLING, f), 'utf8');
            for (const m of src.matchAll(/require\(\s*['"]\.\/([\w.-]+\.js)['"]\s*\)/g)) pending.push(m[1]);
        }
        for (const f of fs.readdirSync(TOOLING)) if (/^cpu-.*\.js$/.test(f)) copySet.add(f);
        check('e2e: the fixture copies every helper the runner requires', copySet.has('suite-tmp.js') && copySet.has('coverage-receipt.js'));
        for (const f of copySet) fs.copyFileSync(path.join(TOOLING, f), path.join(tdir, f));
        // Each suite holds a marker file from its first line until 300 ms AFTER its
        // output, so a validator that starts while any suite still runs sees one
        // and fails: this measures completion, not the order of printed headers.
        const markers = path.join(root, 'running');
        fs.mkdirSync(markers);
        // The stub validator watches for 600 ms, so it sees a suite that starts
        // or still runs at any point while it does, not only at its first line.
        fs.writeFileSync(path.join(tdir, 'validate.js'),
            `const fs=require('fs'),D=${JSON.stringify(markers)};const seen=new Set();\n`
            + "const look=()=>{for(const f of fs.readdirSync(D))seen.add(f);};look();\n"
            + "const t=setInterval(look,10);setTimeout(()=>{clearInterval(t);look();\n"
            + "if(seen.size){console.log('validate started while running: '+[...seen].join(','));process.exitCode=1;}else console.log('validate ran');},600);\n");
        const BIG = 200 * 1024;
        const hold = (label) => `const M=require('path').join(${JSON.stringify(markers)},'${label}');require('fs').writeFileSync(M,'');`
            + "const done=()=>setTimeout(()=>require('fs').rmSync(M,{force:true}),300);";
        const suites = {
            'test-e1': hold('e1') + "setTimeout(()=>{console.log('e1 done');done();},150);",
            'test-e2': hold('e2') + "setTimeout(()=>{console.log('e2 done');done();},150);",
            'test-e3': hold('e3') + "setTimeout(()=>{console.log('e3 failing on purpose');process.exitCode=1;done();},150);",
            'test-e4': hold('e4') + `process.stdout.write('x'.repeat(${BIG})+'\\nE4-END-OF-LOG\\n');done();`,
            'test-e5': hold('e5') + "setTimeout(()=>{console.log('e5 done');done();},150);",
        };
        for (const [l, b] of Object.entries(suites)) fs.writeFileSync(path.join(tdir, l + '.js'), b + '\n');
        fixtureManifest(tdir, { 'test-e1': 'parallel', 'test-e2': 'parallel', 'test-e3': 'parallel', 'test-e4': 'parallel', 'test-e5': 'serial' });
        const store = path.join(root, 'store');
        const env = { ...process.env, AUTODEV_TEST_POOL: '4', AUTODEV_COVERAGE_STORE: store };
        delete env.NODE_V8_COVERAGE;
        const r = spawnSync(process.execPath, [path.join(tdir, 'test-all.js')], { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
        const outText = r.stdout || '';
        check('e2e: a failed pooled suite makes the real runner exit 1', r.status === 1, { status: r.status, stderr: (r.stderr || '').slice(-600) });
        check('e2e: the summary names the failed suite', /FAIL\s+test-e3/.test(outText), outText.slice(-800));
        check('e2e: the summary passes the others and validate', ['test-e1', 'test-e2', 'test-e4', 'test-e5', 'validate'].every((l) => new RegExp(`PASS\\s+${l}\\b`).test(outText)), outText.slice(-800));
        check('e2e: no pool failure row (the pool delivered every suite once)', !/test-all-pool/.test(outText), outText.slice(-800));
        check('e2e: the pool said it was on', /\[pool\] up to 4 at once: 4 parallel, 1 serial/.test(r.stderr || ''), (r.stderr || '').slice(0, 400));
        const e4 = outText.indexOf('=== test-e4 ===');
        const e4log = e4 >= 0 ? outText.slice(e4) : '';
        check('full log: a 200 KB pooled log is printed whole under its header', e4 >= 0 && e4log.includes('x'.repeat(BIG) + '\nE4-END-OF-LOG'), { found: e4 >= 0, len: e4log.length });
        check('full log: a failing suite\'s own output is printed', /=== test-e3 ===\s*\ne3 failing on purpose/.test(outText), outText.slice(0, 400));
        const vIdx = outText.indexOf('=== validate ===');
        check('e2e: validate starts after every suite\'s output', vIdx > 0 && ['test-e1', 'test-e2', 'test-e3', 'test-e4', 'test-e5'].every((l) => outText.indexOf(`=== ${l} ===`) >= 0 && outText.indexOf(`=== ${l} ===`) < vIdx), vIdx);
        check('e2e: validate found no suite still running when it started', /validate ran/.test(outText) && !/validate started while running/.test(outText), (outText.match(/validate[^\n]*/g) || []).slice(-3));
        const headers = (outText.match(/^=== (test-e\d) ===$/gm) || []);
        check('e2e: each suite\'s header appears exactly once', headers.length === 5 && new Set(headers).size === 5, headers);
    }

    // ---- printLog refuses a cut log -----------------------------------------
    {
        const dir = fs.mkdtempSync(path.join(TMP, 'log-'));
        fs.mkdirSync(path.join(dir, 'logs'));
        fs.writeFileSync(path.join(dir, 'logs', 'test-x.log'), 'y'.repeat(5000));
        const cut = (c) => (Buffer.isBuffer(c) ? Math.min(c.length, 100) : Buffer.byteLength(c));
        const err = sink();
        check('full log: a writer that takes only part of the log is reported', pool.printLog({ label: 'test-x', log: 'logs/test-x.log' }, dir, cut, err) === false && /printed \d+ of 5000/.test(err.text()), err.text());
        const out = sink();
        check('full log: a whole write is accepted', pool.printLog({ label: 'test-x', log: 'logs/test-x.log' }, dir, out, sink()) === true && out.text().endsWith('y'.repeat(5000)));
    }

    // ---- CLI ------------------------------------------------------------------
    {
        const st = spawnSync(process.execPath, [SUBJECT, '--status'], { encoding: 'utf8' });
        check('--status prints a population line', st.status === 0 && /^population: \d+ suites, \d+ parallel, \d+ serial/m.test(st.stdout), st.stdout.slice(-300));
        const bad = spawnSync(process.execPath, [SUBJECT, '--nope'], { encoding: 'utf8' });
        check('an unknown argument exits 2', bad.status === 2, bad.status);
    }
}

main().catch((e) => {
    check('the suite itself ran to the end', false, e && e.stack);
}).finally(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* the runner's temp root removes it */ }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed`);
    process.exitCode = failed || results.length === 0 ? 1 : 0;
});
