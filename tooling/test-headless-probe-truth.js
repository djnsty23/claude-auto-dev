#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const SUBJECT = path.resolve(__dirname, '../plugins/autodev-core/scripts/headless-worker.js');
const hw = require(SUBJECT);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-probe-truth-'));
try {
  const rec = { code: 'probe', pid: process.pid, state: 'running', startedAt: new Date().toISOString(),
    supervisorImage: path.basename(process.execPath), log: path.join(scratch, 'worker.log'), report: path.join(scratch, 'REPORT.md') };
  fs.writeFileSync(rec.log, 'worker started\n');
  assert.equal(hw.supervisorLiveness(rec, { image: () => path.basename(process.execPath).toLowerCase() }), 'alive', 'known image positive control');
  assert.equal(hw.supervisorLiveness(rec, { image: () => 'other-image' }), 'reused', 'different image rejection control');
  assert.equal(hw.supervisorLiveness(rec, { image: () => null }), 'unknown', 'unreadable image cannot identify a running supervisor');
  assert.equal(hw.recordStatus(rec, 0, () => null).process, 'unknown', 'status preserves unknown identity');
  assert.equal(hw.livenessFromError({ code: 'EINVAL' }), 'unknown', 'unexpected probe errors are unknown');
  assert.equal(hw.livenessFromError({ code: 'ESRCH' }), 'dead');
  assert.equal(hw.livenessFromError({ code: 'EPERM' }), 'alive');
  assert.equal(hw.lostReason(rec, 0, () => 'unknown', () => null), null, 'unknown never permits lost settlement');
  console.log('PASS known, reused, dead and unreadable process controls');
  const ledger = path.join(scratch, 'ledger.json');
  fs.writeFileSync(rec.log, 'CLAUDE_EXIT=0\n');
  fs.writeFileSync(ledger, JSON.stringify({ version: 1, records: [rec] }));
  const preload = path.join(scratch, 'unreadable-image.cjs');
  fs.writeFileSync(preload, "const cp = require('node:child_process')\nconst real = cp.spawnSync\ncp.spawnSync = (cmd, ...args) => /^(tasklist|ps)(\\.exe)?$/.test(cmd) ? { status: 1, stdout: '', stderr: 'unavailable' } : real(cmd, ...args)\n");
  const r = spawnSync(process.execPath, ['--require', preload, SUBJECT, 'settle', '--code', rec.code, '--unreported', '--ledger', ledger],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(r.status, 1, 'unknown supervisor identity refuses settlement even with an exit-looking line');
  assert.equal(JSON.parse(fs.readFileSync(ledger, 'utf8')).records[0].state, 'running', 'refusal leaves ledger unsettled');
  console.log('PASS subprocess settlement refuses unknown identity and retains the record');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
