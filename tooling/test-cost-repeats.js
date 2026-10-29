#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const subject = process.env.COST_REPEATS_SUBJECT || path.resolve(__dirname, '../plugins/autodev-core/scripts/cost-repeats.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-repeats-'));
const home = path.join(root, 'profile'); const base = path.join(home, 'autodev');
const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: home };
let total = 0; let failed = 0;
function check(name, ok, detail = '') { total++; if (!ok) failed++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`); }
function write(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
const jsonl = (file, values) => write(file, values.map((v) => JSON.stringify(v)).join('\n') + '\n');
const file = path.join(base, 'delivery/cost-comparisons.jsonl');
const read = () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
const run = (extra = []) => spawnSync(process.execPath, [subject, '--now', '2026-11-20T12:00:00Z', ...extra], { env, encoding: 'utf8' });
try {
    let r = run(); check('empty observer is silent', r.status === 0 && r.stdout === '' && r.stderr === '');
    const tasks = [
        { taskId: 'a', slug: 'audit-1', repo: 'repo', briefSha256: 'first' },
        { taskId: 'b', slug: 'audit-2', repo: 'repo', briefSha256: 'second' },
        { taskId: 'c', slug: 'design-1', repo: 'repo', briefTemplate: 'shared' },
        { taskId: 'd', slug: 'copy-1', repo: 'repo', briefTemplate: 'shared' },
        { taskId: 'e', slug: 'audit-3', repo: 'other' },
        { taskId: 'f', slug: 'audit-4', repo: 'repo' },
        { taskId: 'g', slug: 'audit-5', repo: 'repo' },
        { taskId: 'h', slug: 'unknown-1', repo: 'repo' },
        { taskId: 'i', slug: 'unknown-2', repo: 'repo' },
    ];
    const outcomes = tasks.map((t, i) => ({ type: 'outcome', taskId: t.taskId, at: '2026-11-19T23:00:00Z', lastAttemptAt: `2026-11-${String(i + 6).padStart(2, '0')}T09:00:00Z`, costUsd: i === 8 ? null : 10 - i, accepted: i !== 3, standingDay7: i !== 3 }));
    const judges = outcomes.map((o) => ({ taskId: o.taskId, at: o.lastAttemptAt.replace('09:', '10:'), mode: 'live', applied: true, decision: o.accepted ? 'accept' : 'follow-up' }));
    write(path.join(base, 'unattended-workers.json'), JSON.stringify({ records: tasks }));
    jsonl(path.join(base, 'delivery/outcomes.jsonl'), [...outcomes, { ...outcomes[0], at: '2026-11-01T00:00:00Z', costUsd: 999 }]);
    jsonl(path.join(base, 'brain-judge/judgements.jsonl'), judges);
    r = run(); const rows = read();
    check('three disjoint pairs from nine tasks', r.status === 0 && rows.length === 3, r.stdout + r.stderr);
    const pair = rows.find((v) => v.baseline.taskId === 'a');
    check('slug match survives differing brief hashes', pair?.match === 'slug:audit' && pair.candidate.taskId === 'b');
    check('cost per accepted task uses latest full outcome cost', pair?.baseline.costPerAcceptedTask === 10 && pair.costDeltaUsd === -1);
    check('equal judge quality is non-inferior', pair?.qualityNonInferior === true);
    const rejected = rows.find((v) => v.baseline.taskId === 'c');
    check('brief template matches different slugs', rejected?.candidate.taskId === 'd' && rejected.match === 'brief:shared');
    check('rejected repeat cannot claim cost or quality improvement', rejected?.qualityNonInferior === false && rejected.candidate.costPerAcceptedTask === null && rejected.costDeltaUsd === null);
    check('different repositories and missing costs excluded', rows.every((v) => !['e', 'h', 'i'].includes(v.baseline.taskId) && !['e', 'h', 'i'].includes(v.candidate.taskId)));
    r = run(); check('unchanged repeat is silent and idempotent', r.status === 0 && r.stdout === '' && read().length === 3);
    outcomes[1].costUsd = 3; jsonl(path.join(base, 'delivery/outcomes.jsonl'), outcomes); run();
    check('changed evidence appends a revised comparison', read().length === 4 && read().at(-1).costDeltaUsd === -7);
    fs.rmSync(file); jsonl(path.join(base, 'brain-judge/judgements.jsonl'), judges.map((j) => ({ ...j, mode: 'dry' }))); run();
    check('dry verdicts cannot support quality comparisons', read().length === 0);
    r = run(['--unknown', 'x']); check('invalid arguments fail', r.status === 2);
    write(path.join(base, 'delivery/outcomes.jsonl'), '{bad json\n'); r = run(); check('corrupt evidence fails visibly', r.status === 2 && r.stderr.includes('cost-repeats:'));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`cost-repeats: ${total} checks, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
