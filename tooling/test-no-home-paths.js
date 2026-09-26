#!/usr/bin/env node
// Tests for check-no-home-paths.js, which had no suite of its own: validate.js
// spawns it for its verdict and nothing drove its command line.
//
// Run: node tooling/test-no-home-paths.js
//
// --help answers before the scan. Before it had a branch, --help was ignored and
// the script listed and read every tracked file, then printed its population
// line and exited 0. The usage check below fails on that output, which is the
// whole of the old behaviour's negative here: exit 0 and an empty stderr it
// shared with the fix.

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECKER = path.join(ROOT, 'tooling', 'check-no-home-paths.js');

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);

const usage = /^Usage: node tooling\/check-no-home-paths\.js \[--selftest\]$/;
for (const flag of ['--help', '-h']) {
    const r = spawnSync(process.execPath, [CHECKER, flag], { encoding: 'utf8', cwd: ROOT });
    check(`${flag} exits 0`, r.status === 0, `status ${r.status}`);
    check('  and prints the usage line and nothing else',
        usage.test(String(r.stdout).trim()) && String(r.stdout).trim().split('\n').length === 1,
        JSON.stringify(String(r.stdout).slice(0, 160)));
    check('  and writes nothing to stderr', r.stderr === '', JSON.stringify(String(r.stderr).slice(0, 160)));
}

let pass = 0; let fail = 0;
for (const [label, ok, detail] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (!ok && detail ? '  (' + detail + ')' : ''));
    ok ? pass += 1 : fail += 1;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
