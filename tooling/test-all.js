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
