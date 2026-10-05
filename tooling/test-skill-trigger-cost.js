#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const SUBJECT = path.resolve(__dirname, 'check-skill-triggers.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-cost-'));
const run = root => spawnSync(process.execPath, [SUBJECT, '--root', root, '--json'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
function skill(name, description, when) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: ' + name + '\ndescription: "' + description + '"\n' + (when ? 'when_to_use: "' + when + '"\n' : '') + '---\n\nBody.\n');
}
try {
  skill('unicode', 'R\u00e9sum\u00e9 \ud83c\udf31.', 'Load before anything');
  skill('condition', 'Load before editing.', 'Metadata.');
  skill('label', 'A category label.');
  const r = run(tmp);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  const result = JSON.parse(r.stdout);
  assert.deepEqual(result.population, { files: 3, described: 3 });
  assert.equal(result.descriptionBytes, 51, 'UTF-8 description bytes, Unicode positive control');
  assert.equal(result.whenToUseBytes, 29, 'custom metadata measured separately');
  assert.equal(result.rows.find(row => row.name === 'unicode').hasCondition, false, 'custom metadata does not hide a missing description condition');
  assert.equal(result.rows.find(row => row.name === 'condition').hasCondition, true, 'description condition positive control');
  assert.equal(result.rows.find(row => row.name === 'label').hasCondition, false, 'category label negative control');
  console.log('PASS three descriptions, 51 UTF-8 bytes, 29 custom metadata bytes, positive and negative trigger controls');
  const empty = path.join(tmp, 'empty');
  fs.mkdirSync(empty);
  assert.equal(run(empty).status, 2, 'empty population cannot report a successful scan');
  assert.equal(run(path.join(tmp, 'absent')).status, 2, 'missing population cannot report a successful scan');
  const invalid = path.join(tmp, 'broken');
  fs.mkdirSync(invalid);
  fs.writeFileSync(path.join(invalid, 'SKILL.md'), '---\nname: broken\n---\n');
  const bad = run(tmp);
  assert.equal(bad.status, 2, 'partial parse cannot report a successful scan');
  const partial = JSON.parse(bad.stdout);
  assert.deepEqual(partial.population, { files: 4, described: 3 });
  console.log('PASS missing, empty and partially described populations are indeterminate');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
