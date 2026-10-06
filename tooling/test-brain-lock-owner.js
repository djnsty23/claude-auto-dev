#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const SUBJECT = path.resolve(__dirname, '../plugins/autodev-core/scripts/brain-judge.js');
const bj = require(SUBJECT);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-lock-owner-'));
const file = path.join(scratch, 'lock.json');
const which = process.argv.find(a => a.startsWith('--case='))?.slice(7);
const stale = data => {
  fs.writeFileSync(file, JSON.stringify(data));
  const old = new Date(Date.now() - 20 * 60000);
  fs.utimesSync(file, old, old);
};
try {
  if (!which || which === 'owners') {
    stale({ pid: process.pid, token: 'live-owner' });
    const live = bj.takeLock(scratch);
    assert.equal(live.ok, false, 'old age does not prove a live tick has stopped');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'live-owner', 'live lock retained');
    stale({ token: 'unknown-owner' });
    assert.equal(bj.takeLock(scratch).ok, false, 'unknown stale owner cannot be reclaimed');
    stale(null);
    let nullOwner;
    assert.doesNotThrow(() => { nullOwner = bj.takeLock(scratch); }, 'null owner must be refused without throwing');
    assert.equal(nullOwner.ok, false, 'null stale owner cannot be reclaimed');
    assert.equal(fs.readFileSync(file, 'utf8'), 'null', 'null lock retained');
    for (const pid of [0, -1]) {
      const owner = { pid, token: 'nonpositive-owner' };
      stale(owner);
      assert.equal(bj.takeLock(scratch).ok, false, 'nonpositive stale owner PID cannot be reclaimed');
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), owner, 'nonpositive owner lock retained');
    }
    stale({ pid: 2147483646, token: 'dead-owner' });
    const dead = bj.takeLock(scratch);
    assert.equal(dead.ok, true, 'known dead stale owner can be reclaimed');
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'replacement' }));
    dead.release();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'replacement', 'old release cannot unlink a replacement owner');
    fs.unlinkSync(file);
    const normal = bj.takeLock(scratch);
    assert.equal(normal.ok, true, 'empty lock positive control');
    normal.release();
    assert.equal(fs.existsSync(file), false, 'own release removes own lock');
    fs.mkdirSync(file + '.claim');
    assert.equal(bj.takeLock(scratch).ok, false, 'concurrent or interrupted acquisition remains unknown');
    fs.rmdirSync(file + '.claim');
    console.log('PASS live, unknown, null, nonpositive and dead stale owners, replacement and collision controls');
  }
  if (!which || which === 'cleanup') {
    const real = fs.rmdirSync;
    let refused;
    let attempts = 0;
    try {
      fs.rmdirSync = (dir, ...args) => {
        if (dir === file + '.claim') {
          attempts++;
          throw Object.assign(new Error('fixture denial'), { code: 'EACCES' });
        }
        return real(dir, ...args);
      };
      assert.doesNotThrow(() => { refused = bj.takeLock(scratch); },
        'claim cleanup denial must return a refusal without throwing');
    } finally { fs.rmdirSync = real; }
    assert.equal(attempts, 1, 'denial reached acquisition cleanup');
    assert.deepEqual(refused, { ok: false, reason: 'acquisition claim cleanup failed, manual review required' },
      'cleanup denial reports a fixed refusal reason without release authority');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid, 'cleanup denial retains owned lock');
    assert.equal(fs.existsSync(file + '.claim'), true, 'cleanup denial retains acquisition claim');
    assert.equal(bj.takeLock(scratch).ok, false, 'next tick cannot pass retained claim');
    fs.unlinkSync(file);
    fs.rmdirSync(file + '.claim');
    const normal = bj.takeLock(scratch);
    assert.equal(normal.ok, true, 'readable cleanup positive control acquires lock');
    normal.release();
    assert.equal(fs.existsSync(file), false, 'positive control releases lock');
    assert.equal(fs.existsSync(file + '.claim'), false, 'positive control cleans acquisition claim');

    const preload = path.join(scratch, 'cleanup-denied.cjs');
    fs.writeFileSync(preload, `const fs = require('node:fs')
const real = fs.rmdirSync
fs.rmdirSync = (dir, ...args) => {
  if (String(dir).endsWith('lock.json.claim')) throw Object.assign(new Error('fixture denial'), { code: 'EACCES' })
  return real(dir, ...args)
}
`);
    const state = path.join(scratch, 'tick-state');
    const tick = spawnSync(process.execPath, ['--require', preload, SUBJECT, 'tick', '--state-dir', state],
      { encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(scratch, 'profile') } });
    assert.equal(tick.status, 0, 'cleanup denial is a reported skipped tick rather than a CLI crash');
    assert.equal(tick.stderr, '', 'handled cleanup denial emits no exception');
    const result = JSON.parse(tick.stdout);
    assert.equal(result.ok, true, 'tick reports its refused acquisition normally');
    assert.equal(result.value.skipped, refused.reason, 'CLI exposes the fixed cleanup reason');
    assert.deepEqual(result.value.events, [], 'refused tick executes no work');
    assert.deepEqual(result.value.lines, [`tick skipped: ${refused.reason}`], 'CLI reports the refusal once');
    assert.equal(fs.existsSync(path.join(state, 'lock.json')), true, 'CLI retains tick lock');
    assert.equal(fs.existsSync(path.join(state, 'lock.json.claim')), true, 'CLI retains acquisition claim');
    assert.deepEqual(fs.readdirSync(state).sort(), ['lock.json', 'lock.json.claim'],
      'refused tick writes no work state');
    console.log('PASS acquisition cleanup denial refuses direct and CLI ticks while retaining lock and claim');
  }
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
