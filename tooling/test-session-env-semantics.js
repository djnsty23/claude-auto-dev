#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const HOOK = path.resolve(__dirname, '..', 'plugins/autodev-core/hooks/session-env-dedupe.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-semantics-'));
const bash = process.platform === 'win32'
  ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find(f => fs.existsSync(f)) || 'bash'
  : 'bash';
const env = { ...process.env, CLAUDE_CONFIG_DIR: tmp };
delete env.CLAUDE_ENV_FILE;
delete env.CLAUDE_PLUGIN_DATA;
function observed(text) {
  const r = spawnSync(bash, ['-s'], { input: text + '\nprintf "%s" "${HARNESS_CANARY-UNSET}"\n', encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(r.status, 0, 'Bash semantic control executed');
  assert.equal(r.stderr, '', 'Bash semantic control has no error');
  return r.stdout;
}
let cases = 0;
try {
  for (const [name, text] of [
    ['inherited-reader', 'export HARNESS_CANARY=first\nprintenv HARNESS_CANARY\nexport HARNESS_CANARY=last\n'],
    ['conditional-write', 'export HARNESS_CANARY=first\nif false\nthen\nexport HARNESS_CANARY=last\nfi\n'],
    ['heredoc-body', 'export HARNESS_CANARY=first\ncat <<\'END\'\nexport HARNESS_CANARY=middle\nexport HARNESS_CANARY=last\nEND\n'],
    ['continued-command', 'export HARNESS_CANARY=first\nprintf "%s\\n" \\\nexport HARNESS_CANARY=last\nexport HARNESS_CANARY=end\n'],
    ['assignment-only', 'export HARNESS_CANARY=first\nHARNESS_CANARY=middle\nexport HARNESS_CANARY=last\n'],
  ]) {
    const dir = path.join(tmp, 'session-env', name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'sessionstart-hook-1.sh');
    fs.writeFileSync(file, text);
    const before = observed(text);
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: name, hook_event_name: 'PreCompact' }), env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(r.status, 0, name + ' hook exit');
    assert.equal(r.stdout, '', name + ' zero stdout bytes');
    assert.equal(r.stderr, '', name + ' zero stderr bytes');
    assert.equal(fs.readFileSync(file, 'utf8'), text, name + ' opaque program preserved');
    assert.equal(observed(fs.readFileSync(file, 'utf8')), before, name + ' Bash observations preserved');
    cases++;
    console.log('PASS ' + name);
  }
  const dir = path.join(tmp, 'session-env', 'literal-control');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sessionstart-hook-1.sh');
  const block = 'export HARNESS_CANARY=one\nexport SECOND=two\nexport THIRD=three\n';
  fs.writeFileSync(file, block.repeat(23));
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 'literal-control' }), env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  assert.equal(fs.readFileSync(file, 'utf8'), block, 'positive control still reduces 69 exports to 3');
  assert.equal(observed(block.repeat(23)), observed(block));
  cases++;
  console.log('PASS literal-control 69 -> 3');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(cases + ' semantic cases passed via hook subprocesses and independent Bash observations');
