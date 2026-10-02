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
        check('lost log: every suite still ran once', got.length === 5, got.map((r) => r.label));
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
        // Every parallel entry was reviewed against the audit: one that now carries a
        // repo-write, fixed-port or nested-runner signal is a review that is wrong.
        const hard = [];
        for (const [name, e] of loaded.suites) {
            if (e.isolation !== 'parallel') continue;
            let src;
            try { src = fs.readFileSync(path.join(TOOLING, name), 'utf8'); } catch { continue; }
            if (pool.hashFile(path.join(TOOLING, name)) !== e.sha256) continue;
            const sig = pool.auditSource(src).filter((s) => /^(repo-write|fixed-port|nested-runner|npm)/.test(s));
            if (sig.length) hard.push(`${name}: ${sig.join('; ')}`);
        }
        check('tree manifest: no parallel suite writes the repo, binds a fixed port, nests a runner or spawns npm', hard.length === 0, hard);
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
        const writer = `const fs=require('fs'),p=require('path').join(${JSON.stringify(shared)},'fixture.md');
if(fs.existsSync(p)){console.log('another writer is mid-run');process.exitCode=1;}
else{fs.writeFileSync(p,'x');setTimeout(()=>{fs.rmSync(p,{force:true});},400);}`;
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
        const items = Object.keys(bodies).map((label) => ({ label }));
        const run = async (mode) => pool.runSuites(items, runOne, {
            env: { AUTODEV_TEST_POOL: '4' }, dir, out: sink(), err: sink(), noLogs: false, runDir: LOGS,
            manifest: fixtureManifest(dir, Object.fromEntries(Object.keys(bodies).map((l) => [l, mode]))),
        });
        const serial = await run('serial');
        check('real processes, serial: two repo writers and two fixed-port binders all pass',
            serial.length === 4 && serial.every((r) => r.state === 'pass'), serial.map((r) => r.label + ':' + r.state));
        const control = await run('parallel');
        check('control: the same four overlapping really do collide (so the serial pass above means something)',
            control.some((r) => r.state === 'fail'), control.map((r) => r.label + ':' + r.state));
    }

    // ---- end to end through the real test-all.js -----------------------------
    // A copy of the runner and its helpers in a temp tooling dir, with fixture
    // suites, a stub validate.js and a private coverage store.
    {
        const root = fs.mkdtempSync(path.join(TMP, 'e2e-'));
        const tdir = path.join(root, 'tooling');
        fs.mkdirSync(tdir);
        for (const f of fs.readdirSync(TOOLING)) {
            if (/^(test-all\.js|test-all-pool\.js|coverage-receipt\.js|suite-tmp\.js|cpu-.*\.js)$/.test(f)) fs.copyFileSync(path.join(TOOLING, f), path.join(tdir, f));
        }
        fs.writeFileSync(path.join(tdir, 'validate.js'), "console.log('validate ran');\n");
        const BIG = 200 * 1024;
        const suites = {
            'test-e1': "setTimeout(()=>console.log('e1 done'),150);",
            'test-e2': "setTimeout(()=>console.log('e2 done'),150);",
            'test-e3': "setTimeout(()=>{console.log('e3 failing on purpose');process.exitCode=1;},150);",
            'test-e4': `process.stdout.write('x'.repeat(${BIG})+'\\nE4-END-OF-LOG\\n');`,
            'test-e5': "setTimeout(()=>console.log('e5 done'),150);",
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
