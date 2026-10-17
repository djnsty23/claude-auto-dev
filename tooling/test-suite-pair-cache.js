#!/usr/bin/env node
'use strict';
// Tests for tooling/suite-pair-cache.js and tooling/suite-pair-trace.js: the
// check:suites pair cache, its key, its evidence and its three modes.
//
// WHY THIS SUITE EXISTS. A cache that answers wrongly turns check:suites into a
// gate that grades last week's tree. Every way it could answer wrongly is
// planted here as a scenario whose correct answer is known: a subject edited, a
// helper only the stub run reads edited, a discovery input added, a native
// child that reads what nobody declared, a traced process killed, an entry
// corrupted, a run with a conflict, and an unrelated edit that must NOT cost a
// rerun.
//
// HOW. Two layers.
//   · In process: the key, entry validation, the atomic writer, attribution and
//     evidence collection, driven through open() on a throwaway repository so
//     the key parts are the ones the sweep really builds.
//   · End to end: the real check-suites-can-fail.js, copied with every module
//     it requires into a throwaway git repository beside planted suites, run in
//     shadow, --cache and off modes against a private cache directory. The
//     per-pair JSON report is the evidence; the verdict rows must not move.
//
// Every expected value below is planted here. None is read from the cache's
// own source.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sb = require('./spawn-budget.js');
const pc = require('./suite-pair-cache.js');
const tr = require('./suite-pair-trace.js');

const TOOLING = __dirname;
const SWEEP = path.join(__dirname, 'check-suites-can-fail.js');
const TRACE = path.join(__dirname, 'suite-pair-trace.js');
const BUDGET_MS = 180000;

