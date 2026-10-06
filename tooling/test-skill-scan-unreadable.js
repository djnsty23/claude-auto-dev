#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const SUBJECT = path.resolve(__dirname, 'check-skill-triggers.js');
const TOOL_SUBJECT = path.resolve(__dirname, 'check-skill-tool-declarations.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-unreadable-'));
const which = process.argv.find(a => a.startsWith('--case='))?.slice(7);
try {
  const visible = path.join(scratch, 'visible');
  const hidden = path.join(scratch, 'unreadable');
  fs.mkdirSync(visible);
  fs.mkdirSync(hidden);
  const text = '---\nname: visible\ndescription: "Load before editing."\nallowed-tools: Read\n---\n\nUse `Read` to inspect the file.\n';
  fs.writeFileSync(path.join(visible, 'SKILL.md'), text);
  fs.writeFileSync(path.join(hidden, 'SKILL.md'), text);
  const preload = path.join(scratch, 'boundary.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs')\nconst path = require('node:path')\nconst real = fs.readdirSync\nfs.readdirSync = (dir, ...args) => {\n  if (path.resolve(dir) === ${JSON.stringify(hidden)} && process.env.SCAN_DENIED === '1') throw Object.assign(new Error('fixture denial'), { code: 'EACCES' })\n  if (path.resolve(dir) === ${JSON.stringify(path.resolve(__dirname, '../plugins'))}) return real(${JSON.stringify(scratch)}, ...args)\n  if (path.resolve(dir).startsWith(${JSON.stringify(path.resolve(__dirname, '../plugins') + path.sep)})) dir = path.join(${JSON.stringify(scratch)}, path.relative(${JSON.stringify(path.resolve(__dirname, '../plugins'))}, dir))\n  if (path.resolve(dir) === ${JSON.stringify(hidden)} && process.env.SCAN_DENIED === '1') throw Object.assign(new Error('fixture denial'), { code: 'EACCES' })\n  return real(dir, ...args)\n}\n`);
  fs.appendFileSync(preload, `const read = fs.readFileSync\nfs.readFileSync = (file, ...args) => {\n  if (typeof file === 'string' && path.resolve(file).startsWith(${JSON.stringify(path.resolve(__dirname, '../plugins') + path.sep)})) file = path.join(${JSON.stringify(scratch)}, path.relative(${JSON.stringify(path.resolve(__dirname, '../plugins'))}, file))\n  return read(file, ...args)\n}\n`);
  const run = (subject, denied, args) => spawnSync(process.execPath, ['--require', preload, subject, ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, SCAN_DENIED: denied ? '1' : '0' } });
  if (!which || which === 'triggers') {
    const clean = run(SUBJECT, false, ['--root', scratch, '--json']);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.equal(JSON.parse(clean.stdout).population.files, 2, 'both skills positive control');
    const denied = run(SUBJECT, true, ['--root', scratch, '--json']);
    assert.equal(denied.status, 2, 'partial directory discovery cannot report a complete trigger inventory');
    assert.equal(JSON.parse(denied.stdout).population.files, 1, 'known readable skill still counted');
    assert.match(denied.stdout + denied.stderr, /EACCES/, 'discovery error is reported');
    console.log('PASS trigger inventory refuses unreadable directory beside a readable positive control');
  }
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
