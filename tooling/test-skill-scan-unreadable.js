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
const selected = name => !which || which === 'tools' || which === name;
try {
  const visible = path.join(scratch, 'visible');
  const hidden = path.join(scratch, 'unreadable');
  fs.mkdirSync(visible);
  fs.mkdirSync(hidden);
  const text = '---\nname: visible\ndescription: "Load before editing."\nallowed-tools: Read\n---\n\nUse `Read` to inspect the file.\n';
  fs.writeFileSync(path.join(visible, 'SKILL.md'), text);
  fs.writeFileSync(path.join(hidden, 'SKILL.md'), text);
  const preload = path.join(scratch, 'boundary.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs')
const path = require('node:path')
const root = ${JSON.stringify(path.resolve(__dirname, '../plugins'))}
const scratch = ${JSON.stringify(scratch)}
const hidden = ${JSON.stringify(hidden)}
const mode = process.env.SCAN_MODE
const directory = fs.readdirSync
const read = fs.readFileSync
const denied = () => Object.assign(new Error('fixture denial'), { code: 'EACCES' })
const mapped = p => typeof p === 'string' && (path.resolve(p) === root || path.resolve(p).startsWith(root + path.sep))
  ? path.join(scratch, path.relative(root, p)) : p
fs.readdirSync = (dir, ...args) => {
  dir = mapped(dir)
  if (typeof dir !== 'string') return directory(dir, ...args)
  if (path.resolve(dir) === scratch && mode === 'empty') return []
  if (path.resolve(dir) === hidden && mode === 'directory') throw denied()
  return directory(dir, ...args)
}
fs.readFileSync = (file, ...args) => {
  file = mapped(file)
  if (file === path.join(hidden, 'SKILL.md') && mode === 'file') throw denied()
  return read(file, ...args)
}
`);
  const run = (subject, mode, args, extraPreload, stdio) => spawnSync(process.execPath,
    ['--require', preload, ...(extraPreload ? ['--require', extraPreload] : []), subject, ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024,
      stdio, env: { ...process.env, SCAN_MODE: mode } });
  if (!which || which === 'triggers') {
    const clean = run(SUBJECT, 'clean', ['--root', scratch, '--json']);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.equal(JSON.parse(clean.stdout).population.files, 2, 'both skills positive control');
    const denied = run(SUBJECT, 'directory', ['--root', scratch, '--json']);
    assert.equal(denied.status, 2, 'partial directory discovery cannot report a complete trigger inventory');
    assert.equal(JSON.parse(denied.stdout).population.files, 1, 'known readable skill still counted');
    assert.match(denied.stdout + denied.stderr, /EACCES/, 'discovery error is reported');
    console.log('PASS trigger inventory refuses unreadable directory beside a readable positive control');
  }
  if (!which || which.startsWith('tools')) {
    const clean = run(TOOL_SUBJECT, 'clean', []);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.match(clean.stdout, /2 skills scanned/, 'two skills positive control');
  }
  if (selected('tools-directory')) {
    const denied = run(TOOL_SUBJECT, 'directory', []);
    assert.equal(denied.status, 2, 'partial directory discovery cannot pass the tool gate');
    assert.match(denied.stdout + denied.stderr, /EACCES/, 'tool gate reports discovery failure');
    console.log('PASS tool gate refuses unreadable directory beside a readable positive control');
  }
  if (selected('tools-selftest')) {
    const clean = run(TOOL_SUBJECT, 'clean', ['--selftest']);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.match(clean.stdout, /PASS: \d+\/\d+ fixture cases/, 'complete selftest positive control');
    for (const mode of ['file', 'directory']) {
      const denied = run(TOOL_SUBJECT, mode, ['--selftest']);
      assert.ok(Number.isInteger(denied.status) && denied.status !== 0,
        `selftest must refuse incomplete ${mode} population beside readable skill`);
      assert.match(denied.stdout + denied.stderr, /EACCES/, 'selftest reports the denied input');
      assert.match(denied.stdout, /ok\s+the live corpus yields references to judge/,
        'readable skill remains a selftest positive control');
    }
    console.log('PASS selftest refuses denied file and directory with a readable positive control');
  }
  if (selected('tools-file')) {
    const denied = run(TOOL_SUBJECT, 'file', []);
    assert.equal(denied.status, 2, 'unreadable skill file cannot pass the tool gate');
    assert.match(denied.stderr, /NOT CHECKED: .*unreadable[/\\]SKILL\.md \(EACCES\)/,
      'tool gate collects the file read error');
    assert.match(denied.stdout, /1 declare allowed-tools/, 'readable skill was inspected');
    console.log('PASS tool gate collects denied file beside a readable positive control');
  }
  if (selected('tools-count')) {
    const denied = run(TOOL_SUBJECT, 'file', []);
    assert.equal(denied.status, 2, denied.stdout + denied.stderr);
    assert.match(denied.stdout, /1 skills scanned, 1 declare allowed-tools, 0 do not/,
      'file-denial population counts only successfully read skills');
    console.log('PASS file-denial summary counts only the one readable skill');
  }
  if (selected('tools-empty')) {
    const empty = run(TOOL_SUBJECT, 'empty', []);
    assert.equal(empty.status, 2, 'empty scan must refuse a gate verdict');
    assert.match(empty.stderr, /read 0 skills, so nothing was checked/, 'empty population is explicit');
    console.log('PASS empty scan refuses a gate verdict');
  }
  if (selected('tools-advisory')) {
    for (const mode of ['directory', 'file']) {
      const denied = run(TOOL_SUBJECT, mode, ['--advisory']);
      assert.equal(denied.status, 2, 'advisory scan must refuse incomplete population');
      assert.match(denied.stderr, /EACCES/, 'advisory reports the failed input');
    }
    console.log('PASS advisory scan refuses incomplete file and directory populations');
  }
  if (selected('tools-finding')) {
    fs.writeFileSync(path.join(visible, 'SKILL.md'), text.replace('Use `Read`', 'Use `Bash`'));
    try {
      for (const mode of ['clean', 'directory', 'file']) {
        const finding = run(TOOL_SUBJECT, mode, []);
        assert.match(finding.stdout, /mandates Bash, which allowed-tools does not declare/,
          'real undeclared-tool fixture reaches the finding');
        assert.equal(finding.status, 1, 'real undeclared-tool finding must fail the gate');
        const advisory = run(TOOL_SUBJECT, mode, ['--advisory']);
        assert.equal(advisory.status, mode === 'clean' ? 0 : 2,
          'advisory waives findings but never incomplete input');
        assert.match(advisory.stdout, /mandates Bash/, 'advisory still reports the finding');
      }
    } finally { fs.writeFileSync(path.join(visible, 'SKILL.md'), text); }
    console.log('PASS real undeclared tool fails normal gate with complete or partial input');
  }
  if (selected('tools-drain')) {
    const drain = path.join(scratch, 'async-output.cjs');
    // Defer the real diagnostics on every host, including synchronous Windows pipes.
    const payload = 'diagnostic-backpressure-control\n'.repeat(40000);
    fs.writeFileSync(drain, `const payload = 'diagnostic-backpressure-control\\n'.repeat(40000)
let first = true
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream)
  stream.write = (chunk, ...args) => {
    if (stream === process.stdout && first) {
      first = false
      setImmediate(() => write(payload))
    }
    setImmediate(() => write(chunk, ...args))
    return false
  }
}
`);
    const piped = run(TOOL_SUBJECT, 'file', ['--all'], drain);
    assert.equal(piped.status, 2, piped.stderr);
    assert.ok(piped.stdout.startsWith(payload), 'natural exit drains queued backpressure payload');
    assert.match(piped.stdout, /1 skills scanned/, 'queued scan diagnostic drains');
    assert.match(piped.stdout, /run means no DETECTABLE mandate is undeclared, not that none exists\.\r?\n$/,
      'last queued stdout diagnostic drains');
    assert.match(piped.stderr, /EACCES/, 'queued stderr diagnostic drains');
    const outFile = path.join(scratch, 'stdout.txt');
    const errFile = path.join(scratch, 'stderr.txt');
    const out = fs.openSync(outFile, 'w');
    const err = fs.openSync(errFile, 'w');
    try {
      const filed = run(TOOL_SUBJECT, 'file', ['--all'], drain, ['ignore', out, err]);
      assert.equal(filed.status, 2, 'file transport preserves exit status');
    } finally { fs.closeSync(out); fs.closeSync(err); }
    assert.equal(fs.readFileSync(outFile, 'utf8'), piped.stdout, 'pipe and file stdout agree byte for byte');
    assert.equal(fs.readFileSync(errFile, 'utf8'), piped.stderr, 'pipe and file stderr agree byte for byte');
    console.log('PASS natural exit drains queued stdout and stderr with 1240000 payload bytes through pipe and file');
  }
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