let pass = 0, fail = 0, infra = 0;
const failures = [];
function check(label, ok, detail) {
    if (ok) pass++; else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : '  (' + detail + ')'}`);
}

const dirs = [];
const tmp = (label) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-cache-' + label + '-')); dirs.push(d); return d; };

// The sweep plus the closure of its relative requires, read from the source.
function sweepModules() {
    const seen = new Set();
    const walk = (name) => {
        if (seen.has(name) || !fs.existsSync(path.join(TOOLING, name))) return;
        seen.add(name);
        const src = fs.readFileSync(path.join(TOOLING, name), 'utf8');
        for (const m of src.matchAll(/require\(['"]\.\/([\w.-]+\.js)['"]\)/g)) walk(m[1]);
    };
    walk(path.basename(SWEEP));
    return [...seen];
}

const gitIn = (dir) => (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });

function makeRepo(label, files) {
    const dir = tmp(label);
    const git = gitIn(dir);
    git('init', '-q');
    git('config', 'user.name', 'suite');
    git('config', 'user.email', 'suite@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', path.join(dir, 'no-hooks'));
    fs.mkdirSync(path.join(dir, 'tooling'), { recursive: true });
    for (const name of sweepModules()) fs.copyFileSync(path.join(TOOLING, name), path.join(dir, 'tooling', name));
    writeFiles(dir, files);
    const c = commitAll(dir, 'fixture');
    check(`${label}: the fixture is a committed, clean repository`, c, 'commit failed');
    return dir;
}
function writeFiles(dir, files) {
    for (const [rel, text] of Object.entries(files)) {
        if (text === null) { fs.rmSync(path.join(dir, rel), { force: true }); continue; }
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text, 'utf8');
    }
}
function commitAll(dir, msg) {
    const git = gitIn(dir);
    git('add', '-A', '--', '.');
    const c = git('commit', '-q', '-m', msg);
    return c.status === 0 && git('status', '--porcelain').stdout.trim() === '';
}

// ===================================================================== unit ==

// --- modes --------------------------------------------------------------------
{
    const m = (argv, env) => pc.resolveMode(argv, env).mode;
    check('mode: shadow is the default', m([], {}) === 'shadow');
    check('mode: --cache turns reuse on', m(['--cache'], {}) === 'on');
    check('mode: --no-cache turns everything off', m(['--no-cache'], {}) === 'off');
    check('mode: AUTODEV_SUITE_CACHE=on and =off are honoured',
        m([], { AUTODEV_SUITE_CACHE: 'on' }) === 'on' && m([], { AUTODEV_SUITE_CACHE: 'off' }) === 'off');
    check('mode: a flag beats the environment', m(['--no-cache'], { AUTODEV_SUITE_CACHE: 'on' }) === 'off');
    check('mode: an unknown value falls back to shadow, which changes no verdict',
        m([], { AUTODEV_SUITE_CACHE: 'sometimes' }) === 'shadow');
}

// --- declarations, origin, env identity ---------------------------------------
{
    const d = pc.parseDeclarations('x\n// suite-pair-cache: native git.exe reads a/b.txt, c\n  // suite-pair-cache: off\n');
    check('declarations: a native command and its reads are parsed, .exe dropped',
        JSON.stringify(d.natives) === JSON.stringify({ git: ['a/b.txt', 'c'] }) && d.off === true, JSON.stringify(d));
    check('origin: credentials, case and .git do not change the identity',
        pc.normalizeOrigin('https://user:tok@GitHub.com/Org/Repo.git') === pc.normalizeOrigin('https://github.com/org/repo/')
        && pc.normalizeOrigin('git@github.com:org/repo.git') === 'github.com/org/repo');
    const root = path.join(os.tmpdir(), 'some-worktree');
    const a = pc.envIdentity({ INIT_CWD: root, X: '1', TEMP: 'a' }, ['TEMP'], [root]);
    const b = pc.envIdentity({ INIT_CWD: path.join(os.tmpdir(), 'other-worktree'), X: '1', TEMP: 'b' }, ['TEMP'], [path.join(os.tmpdir(), 'other-worktree')]);
    const c = pc.envIdentity({ INIT_CWD: root, X: '2' }, ['TEMP'], [root]);
    check('env: the source tree path is a token and excluded names do not count', a.digest === b.digest);
    check('env: a changed value changes the identity', a.digest !== c.digest);

    // Volatile names: stripped, without case, and nothing else is.
    const raw = { AUTODEV_GATE_RUN_ID: 'r', autodev_gate_run_token: '7', Npm_Package_Version: '1.2.3',
        CLAUDE_CODE_SESSION_ID: 's', OLDPWD: 'o', PATH: 'p', HOME: 'h', AUTODEV_GATE_LANES: '2' };
    const kept = pc.stripVolatileEnv(raw);
    check('env: the volatile names are stripped whatever their case, and only they are',
        JSON.stringify(Object.keys(kept).sort()) === JSON.stringify(['AUTODEV_GATE_LANES', 'HOME', 'PATH']), JSON.stringify(kept));
    const every = pc.stripVolatileEnv(Object.fromEntries(pc.VOLATILE_ENV.map((n) => [n, 'v'])));
    check('env: every VOLATILE_ENV name is stripped', Object.keys(every).length === 0, JSON.stringify(every));
    check('env: two gate runs of two sessions share an identity once the volatile names are stripped',
        pc.envIdentity(pc.stripVolatileEnv({ AUTODEV_GATE_RUN_ID: 'run-1', CLAUDE_CODE_SESSION_ID: 'a', X: '1' }), [], [root]).digest
        === pc.envIdentity(pc.stripVolatileEnv({ AUTODEV_GATE_RUN_ID: 'run-2', CLAUDE_CODE_SESSION_ID: 'b', X: '1' }), [], [root]).digest);
    // Git Bash hands the gate PWD in the MSYS spelling of the worktree.
    const wa = 'C:\\Users\\someone\\wt-a', wb = 'C:\\Users\\someone\\wt-b';
    const pa = pc.envIdentity({ PWD: '/c/Users/someone/wt-a', X: '1' }, [], [wa]);
    const pb = pc.envIdentity({ PWD: '/c/Users/someone/wt-b', X: '1' }, [], [wb]);
    const pz = pc.envIdentity({ PWD: '/c/Users/someone/elsewhere', X: '1' }, [], [wb]);
    check('env: the MSYS spelling of the source tree path is a token too', pa.digest === pb.digest && pb.digest !== pz.digest);
}

// --- package.json and its lockfile, keyed without the release version ----------
{
    const d = tmp('pkg');
    const put = (rel, doc) => fs.writeFileSync(path.join(d, rel), typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2) + '\n');
    const st = (rel) => pc.packageState(d, rel);
    const pkg = (version, extra) => Object.assign({ name: 'n', version, type: 'commonjs', scripts: { t: 'node t.js' } }, extra);
    put('package.json', pkg('1.0.0'));
    const p0 = st('package.json');
    put('package.json', pkg('1.0.1'));
    check('package: a version-only bump keeps the state', st('package.json') === p0, p0);
    put('package.json', pkg('1.0.1', { type: 'module' }));
    check('package: a changed type (the resolver reads it) changes the state', st('package.json') !== p0);
    put('package.json', pkg('1.0.1', { scripts: { t: 'node other.js' } }));
    check('package: a changed script changes the state', st('package.json') !== p0);
    const lock = (version, deps) => ({ name: 'n', version, lockfileVersion: 3, packages: { '': { name: 'n', version, dependencies: deps } } });
    put('package-lock.json', lock('1.0.0', { a: '1' }));
    const l0 = st('package-lock.json');
    put('package-lock.json', lock('1.0.1', { a: '1' }));
    check('package: a lockfile whose root versions alone moved keeps the state', st('package-lock.json') === l0, l0);
    put('package-lock.json', lock('1.0.1', { a: '2' }));
    check('package: a lockfile with a changed dependency changes the state', st('package-lock.json') !== l0);
    put('package.json', '{ not json');
    check('package: an unparseable file falls back to its bytes', /^sha256:/.test(st('package.json')), st('package.json'));
    check('package: an absent file is absent', st('nope.json') === 'absent');
}

// --- attribution of scripts loaded from outside the repository ----------------
{
    const idx = new Map([['d1', ['tooling/one.js']], ['d2', ['tooling/x.js', 'tooling/y.js']]]);
    check('attribute: text matching exactly one repository file is attributed', pc.attribute('d1', idx).rel === 'tooling/one.js');
    check('attribute: text matching two repository files is ambiguous, not attributed', !pc.attribute('d2', idx).rel,
        JSON.stringify(pc.attribute('d2', idx)));
    check('attribute: text matching nothing is not attributed', !pc.attribute('d3', idx).rel);
}

// --- the atomic writer ----------------------------------------------------------
{
    const d = tmp('atomic');
    const f = path.join(d, 'e.json');
    let calls = 0;
    const flaky = (a, b) => { calls++; if (calls <= 2) throw Object.assign(new Error('busy'), { code: 'EPERM' }); fs.renameSync(a, b); };
    const ok = pc.writeAtomic(f, 'one', { renameSync: flaky });
    check('atomic: two EPERM renames are retried and the entry lands', ok === true && fs.readFileSync(f, 'utf8') === 'one',
        `returned ${ok}, ${calls} rename call(s)`);
    const g = path.join(d, 'g.json');
    const never = () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); };
    const r = pc.writeAtomic(g, 'two', { renameSync: never, tries: 3 });
    const left = fs.readdirSync(d).filter((n) => n.startsWith('g.json'));
    check('atomic: a rename that never succeeds reports its code and leaves no file behind',
        r === 'EPERM' && left.length === 0, `returned ${r}, left ${left.join(',')}`);
}

// --- the key, through open() on a real repository -----------------------------
let unitRepo;
{
    unitRepo = makeRepo('unit', {
        'plugins/demo/s.js': 'module.exports = { answer: () => 42 };\n',
        'plugins/demo/other.txt': 'unrelated\n',
        'tooling/test-u.js': "require(require('path').join(__dirname, '..', 'plugins', 'demo', 's.js'));\n",
    });
    const cacheDir = tmp('unit-cache');
    const open = () => pc.open({
        argv: [], env: { AUTODEV_SUITE_CACHE_DIR: cacheDir }, root: unitRepo, sweepRoot: unitRepo,
        checkerDir: path.join(unitRepo, 'tooling'), stub: 'STUB', head: 'h1', suiteEnv: { A: '1' }, log: () => {},
    });
    const base = { cacheable: true, reasons: [], deps: new Map(), natives: new Set(), states: [['script', 'plugins/demo/s.js', 'x']] };
    const keyNow = () => open().pair('test-u.js', 'plugins/demo/s.js', base).key;
    const k0 = keyNow();
    fs.appendFileSync(path.join(unitRepo, 'plugins/demo/other.txt'), 'more\n');
    check('key: an unrelated file does not change the key', keyNow() === k0);
    fs.appendFileSync(path.join(unitRepo, 'plugins/demo/s.js'), '// edit\n');
    const k1 = keyNow();
    check('key: the subject\'s bytes alone change the key', k1 !== k0);
    fs.appendFileSync(path.join(unitRepo, 'tooling/test-u.js'), '// edit\n');
    const k2 = keyNow();
    check('key: the suite\'s bytes alone change the key', k2 !== k1);
    fs.appendFileSync(path.join(unitRepo, 'tooling/suite-pair-trace.js'), '// edit\n');
    check('key: a checker helper\'s bytes change the key', keyNow() !== k2);
    fs.appendFileSync(path.join(unitRepo, 'tooling/test-u.js'), '// suite-pair-cache: native git reads plugins/demo/other.txt\n');
    const k3 = keyNow();
    fs.appendFileSync(path.join(unitRepo, 'plugins/demo/other.txt'), 'declared now\n');
    const k4 = keyNow();
    check('key: a file a declared native child reads changes the key', k4 !== k3);
    fs.writeFileSync(path.join(unitRepo, 'package.json'), JSON.stringify({ name: 'u', version: '1.0.0', type: 'commonjs' }));
    const k5 = keyNow();
    check('key: adding package.json changes the key', k5 !== k4);
    fs.writeFileSync(path.join(unitRepo, 'package.json'), JSON.stringify({ name: 'u', version: '1.0.1', type: 'commonjs' }));
    check('key: a version-only bump of package.json keeps the key', keyNow() === k5);
    fs.writeFileSync(path.join(unitRepo, 'package.json'), JSON.stringify({ name: 'u', version: '1.0.1', type: 'module' }));
    check('key: any other package.json change changes the key', keyNow() !== k5);
    fs.rmSync(path.join(unitRepo, 'package.json'));

    // settle(): what gets queued
    const c = open();
    const p = c.pair('test-u.js', 'plugins/demo/s.js', base);
    const ev = { cacheable: true, reasons: [], deps: new Map(), natives: new Set(['git']), states: [['read', 'plugins/demo/other.txt', 'y']] };
    c.settle(p, 'incomplete', base, ev, true);
    check('settle: an incomplete run is never queued', c.pending.length === 0 && p.cacheable === false, JSON.stringify(p.reasons));
    const p2 = c.pair('test-u.js', 'plugins/demo/s.js', base);
    c.settle(p2, 'killed', base, ev, false);
    check('settle: a run whose restore conflicted is never queued', c.pending.length === 0, JSON.stringify(p2.reasons));
    const p3 = c.pair('test-u.js', 'plugins/demo/s.js', base);
    c.settle(p3, 'killed', base, ev, true);
    check('settle: a completed, clean, declared run is queued', c.pending.length === 1, JSON.stringify(p3.reasons));
    c.flush(false);
    check('flush: entries are withheld from a run that had conflicts',
        fs.readdirSync(c.dir).length === 0 && /withheld/.test(c.flushed), String(c.flushed));
    c.pending.push({ p: p3, file: p3.file, text: 'x' });
    c.flush(true);
    check('flush: a clean run writes its entries', fs.existsSync(p3.file) && c.written === 1, String(c.written));
    const ev2 = Object.assign({}, ev, { natives: new Set(['curl']) });
    const p4 = c.pair('test-u.js', 'plugins/demo/s.js', base);
    c.settle(p4, 'killed', base, ev2, true);
    check('settle: an undeclared native child makes the pair uncacheable',
        p4.cacheable === false && p4.reasons.some((r) => /native child curl undeclared/.test(r)), JSON.stringify(p4.reasons));

    // entry validation
    const good = { schema: 1, key: 'k', outcome: 'killed', deps: { baseline: [['script', 'a', 's']], stub: [['read', 'b', 's']] } };
    check('entry: a well-formed entry has no defect', pc.entryDefect(good, 'k') === null);
    check('entry: an unknown outcome is a defect', pc.entryDefect(Object.assign({}, good, { outcome: 'maybe' }), 'k') !== null);
    check('entry: a wrong key is a defect', pc.entryDefect(good, 'other') !== null);
    check('entry: a malformed dependency list is a defect',
        pc.entryDefect(Object.assign({}, good, { deps: { baseline: [], stub: 'x' } }), 'k') !== null);
}

// --- evidence collection from synthetic trace and coverage -------------------
{
    const repo = unitRepo;
    const run = (records, opts) => {
        const o = opts || {};
        const d = tmp('ev');
        const run = { traceDir: path.join(d, 't'), covDir: path.join(d, 'c'), tmpRoot: path.join(d, 'scratch') };
        for (const x of [run.traceDir, run.covDir, run.tmpRoot]) fs.mkdirSync(x);
        const lines = [JSON.stringify(['start', 4242, 0])].concat(records.map((r) => JSON.stringify(r)));
        if (!o.killed) lines.push(JSON.stringify(['end']));
        fs.writeFileSync(path.join(run.traceDir, 't-4242-0-abcd.jsonl'), lines.join('\n') + '\n');
        const urls = (o.urls || []).map((u) => ({ url: require('url').pathToFileURL(u).href }));
        if (!o.noCoverage) fs.writeFileSync(path.join(run.covDir, 'coverage-4242-1-0.json'), JSON.stringify({ result: urls }));
        const ctx = { sweepRoot: repo, repoVariants: pc.rootVariants(repo), traceRoot: d, preload: TRACE, textIndex: undefined };
        return { ev: pc.collectEvidence(run, ctx), run };
    };
    const inRepo = path.join(repo, 'plugins', 'demo', 's.js');
    let r = run([['read', path.join(repo, 'plugins', 'demo', 'other.txt')], ['list', path.join(repo, 'plugins', 'demo')]], { urls: [inRepo] });
    check('evidence: repository loads, reads and listings become dependencies',
        r.ev.cacheable && r.ev.deps.has('script\0plugins/demo/s.js') && r.ev.deps.has('read\0plugins/demo/other.txt')
        && r.ev.deps.has('list\0plugins/demo'), JSON.stringify([...r.ev.deps.keys()]) + ' ' + r.ev.reasons);
    r = run([], { killed: true, urls: [inRepo] });
    check('evidence: a traced process with no end line is incomplete', !r.ev.cacheable
        && r.ev.reasons.includes('a traced process did not finish'), JSON.stringify(r.ev.reasons));
    r = run([], { noCoverage: true });
    check('evidence: a traced process with no coverage file is incomplete', !r.ev.cacheable, JSON.stringify(r.ev.reasons));
    r = run([['untraced', 'node']], { urls: [inRepo] });
    check('evidence: a Node child started without the trace is incomplete', !r.ev.cacheable, JSON.stringify(r.ev.reasons));
    r = run([['read', path.join(path.dirname(repo), 'outside-' + process.pid + '.txt')]], { urls: [inRepo] });
    check('evidence: a read outside the repository and the temp root is uncacheable',
        !r.ev.cacheable && r.ev.reasons.some((x) => /reads outside the repository/.test(x)), JSON.stringify(r.ev.reasons));
    const outside = path.join(path.dirname(repo), 'outside-written-' + process.pid + '.txt');
    r = run([['read', outside], ['write', outside, '-']], { urls: [inRepo] });
    check('evidence: a read outside the repository stays a reason when the run also wrote that path',
        !r.ev.cacheable && r.ev.reasons.some((x) => /reads outside the repository/.test(x)), JSON.stringify(r.ev.reasons));
    r = run([], { urls: [] });
    check('evidence: coverage that names no script is not coverage of the process',
        !r.ev.cacheable && r.ev.reasons.includes('coverage names no script'), JSON.stringify(r.ev.reasons));
    r = run([['resolve', './dep', inRepo]], { urls: [inRepo] });
    check('evidence: a require() from a repository file becomes a resolve dependency',
        r.ev.cacheable && r.ev.deps.has('resolve\0plugins/demo/s.js\n./dep'), JSON.stringify([...r.ev.deps.keys()]) + ' ' + r.ev.reasons);
    // A script run from the private temp root: attributed by its text.
    const sText = fs.readFileSync(inRepo, 'utf8');
    const copyPath = (rr) => path.join(rr.tmpRoot, 'copy.js');
    const mk = (records, urlsFn) => {
        const d = tmp('ev2');
        const rn = { traceDir: path.join(d, 't'), covDir: path.join(d, 'c'), tmpRoot: path.join(d, 'scratch') };
        for (const x of [rn.traceDir, rn.covDir, rn.tmpRoot]) fs.mkdirSync(x);
        const cp = copyPath(rn);
        const recs = records(cp);
        fs.writeFileSync(path.join(rn.traceDir, 't-7-0-ab.jsonl'),
            [JSON.stringify(['start', 7, 0])].concat(recs.map((x) => JSON.stringify(x)), [JSON.stringify(['end'])]).join('\n') + '\n');
        fs.writeFileSync(path.join(rn.covDir, 'coverage-7-1-0.json'), JSON.stringify({ result: urlsFn(cp).map((u) => ({ url: require('url').pathToFileURL(u).href })) }));
        return pc.collectEvidence(rn, { sweepRoot: repo, repoVariants: pc.rootVariants(repo), traceRoot: d, preload: TRACE, textIndex: undefined });
    };
    let e = mk((cp) => [['compile', cp, tr.textDigest(sText)]], (cp) => [cp]);
    check('evidence: a temp copy whose text matches one tracked file depends on that file',
        e.cacheable && e.deps.has('script\0plugins/demo/s.js'), JSON.stringify([...e.deps.keys()]) + ' ' + e.reasons);
    e = mk((cp) => [['compile', cp, tr.textDigest('module.exports = 1; // written by the suite\n')]], (cp) => [cp]);
    check('evidence: a temp script matching no tracked file is uncacheable',
        !e.cacheable && e.reasons.some((x) => /matches no repository file/.test(x)), JSON.stringify(e.reasons));
    const own = 'module.exports = 2; // fixture text\n';
    e = mk((cp) => [['write', path.join(path.dirname(cp), 'elsewhere.js'), tr.textDigest(own)], ['compile', cp, tr.textDigest(own)]], (cp) => [cp]);
    check('evidence: a temp script whose text the run itself wrote is derived, not a dependency',
        e.cacheable && e.deps.size === 0, JSON.stringify(e.reasons));
    e = mk(() => [], (cp) => [cp]);
    check('evidence: a temp script loaded with no recorded text is uncacheable', !e.cacheable, JSON.stringify(e.reasons));

    // States: what a lookup compares.
    const rs = () => pc.fileState(repo, 'resolve', 'plugins/demo/s.js\n./dep');
    const none = rs();
    fs.mkdirSync(path.join(repo, 'plugins/demo/dep'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'plugins/demo/dep/index.js'), 'module.exports = 1;\n');
    const viaDir = rs();
    fs.writeFileSync(path.join(repo, 'plugins/demo/dep.js'), 'module.exports = 2;\n');
    const viaFile = rs();
    check('state: a require that starts resolving, then resolves to a new file beside it, changes state each time',
        none === 'unresolved' && viaDir === 'path:plugins/demo/dep/index.js' && viaFile === 'path:plugins/demo/dep.js',
        JSON.stringify([none, viaDir, viaFile]));
    const st0 = pc.fileState(repo, 'stat', 'plugins/demo/other.txt');
    fs.appendFileSync(path.join(repo, 'plugins/demo/other.txt'), 'longer\n');
    check('state: a stat dependency changes with the file size', pc.fileState(repo, 'stat', 'plugins/demo/other.txt') !== st0, st0);
}

// --- the tracer itself, preloaded into real processes ---------------------------
{
    const d = tmp('tracer');
    const traceDir = path.join(d, 't');
    const covDir = path.join(d, 'c');
    fs.mkdirSync(traceDir);
    fs.mkdirSync(covDir);
    fs.writeFileSync(path.join(d, 'data.txt'), 'x');
    fs.writeFileSync(path.join(d, 'rw.txt'), 'x');
    fs.writeFileSync(path.join(d, 'late.txt'), 'x');
    fs.mkdirSync(path.join(d, 'lib'));
    fs.writeFileSync(path.join(d, 'lib', 'index.js'), 'module.exports = 1;\n');
    const script = path.join(d, 'probe.js');
    fs.writeFileSync(script, [
        "const fs = require('fs'); const path = require('path'); const cp = require('child_process');",
        "fs.readFileSync(path.join(__dirname, 'data.txt'));",
        "fs.readdirSync(__dirname);",
        "fs.existsSync(path.join(__dirname, 'nope'));",
        "fs.writeFileSync(path.join(__dirname, 'out.txt'), 'w');",
        "try { fs.writeFileSync(path.join(__dirname, 'no-such-dir', 'failed.txt'), 'w'); } catch { /* expected */ }",
        "fs.closeSync(fs.openSync(path.join(__dirname, 'rw.txt'), 'r+'));",
        "if (typeof fs.realpathSync.native !== 'function') throw new Error('realpathSync.native lost');",
        "fs.realpathSync.native(__dirname);",
        "require('./lib');",
        "cp.spawnSync('git', ['--version']);",
        "cp.spawnSync(process.execPath, ['-e', '1'], { env: { PATH: process.env.PATH } });",
        "cp.spawnSync(process.execPath, ['-e', '1']);",
        "process.on('exit', () => { fs.readFileSync(path.join(__dirname, 'late.txt')); });",
        "process.stdout.write('probe-done');",
    ].join('\n'));
    const env = Object.assign({}, process.env, {
        NODE_OPTIONS: '--require "' + TRACE.replace(/\\/g, '/') + '"',
        [tr.TRACE_DIR_ENV]: traceDir,
        [tr.COVERAGE_ENV]: covDir,
    });
    const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    check('tracer: the traced process runs normally and the tracer prints nothing',
        r.status === 0 && r.stdout === 'probe-done' && r.stderr === '', `exit ${r.status} stdout ${JSON.stringify(r.stdout)} stderr ${JSON.stringify(r.stderr.slice(0, 300))}`);
    const t = tr.readTraceDir(traceDir);
    const has = (kind, tail) => t.records.some((x) => x[0] === kind && (tail === undefined || String(x[1]).endsWith(tail)));
    check('tracer: every process that ran under it left a complete record',
        t.processes.length === 2 && t.processes.every((p) => p.complete), JSON.stringify(t.processes));
    check('tracer: a read, a listing, a stat and a write are recorded',
        has('read', 'data.txt') && has('list') && has('stat', 'nope') && has('write', 'out.txt'), JSON.stringify(t.records.slice(0, 20)));
    check('tracer: a native child is recorded by name', has('native') && t.records.some((x) => x[0] === 'native' && x[1] === 'git'));
    check('tracer: a Node child started with a replaced environment is recorded as untraced', has('untraced'));
    // Node records the main module and a require's parent by real path, so a temp
    // directory behind a symlink (macOS /var -> /private/var) names the script
    // under its other spelling. The same file, either way.
    const scriptReal = fs.realpathSync.native(script);
    const isScript = (p) => typeof p === 'string' && (p === script || p === scriptReal);
    check('tracer: the script it compiled is recorded with its text digest',
        t.records.some((x) => x[0] === 'compile' && isScript(x[1]) && x[2] === tr.textDigest(fs.readFileSync(script))),
        JSON.stringify(t.records.filter((x) => x[0] === 'compile')));
    check('tracer: a write that threw is not recorded as a write', !has('write', 'failed.txt'));
    check('tracer: a file opened r+ is recorded as read', has('read', 'rw.txt'));
    check('tracer: a read in an exit listener registered after the preload is recorded', has('read', 'late.txt'));
    check('tracer: a require() is recorded with its request and parent',
        t.records.some((x) => x[0] === 'resolve' && x[1] === './lib' && isScript(x[2])),
        JSON.stringify(t.records.filter((x) => x[0] === 'resolve')));
    check('tracer: fork() with a non-Node execPath is a native child',
        JSON.stringify(tr.classifyChild('fork', ['x.js', [], { execPath: 'C:/tools/native-reader.exe', env: {} }], {}))
        === JSON.stringify(['native', 'native-reader']));

    // Killed mid-run: a start and no end.
    const t2 = path.join(d, 't2');
    fs.mkdirSync(t2);
    const env2 = Object.assign({}, env, { [tr.TRACE_DIR_ENV]: t2 });
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { env: env2, timeout: 1500, windowsHide: true });
    const k = tr.readTraceDir(t2);
    check('tracer: a process killed mid-run leaves a start and no end', k.processes.length === 1 && !k.processes[0].complete,
        JSON.stringify(k.processes));
    // Required rather than preloaded, it installs nothing.
    check('tracer: a shell command line is classified by its program, and a compound one as a shell', tr.classifyChild('exec', ['git status | cat'], {}).join(' ') === 'native shell'
        && tr.classifyChild('execSync', ['git status'], {}).slice(0, 2).join(' ') === 'native git'
        && tr.classifyChild('execSync', ['git status'], {})[3].includes('!shell'));
}

// A git child is allowed undeclared only when it is confined to its run's own
// temp root. Each case below names one way out of that root, written by hand
// rather than derived from the tracer's own lists.
{
    const root = tmp('confine');
    const inRoot = path.join(root, 'fixture');
    const outside = tmp('confine-out');
    const home = tmp('confine-home');
    const conf = (recs, homes) => pc.gitConfinement(recs, root, homes || []);
    const git = (cwd, args, env) => ['native', 'git', ...Object.values(tr.gitReach(args, { cwd, env: env || {} }, false))];
    check('confine: a git child in its temp root with plain arguments is confined',
        conf([git(inRoot, ['init', '-q']), git(inRoot, ['commit', '-m', 'x y'])]).length === 0,
        JSON.stringify(conf([git(inRoot, ['init', '-q'])])));
    check('confine: a git child whose cwd is outside its temp root is not',
        /runs outside its temp root/.test(conf([git(outside, ['status'])]).join(';')));
    check('confine: an absolute argument outside the temp root is not',
        /reaches outside its temp root/.test(conf([git(inRoot, ['clone', outside, 'copy'])]).join(';')));
    check('confine: the path after --opt= is read as an argument',
        /reaches outside its temp root/.test(conf([git(inRoot, ['--git-dir=' + outside, 'log'])]).join(';')));
    check('confine: an absolute argument inside the temp root is confined',
        conf([git(inRoot, ['clone', path.join(root, 'origin'), 'copy'])]).length === 0);
    check('confine: a -c key=value naming a path outside the temp root is not',
        /reaches outside its temp root/.test(conf([git(inRoot, ['-c', 'include.path=' + outside, 'log'])]).join(';')));
    check('confine: a ~ path is not', /a git child tilde/.test(conf([git(inRoot, ['-c', 'include.path=~/x.gitconfig', 'log'])]).join(';')));
    check('confine: config given through the environment is not',
        /a git child configenv/.test(conf([git(inRoot, ['log'], { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'include.path', GIT_CONFIG_VALUE_0: 'x' })]).join(';'))
        && /a git child configenv/.test(conf([git(inRoot, ['log'], { GIT_CONFIG_PARAMETERS: "'core.hookspath'='x'" })]).join(';')));
    check('confine: a URL argument is not', /a git child url/.test(conf([git(inRoot, ['fetch', 'https://example.invalid/r.git'])]).join(';')));
    check('confine: a .. segment is not', /a git child dotdot/.test(conf([git(inRoot, ['clone', '../../elsewhere', 'c'])]).join(';')));
    check('confine: a shell command line is not', /a git child shell/.test(conf([['native', 'git', ...Object.values(tr.gitReach([], { cwd: inRoot }, true))]]).join(';')));
    check('confine: GIT_DIR outside the temp root is not',
        /reaches outside its temp root/.test(conf([git(inRoot, ['log'], { GIT_DIR: outside })]).join(';')));
    check('confine: a home outside the temp root and the sweep homes is not',
        /home outside its temp root/.test(conf([git(inRoot, ['log'], { HOME: home })]).join(';')));
    check('confine: the sweep\'s own home is allowed',
        conf([git(inRoot, ['log'], { HOME: home })], [process.platform === 'win32' ? path.resolve(home).toLowerCase() : path.resolve(home)]).length === 0,
        JSON.stringify(conf([git(inRoot, ['log'], { HOME: home })], [home])));
    check('confine: a record without its reach (an older tracer) is not',
        /no recorded reach/.test(conf([['native', 'git']]).join(';')));
    check('confine: no temp root confines nothing',
        pc.gitConfinement([git(inRoot, ['log'])], undefined, []).length > 0);
    // Git control files written by the run.
    const gf = (p, data) => ['gitfile', p, tr.gitControlReach(data)];
    check('confine: a git control file in the root naming nothing outside it is confined',
        conf([gf(path.join(inRoot, '.git', 'description'), 'fixture\n'), gf(path.join(inRoot, '.git'), 'gitdir: sub\n')]).length === 0);
    check('confine: a git control file naming a path outside the root is not',
        /names a path outside its temp root/.test(conf([gf(path.join(inRoot, '.git', 'config'), '[remote "o"]\n\turl = ' + outside + '\n')]).join(';')));
    check('confine: a gitdir file with a .. segment is not',
        /control file dotdot/.test(conf([gf(path.join(inRoot, '.git'), 'gitdir: ../../repo/.git/worktrees/w\n')]).join(';')));
    check('confine: a git control file written from a non-text value is not',
        /control file opaque/.test(conf([gf(path.join(inRoot, '.git', 'config'), new Uint8Array(4))]).join(';')));
    check('confine: a git control file written outside the root is not',
        /writes a git control file outside its temp root/.test(conf([gf(path.join(outside, '.git', 'config'), 'x\n')]).join(';')));
    check('trace: git control paths are a .git file, anything under .git, and .gitmodules',
        ['a/.git', 'a/.git/config', 'a\\.git\\info\\alternates', 'a/.gitmodules'].every(tr.isGitControl)
        && !['a/.gitignore', 'a/.github/x', 'a/git/config', 'a/x.git'].some(tr.isGitControl));

    // gitIdentity: git and its config outside any repository.
    const id1 = pc.gitIdentity(process.env);
    check('git identity: sound in a temp root no repository encloses', id1.sound === true && /^[0-9a-f]{64}$/.test(id1.digest), JSON.stringify(id1));
    const cfgA = path.join(tmp('gitcfg'), 'a.gitconfig');
    fs.writeFileSync(cfgA, '[user]\n\tname = fixture one\n');
    const cfgB = path.join(path.dirname(cfgA), 'b.gitconfig');
    fs.writeFileSync(cfgB, '[user]\n\tname = fixture two\n');
    const cfgH = path.join(path.dirname(cfgA), 'h.gitconfig');
    fs.writeFileSync(cfgH, '[core]\n\thooksPath = ' + outside.replace(/\\/g, '/') + '\n');
    const withCfg = (f) => Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: f, GIT_CONFIG_NOSYSTEM: '1' });
    const ida = pc.gitIdentity(withCfg(cfgA));
    const idb = pc.gitIdentity(withCfg(cfgB));
    check('git identity: a different global config changes its digest', ida.sound && idb.sound && ida.digest !== idb.digest);
    check('git identity: the same config gives the same digest', pc.gitIdentity(withCfg(cfgA)).digest === ida.digest);
    const idh = pc.gitIdentity(withCfg(cfgH));
    check('git identity: a configured hooks directory is unsound', idh.sound === false && /hooks or template/.test(idh.why), JSON.stringify(idh));
    // A repository enclosing the temp root: git would discover it from a fixture
    // directory that is not yet a repository.
    const enclosing = tmp('enclosing');
    gitIn(enclosing)('init', '-q');
    const inner = path.join(enclosing, 'tmp');
    fs.mkdirSync(inner);
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    let ide;
    try {
        process.env.TEMP = process.env.TMP = process.env.TMPDIR = inner;
        ide = pc.gitIdentity(process.env);
    } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    check('git identity: a repository enclosing the temp root is unsound',
        ide.sound === false && /encloses the temp root/.test(ide.why), JSON.stringify(ide));
}

// The tracer records a write to a git control file through each entry point.
{
    const d = tmp('gitfile');
    const traceDir = path.join(d, 't');
    const covDir = path.join(d, 'c');
    fs.mkdirSync(traceDir);
    fs.mkdirSync(covDir);
    const probeOut = tmp('gitfile-out');
    const script = path.join(d, 'probe.js');
    fs.writeFileSync(script, [
        "const fs = require('fs'); const path = require('path');",
        "const g = path.join(__dirname, 'fx', '.git'); fs.mkdirSync(g, { recursive: true });",
        "fs.writeFileSync(path.join(g, 'config'), '[remote \"o\"]\\n\\turl = ' + process.env.PROBE_OUT + '\\n');",
        "fs.appendFileSync(path.join(g, 'description'), 'fixture\\n');",
        "fs.copyFileSync(__filename, path.join(g, 'copied'));",
        "fs.writeFileSync(path.join(__dirname, 'fx', 'plain.txt'), 'x');",
        "fs.promises.writeFile(path.join(g, 'async'), 'gitdir: ../x\\n').then(() => process.stdout.write('probe-done'));",
    ].join('\n'));
    const env = Object.assign({}, process.env, {
        NODE_OPTIONS: '--require "' + TRACE.replace(/\\/g, '/') + '"',
        [tr.TRACE_DIR_ENV]: traceDir, [tr.COVERAGE_ENV]: covDir, PROBE_OUT: probeOut,
    });
    const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const recs = tr.readTraceDir(traceDir).records.filter((x) => x[0] === 'gitfile');
    const at = (tail) => recs.find((x) => String(x[1]).replace(/\\/g, '/').endsWith(tail));
    check('trace gitfile: the probe ran', r.status === 0 && r.stdout === 'probe-done', r.stderr.slice(0, 300));
    check('trace gitfile: a written config carries the absolute path its text names',
        at('.git/config') && at('.git/config')[2].some((p) => p.toLowerCase() === path.resolve(probeOut).toLowerCase()), JSON.stringify(recs));
    check('trace gitfile: an appended file is recorded', at('.git/description') && at('.git/description')[2].length === 0, JSON.stringify(recs));
    check('trace gitfile: a copy into .git is opaque', at('.git/copied') && at('.git/copied')[2].includes('!opaque'), JSON.stringify(recs));
    check('trace gitfile: an asynchronous write is recorded', at('.git/async') && at('.git/async')[2].includes('!dotdot'), JSON.stringify(recs));
    check('trace gitfile: a file outside .git is not a git control file', !at('plain.txt'), JSON.stringify(recs));
}

// ============================================================ end to end ==

const sub = (n) => `module.exports = { answer: () => 42 };  // subject ${n}\n`;
const suite = (n, before, after) => [
    "const fs = require('fs'); const path = require('path'); const cp = require('child_process');",
    before || '',
    `const s = require(path.join(__dirname, '..', 'plugins', 'demo', '${n}.js'));`,
    "if (typeof s.answer === 'function' && s.answer() === 42) process.exit(0);",
    after || '',
    'process.exit(1);',
    '',
].join('\n');
const externalDir = tmp('external');
const externalFile = path.join(externalDir, 'outside.txt');
fs.writeFileSync(externalFile, 'outside\n');
const DEMO = (...p) => `path.join(__dirname, '..', 'plugins', 'demo', ${p.map((x) => JSON.stringify(x)).join(', ')})`;
const FILES = {
    'VERSION': '1.0.0\n',
    'tooling/validate.js': [
        "const v = require('fs').readFileSync(require('path').join(__dirname, '..', 'VERSION'), 'utf8').trim();",
        "if (v === '0.0.0-canary') process.exit(1);",
        '',
    ].join('\n'),
    'unrelated.txt': 'one\n',
    // a: the subject requires a helper; only the baseline loads it.
    'plugins/demo/a.js': "const h = require('./helper'); module.exports = { answer: () => h.base() + 1 };\n",
    'plugins/demo/helper.js': 'module.exports = { base: () => 41 };\n',
    'tooling/test-a.js': suite('a'),
    // b: edited by the second commit.
    'plugins/demo/b.js': sub('b'),
    'tooling/test-b.js': suite('b'),
    // e: never edited; its pair must stay a hit across an unrelated commit.
    'plugins/demo/e.js': sub('e'),
    'tooling/test-e.js': suite('e'),
    // f: reads diag.txt only on its failure path, so only the STUB run depends on it.
    'plugins/demo/f.js': sub('f'),
    'plugins/demo/diag.txt': 'diagnosis one\n',
    'tooling/test-f.js': suite('f', '', `fs.readFileSync(${DEMO('diag.txt')}, 'utf8');`),
    // d: discovers its inputs by listing a directory.
    'plugins/demo/d.js': sub('d'),
    'plugins/demo/inputs/one.txt': '1\n',
    'tooling/test-d.js': suite('d', `if (!fs.readdirSync(${DEMO('inputs')}).length) process.exit(1);`),
    // n: a native child it does not declare.
    'plugins/demo/n.js': sub('n'),
    'tooling/test-n.js': suite('n', "cp.spawnSync('git', ['--version']);"),
    // g: the same native child, declared with the file it reads.
    'plugins/demo/g.js': sub('g'),
    'plugins/demo/conf.txt': 'conf one\n',
    'tooling/test-g.js': '// suite-pair-cache: native git reads plugins/demo/conf.txt\n'
        + suite('g', "cp.spawnSync('git', ['--version']);"),
    // q: an undeclared git child confined to its own temp root.
    'plugins/demo/q.js': sub('q'),
    'tooling/test-q.js': suite('q', String.raw`const d = fs.mkdtempSync(path.join(require('os').tmpdir(), 'q'));
cp.spawnSync('git', ['init', '-q'], { cwd: d });
fs.writeFileSync(path.join(d, '.git', 'description'), 'fixture\n');
cp.spawnSync('git', ['status', '--short'], { cwd: d });`),
    // w: the same, but the git config it writes names a path outside that root.
    'plugins/demo/w.js': sub('w'),
    'tooling/test-w.js': suite('w', String.raw`const d = fs.mkdtempSync(path.join(require('os').tmpdir(), 'w'));
cp.spawnSync('git', ['init', '-q'], { cwd: d });
fs.appendFileSync(path.join(d, '.git', 'config'), '[remote "o"]\n\turl = ' + path.dirname(process.env.PAIR_FIXTURE_EXTERNAL).replace(/\\/g, '/') + '\n');
cp.spawnSync('git', ['remote', '-v'], { cwd: d });`),
    // k: a traced child it kills, so the run's evidence is incomplete.
    'plugins/demo/k.js': sub('k'),
    'tooling/test-k.js': suite('k', "cp.spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeout: 1500 });"),
    // r: only the STUB run requires '../plugins/demo/rdep', which resolves to
    // rdep/index.js until the second commit adds rdep.js beside it. Nothing
    // that run loaded or read changes, so only re-resolving the request can
    // see that the same require() would now load a different file.
    'plugins/demo/r.js': sub('r'),
    'plugins/demo/rdep/index.js': 'module.exports = { v: 42 };\n',
    'tooling/test-r.js': suite('r', '', "require('../plugins/demo/rdep');"),
    // x: reads a file outside the repository.
    'plugins/demo/x.js': sub('x'),
    'tooling/test-x.js': suite('x', 'fs.readFileSync(process.env.PAIR_FIXTURE_EXTERNAL);'),
};
const SUITES = ['a', 'b', 'd', 'e', 'f', 'g', 'k', 'n', 'q', 'r', 'w', 'x'];
const CACHEABLE = ['a', 'b', 'd', 'e', 'f', 'g', 'q', 'r'];

