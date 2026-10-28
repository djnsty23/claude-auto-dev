'use strict';
// H3 plant: harness2's ledger checks duplicate labels before counts "because a duplicate can
// satisfy them". Plant that exact defect into a coverage receipt and see whether check() refuses.
// The fixture mirrors tooling/test-gate-evidence.js probeCompleteness.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const cr = require(path.resolve(__dirname, '../../../tooling/coverage-receipt.js'));

const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const fx = mk('h3-fx-');
fs.mkdirSync(path.join(fx, 'tooling'));
fs.mkdirSync(path.join(fx, 'plugins', 'fx'), { recursive: true });
for (const s of ['test-alpha.js', 'test-beta.js']) fs.writeFileSync(path.join(fx, 'tooling', s), 'process.exitCode = 0;\n');
fs.writeFileSync(path.join(fx, 'plugins', 'fx', 'thing.js'), 'module.exports = 1;\n');
spawnSync('git', ['init', '-q'], { cwd: fx, windowsHide: true });
const store = mk('h3-store-');
const env = { AUTODEV_COVERAGE_STORE: store };
const runDir = path.join(store, 'runs', 'r1');
fs.mkdirSync(runDir, { recursive: true });
const labels = cr.expectedLabels(path.join(fx, 'tooling'));
const dumps = labels.map((label) => {
  const buf = Buffer.from(JSON.stringify({ files: {} }));
  fs.writeFileSync(path.join(runDir, `${label}.json`), buf);
  return { label, file: `${label}.json`, sha256: cr.sha256(buf), rawDumps: 1 };
});
const src = cr.sourceHashes(fx);
const good = {
  schema: cr.SCHEMA, runId: 'r1', root: cr.canonicalRoot(fx), runDir, node: cr.nodeIdentity(), verdict: 'pass',
  outcomes: labels.map((label) => ({ label, state: 'pass' })), treeInert: { state: 'pass' },
  tree: { after: cr.treeIdentity(fx) }, sources: { start: src.digest, end: src.digest, files: src.files },
  expectedSuites: labels, executedSuites: labels, dumps,
};
const grade = (r) => { fs.writeFileSync(path.join(store, cr.RECEIPT), JSON.stringify(r)); try { return cr.check(fx, env); } catch (e) { return { ok: 'threw', problem: e.message }; } };
const [a, b] = labels;
const swap = (arr) => arr.map((l) => (l === b ? a : l)); // b replaced by a second a: same count
const plants = {
  control: good,
  'expected: dup a, b missing': { ...good, expectedSuites: swap(labels) },
  'executed: dup a, b missing': { ...good, executedSuites: swap(labels) },
  'outcomes: dup a, b missing': { ...good, outcomes: good.outcomes.map((o) => (o.label === b ? { label: a, state: 'pass' } : o)) },
  'outcomes: a twice, pass and fail': { ...good, outcomes: good.outcomes.concat([{ label: a, state: 'fail' }]) },
  'dumps: dup a, b missing': { ...good, dumps: dumps.map((d) => (d.label === b ? { ...dumps[0] } : d)) },
};
let pass = 0;
console.log(`labels: ${labels.join(', ')}`);
for (const [name, r] of Object.entries(plants)) {
  const g = grade(r);
  const want = name === 'control' ? true : false;
  const ok = g.ok === want;
  if (ok) pass++;
  console.log(`${ok ? 'OK  ' : 'MISS'} ${name}: ok=${g.ok}${g.problem ? ' | ' + String(g.problem).slice(0, 110) : ''}`);
}
console.log(`${pass}/${Object.keys(plants).length} graded as expected`);
process.exitCode = pass === Object.keys(plants).length ? 0 : 1;
