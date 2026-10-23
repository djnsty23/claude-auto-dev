#!/usr/bin/env node
'use strict';
// Evidence ledger, not a browser or a taste classifier. All artifact claims are
// supplied by the collector/reviewer; hashes prove integrity, not truth.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const catalog = require('../skills/design-review/references/criteria.json');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' && value.trim().length > 0;
const scalar = value => typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
    return value;
}
function contractHash(definition) {
    const { revision, ...contract } = definition;
    return hash(JSON.stringify(canonical({ catalog, contract })));
}
function validateDefinition(d) {
    if (!d || !['product', 'audience', 'primaryTask', 'revision'].every(k => text(d[k]))) throw new Error('Product, audience, primaryTask and exact revision/build identity are required');
    if (!Array.isArray(d.brandRules) || !d.brandRules.every(text) || !Array.isArray(d.references) || !['unavailable', 'pending', 'approved'].includes(d.calibration)) throw new Error('Declare brandRules, references and calibration explicitly');
    if (d.calibration === 'approved' && !d.references.some(r => r && text(r.source) && text(r.approvedBy) && text(r.approvedAt))) throw new Error('Approved calibration needs a sourced approval record');
    if (!Array.isArray(d.cases) || !d.cases.length || d.cases.length > 100) throw new Error('Define 1-100 cases before measuring');
    const ids = new Set();
    for (const c of d.cases) {
        if (!c || !['id', 'route', 'role', 'data', 'state'].every(k => text(c[k])) || ids.has(c.id) || !c.viewport || !['width', 'height'].every(k => Number.isInteger(c.viewport[k]) && c.viewport[k] > 0)) throw new Error('Each unique case needs route, role, data, state and nonzero viewport');
        ids.add(c.id);
    }
    if (d.acceptance !== undefined && (!d.acceptance || typeof d.acceptance !== 'object' || Array.isArray(d.acceptance))) throw new Error('Acceptance must map criterion IDs to check contracts');
    for (const [id, checks] of Object.entries(d.acceptance || {})) {
        if (!catalog.some(c => c.id === id && c.layer !== 'judgment') || !Array.isArray(checks) || !checks.length || new Set(checks.map(c => c.name)).size !== checks.length) throw new Error('Invalid acceptance criterion or duplicate check');
        for (const c of checks) if (!text(c.name) || !['eq', 'lte', 'gte'].includes(c.operator) || !scalar(c.expected) || (c.operator !== 'eq' && typeof c.expected !== 'number')) throw new Error('Invalid check expectation');
    }
}
function createReview(definition) {
    validateDefinition(definition);
    const copy = structuredClone(definition);
    return { schema: 'autodev.design-review/1', definition: copy, contractHash: contractHash(copy),
        requirements: catalog.flatMap(c => copy.cases.map(k => ({ criterion: c.id, caseId: k.id }))), observations: [],
        diagnoses: [], batches: [], retainedChecks: [],
        outcomes: { ownerMisses: null, manualReworkMinutes: null, taskCompletion: null, reviewMinutes: null } };
}
function readArtifact(e, root) {
    if (!e || !text(e.path) || path.isAbsolute(e.path) || !/^[a-f0-9]{64}$/.test(e.sha256) || !text(e.kind)) throw new Error('Invalid artifact reference');
    const base = fs.realpathSync(root), file = fs.realpathSync(path.resolve(base, e.path)), relative = path.relative(base, file);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Artifact escapes evidence root');
    const size = fs.statSync(file).size;
    if (size === 0 || size > 32 * 1024 * 1024) throw new Error('Artifact is empty or exceeds 32 MiB');
    const bytes = fs.readFileSync(file);
    if (hash(bytes) !== e.sha256) throw new Error('Artifact digest mismatch');
    return e.kind === 'screenshot' ? null : JSON.parse(bytes.toString('utf8'));
}
function assess(criterion, caseId, review, root) {
    const base = { criterion: criterion.id, caseId, layer: criterion.layer, severity: criterion.severity };
    const unknown = reason => ({ ...base, status: 'unknown', reason });
    const rows = review.observations.filter(o => o && o.criterion === criterion.id && o.caseId === caseId);
    if (rows.length !== 1) return unknown(rows.length ? 'Duplicate observations' : 'Not tested');
    const o = rows[0];
    if (o.revision !== review.definition.revision) return unknown('Observation belongs to a different revision');
    if (o.applicable === false) return text(o.rationale) ? { ...base, status: 'not-applicable', reason: o.rationale } : unknown('Not-applicable needs a rationale');
    if (!Array.isArray(o.evidence) || !o.evidence.length) return unknown('No evidence artifacts');
    try {
        const records = o.evidence.map(e => ({ kind: e.kind, record: readArtifact(e, root) }));
        const requiredKind = criterion.layer === 'judgment' ? 'review' : criterion.layer === 'usability' ? 'interaction' : 'measurement';
        const matching = records.filter(e => e.kind === requiredKind);
        if (matching.length !== 1) return unknown('Expected exactly one ' + requiredKind + ' artifact');
        const record = matching[0].record;
        if (!record || record.revision !== o.revision || record.caseId !== caseId || record.criterion !== criterion.id) return unknown('Evidence identity does not match observation');
        if (criterion.layer === 'judgment') {
            const j = record.judgment;
            if (!records.some(e => e.kind === 'screenshot') || !j || !['acceptable', 'concern'].includes(j.disposition) || !text(j.rationale) || !text(j.reviewer)) return unknown('Judgment needs screenshot, rationale and reviewer');
            return { ...base, status: 'advisory', judgment: j, reason: 'Subjective review, not an objective pass' };
        }
        const expected = review.definition.acceptance?.[criterion.id];
        if (!expected) return unknown('No predefined acceptance checks');
        if (!Array.isArray(record.checks) || record.checks.length !== expected.length) return unknown('Missing or additional checks');
        const checks = expected.map(rule => {
            const found = record.checks.filter(c => c && c.name === rule.name);
            if (found.length !== 1) throw new Error('Missing or duplicate check');
            const c = found[0];
            if (c.operator !== rule.operator || !isDeepStrictEqual(c.expected, rule.expected) || !scalar(c.observed) || (rule.operator !== 'eq' && typeof c.observed !== 'number')) throw new Error('Evidence changed the acceptance condition or omitted observation');
            const passed = rule.operator === 'eq' ? isDeepStrictEqual(c.expected, c.observed) : rule.operator === 'lte' ? c.observed <= c.expected : c.observed >= c.expected;
            return { ...c, passed };
        });
        return { ...base, status: checks.every(c => c.passed) ? 'verified' : 'failed', checks, reason: 'Computed from predefined checks and recorded observations' };
    } catch (e) { return unknown(e.message); }
}
function evaluate(review, options = {}) {
    try {
        if (review?.schema !== 'autodev.design-review/1') throw new Error('Unsupported review schema');
        validateDefinition(review.definition);
        if (review.contractHash !== contractHash(review.definition)) throw new Error('Definition or criterion catalog changed: start a new review');
        if (!Array.isArray(review.observations)) throw new Error('Observations must be an array');
        const allowed = new Set(catalog.flatMap(c => review.definition.cases.map(k => JSON.stringify([c.id, k.id]))));
        if (review.observations.some(o => !o || !allowed.has(JSON.stringify([o.criterion, o.caseId])))) throw new Error('Unknown criterion or case in observations');
        // requirements is a convenience template, never the authoritative population.
        const results = catalog.flatMap(c => review.definition.cases.map(k => assess(c, k.id, review, options.root || process.cwd())));
        const counts = { expected: results.length, verified: 0, failed: 0, unknown: 0, advisory: 0, 'not-applicable': 0 };
        for (const r of results) counts[r.status]++;
        const status = counts.failed ? 'failed' : counts.unknown || !counts.verified ? 'incomplete' : 'verified';
        return { status, counts, results, calibration: review.definition.calibration, outcomes: review.outcomes,
            limitation: 'Verified means recorded scoped checks passed, not design approval or proven business impact. Supplied evidence is not independently authenticated.' };
    } catch (e) { return { status: 'incomplete', reason: e.message, counts: { expected: 0 }, results: [] }; }
}
function compare(before, after, options = {}) {
    const a = evaluate(before, { root: options.beforeRoot || options.root }), b = evaluate(after, { root: options.afterRoot || options.root });
    if (before?.contractHash !== after?.contractHash || !a.results.length || !b.results.length) return { status: 'incomplete', reason: 'Changed/invalid contract, cases or acceptance; measure a fresh comparable baseline', before: a, after: b };
    if (before.definition.revision === after.definition.revision) return { status: 'incomplete', reason: 'Baseline and candidate identities must differ', before: a, after: b };
    const resolved = [], regressed = [], lostCoverage = [];
    for (let i = 0; i < a.results.length; i++) {
        const x = a.results[i], y = b.results[i], key = { criterion: x.criterion, caseId: x.caseId };
        if (x.status !== 'unknown' && y.status === 'unknown' || x.status !== 'not-applicable' && y.status === 'not-applicable') lostCoverage.push(key);
        if (x.status === 'failed' && y.status === 'verified') resolved.push(key);
        if (x.status !== 'failed' && y.status === 'failed' || x.judgment?.disposition === 'acceptable' && y.judgment?.disposition === 'concern') regressed.push(key);
    }
    const incomplete = a.counts.unknown || b.counts.unknown || lostCoverage.length || !b.counts.verified;
    return { status: regressed.length ? 'regressed' : incomplete ? 'incomplete' : resolved.length ? 'improved' : 'unchanged', resolved, regressed, lostCoverage, before: a.counts, after: b.counts,
        remainingFailures: b.results.filter(r => r.status === 'failed'), advisory: b.results.filter(r => r.status === 'advisory'), outcomes: { before: before.outcomes, after: after.outcomes } };
}
function main(args) {
    if (!args.length || args.includes('--help')) { console.log('design-review init <definition.json> | check <review.json> | compare <before.json> <after.json>\nJSON on stdout; evidence paths relative to each review file. check: 0 verified, 1 failed, 2 incomplete. compare: 0 improved, 1 regressed, 2 otherwise.'); return 0; }
    const [command, file, other] = args;
    const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
    let result, code;
    if (command === 'init' && args.length === 2) { result = createReview(read(file)); code = 0; }
    else if (command === 'check' && args.length === 2) { result = evaluate(read(file), { root: path.dirname(path.resolve(file)) }); code = result.status === 'verified' ? 0 : result.status === 'failed' ? 1 : 2; }
    else if (command === 'compare' && args.length === 3) { result = compare(read(file), read(other), { beforeRoot: path.dirname(path.resolve(file)), afterRoot: path.dirname(path.resolve(other)) }); code = result.status === 'improved' ? 0 : result.status === 'regressed' ? 1 : 2; }
    else throw new Error('Invalid command; use --help');
    console.log(JSON.stringify(result, null, 2)); return code;
}
module.exports = { catalog, createReview, evaluate, compare, contractHash };
if (require.main === module) { try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('design-review: ' + e.message); process.exitCode = 2; } }