// The fixture sweeps start as a top-level check:suites does: with no tracer.
// Under the real check:suites this suite is itself a traced pair, so its own
// environment carries that sweep's tracer preload in NODE_OPTIONS, its trace
// directory and its coverage directory. Inherited, the outer preload loads in
// every fixture process from outside the fixture repository, the cache rightly
// calls every pair uncacheable, and R1 to R4 fail on the harness, not on the
// cache. `[measured 2026-10-02]` the gate's check:suites read exactly that red.
function untracedEnv() {
    const drop = new Set(['NODE_OPTIONS', tr.TRACE_DIR_ENV.toUpperCase(), tr.COVERAGE_ENV.toUpperCase()]);
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!drop.has(k.toUpperCase())) env[k] = v;
    return env;
}

function runSweep(repo, cacheDir, label, flags, envExtra) {
    const report = path.join(cacheDir, '..', path.basename(cacheDir) + '-' + label + '.json');
    const env = Object.assign(untracedEnv(), {
        AUTODEV_SUITE_CACHE_DIR: cacheDir, AUTODEV_SUITE_CACHE_REPORT: report, AUTODEV_SUITE_CACHE: '',
        PAIR_FIXTURE_EXTERNAL: externalFile,
    }, envExtra || {});
    const r = sb.runBudgeted(process.execPath, [path.join(repo, 'tooling', path.basename(SWEEP))].concat(flags || []), {
        cwd: repo, encoding: 'utf8', timeout: BUDGET_MS, windowsHide: true, input: '', env,
    });
    if (sb.classify(r, 'exit2') !== 'verdict') {
        infra++;
        console.log(`INDETERMINATE  ${label}: sweep produced no verdict: ${sb.reason(r)} ${sb.lastWords(r, 400)}`);
        return null;
    }
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(report, 'utf8')); } catch { /* checked by the caller */ }
    const all = (r.stdout || '') + '\n' + (r.stderr || '');
    const byLetter = {};
    for (const p of (doc && doc.pairs) || []) {
        const m = p.suite.match(/^test-(\w+)\.js$/);
        if (m) byLetter[m[1]] = p;
    }
    return { code: r.status, all, doc, p: byLetter, rows: doc ? JSON.stringify(doc.rows) : null };
}
const tail = (s) => (s ? s.all.slice(-1500) : '');

