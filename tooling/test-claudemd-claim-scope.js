#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const SUBJECT = path.resolve(__dirname, '..', 'plugins/autodev-memory/scripts/claudemd-audit.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-scope-'));
try {
  const cases = [
    ['mixed-history', 'The `src/gone.ts` module was removed.\nThe `src/gone.ts` module is the current entry point.\n', true],
    ['mixed-private', 'The `src/gone.ts` file is private and gitignored.\nRead `src/gone.ts` for the public entry point.\n', true],
    ['history-only', 'The `src/gone.ts` module was removed.\nThe `src/gone.ts` module was retired.\n', false],
    ['private-only', 'The `src/gone.ts` file is private and gitignored.\n', false],
    ['contradiction', 'The `src/gone.ts` file was removed but still exports the parser.\n', true],
  ];
  for (const [name, text, expected] of cases) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), text + 'Read `src/control.ts` for the runner.\n');
    const before = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    const r = spawnSync(process.execPath, [SUBJECT, dir, '--json'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    const row = JSON.parse(r.stdout)[0];
    assert.equal(row.refsChecked, 2, 'eligible reference population');
    assert.ok(row.findings.some(f => f.ref === 'src/control.ts' && f.kind === 'missing'), 'planted positive remains visible beside every exemption');
    assert.equal(row.findings.some(f => f.ref === 'src/gone.ts'), expected, name);
    assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), before, 'read-only');
    console.log('PASS ' + name);
  }
  console.log(cases.length + ' per-mention detector cases passed, each with a positive control');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
