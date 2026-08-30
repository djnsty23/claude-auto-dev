#!/usr/bin/env node
// Test runner for claude-auto-dev. Pure Node, zero dependencies.
// Discovers every tooling/test-*.js suite (excluding itself), runs each in its
// own child process, then runs validate.js as a final consistency gate.
// Prints a concise `SUITE pass/fail` summary and exits non-zero if ANY suite or
// validate fails. A suite that crashes (non-zero exit / signal) counts as a
// failure, never a hang — spawnSync is synchronous and each child inherits stdio.
//
// node:sqlite is built in on Node 22+ and loads without a flag on this project's
// runtime, so no extra flags are passed to children. If a future Node build
// required `--experimental-sqlite`, add it to CHILD_FLAGS below.
// Run: node tooling/test-all.js   (or: npm test)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const scriptsDir = __dirname;
const repoRoot = path.resolve(scriptsDir, '..');
const self = path.basename(__filename);

// Extra flags to pass to each child node process (none needed on Node 22+).
const CHILD_FLAGS = [];

const suites = fs
  .readdirSync(scriptsDir)
  .filter((f) => /^test-.*\.js$/.test(f) && f !== self)
  .sort();

if (suites.length === 0) {
  console.error('No test suites found in ' + scriptsDir);
  process.exit(1);
}

// A mutation sweep (find-vacuous-assertions.js) OVERWRITES its subject in place,
// restoring between mutants. So a suite run that overlaps a sweep reads a file
// that does not exist on disk by the time the result is printed. On 2026-08-17
// this produced a clean 25/25 measured against a half-mutated check-superseded.js
// — a pass that was not about any real version of the code.
//
// The sweep already writes `<subject>.vacuity-backup` before its first mutation
// and removes it on clean exit, so that file is exactly the in-flight marker; no
// new mechanism is needed. Its presence means either a sweep is running now, or
// one died and left the subject mutated. Both make a pass here meaningless.
//
// This guard is safe because the sweep invokes `node <suite>` directly and never
// routes through this runner — verified at find-vacuous-assertions.js:224.
{
  const stale = fs
    .readdirSync(scriptsDir)
    .filter((f) => f.endsWith('.vacuity-backup'));
  if (stale.length > 0) {
    console.error('\nRefusing to run: a mutation sweep is in flight or died mid-run.\n');
    console.error('Found: ' + stale.join(', '));
    console.error('\nThe sweep rewrites its subject in place, so any result printed now would');
    console.error('describe a mutant rather than the committed code. Wait for the sweep to');
    console.error('finish, or recover the subject by re-running `npm run check:vacuity`');
    console.error('(it restores from the backup first), then re-run the tests.\n');
    process.exit(2);
  }
}

// MUTUAL EXCLUSION WITH THE STUB SWEEP (check-suites-can-fail.js). The sweep
// overwrites subjects in place, so a test run overlapping it measures mutants;
// and this run's suites create zz- fixtures the sweep's cleanup would delete
// mid-use. Two locks in tmpdir close both directions: the sweep's own lock
// (refused here while its holder is alive) and a per-pid announce lock this
// run writes so a starting sweep can see a test run in flight. Children the
// sweep spawns are exempt via AUTODEV_SWEEP_CHILD — the sweep running a suite
// is the intended case, not a collision.
{
  const os = require('os');
  const crypto = require('crypto');
  const key = 'check-suites-'
    + crypto.createHash('sha1').update(fs.realpathSync(repoRoot)).digest('hex').slice(0, 12);
  const sweepLock = path.join(os.tmpdir(), key + '.lock');

  // The sweep-child exemption is AUTHENTICATED, not a boolean: the env value
  // must equal the nonce inside the LIVE sweep lock, whose holder must be
  // alive. A stale or fabricated AUTODEV_SWEEP_CHILD proves nothing and the
  // full guard applies (Sol's round-8 blocker: a bare flag was a bypass any
  // inherited environment could trip).
  let sweepChild = false;
  if (process.env.AUTODEV_SWEEP_CHILD) {
    try {
      const lines = fs.readFileSync(sweepLock, 'utf8').split('\n');
      process.kill(parseInt(lines[0], 10), 0);   // throws if dead
      sweepChild = lines[1] === process.env.AUTODEV_SWEEP_CHILD;
    } catch { sweepChild = false; }
  }

  if (!sweepChild) {
    // ANNOUNCE FIRST, check second. Round 8's ordering blocker: with
    // check-then-announce, a sweep could acquire its lock and scan for test
    // locks in the gap between this run's check and its announcement, and
    // both would proceed. Announcing first means any sweep that acquires
    // later must see this run in its scan. If both start in the same
    // instant, each sees the other and both refuse — a safe outcome.
    // Announce failure fails CLOSED: an unannounced test run is invisible
    // to sweeps, which is exactly the collision this exists to prevent.
    const announce = path.join(os.tmpdir(), key + '.test-' + process.pid + '.lock');
    try {
      fs.writeFileSync(announce, String(process.pid));
      process.on('exit', () => { try { fs.unlinkSync(announce); } catch { /* gone */ } });
    } catch (e) {
      console.error('\nRefusing to run: could not announce this test run ('
        + (e.code || e.message) + ' writing ' + announce + ').');
      console.error('An unannounced run is invisible to a concurrent stub sweep.\n');
      process.exit(2);
    }
    try {
      const holder = parseInt(fs.readFileSync(sweepLock, 'utf8'), 10);
      if (Number.isFinite(holder)) {
        process.kill(holder, 0);   // throws if dead
        try { fs.unlinkSync(announce); } catch { /* withdrawn best-effort */ }
        console.error('\nRefusing to run: a stub sweep (pid ' + holder + ') holds this tree.');
        console.error('Any result printed now would describe its mutants, not the committed code.');
        console.error('Wait for it to finish, then re-run.\n');
        process.exit(2);
      }
    } catch { /* no sweep lock, or its holder is dead — proceed */ }
  }
}

