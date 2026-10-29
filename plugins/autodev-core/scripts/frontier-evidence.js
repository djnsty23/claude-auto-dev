#!/usr/bin/env node
'use strict';
// Frozen routing experiment and its append-only observer. No model calls.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { withLedgerLock } = require('./ledger-lock.js');

// Fixed before collecting outcomes. This is a finite-task, descriptive comparison,
// not a confidence interval or a claim about unseen populations.
const CONTRACT = Object.freeze({ version: 1, seed: 'frontier-routing-v1', margin: 0.05,
    method: 'paired finite-task pass-rate difference', repeat: 1,
    baseline: 'V0', routed: { fix: 'V1', locate: 'H1', review: 'V1', decide: 'V1' } });
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function taskContent(tasksDir, task) {
    const part = (name) => {
        if (typeof name !== 'string' || path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error('invalid task content path');
        const file = path.join(tasksDir, name);
        if (fs.lstatSync(file).isSymbolicLink()) throw new Error('linked task content');
        return fs.readFileSync(file, 'utf8');
    };
    const brief = part(task.brief);
    const support = (task.support || []).map((s) => part(s.from));
    return { text: [brief, ...support], contentHash: hash(JSON.stringify([part(`${task.id}.json`), brief,
        task.expected ? part(task.expected) : '', ...support])) };
}
function rows(file) {
    try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function taskSet(tasksDir) {
    return fs.readdirSync(tasksDir).filter((n) => /^[A-Za-z0-9]{1,4}\.json$/.test(n)).sort().map((n) => {
        const task = read(path.join(tasksDir, n));
        if (task.id !== n.slice(0, -5) || !CONTRACT.routed[task.lane]) throw new Error('invalid split task');
        const idHash = hash(`${CONTRACT.seed}:${task.id}`);
        return { id: task.id, lane: task.lane, idHash, contentHash: taskContent(tasksDir, task).contentHash,
            split: parseInt(idHash.slice(0, 8), 16) % 2 ? 'held-out' : 'training' };
    });
}
function split(data, tasksDir) {
    const tasks = taskSet(tasksDir);
    if (!tasks.length) throw new Error('empty task set');
    const contract = { ...CONTRACT, tasks };
    const splitId = hash(JSON.stringify(contract));
    const file = path.join(data, 'routing-split.json');
    fs.mkdirSync(data, { recursive: true });
    return withLedgerLock(file, () => {
        if (fs.existsSync(file)) {
            const old = read(file);
            // Preserve the original content seal even when text changes. A run then
            // records sealed:false rather than silently enrolling the edited task.
            const identity = (list) => list.map(({ contentHash, ...t }) => t);
            if (JSON.stringify(identity(old.tasks)) !== JSON.stringify(identity(tasks))) throw new Error('split changed: use a separate data root for a new experiment');
            return old;
        }
        const value = { ...contract, splitId, createdAt: new Date().toISOString() };
        const tmp = `${file}.${process.pid}.tmp`;
        try { fs.writeFileSync(tmp, JSON.stringify(value) + '\n'); fs.renameSync(tmp, file); }
        finally { fs.rmSync(tmp, { force: true }); }
        return value;
    });
}
function assignment(data, tasksDir, taskId) {
    const frozen = split(data, tasksDir);
    const task = frozen.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error('task outside frozen split');
    return { splitId: frozen.splitId, splitAt: frozen.createdAt, taskIdHash: task.idHash, split: task.split, heldOutHash: task.contentHash };
}
// Only inputs available before invocation are scanned. The evaluation prompt is
// deliberately not a learning input. Whitespace normalization also catches copies
// embedded in JSON strings. Semantic paraphrases are outside this text seal.
function seal(data, tasksDir, taskId, roots) {
    const a = assignment(data, tasksDir, taskId);
    const checkedAt = new Date().toISOString();
    const hits = [], errors = [], scanned = [];
    let content;
    try { content = taskContent(tasksDir, read(path.join(tasksDir, `${taskId}.json`))); }
    catch { errors.push('task-unreadable'); }
    const normalize = (s) => s.replace(/\s+/g, ' ').trim();
    const needles = (content?.text || []).map(normalize).filter(Boolean);
    function strings(value) {
        if (typeof value === 'string') return [value];
        if (!value || typeof value !== 'object') return [];
        return Object.values(value).flatMap(strings);
    }
    function walk(file, label, optional = false) {
        try {
            const stat = fs.lstatSync(file);
            if (stat.isSymbolicLink()) { errors.push(`${label}:linked-input`); return; }
            if (stat.isDirectory()) {
                for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name), `${label}/${name}`);
                return;
            }
            if (!stat.isFile() || stat.size > 8 * 1024 * 1024) { errors.push(`${label}:unreadable-input`); return; }
            const text = fs.readFileSync(file, 'utf8');
            scanned.push({ fileHash: hash(label), contentHash: hash(text) });
            let candidates = [text];
            for (const raw of [text, ...text.split('\n')]) {
                try { candidates.push(...strings(JSON.parse(raw))); } catch { /* plain text */ }
            }
            if (candidates.some((s) => needles.some((needle) => normalize(s).includes(needle)))) hits.push(hash(label));
        } catch (e) { if (!(optional && e.code === 'ENOENT')) errors.push(`${label}:unreadable-input`); }
    }
    roots.forEach((r, i) => walk(r.path, `input-${i}`, r.optional === true));
    const contentMatches = !!content && content.contentHash === a.heldOutHash;
    const sealed = a.split === 'held-out' && contentMatches && needles.length > 0 && hits.length === 0 && errors.length === 0;
    return { ...a, sealed, seal: { checkedAt, contentMatches, currentHash: content?.contentHash || null,
        visibleToLearning: hits.length > 0, hits, errors, files: scanned.length, inputsHash: hash(JSON.stringify(scanned)) } };
}
function route(task, arm) {
    if (!['baseline', 'routed'].includes(arm)) throw new Error('routing arm must be baseline or routed');
    return arm === 'baseline' ? CONTRACT.baseline : CONTRACT.routed[task.lane];
}
function comparison(frozen, input) {
    const tasks = frozen.tasks.filter((t) => t.split === 'held-out');
    const selected = input.filter((r) => r && r.splitId === frozen.splitId && r.split === 'held-out' && r.repeat === CONTRACT.repeat && r.routingArm);
    const problems = [];
    if (selected.some((r) => !tasks.some((t) => t.id === r.task) || !['baseline', 'routed'].includes(r.routingArm))) problems.push('unplanned held-out outcome');
    const pairs = [];
    for (const t of tasks) {
        const pair = {};
        for (const arm of ['baseline', 'routed']) {
            const candidates = selected.filter((r) => r.task === t.id && r.routingArm === arm);
            const r = candidates[0];
            if (candidates.length !== 1 || !r || typeof r.pass !== 'boolean' || r.exit !== 0
                || r.taskIdHash !== t.idHash || r.route !== route(t, arm) || r.variant !== r.route
                || r.sealed !== true || r.heldOutHash !== t.contentHash
                || r.seal?.contentMatches !== true || r.seal.currentHash !== t.contentHash || r.seal.visibleToLearning !== false
                || !Array.isArray(r.seal.hits) || r.seal.hits.length !== 0 || !Array.isArray(r.seal.errors) || r.seal.errors.length !== 0
                || !(Date.parse(r.seal.checkedAt) >= Date.parse(frozen.createdAt) && Date.parse(r.seal.checkedAt) <= Date.parse(r.startedAt))
                || !(Date.parse(r.startedAt) >= Date.parse(frozen.createdAt))
                || !(Date.parse(r.finishedAt) >= Date.parse(r.startedAt))
                || !r.fingerprint || !r.fingerprint.model || r.fingerprint.model !== r.fingerprint.requestedModel
                || r.leak?.suspect !== false || r.verdict !== (r.pass ? 'pass' : 'fail')) {
                problems.push(`${t.id}:${arm}: missing, duplicate or invalid outcome`);
            } else pair[arm] = r;
        }
        if (pair.baseline && pair.routed) {
            const a = pair.baseline, b = pair.routed;
            const same = ['snapshot', 'harnessCommit', 'pinHash'].every((k) => a.fingerprint[k] && a.fingerprint[k] === b.fingerprint[k]);
            if (!same || !a.taskHash || a.taskHash !== b.taskHash || a.account !== b.account) problems.push(`${t.id}: unmatched inputs`);
            else pairs.push({ task: t.id, baseline: a.run, routed: b.run, baselinePass: a.pass, routedPass: b.pass });
        }
    }
    const complete = tasks.length > 0 && pairs.length === tasks.length && !problems.length;
    const baselineRate = complete ? pairs.filter((p) => p.baselinePass).length / pairs.length : null;
    const routedRate = complete ? pairs.filter((p) => p.routedPass).length / pairs.length : null;
    const delta = complete ? routedRate - baselineRate : null;
    return { type: 'routing-comparison', splitId: frozen.splitId, splitAt: frozen.createdAt,
        margin: CONTRACT.margin, method: CONTRACT.method, expected: tasks.length, paired: pairs.length,
        complete, baselineRate, routedRate, delta, nonInferior: complete && delta >= -CONTRACT.margin,
        pairs, problems, evidenceAt: selected.map((r) => r.finishedAt).filter(Boolean).sort().at(-1) || null };
}
function observe(data) {
    const splitFile = path.join(data, 'routing-split.json');
    if (!fs.existsSync(splitFile)) return null;
    const file = path.join(data, 'routing-comparisons.jsonl');
    return withLedgerLock(file, () => {
        const value = comparison(read(splitFile), rows(path.join(data, 'runs.jsonl')));
        const digest = hash(JSON.stringify(value));
        if (rows(file).at(-1)?.digest === digest) return null;
        const row = { ...value, digest, at: new Date().toISOString() };
        fs.appendFileSync(file, JSON.stringify(row) + '\n');
        return row;
    });
}
function main(argv) {
    if (argv.includes('--help')) { console.log('frontier-evidence.js [observe | split --tasks-dir DIR | seal --tasks-dir DIR --task ID --inputs DIR] [--data DIR]'); return; }
    const val = (key) => { const i = argv.indexOf(key); return i < 0 ? null : argv[i + 1]; };
    const data = val('--data') || process.env.FRONTIER_DATA || path.join(process.env.CLAUDE_CONFIG_DIR || process.env.BRAIN_CLOCK_CLAUDE_DIR || path.join(os.homedir(), '.claude'), 'autodev', 'frontier');
    const cmd = argv[0] || 'observe';
    if (cmd === 'split' && val('--tasks-dir')) console.log(JSON.stringify(split(data, val('--tasks-dir'))));
    else if (cmd === 'seal' && val('--tasks-dir') && val('--task') && val('--inputs')) console.log(JSON.stringify(seal(data, val('--tasks-dir'), val('--task'), [{ path: val('--inputs') }])));
    else if (cmd === 'observe') { const result = observe(data); if (result) console.log(JSON.stringify(result)); }
    else throw new Error('expected observe or split --tasks-dir DIR');
}
if (require.main === module) {
    try { main(process.argv.slice(2)); }
    catch (e) { console.error(`frontier-evidence: ${e.message}`); process.exitCode = 1; }
}
module.exports = { assignment, route, seal, comparison, observe };
