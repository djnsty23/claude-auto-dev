#!/usr/bin/env node
'use strict';

// Independent acceptance controls for the review ledger, not evidence that a
// real product meets the criteria. Every control drives the shipped module;
// CLI controls additionally assert the public exit-code contract.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../plugins/autodev-core/scripts/design-review.js');
const { catalog, createReview, evaluate, compare } = require(script);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'design-review-acceptance-')));
let sequence = 0;
let passed = 0;
let failed = 0;
const clone = value => JSON.parse(JSON.stringify(value));
const subjective = criterion => criterion.layer === 'judgment';
const objective = () => catalog.find(criterion => !subjective(criterion));

function test(label, run) {
  try { run(); passed++; console.log(`PASS ${label}`); }
  catch (error) { failed++; console.error(`FAIL ${label}: ${error.stack}`); }
}

function definition(revision = 'fixture-before') {
  return {
    product: 'Controlled acceptance fixture', audience: 'People choosing a service',
    primaryTask: 'Select a suitable plan and confirm the selection',
    brandRules: ['Use the fixture token configuration'], references: [], calibration: 'unavailable',
    revision,
    cases: [{ id: 'long-mobile', route: '/plans', viewport: { width: 390, height: 844 },
      role: 'visitor', data: 'long plan names and one absent description', state: 'success' }],
    acceptance: Object.fromEntries(catalog.filter(criterion => !subjective(criterion)).map(criterion => [criterion.id,
      [{ name: `${criterion.id}:fixture-defects`, operator: 'eq', expected: 0 }]])),
  };
}

function artifact(kind, data) {
  const relative = `evidence-${++sequence}.${kind === 'screenshot' ? 'png' : 'json'}`;
  // A real tiny PNG, intentionally synthetic. It tests the evidence boundary,
  // not the visual quality of a rendered application.
  const bytes = kind === 'screenshot'
    ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Y1sAAAAASUVORK5CYII=', 'base64')
    : Buffer.from(JSON.stringify(data));
  fs.writeFileSync(path.join(root, relative), bytes);
  return { path: relative, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), kind };
}

function complete(revision = 'fixture-before') {
  const review = createReview(definition(revision));
  review.observations = catalog.map(criterion => {
    const base = { criterion: criterion.id, caseId: 'long-mobile', revision };
    if (subjective(criterion)) {
      const judgment = { disposition: 'acceptable', rationale: 'Synthetic review for the ledger acceptance control only.', reviewer: 'acceptance fixture' };
      return { ...base, judgment, evidence: [artifact('screenshot'), artifact('review', { ...base, judgment })] };
    }
    const checks = review.definition.acceptance[criterion.id].map(check => ({ ...check, observed: 0 }));
    return { ...base, checks, evidence: [artifact(criterion.layer === 'usability' ? 'interaction' : 'measurement', { ...base, checks })] };
  });
  return review;
}

