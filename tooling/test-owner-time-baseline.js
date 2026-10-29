#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const subject = process.env.OWNER_TIME_BASELINE_SUBJECT || path.resolve(__dirname, '../plugins/autodev-core/scripts/owner-time-baseline.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-time-baseline-'));
const home = path.join(root, 'profile'); const base = path.join(home, 'autodev');
const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: home };
let total = 0; let failed = 0;
function check(name, ok, detail = '') { total++; if (!ok) failed++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`); }
function jsonl(file, values) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, values.map((v) => JSON.stringify(v)).join('\n') + '\n'); }
const file = path.join(base, 'owner-asks/ledger.jsonl');
const judgeFile = path.join(base, 'brain-judge/judgements.jsonl');
const read = () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.type === 'owner-time-baseline') : [];
const run = (extra = []) => spawnSync(process.execPath, [subject, '--now', '2026-11-20T12:00:00Z', ...extra], { env, encoding: 'utf8' });
try {
    let r = run(); check('empty observer is silent', r.status === 0 && r.stdout === '' && r.stderr === '');
    const events = [
        { type: 'raised', at: '2026-11-02T09:00:00Z', key: 'ask1' },
        { type: 'os-submitted', at: '2026-11-02T09:01:00Z', key: 'ask1' },
        { type: 'receipt', at: '2026-11-03T09:00:00Z', key: 'ask1', by: 'owner' },
        { type: 'receipt', at: '2026-11-03T09:01:00Z', key: 'ask1', by: 'owner' },
        { type: 'owner-time-correct', at: '2026-11-03T10:00:00Z', minutes: 30 },
        { type: 'owner-time-start', at: '2026-11-08T23:50:00Z' },
        { type: 'owner-time-stop', at: '2026-11-09T00:10:00Z' },
        { type: 'raised', at: '2026-11-09T09:00:00Z', key: 'ask2' },
        { type: 'resolved', at: '2026-11-10T09:00:00Z', key: 'ask2', by: 'owner' },
        { type: 'owner-time-correct', at: '2026-11-10T10:00:00Z', minutes: 6 },
        { type: 'owner-time-correct', at: '2026-11-17T10:00:00Z', minutes: 100 },
    ];
    const judges = ['2026-11-03', '2026-11-04', '2026-11-10', '2026-11-11'].map((d, i) => ({ taskId: `t${i}`, at: `${d}T11:00:00Z`, mode: 'live', decision: 'accept', applied: true }));
    jsonl(file, events); jsonl(judgeFile, [...judges, judges[0], { ...judges[0], taskId: 'dry', mode: 'dry' }, { ...judges[0], taskId: 'refused', applied: false }]);
    r = run(); let result = read();
    check('two completed weeks from eleven events', r.status === 0 && result.length === 2, r.stdout + r.stderr);
    check('active time splits at UTC week boundary', result[0]?.ownerMinutes === 40 && result[1]?.ownerMinutes === 16);
    check('minutes divided by unique accepted tasks', result[0]?.acceptedTasks === 2 && result[0]?.minutesPerAcceptedTask === 20 && result[1]?.minutesPerAcceptedTask === 8);
    check('owner receipts deduplicated and latency excluded', result[0]?.deliveredAsks === 1 && result[0]?.ownerMinutes < 1440 && result[1]?.deliveredAsks === 1);
    r = run(); check('unchanged weeks are silent and idempotent', r.status === 0 && r.stdout === '' && read().length === 2);
    fs.appendFileSync(file, JSON.stringify({ type: 'owner-time-correct', at: '2026-11-05T10:00:00Z', minutes: -10 }) + '\n'); run();
    result = read(); check('late correction appends revised week', result.length === 3 && result.at(-1).minutesPerAcceptedTask === 15);
    jsonl(file, events.filter((e) => !e.type.startsWith('owner-time-'))); run();
    check('receipts alone cannot invent owner minutes', read().every((w) => w.measured === false && w.minutesPerAcceptedTask === null));
    jsonl(file, events.filter((e) => !['receipt', 'resolved'].includes(e.type))); run();
    check('OS submission alone is not delivered', read().every((w) => w.deliveredAsks === 0 && w.minutesPerAcceptedTask === null));
    jsonl(file, events); jsonl(judgeFile, []); run();
    check('zero accepted tasks yields unknown instead of division by zero', read().every((w) => w.acceptedTasks === 0 && w.minutesPerAcceptedTask === null));
    jsonl(judgeFile, judges); jsonl(file, events.filter((e) => e.type !== 'owner-time-stop')); run();
    check('open timer leaves affected completed weeks unknown', read().every((w) => w.openTimer && w.minutesPerAcceptedTask === null));
    jsonl(file, [...events, { type: 'owner-time-correct', at: '2026-11-03T12:00:00Z', minutes: -100 }]); run();
    check('negative corrected time cannot establish a baseline', read()[0]?.minutesPerAcceptedTask === null);
    r = run(['--now', 'invalid']); check('invalid time fails', r.status === 2);
    fs.writeFileSync(file, '{broken\n'); r = run(); check('corrupt ledger fails visibly', r.status === 2 && r.stderr.includes('owner-time-baseline:'));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`owner-time-baseline: ${total} checks, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
