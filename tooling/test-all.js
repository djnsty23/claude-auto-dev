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
// HEAD is captured alongside the status, and that half is not cosmetic.
// [measured 2026-09-03] a status-only snapshot reports GREEN when someone
// COMMITS during a run: the tree is clean before and clean after, so the two
// strings match while the run graded one version of a file at the start and a
// different one at the end. An UNCOMMITTED edit fails loudly today; the
// committed case was silent, and committing mid-run is the more natural of the
// two actions. The subject is still "did this run grade ONE tree", and HEAD is
// part of identifying which tree that was, not a demand that it be committed.
const gitState = () => {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) return null;                   // null = not a git repo; skip the check
  const h = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  // A repo with no commits yet has no HEAD. Fall back to a marker rather than
  // returning null: null disables the whole check, which would make this gate
  // structurally incapable of firing on a fresh repo.
  const head = h.status === 0 ? (h.stdout || '').trim() : '(no commits)';
  return 'HEAD ' + head + '\n' + (r.stdout || '');
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
    // Split the two causes: they need different diagnoses, and one message
    // covering both would misattribute either as the other.
    const headBefore = treeBefore.split('\n')[0];
    const headAfter = treeAfter.split('\n')[0];
    const was = new Set(treeBefore.split('\n').slice(1).filter(Boolean));
    const now = treeAfter.split('\n').slice(1).filter(Boolean);
    const added = now.filter((l) => !was.has(l));
    const gone = [...was].filter((l) => !now.includes(l));
    console.error('\n=== tree-inert ===');
    if (headAfter !== headBefore) {
      console.error('HEAD MOVED DURING THE RUN. This gate graded a mixture of two trees.');
      console.error('  was:  ' + headBefore);
      console.error('  now:  ' + headAfter);
      console.error('Nothing was left dirty: a commit landed mid-run, so a status-only');
      console.error('check reports GREEN. Re-run on a settled tree before believing it.');
    }
    if (added.length || gone.length) {
      console.error('THE TEST RUN MODIFIED THE WORKING TREE. A suite rewrote what it grades.');
      for (const l of added.slice(0, 15)) console.error('  now:  ' + l);
      for (const l of gone.slice(0, 15)) console.error('  was:  ' + l);
    }
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
