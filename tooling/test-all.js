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