{
    const repo = makeRepo('e2e space', FILES);
    const cacheRoot = tmp('e2e-cache');
    const cacheDir = path.join(cacheRoot, 'c');

    // R1: shadow, empty cache. Every pair runs, the cacheable ones are stored.
    const r1 = runSweep(repo, cacheDir, 'r1');
    if (r1) {
        check('R1 shadow: the sweep exits 0 with every suite verified', r1.code === 0
            && new RegExp(`${SUITES.length + 1} suite\\(s\\) · ${SUITES.length + 1} verified`).test(r1.all), tail(r1));
        check('R1 shadow: the report covers every planted pair', r1.doc && SUITES.every((s) => r1.p[s]), tail(r1));
        const bad = CACHEABLE.filter((s) => !(r1.p[s] && r1.p[s].stored && r1.p[s].fresh === 'killed'));
        check('R1 shadow: every cacheable pair ran fresh and was stored', bad.length === 0,
            bad.map((s) => s + ':' + JSON.stringify(r1.p[s] && [r1.p[s].lookup, r1.p[s].reasons, r1.p[s].stored])).join(' '));
        const why = (s) => (r1.p[s] ? r1.p[s].lookupReason + ' ' + r1.p[s].reasons.join(';') : 'absent');
        check('R1 shadow: an undeclared native child makes its pair uncacheable', r1.p.n && !r1.p.n.stored
            && /native child git undeclared/.test(why('n')), why('n'));
        check('R1 shadow: an undeclared git child outside its temp root says so',
            /native child git undeclared: a git child runs outside its temp root/.test(why('n')), why('n'));
        check('R1 shadow: a git config naming a path outside the temp root makes its pair uncacheable', r1.p.w && !r1.p.w.stored
            && /native child git undeclared: a git control file names a path outside its temp root/.test(why('w')), why('w'));
        check('R1 shadow: a killed traced child makes its pair uncacheable', r1.p.k && !r1.p.k.stored
            && /did not finish/.test(why('k')), why('k'));
        check('R1 shadow: a read outside the repository makes its pair uncacheable', r1.p.x && !r1.p.x.stored
            && /reads outside the repository/.test(why('x')), why('x'));
        check('R1 shadow: the summary prints the hit, miss and uncacheable populations',
            /\[pair-cache\] mode shadow \(default\) · 12 pair\(s\): 0 hit · 8 miss · 4 uncacheable/.test(r1.all), tail(r1));
    }

    // R2: shadow again on the same tree. Every stored pair is a hit and agrees.
    const r2 = r1 ? runSweep(repo, cacheDir, 'r2') : null;
    if (r2) {
        const notHit = CACHEABLE.filter((s) => !(r2.p[s] && r2.p[s].lookup === 'hit' && r2.p[s].agree === true));
        check('R2 shadow: every stored pair is a hit that agrees with its fresh run', notHit.length === 0,
            notHit.map((s) => s + ':' + JSON.stringify(r2.p[s] && [r2.p[s].lookup, r2.p[s].lookupReason, r2.p[s].fresh])).join(' '));
        check('R2 shadow: in shadow every pair still ran fresh', CACHEABLE.every((s) => r2.p[s] && r2.p[s].fresh === 'killed'));
        check('R2 shadow: the verdict rows are the uncached run\'s rows', r2.rows === r1.rows && r2.code === 0);
    }

    // R3: --cache on the same tree. Stored pairs are skipped, verdicts unchanged.
    const r3 = r2 ? runSweep(repo, cacheDir, 'r3', ['--cache']) : null;
    if (r3) {
        const notSkipped = CACHEABLE.filter((s) => !(r3.p[s] && r3.p[s].lookup === 'hit' && r3.p[s].fresh === null));
        check('R3 --cache: every valid pair is skipped', notSkipped.length === 0, notSkipped.join(','));
        check('R3 --cache: the uncacheable pairs still ran', ['k', 'n', 'w', 'x'].every((s) => r3.p[s] && r3.p[s].fresh === 'killed'));
        check('R3 --cache: the verdict rows and exit code are the uncached run\'s', r3.rows === r1.rows && r3.code === 0, tail(r3));
        check('R3 --cache: the summary counts the skipped pairs', /8 hit · 0 miss · 4 uncacheable · 8 skipped/.test(r3.all), tail(r3));
    }

    // Commit 2: one edit per scenario, plus an unrelated one, plus two entries
    // tampered with in the cache itself.
    if (r3) {
        writeFiles(repo, {
            'plugins/demo/b.js': sub('b') + '// edited subject\n',
            'plugins/demo/helper.js': 'module.exports = { base: () => 41 };  // edited helper\n',
            'plugins/demo/diag.txt': 'diagnosis two\n',
            'plugins/demo/inputs/two.txt': '2\n',
            'plugins/demo/conf.txt': 'conf two\n',
            'unrelated.txt': 'two\n',
            'plugins/demo/rdep.js': 'module.exports = { v: 42 };  // now wins the lookup\n',
        });
        check('commit 2 lands', commitAll(repo, 'edits'));
    }
    const tamper = (letter, fn) => {
        const p = r3 && r3.p[letter];
        if (!p || !p.key) return false;
        const f = path.join(cacheDir, 'v1', r3.doc.repoId, p.key + '.json');
        const e = JSON.parse(fs.readFileSync(f, 'utf8'));
        fs.writeFileSync(f, JSON.stringify(fn(e)));
        return true;
    };
    // e: still valid but its recorded outcome flipped, so shadow must DISAGREE.
    const tampered = r3 && tamper('e', (e) => Object.assign(e, { outcome: 'green' }));
    const r4 = tampered ? runSweep(repo, cacheDir, 'r4') : null;
    if (r4) {
        const p = r4.p;
        const desc = (s) => JSON.stringify(p[s] && [p[s].lookup, p[s].lookupReason]);
        check('R4: a file added beside a requirer that now wins its require() reruns the pair', p.r && p.r.lookup === 'miss'
            && /^dependency changed: resolve tooling\/test-r\.js\n\.\.\/plugins\/demo\/rdep$/.test(p.r.lookupReason), desc('r'));
        check('R4: an edited subject reruns its pair', p.b && p.b.lookup === 'miss', desc('b'));
        check('R4: an edited helper the baseline loads reruns its pair', p.a && p.a.lookup === 'miss'
            && /baseline/.test(p.a.lookupReason), desc('a'));
        check('R4: an edited file only the stub run reads reruns its pair', p.f && p.f.lookup === 'miss'
            && /dependency changed: read plugins\/demo\/diag\.txt/.test(p.f.lookupReason), desc('f'));
        check('R4: an added discovery input reruns its pair', p.d && p.d.lookup === 'miss', desc('d'));
        check('R4: an edited file a declared native child reads reruns its pair', p.g && p.g.lookup === 'miss', desc('g'));
        check('R4: an unrelated edit leaves an untouched pair a hit', p.e && p.e.lookup === 'hit', desc('e'));
        check('R4 shadow: a cached outcome that differs from the fresh run is reported as a disagreement',
            p.e && p.e.agree === false && /DISAGREE test-e\.js with plugins\/demo\/e\.js stubbed: cache said green, the fresh run said killed/.test(r4.all),
            tail(r4));
        check('R4 shadow: a disagreement changes no verdict and no exit code', r4.code === 0 && r4.rows === r1.rows, tail(r4));
    }

    // R5: corrupt entries are misses, never answers.
    if (r4) {
        const corrupt = (letter, text) => {
            const f = path.join(cacheDir, 'v1', r4.doc.repoId, r4.p[letter].key + '.json');
            fs.writeFileSync(f, text);
        };
        const bE = JSON.parse(fs.readFileSync(path.join(cacheDir, 'v1', r4.doc.repoId, r4.p.b.key + '.json'), 'utf8'));
        corrupt('b', JSON.stringify(Object.assign(bE, { outcome: 'maybe' })));
        corrupt('d', '{"schema":1,"key":');
    }
    const r5 = r4 ? runSweep(repo, cacheDir, 'r5', [], { AUTODEV_SUITE_CACHE: 'on' }) : null;
    if (r5) {
        check('R5: an entry with an impossible outcome is corrupt and the pair runs fresh',
            r5.p.b && r5.p.b.lookup === 'corrupt' && r5.p.b.fresh === 'killed', JSON.stringify(r5.p.b));
        check('R5: a truncated entry is corrupt and the pair runs fresh',
            r5.p.d && r5.p.d.lookup === 'corrupt' && r5.p.d.fresh === 'killed', JSON.stringify(r5.p.d));
        check('R5: AUTODEV_SUITE_CACHE=on reuses the others', ['a', 'e', 'f', 'g'].every((s) => r5.p[s] && r5.p[s].lookup === 'hit'),
            JSON.stringify(['a', 'e', 'f', 'g'].map((s) => r5.p[s] && r5.p[s].lookup)));
        check('R5: verdicts unchanged', r5.code === 0 && r5.rows === r1.rows, tail(r5));
    }

    // R6: --no-cache is the sweep as it was: no tracing, no report pairs.
    const r6 = r5 ? runSweep(repo, cacheDir, 'r6', ['--no-cache']) : null;
    if (r6) {
        check('R6 --no-cache: off, no pairs looked up, verdicts unchanged',
            /\[pair-cache\] off \(--no-cache\)/.test(r6.all) && r6.doc && r6.doc.pairs.length === 0 && r6.rows === r1.rows && r6.code === 0,
            tail(r6));
    }
}

