#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const SUBJECT = path.resolve(__dirname, 'generate-agents-md.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loading-contract-'));
const run = args => spawnSync(process.execPath, [SUBJECT, '--root', tmp, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
try {
  const dir = path.join(tmp, 'plugins/autodev-core/skills/rule-fixture');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'VERSION'), '1.2.3\n');
  const hand = '# AGENTS.md\n\nRead CLAUDE.md first.\n';
  fs.writeFileSync(path.join(tmp, 'AGENTS.md'), hand);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: rule-fixture\ndescription: "Load before checking the fixture."\npaths:\n  - "**/*.js"\n---\n\nThe fixture keeps its guidance.\n');
  const r = run(['--write']);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  const text = fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8');
  assert.ok(text.startsWith(hand), 'hand-maintained guidance preserved');
  assert.match(text, /Load the applicable skills explicitly/);
  assert.match(text, /paths.*does not load a skill/);
  assert.doesNotMatch(text, /always-on.*rule-|loads by path glob|globs that trigger the rule/);
  assert.match(text, /\*\*paths:\*\* `\*\*\/\*\.js`/, 'declared scope still visible');
  assert.equal(run(['--check']).status, 0, 'matching contract control');
  fs.writeFileSync(path.join(tmp, 'AGENTS.md'), text + '\nSTALE\n');
  assert.equal(run(['--check']).status, 1, 'planted generated drift fails');
  console.log('PASS explicit loading contract, declared path scope, preserved hand text and positive drift control');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
