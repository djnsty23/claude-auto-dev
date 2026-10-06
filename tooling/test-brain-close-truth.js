#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const SUBJECT = path.resolve(__dirname, '../plugins/autodev-core/scripts/brain-judge.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-close-truth-'));
const which = process.argv.find(a => a.startsWith('--case='))?.slice(7);
try {
  const startedAt = new Date().toISOString();
  const fixture = (code, state, exit, result) => {
    const log = path.join(scratch, `${code}.log`);
    const report = path.join(scratch, `${code}.md`);
    fs.writeFileSync(log, Number.isInteger(exit) ? `CLAUDE_EXIT=${exit}\n` : 'worker started\n');
    const h = { code, pid: process.pid, startedAt, state, exit, result, log, report };
    const r = { taskId: code, slug: code, state: 'started', channel: 'headless', launchedAt: startedAt,
      headless: { code, startedAt }, repo: scratch };
    return { h, r };
  };
  const tick = (fixtures, label) => {
    const ledger = path.join(scratch, `${label}-workers.json`);
    const headless = path.join(scratch, `${label}-headless.json`);
    fs.writeFileSync(ledger, JSON.stringify({ version: 1, records: fixtures.map(f => f.r) }));
    fs.writeFileSync(headless, JSON.stringify({ version: 1, records: fixtures.map(f => f.h) }));
    const r = spawnSync(process.execPath, [SUBJECT, 'tick', '--ledger', ledger, '--headless-ledger', headless,
      '--state-dir', path.join(scratch, label), '--clock-dir', path.join(scratch, 'clock')],
      { encoding: 'utf8', windowsHide: true, timeout: 15000,
        env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(scratch, 'profile') } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return JSON.parse(r.stdout).value;
  };
  if (!which || which === 'exit') {
    const out = tick([fixture('clean', 'settled', 0, 'done'), fixture('crashed', 'settled', 1, 'done'),
      fixture('missing-exit', 'settled', null, 'done')], 'exit');
    const statuses = Object.fromEntries(out.events.filter(e => e.type === 'judge.would-close').map(e => [e.detail.taskId, e.detail.runStatus]));
    assert.equal(statuses.clean, 'succeeded', 'completed exit-zero positive control');
    assert.equal(statuses.crashed, 'failed', 'a done report cannot hide nonzero exit');
    assert.equal(statuses['missing-exit'], 'failed', 'missing exit is not success');
    console.log('PASS tick closes exit-zero success and refuses crash or missing-exit success');
  }
  if (!which || which === 'unsettled') {
    const waiting = fixture('unverified', 'running', null, null);
    const prompt = fixture('prompted', 'running', null, null);
    fs.mkdirSync(path.join(scratch, 'prompted'));
    fs.writeFileSync(path.join(scratch, 'prompted', 'ask.json'), JSON.stringify({ question: 'Choose a mode' }));
    const finished = fixture('unsettled-exit', 'running', 1, null);
    const out = tick([waiting, prompt, finished], 'unsettled');
    const states = Object.fromEntries(out.events.filter(e => e.type === 'judge.close-pending').map(e => [e.detail.taskId, e.detail]));
    assert.equal(states.prompted?.ask, 'open', 'prompted worker is reported to the coordinator');
    assert.equal(states['unsettled-exit']?.process, 'exited', 'crashed unsettled worker is reported as exited');
    assert.ok(states.unverified && ['unknown', 'running'].includes(states.unverified.process), 'unsettled process observation is explicit');
    assert.ok(out.lines.some(l => /awaiting settlement/.test(l)), 'unsettled ledger is not summarized as still running');
    const second = tick([waiting, prompt, finished], 'unsettled');
    assert.equal(second.events.filter(e => e.type === 'judge.close-pending').length, 0, 'unchanged observations are quiet on the next tick');
    console.log('PASS tick reports prompted and exited workers and deduplicates unchanged observations');
  }
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