// A release bump between two gate runs of two sessions. `[measured 2026-10-17]`
// every gate since 10-08 hit nothing: gate-lock gives each run a new
// AUTODEV_GATE_RUN_ID and token, the suite environment carried them into the
// key, and package.json's version moved on every release. So: the run id, the
// token, the session and the version all differ between B1 and B2, and only
// what a suite can actually observe may cost a rerun.
{
    const pkgJson = (v) => JSON.stringify({ name: 'fixture', version: v, type: 'commonjs' }, null, 2) + '\n';
    const repo = makeRepo('bump', {
        'VERSION': '1.0.0\n',
        'package.json': pkgJson('1.0.0'),
        'tooling/validate.js': FILES['tooling/validate.js'],
        'plugins/demo/b.js': sub('b'),
        'tooling/test-b.js': suite('b'),
        'plugins/demo/c.js': sub('c'),
        'tooling/test-c.js': suite('c'),
        'plugins/demo/e.js': sub('e'),
        'tooling/test-e.js': suite('e'),
        // v reads package.json itself, so a bump must rerun it.
        'plugins/demo/v.js': sub('v'),
        'tooling/test-v.js': suite('v', `JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));`),
    });
    const cacheDir = path.join(tmp('bump-cache'), 'c');
    const gateEnv = (n, v) => ({ AUTODEV_GATE_RUN_ID: 'run-' + n, AUTODEV_GATE_RUN_TOKEN: String(n),
        CLAUDE_CODE_SESSION_ID: 'session-' + n, npm_package_version: v });
    const bump = (v, extra) => {
        writeFiles(repo, Object.assign({ 'VERSION': v + '\n', 'package.json': pkgJson(v) }, extra || {}));
        return commitAll(repo, 'release ' + v);
    };
    const desc = (r, s) => JSON.stringify(r.p[s] && [r.p[s].lookup, r.p[s].lookupReason, r.p[s].fresh, r.p[s].agree]);
    const b1 = runSweep(repo, cacheDir, 'b1', [], gateEnv(1, '1.0.0'));
    if (b1) {
        check('B1: every pair of the bump fixture is stored', ['b', 'c', 'e', 'v'].every((s) => b1.p[s] && b1.p[s].stored),
            ['b', 'c', 'e', 'v'].map((s) => desc(b1, s)).join(' '));
    }
    const b2 = b1 && bump('1.0.1') ? runSweep(repo, cacheDir, 'b2', [], gateEnv(2, '1.0.1')) : null;
    if (b2) {
        check('B2: across a version-only bump, a new run id and a new session, untouched pairs are hits that agree',
            ['b', 'c', 'e'].every((s) => b2.p[s] && b2.p[s].lookup === 'hit' && b2.p[s].agree === true),
            ['b', 'c', 'e'].map((s) => desc(b2, s)).join(' '));
        check('B2: a suite that reads package.json itself reruns after the bump', b2.p.v && b2.p.v.lookup === 'miss'
            && /package\.json/.test(b2.p.v.lookupReason), desc(b2, 'v'));
        check('B2: the verdict rows are B1\'s', b2.code === 0 && b2.rows === b1.rows, tail(b2));
    }
    // B3: another bump, carrying two planted defects. test-b.js is made vacuous
    // (it exits 0 before it tests anything), which is the verdict the sweep
    // exists to catch, and c.js is edited. Both pairs must miss, and the fresh
    // run must report the vacuous suite, not a cached "killed".
    const vacuous = 'process.exit(0);\n' + suite('b');
    const b3 = b2 && bump('1.0.2', { 'tooling/test-b.js': vacuous, 'plugins/demo/c.js': sub('c') + '// edited\n' })
        ? runSweep(repo, cacheDir, 'b3', [], gateEnv(3, '1.0.2')) : null;
    if (b3) {
        check('B3: a suite made vacuous misses, and its fresh run is the vacuous verdict', b3.p.b && b3.p.b.lookup === 'miss'
            && b3.p.b.fresh === 'green' && b3.code === 1 && /VACUOUS/.test(b3.all), desc(b3, 'b') + ' ' + tail(b3));
        check('B3: an edited subject misses across a bump', b3.p.c && b3.p.c.lookup === 'miss', desc(b3, 'c'));
        check('B3: the untouched pair is still a hit that agrees', b3.p.e && b3.p.e.lookup === 'hit' && b3.p.e.agree === true, desc(b3, 'e'));
    }
    // B4: the same tree with a changed environment name that is not volatile.
    // A suite could read it, so every key is new.
    const b4 = b3 ? runSweep(repo, cacheDir, 'b4', [], Object.assign(gateEnv(4, '1.0.2'), { PAIR_FIXTURE_FLAG: 'changed' })) : null;
    if (b4) {
        check('B4: a changed environment name that is not volatile changes every key',
            ['b', 'c', 'e', 'v'].every((s) => b4.p[s] && b4.p[s].lookup === 'miss' && b4.p[s].lookupReason === 'no entry'),
            ['b', 'c', 'e', 'v'].map((s) => desc(b4, s)).join(' '));
    }
}

