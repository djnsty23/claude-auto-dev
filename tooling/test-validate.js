#!/usr/bin/env node
// Tests for validate.js checks that are not covered by simply running it green.
//
// Run: node tooling/test-validate.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VALIDATE = path.join(ROOT, 'tooling', 'validate.js');

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

const runValidate = () => spawnSync(process.execPath, [VALIDATE], { encoding: 'utf8', cwd: ROOT });

// Baseline: the repo must be green, or nothing below distinguishes anything.
const base = runValidate();
check('validate is green on a clean tree', base.status === 0);

// The stale-mutation-backup check. This is the only guard against the one defect
// class no test can catch — a mutant that survives its suite is by definition
// invisible to it. Three reached the public remote on 2026-08-16 while every
// gate stayed green.
//
// The marker file is created inside the repo, so it is removed in a finally:
// leaving one behind would fail every later run of this very check.
const marker = path.join(ROOT, 'plugins', 'autodev-core', 'scripts', '.test-subject.js.vacuity-backup');
let withMarker;
try {
    fs.writeFileSync(marker, 'placeholder');
    withMarker = runValidate();
} finally {
    fs.rmSync(marker, { force: true });
}

check('a stale .vacuity-backup makes validate FAIL', withMarker.status === 1);
// Asserted as a line of its OWN, not merely present in the output. The weaker
// `.includes(name)` version was vacuous: the restore-hint line also contains the
// filename, so deleting the listing line entirely left the assertion green. One
// output line masking another — the same shape check-suites-can-fail cannot see.
check('  and the failure lists the file on its own line',
    (withMarker.stdout || '').split('\n').some((l) => {
        const t = l.trim();
        return t.endsWith('.test-subject.js.vacuity-backup') && !t.includes('restore with');
    }));
check('  and gives a restore command', /restore with: git checkout --/.test(withMarker.stdout || ''));

// Removing it must clear the failure, or the check is a one-way trap.
const after = runValidate();
check('removing the backup clears the failure', after.status === 0);

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
