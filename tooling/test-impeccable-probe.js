#!/usr/bin/env node
'use strict';

// Subprocess controls for plugins/autodev-core/scripts/impeccable-probe.js.
// The real CLI is replaced by a stub `npx` on PATH that replays output captured
// from impeccable 4.5.2 on tooling/fixtures/impeccable-probe/slop (purple
// gradient on white, Inter everywhere, nested cards). The stub refuses any
// invocation other than the pinned one, so the probe and the measured command
// form cannot drift apart. No network is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const probe = path.resolve(__dirname, '../plugins/autodev-core/scripts/impeccable-probe.js');
const { IMPECCABLE_VERSION } = require(probe);
const { createReview, evaluate } = require('../plugins/autodev-core/scripts/design-review.js');
const fixtures = path.join(__dirname, 'fixtures/impeccable-probe');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-probe-')));
const stubDir = path.join(root, 'bin');
const emptyBin = path.join(root, 'empty-bin');
let passed = 0;
let failed = 0;

function test(label, run) {
  try { run(); passed++; console.log(`PASS ${label}`); }
  catch (error) { failed++; console.error(`FAIL ${label}: ${error.stack}`); }
}

// The stub: pinned argv or exit 64, then the captured output for the target.
const stub = `'use strict';
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2);
const want = ['-y', 'impeccable@${IMPECCABLE_VERSION}', 'detect', '--json'];
if (args.length !== 5 || want.some((w, i) => args[i] !== w)) { process.stderr.write('unexpected invocation: ' + args.join(' ')); process.exit(64); }
const mode = process.env.STUB_MODE || '';
const name = path.basename(args[4]);
if (mode === 'fail') { process.stdout.write('[]'); process.stderr.write('Warning: cannot access ' + args[4]); process.exit(1); }
if (mode === 'garbage') { process.stdout.write('3 anti-patterns found'); process.exit(2); }
if (mode === 'contradict') { process.stdout.write('[]'); process.exit(2); }
if (mode === 'advisory') { process.stdout.write(JSON.stringify([{ antipattern: 'em-dash-overuse', category: 'quality', severity: 'advisory' }])); process.exit(0); }
if (name === 'slop') { process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(fixtures, 'detect-slop.json'))}, 'utf8')); process.exit(2); }
if (name === 'clean') { process.stdout.write('[]\\n'); process.exit(0); }
process.stderr.write('stub has no capture for ' + name); process.exit(70);
`;