// A run with a conflict writes no entry at all, even for pairs that completed.
{
    const repo = makeRepo('conflict', {
        'VERSION': '1.0.0\n',
        'tooling/validate.js': FILES['tooling/validate.js'],
        'plugins/demo/e.js': sub('e'),
        'tooling/test-e.js': suite('e'),
        'plugins/demo/z.js': sub('z'),
        // Refuses (exit 2) once its subject is stubbed: a conflict, not a verdict.
        'tooling/test-z.js': suite('z', '', 'process.exit(2);'),
    });
    const cacheRoot = tmp('conflict-cache');
    const cacheDir = path.join(cacheRoot, 'c');
    const r = runSweep(repo, cacheDir, 'r');
    if (r) {
        check('conflict: the sweep is indeterminate', r.code === 2, tail(r));
        const entries = (() => { try { return fs.readdirSync(path.join(cacheDir, 'v1', r.doc.repoId)); } catch { return []; } })();
        check('conflict: no entry is written, not even for the clean pair', r.p.e && r.p.e.fresh === 'killed' && entries.length === 0,
            entries.join(','));
        check('conflict: the summary says the entries were withheld', /entries withheld/.test(r.all), tail(r));
    }
}

for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp root */ }
}
console.log(`\n${pass} passed, ${fail} failed${infra ? `, ${infra} indeterminate` : ''}`);
if (fail) console.log('Failed: ' + failures.join(' | '));
process.exitCode = fail ? 1 : (infra ? 2 : 0);
