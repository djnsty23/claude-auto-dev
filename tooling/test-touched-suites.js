#!/usr/bin/env node
'use strict';
// test-touched-suites.js: drives tooling/touched-suites.js and tooling/gate-fast.js as
// subprocesses against a hand-built git fixture.
//
// The fixture has one suite per way a suite can reach a file, and one that reaches
// nothing, so each reach rule has its own assertion:
//   test-alpha   names lib/subject.js by basename in a path.join
//   test-beta    requires lib/hub.js, which requires lib/mid.js, which requires lib/leaf.js
//   test-gamma   names the fixture dir gamma-fix, whose m.json names lib/far.js (one hop)
//   test-delta   names nothing, so it is never selected
// Then gate-fast must run the selected suite, go red on it, and write a run record
// with the head, the dirty flag and the failed suite's tail. With no base it is exit 2.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOUCHED = path.join(__dirname, 'touched-suites.js');
const GATE_FAST = path.join(__dirname, 'gate-fast.js');
let failed = 0;
let checks = 0;
function check(name, cond, detail) {
    checks++;
    if (cond) { console.log(`PASS  ${name}`); return; }
    failed++;
    console.log(`FAIL  ${name}`);
    if (detail) console.log(String(detail).split('\n').slice(0, 30).map((l) => `      ${l}`).join('\n'));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'touched-suites-'));
const repo = path.join(tmp, 'repo');
const home = path.join(tmp, 'home');
const g = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
};
const put = (rel, text) => { const p = path.join(repo, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const FILES = {
    'package.json': JSON.stringify({ name: 'fixture', version: '0.0.0', scripts: { gate: 'npm run check:agents-md', 'check:agents-md': 'node -e "process.exit(0)"' } }, null, 2),
    'lib/subject.js': 'module.exports = 1;\n',
    'lib/hub.js': "const path = require('path');\nmodule.exports = require(path.join(__dirname, 'mid.js'));\n",
    'lib/mid.js': "module.exports = require('./leaf.js');\n",
    'lib/leaf.js': 'module.exports = 2;\n',
    'lib/far.js': 'module.exports = 3;\n',
    'lib/other.js': 'module.exports = 4;\n',
    'tooling/test-alpha.js': "const fs = require('fs'); const path = require('path');\nconst S = path.join(__dirname, '..', 'lib', 'subject.js');\nif (fs.readFileSync(S, 'utf8').includes('BROKEN')) { console.log('FAIL  alpha saw the planted defect'); process.exitCode = 1; } else console.log('PASS  alpha');\n",
    'tooling/test-beta.js': "require('../lib/hub.js');\nconsole.log('PASS  beta');\n",
    'tooling/test-gamma.js': "const path = require('path');\nrequire(path.join(__dirname, 'fixtures', 'gamma-fix', 'm.json'));\nconsole.log('PASS  gamma');\n",
    'tooling/fixtures/gamma-fix/m.json': JSON.stringify({ file: 'lib/far.js' }),
    'tooling/test-delta.js': "console.log('PASS  delta');\n",
};

function setup() {
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    g('init', '-q');
    g('config', 'user.email', 'fixture@example.invalid');
    g('config', 'user.name', 'fixture');
    for (const [rel, text] of Object.entries(FILES)) put(rel, text);
    g('add', '.');
    g('commit', '-q', '-m', 'fixture');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
}

function select(extra = []) {
    const r = spawnSync(process.execPath, [TOUCHED, '--root', repo, '--json', ...extra], { encoding: 'utf8' });
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* reported below */ }
    return { code: r.status, j, out: r.stdout + r.stderr, names: j ? j.selected.map((s) => s.suite).sort() : null };
}

/** Plant a change to `rel`, select, then restore it with the inverse write. */
function touching(rel, fn) {
    const before = fs.readFileSync(path.join(repo, rel), 'utf8');
    put(rel, `${before}// touched\n`);
    try { return fn(select()); } finally { put(rel, before); }
}

function gateFast(extra = []) {
    const r = spawnSync(process.execPath, [GATE_FAST, '--root', repo, ...extra], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: home } });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function lastRecord() {
    const dir = path.join(home, 'autodev', 'locks', 'fast-gate.runs');
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return null; }
    if (!names.length) return null;
    const recs = names.map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
    return recs.sort((a, b) => String(a.endUtc).localeCompare(String(b.endUtc))).pop();
}

