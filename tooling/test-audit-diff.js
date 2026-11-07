#!/usr/bin/env node
'use strict';
// Suite for audit-diff.js: the deterministic new / still open / resolved diff
// between two audit findings files, and the evidence rules it enforces.
//
// Every case that reads a file goes through the CLI as a subprocess, so the
// exit codes the audit skill relies on are the ones graded. The pure functions
// are also driven directly.
//
// Run: node tooling/test-audit-diff.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'audit-diff.js');
const A = require(SCRIPT);

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail !== undefined ? '\n      -> ' + JSON.stringify(detail) : ''));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-diff-'));
function write(name, doc) {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, typeof doc === 'string' ? doc : JSON.stringify(doc), 'utf8');
    return p;
}
function run(args) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', windowsHide: true });
    return { code: r.status, out: r.stdout, err: r.stderr };
}
const finding = (over) => Object.assign(
    { severity: 'P1', file: 'src/a.js', line: 10, title: 'unchecked input', evidence: 'curl -i /api/x' }, over);
const doc = (findings, over) => Object.assign(
    { schema: 1, date: '2026-01-01', revision: 'abc', findings, checked_clean: ['auth routes'] }, over);

try {
    // --- pure: classification
    const prev = doc([finding({}), finding({ file: 'src/b.js', title: 'gone' }), finding({ file: 'src/c.js', title: 'bumped', severity: 'P2' })]);
    const curr = doc([finding({ line: 99 }), finding({ file: 'src/d.js', title: 'fresh', severity: 'P0' }),
        finding({ file: 'src/c.js', title: 'Bumped', severity: 'P1' })]);
    const d = A.diffFindings(prev, curr);
    check('line drift keeps a finding still open', d.still_open.some((f) => f.file === 'src/a.js'), d.still_open);
    check('new finding is new', d.new.length === 1 && d.new[0].file === 'src/d.js', d.new);
    check('missing finding is resolved', d.resolved.length === 1 && d.resolved[0].title === 'gone', d.resolved);
    check('title case does not split identity', d.still_open.length === 2, d.still_open);
    check('severity change is reported', d.changed.length === 1 && d.changed[0].from === 'P2' && d.changed[0].to === 'P1', d.changed);
    check('counts per severity', d.counts.new === 'P0:1 P1:0 P2:0', d.counts);
    check('an id outranks file and title', A.diffFindings(doc([finding({ id: 'X1' })]), doc([finding({ id: 'X1', file: 'moved.js', title: 'renamed' })])).still_open.length === 1);
    check('first run: everything new', A.diffFindings(null, curr).new.length === 3 && A.diffFindings(null, curr).previous === null);
    check('same id keys equal across lines', A.keyOf(finding({ line: 1 })) === A.keyOf(finding({ line: 2 })));

    // --- pure: evidence rules
    check('valid document has no problems', A.validateFindings(prev).length === 0, A.validateFindings(prev));
    check('finding without evidence refused', A.validateFindings(doc([finding({ evidence: ' ' })])).length === 1);
    check('bad severity refused', A.validateFindings(doc([finding({ severity: 'P3' })])).length === 1);
    check('non-integer line refused', A.validateFindings(doc([finding({ line: '4' })])).length === 1);
    check('null line accepted', A.validateFindings(doc([finding({ line: null })])).length === 0);
    check('missing checked_clean refused', A.validateFindings({ schema: 1, findings: [] }).some((p) => /checked_clean/.test(p)));
    check('duplicate finding refused', A.validateFindings(doc([finding({}), finding({ line: 3 })])).some((p) => /duplicates/.test(p)));
    check('metric without probe refused', A.validateFindings(doc([], { metrics: [{ name: 'files', value: 12 }] })).some((p) => /probe/.test(p)));
    check('metric with probe accepted', A.validateFindings(doc([], { metrics: [{ name: 'files', value: 12, probe: 'git ls-files | wc -l' }] })).length === 0);
    check('non-object refused', A.validateFindings([]).length === 1 && A.validateFindings(null).length === 1);
    check('wrong schema refused', A.validateFindings(doc([], { schema: 2 })).length === 1);
    check('findings not an array refused', A.validateFindings({ schema: 1, findings: {} }).some((p) => /findings must be/.test(p)));
    check('non-object finding refused', A.validateFindings(doc([null])).length === 1);
    check('metrics not an array refused', A.validateFindings(doc([], { metrics: 5 })).length === 1);
    check('nameless metric refused', A.validateFindings(doc([], { metrics: [{ probe: 'x' }] })).length === 1);
    check('parseArgs rejects unknown flag', A.parseArgs(['--nope']).error !== undefined);
    check('parseArgs rejects missing value', A.parseArgs(['--curr']).error !== undefined);
    check('parseArgs reads values', A.parseArgs(['--curr', 'a', '--json']).curr === 'a');
    check('render names the first run', /first run/.test(A.render(A.diffFindings(null, curr))));
    check('findPrevious on a missing dir is null', A.findPrevious(path.join(tmp, 'nope'), 'audit-2026-02-01.json') === null);

    // --- CLI
    const pPrev = write('audit-2026-01-01.json', prev);
    const pCurr = write('audit-2026-02-01.json', curr);
    const r1 = run(['--curr', pCurr, '--prev', pPrev]);
    check('cli: diff exits 0', r1.code === 0, r1);
    check('cli: output names NEW, STILL OPEN, RESOLVED', /NEW \(1\)/.test(r1.out) && /STILL OPEN \(2\)/.test(r1.out) && /RESOLVED \(1\)/.test(r1.out), r1.out);
    const r2 = run(['--curr', pCurr, '--dir', tmp, '--json']);
    const j = r2.code === 0 ? JSON.parse(r2.out) : null;
    check('cli: --dir picks the older file and --json parses', j && j.previous === '2026-01-01' && j.new.length === 1, r2);
    const r3 = run(['--curr', pPrev, '--dir', tmp]);
    check('cli: no older file is a first run, not an error', r3.code === 0 && /first run/.test(r3.out), r3);
    check('cli: finding without evidence exits 1', run(['--curr', write('bad.json', doc([finding({ evidence: '' })]))]).code === 1);
    check('cli: unparseable previous exits 2, never an empty baseline', run(['--curr', pCurr, '--prev', write('junk.json', '{nope')]).code === 2);
    check('cli: missing previous file exits 2', run(['--curr', pCurr, '--prev', path.join(tmp, 'absent.json')]).code === 2);
    check('cli: invalid previous exits 2', run(['--curr', pCurr, '--prev', write('badprev.json', doc([finding({ severity: 'X' })]))]).code === 2);
    check('cli: no --curr exits 2', run([]).code === 2);
    check('cli: unknown flag exits 2', run(['--zzz']).code === 2);
    check('cli: --help returns 0', run(['--help']).code === 0);
    const st = run(['--selftest']);
    check('cli: selftest passes', st.code === 0 && /selftest ok/.test(st.out), st);
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
    process.stderr.write(failures.length + ' failed:\n  ' + failures.join('\n  ') + '\n');
    process.exitCode = 1;
} else {
    process.stdout.write('audit-diff: ' + passed + ' checks passed\n');
}