// A SUITE MUST NOT REWRITE THE TREE IT GRADES.
//
// This repo already has the scar. find-vacuous-assertions.js overwrites its
// subject with mutants; a killed run left one in place, a later `git add -A`
// swept it into a commit, and an `if (!installed.plugins[...])` shipped to a
// PUBLIC repo as `if (true)`. Nothing caught it — validate passed and the
// pre-push hook passed, because a mutation that survives its suite is by
// definition one the suite cannot see.
//
// The guards added then were local to that script: refuse a dirty subject, and
// recover from a backup. Both are good and neither watches the RUNNER. So this
// records the working tree before the suites and compares after. It is
// deliberately a comparison and not a cleanliness check — the tree is often
// legitimately dirty while working, and the property that matters is that
// running the gate CHANGED NOTHING, not that everything was committed first.
//
// The failure it catches cannot be caught by exit codes: the scripts that do
// this exit 0. Only looking at the state afterwards can see it.
const gitState = () => {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '') : null;   // null = not a git repo; skip the check
};
const treeBefore = gitState();

const results = [];

// NOTE: this used to be declared `run(label, file, args)` while every call site
// passed two arguments, so `args` was always undefined and spawnSync launched a
// bare `node` with no script. Every suite "passed" without running, and CI was
// green on an empty test run. Keep the parameter list matching the call sites.
function run(label, args) {
  const res = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    cwd: repoRoot,
  });
  // spawnSync returns non-null `signal` if the child was killed, or a numeric
  // `status`. Anything other than a clean 0 exit is a failure.
  let ok;
  if (res.error) {
    console.error(`\n[${label}] failed to spawn: ${res.error.message}`);
    ok = false;
  } else if (res.signal) {
    console.error(`\n[${label}] terminated by signal ${res.signal}`);
    ok = false;
  } else {
    ok = res.status === 0;
  }
  results.push([label, ok]);
  return ok;
}

for (const file of suites) {
  const label = file.replace(/\.js$/, '');
  console.log(`\n=== ${label} ===`);
  run(label, [...CHILD_FLAGS, path.join(scriptsDir, file)]);
}

// Final gate: the consistency validator.
console.log(`\n=== validate ===`);
run('validate', [...CHILD_FLAGS, path.join(scriptsDir, 'validate.js')]);

// Did running the gate change the tree it was grading?
if (treeBefore !== null) {
  const treeAfter = gitState();
  if (treeAfter !== null && treeAfter !== treeBefore) {
    const was = new Set(treeBefore.split('\n').filter(Boolean));
    const now = treeAfter.split('\n').filter(Boolean);
    const added = now.filter((l) => !was.has(l));
    const gone = [...was].filter((l) => !now.includes(l));
    console.error('\n=== tree-inert ===');
    console.error('THE TEST RUN MODIFIED THE WORKING TREE. A suite rewrote what it grades.');
    for (const l of added.slice(0, 15)) console.error('  now:  ' + l);
    for (const l of gone.slice(0, 15)) console.error('  was:  ' + l);
    console.error('Every suite above exited 0. That is the point — no exit code can see this.');
    results.push(['tree-inert', false]);
  } else {
    results.push(['tree-inert', true]);
  }
}

// --- Summary ---
console.log('\n──────── summary ────────');
let failed = 0;
for (const [label, ok] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
}
console.log(
  `\n${results.length - failed}/${results.length} suites passed` +
    (failed ? ` — ${failed} FAILED` : '')
);

process.exit(failed > 0 ? 1 : 0);