try {
    setup();

    // -- Selection, one reach rule per assertion -----------------------------------
    let r = select();
    check('a clean tree selects nothing and still reads the population', r.code === 0 && r.names && r.names.length === 0 && r.j.suites === 4, r.out);

    touching('lib/subject.js', (x) => check('a basename named in a path.join selects that suite only', JSON.stringify(x.names) === '["tooling/test-alpha.js"]', x.out));
    touching('lib/leaf.js', (x) => check('a file three require() levels down selects the suite (require closure)', JSON.stringify(x.names) === '["tooling/test-beta.js"]', x.out));
    touching('lib/far.js', (x) => check('a file a fixture names selects the suite that names the fixture dir (one hop)', JSON.stringify(x.names) === '["tooling/test-gamma.js"]', x.out));
    touching('tooling/fixtures/gamma-fix/m.json', (x) => check('the fixture file itself selects its suite', JSON.stringify(x.names) === '["tooling/test-gamma.js"]', x.out));
    touching('tooling/test-delta.js', (x) => check('a suite that names nothing is selected only by its own edit', JSON.stringify(x.names) === '["tooling/test-delta.js"]', x.out));
    touching('lib/other.js', (x) => check('a file no suite reaches selects nothing', x.names && x.names.length === 0, x.out));

    // A new untracked file counts as touched.
    put('lib/new.js', 'module.exports = 5;\n');
    put('tooling/test-epsilon.js', "require('../lib/new.js');\n");
    r = select();
    check('an untracked suite and its untracked subject are selected', r.names && r.names.includes('tooling/test-epsilon.js'), r.out);
    fs.unlinkSync(path.join(repo, 'lib', 'new.js'));
    fs.unlinkSync(path.join(repo, 'tooling', 'test-epsilon.js'));

    r = select(['--base', 'refs/remotes/origin/no-such']);
    check('an unreadable base exits 2, never an empty selection', r.code === 2 && /COULD NOT READ/.test(r.out), r.out);

    // -- gate-fast runs the selection and records it -------------------------------
    let gf = gateFast();
    let rec = lastRecord();
    const head = g('rev-parse', 'HEAD');
    check('gate-fast on a clean tree exits 0 and says no suite was selected', gf.code === 0 && /touched suites: 0 of 4 selected/.test(gf.out), gf.out);
    check('the clean run record carries the head, dirty=false and exit 0', rec && rec.kind === 'gate-fast' && rec.head === head && rec.dirty === false && rec.exit === 0 && rec.touched.evidence.length === 0, JSON.stringify(rec));

    const subject = fs.readFileSync(path.join(repo, 'lib', 'subject.js'), 'utf8');
    put('lib/subject.js', `${subject}// BROKEN\n`);
    gf = gateFast();
    rec = lastRecord();
    put('lib/subject.js', subject);
    check('a touched suite that fails turns gate-fast red (exit 1) and names it', gf.code === 1 && /FAIL\s+tooling\/test-alpha\.js\s+exit=1/.test(gf.out) && /alpha saw the planted defect/.test(gf.out), gf.out);
    check('only the selected suite ran', !/test-beta|test-gamma|test-delta/.test(gf.out), gf.out);
    const ev = rec && rec.touched && rec.touched.evidence && rec.touched.evidence[0];
    check('the red run record is dirty, exit 1, and the failed suite carries its exit and tail',
        rec && rec.dirty === true && rec.exit === 1 && ev && ev.step === 'tooling/test-alpha.js' && ev.status === 'fail' && ev.exit === 1 && /planted defect/.test(ev.tail.text), JSON.stringify(rec));

    g('update-ref', '-d', 'refs/remotes/origin/main');
    gf = gateFast();
    check('gate-fast with no readable base is INDETERMINATE (exit 2)', gf.code === 2 && /touched suites: INDETERMINATE/.test(gf.out), gf.out);
    rec = lastRecord();
    check('the indeterminate run record says why', rec && rec.exit === 2 && rec.touched && /merge base/.test(rec.touched.error || ''), JSON.stringify(rec));
} catch (e) {
    failed++;
    console.log(`FAIL  the suite crashed: ${e.stack || e}`);
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\ntouched-suites: ${checks - failed}/${checks} checks passed`);
process.exitCode = failed ? 1 : 0;