function setup() {
  fs.mkdirSync(stubDir, { recursive: true });
  fs.mkdirSync(emptyBin, { recursive: true });
  const stubJs = path.join(stubDir, 'stub.js');
  fs.writeFileSync(stubJs, stub);
  fs.writeFileSync(path.join(stubDir, 'npx'), `#!/bin/sh\nexec "${process.execPath}" "${stubJs}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(stubDir, 'npx.cmd'), `@"${process.execPath}" "${stubJs}" %*\r\n`);
}

function run(args, { bin = stubDir, mode = '' } = {}) {
  const env = { PATH: bin, STUB_MODE: mode };
  for (const key of ['SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  const r = spawnSync(process.execPath, [probe, ...args], { env, encoding: 'utf8', timeout: 30000 });
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { /* asserted by callers */ }
  return { code: r.status, report, stdout: r.stdout, stderr: r.stderr };
}

const target = name => path.join(fixtures, name);
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function ledgerStatus(artifactName, revision) {
  const review = createReview({
    product: 'Probe fixture', audience: 'Visitors', primaryTask: 'Read the page', revision,
    brandRules: ['Fixture tokens'], references: [], calibration: 'unavailable',
    cases: [{ id: 'home', route: '/', viewport: { width: 1280, height: 800 }, role: 'visitor', data: 'fixture copy', state: 'success' }],
    acceptance: { 'generic-tells': [{ name: 'impeccable slop findings', operator: 'lte', expected: 0 }] },
  });
  review.observations = [{ criterion: 'generic-tells', caseId: 'home', revision, evidence: [{ path: artifactName, sha256: sha(path.join(root, artifactName)), kind: 'measurement' }] }];
  const report = evaluate(review, { root });
  return { row: report.results.find(r => r.criterion === 'generic-tells'), overall: report.status };
}

try {
  setup();

  test('planted negative: purple gradient, Inter everywhere and nested cards fire (exit 1)', () => {
    const r = run([target('slop')]);
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.report.status, 'findings');
    for (const rule of ['ai-color-palette', 'overused-font', 'nested-cards']) assert.ok(r.report.byRule[rule] >= 1, `${rule} missing from ${JSON.stringify(r.report.byRule)}`);
    assert.equal(r.report.primary, 9);
    assert.equal(r.report.slop, 6);
    assert.equal(r.report.population.files, 1);
    console.log(`  planted: exit ${r.code} ${JSON.stringify(r.report.byRule)}`);
  });

  test('clean page passes (exit 0) after a scan that read one file', () => {
    const r = run([target('clean')]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.report.status, 'clean');
    assert.equal(r.report.primary, 0);
    assert.equal(r.report.population.files, 1);
    console.log(`  clean: exit ${r.code} status ${r.report.status} files ${r.report.population.files}`);
  });

  test('absent npx is indeterminate (exit 2), never a pass', () => {
    const r = run([target('clean')], { bin: emptyBin });
    assert.equal(r.code, 2);
    assert.equal(r.report.status, 'indeterminate');
  });

  test('impeccable exit 1 (target unscannable) is indeterminate', () => {
    const r = run([target('clean')], { mode: 'fail' });
    assert.equal(r.code, 2);
    assert.match(r.report.reason, /exited 1/);
  });

  test('unparseable output is indeterminate, even with the findings exit code', () => {
    const r = run([target('slop')], { mode: 'garbage' });
    assert.equal(r.code, 2);
    assert.match(r.report.reason, /not JSON/);
  });

  test('exit 2 with an empty findings array is contradictory, so indeterminate', () => {
    const r = run([target('slop')], { mode: 'contradict' });
    assert.equal(r.code, 2);
    assert.match(r.report.reason, /contradictory/);
  });

  test('advisories on exit 0 are listed but never fail the scan', () => {
    const r = run([target('clean')], { mode: 'advisory' });
    assert.equal(r.code, 0);
    assert.equal(r.report.advisories, 1);
  });

  test('a directory with no scannable file is indeterminate before impeccable runs', () => {
    const empty = path.join(root, 'empty-site');
    fs.mkdirSync(path.join(empty, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(empty, 'node_modules', 'ignored.html'), '<p>vendored</p>');
    fs.writeFileSync(path.join(empty, 'README.txt'), 'no markup');
    const r = run([empty]);
    assert.equal(r.code, 2);
    assert.match(r.report.reason, /read 0 scannable files/);
  });

  test('a missing target is indeterminate', () => {
    const r = run([path.join(root, 'does-not-exist')]);
    assert.equal(r.code, 2);
  });

  test('a changed invocation is refused by the stub, so the probe goes indeterminate', () => {
    // Control for the stub itself: a wrong argv must not replay a capture.
    const r = spawnSync(process.execPath, [path.join(stubDir, 'stub.js'), '-y', 'impeccable', 'detect', '--json', target('slop')], { encoding: 'utf8' });
    assert.equal(r.status, 64);
  });

  test('--out writes a ledger artifact: planted fails the generic-tells row, clean verifies it', () => {
    const bad = run([target('slop'), '--case', 'home', '--revision', 'rev-a', '--out', path.join(root, 'slop-artifact.json')]);
    assert.equal(bad.code, 1);
    const badLedger = ledgerStatus('slop-artifact.json', 'rev-a');
    assert.equal(badLedger.row.status, 'failed');
    assert.equal(badLedger.row.checks[0].observed, 6);
    const good = run([target('clean'), '--case', 'home', '--revision', 'rev-b', '--out', path.join(root, 'clean-artifact.json')]);
    assert.equal(good.code, 0);
    assert.equal(ledgerStatus('clean-artifact.json', 'rev-b').row.status, 'verified');
    console.log(`  ledger: planted row ${badLedger.row.status}, clean row verified`);
  });

  test('an indeterminate scan writes no artifact, so the ledger row stays unknown', () => {
    const out = path.join(root, 'none.json');
    const r = run([target('clean'), '--case', 'home', '--revision', 'rev-c', '--out', out], { bin: emptyBin });
    assert.equal(r.code, 2);
    assert.equal(fs.existsSync(out), false);
  });
} finally {
  // Only remove the exact mkdtemp directory owned by this suite.
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`impeccable-probe: ${passed}/${passed + failed} passed`);
process.exitCode = failed ? 1 : 0;
