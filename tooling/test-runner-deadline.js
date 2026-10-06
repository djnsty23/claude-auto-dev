#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
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
  for (const name of ['suite-tmp.js', 'suite-process-tree.js', 'coverage-receipt.js']) fs.copyFileSync(path.join(__dirname, name), path.join(dir, name));
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
  fs.writeFileSync(path.join(dir, 'test-a.js'), 'setTimeout(() => {}, 6000);\n');
  fs.writeFileSync(path.join(dir, 'test-b.js'), 'process.exitCode = 1;\n');
  const reverse = run();
  assert.equal(reverse.status, 1, 'later completed failure wins over earlier timeout');
  assert.match(reverse.stdout, /INDET\s+test-a/);
  assert.match(reverse.stdout, /FAIL\s+test-b/);
  console.log('PASS later completed failure is not downgraded by earlier timeout');
  const invalid = run({ env: { ...env, AUTODEV_TEST_SUITE_TIMEOUT_MS: 'invalid' } });
  assert.equal(invalid.status, 2);
  assert.doesNotMatch(invalid.stdout, /=== test-/);
  console.log('PASS invalid deadline refuses before executing suites');
  fs.writeFileSync(path.join(dir, 'test-b.js'), 'console.log("LATER-CONTROL");\n');
  fs.writeFileSync(path.join(dir, 'test-a.js'), 'console.log("FAIL ASSERTION CANARY"); process.exitCode = 1; setInterval(() => {}, 1000);\n');
  const failureThenHang = run();
  assert.equal(failureThenHang.status, 2, 'unobserved exitCode before hang is not a completed verdict');
  assert.match(failureThenHang.stdout, /FAIL ASSERTION CANARY/);
  assert.match(failureThenHang.stdout, /INDET\s+test-a/);
  assert.match(failureThenHang.stdout, /Output may contain assertion failures/,
    'timeout summary acknowledges preserved failure evidence');
  console.log('PASS failure text and assigned exitCode before hang stay INDET with preserved evidence');
  fs.writeFileSync(path.join(dir, 'test-a.js'), 'console.log("FAIL textual control, completed exit zero");\n');
  const textualFailure = run();
  assert.equal(textualFailure.status, 0, 'arbitrary failure-looking stdout cannot override completed exit zero');
  assert.match(textualFailure.stdout, /PASS\s+test-a/);
  fs.writeFileSync(path.join(dir, 'test-a.js'), 'console.log("PASS textual control, no completed exit"); setInterval(() => {}, 1000);\n');
  const textualPass = run();
  assert.equal(textualPass.status, 2, 'success-looking stdout cannot turn a timeout into a pass');
  assert.match(textualPass.stdout, /INDET\s+test-a/);
  console.log('PASS verdicts use observed exit only, never failure-looking or success-looking stdout');
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
  const meta = path.join(tmp, 'tree.pid');
  const beat = path.join(tmp, 'heartbeat.pid');
  const leafPid = path.join(tmp, 'leaf.pid');
  const leaf = `
    const fs = require('fs'); let n = 0;
    fs.writeFileSync(${JSON.stringify(leafPid)}, String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => fs.writeFileSync(${JSON.stringify(beat)}, String(++n)), 25);
    setTimeout(() => process.exit(0), 12000);
  `;
  const middle = `
    const g = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}],
      { detached: true, stdio: 'inherit' }); g.unref();
    process.on('SIGTERM', () => {});
    setTimeout(() => process.exit(0), 12000);
  `;
  fs.writeFileSync(path.join(dir, 'test-a.js'), `
    const fs = require('fs');
    const g = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(middle)}],
      { detached: true, stdio: 'inherit', cwd: require('os').tmpdir() }); g.unref();
    fs.writeFileSync(${JSON.stringify(meta)}, JSON.stringify({ owner: process.pid, pid: g.pid, root: require('os').tmpdir() }));
    process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
  `);
  fs.writeFileSync(path.join(dir, 'test-b.js'), `
    const fs = require('fs'); const m = JSON.parse(fs.readFileSync(${JSON.stringify(meta)}, 'utf8'));
    const pids = [m.owner, m.pid, Number(fs.readFileSync(${JSON.stringify(leafPid)}, 'utf8'))];
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const before = fs.readFileSync(${JSON.stringify(beat)}, 'utf8');
    setTimeout(() => {
      const changed = fs.readFileSync(${JSON.stringify(beat)}, 'utf8') !== before;
      const live = pids.filter(alive); const removed = !fs.existsSync(m.root);
      console.log('TREE-CANARY', JSON.stringify({ changed, live, removed }));
      process.exitCode = changed || live.length || !removed ? 1 : 0;
    }, 200);
  `);
  const stranger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: 'ignore' });
  stranger.unref();
  let tree;
  try {
    tree = run();
    assert.equal(tree.error, undefined, 'tree cleanup bounded below outer deadline');
    assert.equal(tree.status, 2, 'timeout stays INDET with clean descendants: ' + tree.stdout + tree.stderr);
    assert.match(tree.stdout, /TREE-CANARY {"changed":false,"live":\[\],"removed":true}/);
    assert.match(tree.stdout, /PASS\s+test-b/);
    assert.doesNotThrow(() => process.kill(stranger.pid, 0), 'unrelated process stays alive');
    console.log('PASS detached child and grandchild stop before next suite and fixture removal, unrelated PID survives');
  } finally {
    const pids = [stranger.pid];
    if (fs.existsSync(meta)) { const m = JSON.parse(fs.readFileSync(meta, 'utf8')); pids.push(m.owner, m.pid); }
    if (fs.existsSync(leafPid)) pids.push(Number(fs.readFileSync(leafPid, 'utf8')));
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
  }
} finally {
  // Let Windows release the explicitly stopped fixture's cwd handle.
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
}
main().catch(e => { console.error(e); process.exitCode = 1; });
