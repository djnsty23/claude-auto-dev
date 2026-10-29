#!/usr/bin/env node
'use strict';
// Configure brain-clock: {"id":"cost-repeats","script":"cost-repeats.js","everyMin":1440}.
// Match within one repository by exact brief hash/template or conservative slug
// family (only a trailing date, version or run number is removed). Consecutive
// non-overlapping pairs avoid counting every combination as independent evidence.
// Cost includes all attempts already aggregated by delivery-outcomes.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { configDir } = require('./claude-paths.js');

function rows(file) {
    try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((s) => s.trim()).map(JSON.parse); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function main(argv) {
    if (argv.includes('--help')) { console.log('Usage: cost-repeats.js [--config-dir DIR] [--now ISO]'); return; }
    const opts = {};
    for (let i = 0; i < argv.length; i += 2) {
        if (!['--config-dir', '--now'].includes(argv[i]) || !argv[i + 1]) throw new Error('invalid arguments');
        opts[argv[i]] = argv[i + 1];
    }
    const root = path.join(opts['--config-dir'] || configDir(), 'autodev');
    const now = opts['--now'] ? Date.parse(opts['--now']) : Date.now();
    if (!Number.isFinite(now)) throw new Error('invalid time');
    const latest = new Map();
    for (const r of rows(path.join(root, 'delivery', 'outcomes.jsonl'))) {
        if (!r || r.type !== 'outcome' || !r.taskId || !(Date.parse(r.at) <= now)) continue;
        if (!latest.has(r.taskId) || Date.parse(r.at) >= Date.parse(latest.get(r.taskId).at)) latest.set(r.taskId, r);
    }
    if (!latest.size) return;
    const tasks = JSON.parse(fs.readFileSync(path.join(root, 'unattended-workers.json'), 'utf8')).records;
    if (!Array.isArray(tasks)) throw new Error('worker records unavailable');
    const judges = rows(path.join(root, 'brain-judge', 'judgements.jsonl'));
    const comparable = [];
    for (const task of tasks) {
        const o = latest.get(task.taskId);
        if (!o || !task.repo || !Number.isFinite(o.costUsd) || o.costUsd < 0 || typeof o.accepted !== 'boolean' || !(Date.parse(o.lastAttemptAt) <= now)) continue;
        const j = judges.filter((r) => r && r.taskId === task.taskId && r.mode === 'live' && r.applied === true
            && Date.parse(r.at) >= Date.parse(o.lastAttemptAt) && Date.parse(r.at) <= now)
            .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
        if (!j || !['accept', 'follow-up', 'escalate', 'reject'].includes(j.decision) || (j.decision === 'accept') !== o.accepted) continue;
        const slug = typeof task.slug === 'string' ? task.slug.replace(/-(?:\d{4}-\d{2}-\d{2}|v?\d+)$/, '') : '';
        const brief = task.briefTemplate || task.briefSha256 || null;
        if (!brief && !slug) continue;
        comparable.push({ repo: task.repo, slug, brief, value: { taskId: task.taskId, lastAttemptAt: o.lastAttemptAt, costUsd: o.costUsd,
            accepted: o.accepted, costPerAcceptedTask: o.accepted ? o.costUsd : null,
            judgeOutcome: j.decision, judgedAt: j.at, standingDay7: o.standingDay7 ?? null } });
    }
    const file = path.join(root, 'delivery', 'cost-comparisons.jsonl');
    const existing = new Set(rows(file).map((r) => r.signature)); const pending = [];
    comparable.sort((a, b) => Date.parse(a.value.lastAttemptAt) - Date.parse(b.value.lastAttemptAt) || a.value.taskId.localeCompare(b.value.taskId));
    const used = new Set();
    for (let i = 0; i < comparable.length; i++) {
        if (used.has(i)) continue;
        const a = comparable[i];
        const next = comparable.findIndex((b, k) => k > i && !used.has(k) && a.repo === b.repo
            && ((a.brief && a.brief === b.brief) || (a.slug && a.slug === b.slug)));
        if (next < 0) continue;
        used.add(i); used.add(next);
        const b = comparable[next];
        const match = a.brief && a.brief === b.brief ? `brief:${a.brief}` : `slug:${a.slug}`;
        const key = JSON.stringify([a.repo, match]);
        const baseline = a.value; const candidate = b.value;
        const signature = crypto.createHash('sha256').update(JSON.stringify([key, baseline, candidate])).digest('hex');
        if (existing.has(signature)) continue;
        const qualityNonInferior = candidate.accepted && (!baseline.accepted || (baseline.standingDay7 !== true || candidate.standingDay7 === true));
        pending.push({ type: 'cost-comparison', at: new Date(now).toISOString(), comparedAt: candidate.lastAttemptAt,
            signature, match, baseline, candidate, qualityNonInferior,
            costDeltaUsd: baseline.accepted && candidate.accepted ? candidate.costPerAcceptedTask - baseline.costPerAcceptedTask : null });
    }
    if (pending.length) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, pending.map((r) => JSON.stringify(r)).join('\n') + '\n');
        console.log(`cost-repeats: ${pending.length} comparisons from ${latest.size} outcomes; ${comparable.length} comparable tasks`);
    }
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { console.error(`cost-repeats: ${e.message}`); process.exitCode = 2; } }
module.exports = { main };