function row(review, criterion = objective().id) { return review.observations.find(item => item.criterion === criterion); }
function result(review, criterion = objective().id) {
  return evaluate(review, { root }).results.find(item => item.criterion === criterion && item.caseId === 'long-mobile');
}
function rewriteEvidence(observation, mutate) {
  const index = observation.evidence.findIndex(item => item.kind !== 'screenshot');
  const current = observation.evidence[index];
  const data = JSON.parse(fs.readFileSync(path.join(root, current.path), 'utf8'));
  mutate(data);
  observation.evidence[index] = artifact(current.kind, data);
}
function failObservation(review, criterion = objective().id) {
  const observation = row(review, criterion);
  observation.checks[0].observed = 1;
  rewriteEvidence(observation, data => { data.checks[0].observed = 1; });
}
function cli(command, ...records) {
  const files = records.map(record => {
    const file = path.join(root, `input-${++sequence}.json`);
    fs.writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record));
    return file;
  });
  const run = spawnSync(process.execPath, [script, command, ...files], { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.ifError(run.error);
  return { code: run.status, report: JSON.parse(run.stdout), stderr: run.stderr };
}

try {
  test('catalog has 20-30 unique criteria across the three promised layers', () => {
    assert.ok(catalog.length >= 20 && catalog.length <= 30);
    assert.equal(new Set(catalog.map(item => item.id)).size, catalog.length);
    assert.deepEqual(new Set(catalog.map(item => item.layer)), new Set(['measurable', 'judgment', 'usability']));
    for (const criterion of catalog) for (const field of ['applicability', 'evidence', 'severity', 'completion']) assert.ok(criterion[field], `${criterion.id}.${field}`);
  });
  test('new review has unknown outcomes and all criterion-case requirements', () => {
    const review = createReview(definition());
    assert.equal(review.requirements.length, catalog.length);
    for (const value of Object.values(review.outcomes)) assert.equal(value, null);
    const report = evaluate(review, { root });
    assert.equal(report.status, 'incomplete');
    assert.equal(report.results.length, catalog.length);
    assert.ok(report.results.every(item => item.status === 'unknown'));
  });
  test('every criterion is independently required for every scenario', () => {
    const def = definition();
    def.cases.push({ ...clone(def.cases[0]), id: 'empty-desktop', state: 'empty', data: 'no plans', viewport: { width: 1280, height: 900 } });
    const review = createReview(def);
    review.observations = complete().observations;
    const report = evaluate(review, { root });
    assert.equal(report.results.length, catalog.length * 2);
    assert.equal(report.results.filter(item => item.caseId === 'empty-desktop' && item.status === 'unknown').length, catalog.length);
    assert.equal(report.status, 'incomplete');
  });
  test('complete positive control verifies coverage while judgments remain advisory', () => {
    const report = evaluate(complete(), { root });
    assert.equal(report.status, 'verified');
    for (const item of report.results) assert.equal(item.status, subjective(catalog.find(criterion => criterion.id === item.criterion)) ? 'advisory' : 'verified');
  });
  test('a real failed assertion produces a failed row and report', () => {
    const review = complete(); failObservation(review);
    assert.equal(result(review).status, 'failed');
    assert.equal(evaluate(review, { root }).status, 'failed');
  });
  test('deleting requirements cannot erase the expected coverage population', () => {
    const review = createReview(definition()); review.requirements = [];
    const report = evaluate(review, { root });
    assert.notEqual(report.status, 'verified');
    assert.equal(report.results.length, catalog.length);
  });
  test('dropping an observation creates unknown coverage', () => {
    const review = complete(); review.observations = review.observations.filter(item => item.criterion !== objective().id);
    assert.equal(result(review).status, 'unknown'); assert.equal(evaluate(review, { root }).status, 'incomplete');
  });
  test('missing evidence is unknown, never a verified row', () => {
    const review = complete(); row(review).evidence = [];
    assert.equal(result(review).status, 'unknown');
  });
  test('deleted evidence is unknown even when recorded checks pass', () => {
    const review = complete(); fs.unlinkSync(path.join(root, row(review).evidence[0].path));
    assert.equal(result(review).status, 'unknown');
  });
  test('changed file bytes invalidate the recorded hash', () => {
    const review = complete(); fs.appendFileSync(path.join(root, row(review).evidence[0].path), ' ');
    assert.equal(result(review).status, 'unknown');
  });
  test('absolute artifact paths are refused even for existing hash-valid files', () => {
    const review = complete(); const evidence = row(review).evidence[0];
    assert.equal(result(review).status, 'verified');
    evidence.path = path.join(root, evidence.path);
    assert.equal(result(review).status, 'unknown');
  });
  test('parent traversal cannot read hash-valid artifacts outside the evidence root', () => {
    const review = complete(); const observation = row(review);
    assert.equal(result(review).status, 'verified');
    const nested = path.join(root, `nested-${++sequence}`); fs.mkdirSync(nested);
    observation.evidence[0].path = `../${observation.evidence[0].path}`;
    const checked = evaluate(review, { root: nested }).results.find(item => item.criterion === objective().id);
    assert.equal(checked.status, 'unknown');
    assert.match(checked.reason, /escapes evidence root/);
  });
  test('symlink or junction cannot bypass the evidence root boundary', () => {
    const review = complete(); const evidence = row(review).evidence[0];
    const nested = path.join(root, `link-root-${++sequence}`); fs.mkdirSync(nested);
    const outside = path.join(root, `link-outside-${++sequence}`); fs.mkdirSync(outside);
    fs.copyFileSync(path.join(root, evidence.path), path.join(outside, 'measurement.json'));
    fs.symlinkSync(outside, path.join(nested, 'linked'), 'junction');
    evidence.path = 'linked/measurement.json';
    const checked = evaluate(review, { root: nested }).results.find(item => item.criterion === objective().id);
    assert.equal(checked.status, 'unknown');
    assert.match(checked.reason, /escapes evidence root/);
  });
  test('hash-valid stale evidence cannot verify a new revision', () => {
    const review = complete(); rewriteEvidence(row(review), data => { data.revision = 'older-revision'; });
    assert.equal(result(review).status, 'unknown');
  });
  test('hash-valid evidence for another case cannot verify this case', () => {
    const review = complete(); rewriteEvidence(row(review), data => { data.caseId = 'different-case'; });
    assert.equal(result(review).status, 'unknown');
  });
  test('hash-valid evidence for another criterion cannot verify this criterion', () => {
    const review = complete(); rewriteEvidence(row(review), data => { data.criterion = 'different-criterion'; });
    assert.equal(result(review).status, 'unknown');
  });
  test('stale observation revision remains unknown', () => {
    const review = complete(); row(review).revision = 'older-revision';
    assert.equal(result(review).status, 'unknown');
  });
  test('changing frozen acceptance invalidates the review contract', () => {
    const review = complete(); review.definition.acceptance[objective().id][0].expected = 99;
    assert.notEqual(evaluate(review, { root }).status, 'verified');
  });
  test('no configured acceptance means unknown, even with passing file assertions', () => {
    const def = definition(); delete def.acceptance[objective().id];
    const review = createReview(def); review.observations = complete().observations;
    assert.equal(result(review).status, 'unknown');
  });
  test('relaxed evidence thresholds cannot replace frozen expectations', () => {
    const review = complete(); rewriteEvidence(row(review), data => { data.checks[0].expected = 10; data.checks[0].operator = 'lte'; });
    assert.equal(result(review).status, 'unknown');
  });
  test('missing expected file assertion cannot verify the criterion', () => {
    const review = complete(); rewriteEvidence(row(review), data => { data.checks = []; });
    assert.equal(result(review).status, 'unknown');
  });
  test('observation claims do not override failed file measurements', () => {
    const review = complete(); rewriteEvidence(row(review), data => { data.checks[0].observed = 1; });
    assert.equal(result(review).status, 'failed');
  });
  test('positive model judgment cannot satisfy objective evidence', () => {
    const review = complete(); const observation = row(review);
    observation.judgment = { disposition: 'acceptable', rationale: 'A model liked it.', reviewer: 'model' };
    observation.evidence = [artifact('screenshot'), artifact('review', { ...observation, evidence: undefined })];
    assert.equal(result(review).status, 'unknown');
  });
  test('subjective judgment without a screenshot stays unknown', () => {
    const review = complete(); const criterion = catalog.find(subjective);
    row(review, criterion.id).evidence = row(review, criterion.id).evidence.filter(item => item.kind !== 'screenshot');
    assert.equal(result(review, criterion.id).status, 'unknown');
  });
  test('subjective judgment without a review record stays unknown', () => {
    const review = complete(); const criterion = catalog.find(subjective);
    row(review, criterion.id).evidence = row(review, criterion.id).evidence.filter(item => item.kind !== 'review');
    assert.equal(result(review, criterion.id).status, 'unknown');
  });
  test('hash-valid stale subjective review cannot count as advisory', () => {
    const review = complete(); const criterion = catalog.find(subjective);
    rewriteEvidence(row(review, criterion.id), data => { data.revision = 'older-revision'; });
    assert.equal(result(review, criterion.id).status, 'unknown');
  });
  test('not-applicable requires an explicit rationale and never counts as verified', () => {
    const review = complete(); const observation = row(review);
    observation.applicable = false; observation.rationale = ''; observation.evidence = [];
    assert.equal(result(review).status, 'unknown');
    observation.rationale = 'The controlled fixture has no instance of this interface pattern.';
    assert.equal(result(review).status, 'not-applicable');
  });
  test('duplicate observations cannot select whichever verdict looks better', () => {
    const review = complete(); review.observations.push(clone(row(review)));
    assert.notEqual(evaluate(review, { root }).status, 'verified');
  });
  test('comparable complete failed-to-verified transition reports improved', () => {
    const before = complete(); const after = complete('fixture-after'); failObservation(before);
    assert.equal(compare(before, after, { root }).status, 'improved');
  });
  test('comparable complete verification without resolved defects is unchanged', () => {
    assert.equal(compare(complete(), complete('fixture-after'), { root }).status, 'unchanged');
  });
  test('one revision cannot impersonate both baseline and candidate', () => {
    const before = complete(); const after = complete(); failObservation(before);
    assert.equal(compare(before, after, { root }).status, 'incomplete');
  });
  test('new objective failure reports regressed', () => {
    const before = complete(); const after = complete('fixture-after'); failObservation(after);
    assert.equal(compare(before, after, { root }).status, 'regressed');
  });
  test('an unrelated regression outranks a resolved defect', () => {
    const before = complete(); const after = complete('fixture-after'); failObservation(before);
    failObservation(after, catalog.filter(criterion => !subjective(criterion))[1].id);
    assert.equal(compare(before, after, { root }).status, 'regressed');
  });
  test('missing evidence in candidate cannot produce improvement', () => {
    const before = complete(); const after = complete('fixture-after'); failObservation(before);
    after.observations.pop(); assert.equal(compare(before, after, { root }).status, 'incomplete');
  });
  test('baseline unknown coverage cannot produce improvement', () => {
    const before = complete(); const after = complete('fixture-after'); failObservation(before);
    before.observations.pop(); assert.equal(compare(before, after, { root }).status, 'incomplete');
  });
  test('subjective approval alone is not an objectively verified improvement', () => {
    const before = complete(); const after = complete('fixture-after'); const criterion = catalog.find(subjective);
    row(before, criterion.id).judgment.disposition = 'concern';
    rewriteEvidence(row(before, criterion.id), data => { data.judgment.disposition = 'concern'; });
    assert.notEqual(compare(before, after, { root }).status, 'improved');
  });
  test('changed case viewport is not a comparable improvement', () => {
    const before = complete(); failObservation(before);
    const def = definition('fixture-after'); def.cases[0].viewport.width = 1200;
    const after = createReview(def); after.observations = complete('fixture-after').observations;
    assert.equal(compare(before, after, { root }).status, 'incomplete');
  });
  test('changed acceptance threshold is not a comparable improvement', () => {
    const before = complete(); failObservation(before);
    const def = definition('fixture-after'); def.acceptance[objective().id][0].expected = 1;
    const after = createReview(def); after.observations = complete('fixture-after').observations;
    assert.equal(compare(before, after, { root }).status, 'incomplete');
  });
  test('CLI init creates an incomplete review from a definition file', () => {
    const run = cli('init', definition()); assert.equal(run.code, 0);
    assert.equal(evaluate(run.report, { root }).status, 'incomplete');
  });
  test('CLI check complete positive control exits zero', () => {
    const run = cli('check', complete()); assert.equal(run.code, 0); assert.equal(run.report.status, 'verified');
  });
  test('CLI check measured failure exits one', () => {
    const review = complete(); failObservation(review);
    const run = cli('check', review); assert.equal(run.code, 1); assert.equal(run.report.status, 'failed');
  });
  test('CLI check missing evidence exits two', () => {
    const run = cli('check', createReview(definition())); assert.equal(run.code, 2); assert.equal(run.report.status, 'incomplete');
  });
  test('CLI compare reports an observed improvement', () => {
    const before = complete(); failObservation(before);
    const run = cli('compare', before, complete('fixture-after'));
    assert.equal(run.code, 0); assert.equal(run.report.status, 'improved');
  });
} finally {
  // Only remove the exact mkdtemp directory owned by this suite.
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`design-review acceptance: ${passed}/${passed + failed} passed`);
process.exitCode = failed ? 1 : 0;
