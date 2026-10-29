#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const script = process.env.ACCOUNT_SWITCH_DRILL_SUBJECT || path.resolve(__dirname, '../plugins/autodev-core/scripts/account-switch-drill.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-drill-test-'));
let passed = 0;
let failed = 0;
function check(name, ok, detail = '') { if (ok) passed++; else { failed++; console.log(`FAIL ${name}: ${detail}`); } }
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 85000, windowsHide: true,
    env: { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root, BRAIN_CLOCK_CLAUDE_DIR: root } });
try {
    const r = run(['--json']);
    const row = JSON.parse(r.stdout || '{}');
    check('real queue launch and reconcile pass', r.status === 0 && row.ok === true, row.why || r.stderr);
    check('two queued tasks survive with dependency intact', row.queued === 2 && row.kept === 2, row.why);
    check('worker actually sees switched config', row.configSwitched === true && row.launched === 1, row.why);
    check('reconciler closes exactly one run', row.reconciled === 1, row.why);
    check('bounded dated synthetic drill', row.mode === 'synthetic-shared-queue' && Number.isFinite(Date.parse(row.at)) && row.durationMs > 0 && row.durationMs < 80000);
    const log = path.join(root, 'autodev/windows/account-switch-drills.jsonl');
    check('ledger equals returned row', fs.readFileSync(log, 'utf8').trim() === JSON.stringify(row));
    check('help is read only', run(['--help']).status === 0 && fs.readFileSync(log, 'utf8').trim().split('\n').length === 1);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`account-switch-drill: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
