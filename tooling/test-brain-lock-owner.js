#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SUBJECT = path.resolve(__dirname, '../plugins/autodev-core/scripts/brain-judge.js');
const bj = require(SUBJECT);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-lock-owner-'));
const file = path.join(scratch, 'lock.json');
const stale = data => {
  fs.writeFileSync(file, JSON.stringify(data));
  const old = new Date(Date.now() - 20 * 60000);
  fs.utimesSync(file, old, old);
};
try {
  stale({ pid: process.pid, token: 'live-owner' });
  const live = bj.takeLock(scratch);
  assert.equal(live.ok, false, 'old age does not prove a live tick has stopped');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'live-owner', 'live lock retained');
  stale({ token: 'unknown-owner' });
  assert.equal(bj.takeLock(scratch).ok, false, 'unknown stale owner cannot be reclaimed');
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
  console.log('PASS live, unknown and dead stale owners, replacement release and acquisition collision controls');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
