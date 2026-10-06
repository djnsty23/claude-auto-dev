#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const SUBJECT = path.resolve(__dirname, 'test-all.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-deadline-'));
const env = { ...process.env, AUTODEV_TEST_SUITE_TIMEOUT_MS: '1000' };
for (const key of Object.keys(env)) if (/^GIT_|^NODE_V8_COVERAGE$|^CLAUDE_CONFIG_DIR$|^AUTODEV_COVERAGE_STORE$/.test(key)) delete env[key];
Object.assign(env, { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
const invoke = (file, args, extra = {}) => spawnSync(file, args, { cwd: tmp, env, encoding: 'utf8', windowsHide: true, timeout: 15000, ...extra });
async function main() {
try {
  const dir = path.join(tmp, 'tooling');
  fs.mkdirSync(dir);
  fs.copyFileSync(SUBJECT, path.join(dir, 'test-all.js'));
  for (const name of ['suite-tmp.js', 'coverage-receipt.js']) fs.copyFileSync(path.join(__dirname, name), path.join(dir, name));
  fs.writeFileSync(path.join(dir, 'validate.js'), 'console.log("VALIDATED");\n');
  fs.writeFileSync(path.join(dir, 'test-a.js'), 'console.log("HANGING-CONTROL"); setTimeout(() => {}, 6000);\n');
  fs.writeFileSync(path.join(dir, 'test-b.js'), 'console.log("LATER-CONTROL");\n');
  fs.writeFileSync(path.join(tmp, '.gitignore'), '*.pid\n');
  fs.writeFileSync(path.join(tmp, 'message.txt'), 'chore: fixture\n');
  for (const args of [['init', '-q'], ['add', 'tooling', 'message.txt', '.gitignore'], ['commit', '-F', 'message.txt']]) assert.equal(invoke('git', args).status, 0, 'fixture git operation');
  const run = extra => invoke(process.execPath, [path.join(dir, 'test-all.js'), '--serial', '--no-receipt'], extra);
  const hung = run();
  assert.equal(hung.error, undefined, 'runner itself finished before outer deadline');
  assert.equal(hung.status, 2, 'hanging suite is indeterminate');
  assert.match(hung.stdout, /HANGING-CONTROL/);
  assert.match(hung.stdout, /INDET\s+test-a/);
  assert.match(hung.stderr, /DID NOT FINISH.*ETIMEDOUT/);
  assert.match(hung.stdout, /LATER-CONTROL/);
  assert.match(hung.stdout, /PASS\s+test-b/);
  assert.match(hung.stdout, /VALIDATED/);
  console.log('PASS hung suite is indeterminate, later suite and validator still execute');
  fs.writeFileSync(path.join(dir, 'test-a.js'), 'console.log("FAST-CONTROL");\n');
  const fast = run();
  assert.equal(fast.status, 0, 'fast suites still pass');
  assert.match(fast.stdout, /PASS\s+test-a/);
  console.log('PASS fast negative control passes within the same deadline');
  fs.writeFileSync(path.join(dir, 'test-a.js'), 'process.exitCode = 1;\n');
  fs.writeFileSync(path.join(dir, 'test-b.js'), 'setTimeout(() => {}, 6000);\n');
  const failed = run();
  assert.equal(failed.status, 1, 'a real failure remains failure beside a timed-out suite');
  assert.match(failed.stdout, /FAIL\s+test-a/);
  assert.match(failed.stdout, /INDET\s+test-b/);
  console.log('PASS earlier failure is not downgraded by a later timeout');
  const invalid = run({ env: { ...env, AUTODEV_TEST_SUITE_TIMEOUT_MS: 'invalid' } });
  assert.equal(invalid.status, 2);
  assert.doesNotMatch(invalid.stdout, /=== test-/);
  console.log('PASS invalid deadline refuses before executing suites');
  fs.writeFileSync(path.join(dir, 'test-b.js'), 'console.log("LATER-CONTROL");\n');
  for (const code of [1, 0]) {
    const pidFile = path.join(tmp, 'holder.pid');
    fs.writeFileSync(path.join(dir, 'test-a.js'), `
      const g = require('child_process').spawn(process.execPath,
        ['-e', 'setTimeout(() => {}, 12000)'], { detached: true, stdio: 'inherit' });
      require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
      g.unref(); process.exitCode = ${code};
    `);
    let held;
    try { held = run(); }
    finally {
      if (fs.existsSync(pidFile)) {
        try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); }
        catch (e) { if (e.code !== 'ESRCH') throw e; }
      }
    }
    assert.equal(held.error, undefined, 'held-pipe runner completed');
    assert.equal(held.status, code, `completed exit ${code} retains its verdict despite held pipes`);
    assert.match(held.stdout, code ? /FAIL\s+test-a/ : /PASS\s+test-a/);
    assert.doesNotMatch(held.stderr, /ETIMEDOUT/);
    console.log(`PASS completed exit ${code} with held pipes preserves verdict`);
  }
} finally {
  // Let Windows release the explicitly stopped fixture's cwd handle.
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
}
main().catch(e => { console.error(e); process.exitCode = 1; });
