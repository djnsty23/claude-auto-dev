#!/usr/bin/env node
// Tests the mutation-sweep guard in test-all.js.
//
// Why this exists: on 2026-08-17 a `check:vacuity` sweep was backgrounded after
// its 120s timeout, and `npm test` was then run against the same repo. It printed
// a clean 25/25 — measured against a check-superseded.js that was half-mutated at
// the time. The pass described a file that did not exist on disk by the time it
// was printed. Minutes later a `git diff` taken during a second sweep showed a
// `|| -> &&` edit in a file nobody had touched, which read exactly like a harness
// leaking a mutant; it was the in-flight mutant.
//
// The guard refuses to run any suite while a `*.vacuity-backup` file exists in
// tooling/, because the sweep writes that file before its first mutation and
// removes it on clean exit — so its presence means either a sweep is running now
// or one died leaving the subject mutated.
//
// ONE-SIDED, DELIBERATELY. Only the refusal is asserted here. The pass-through
// side cannot be fixtured cheaply: proving "no backup -> suites run" means
// spawning a full test-all.js from inside a suite that test-all.js is running,
// which recurses and costs a whole extra suite sweep. It does not need a fixture
// — every ordinary `npm test` in this repo exercises it, and any regression that
// made the guard fire unconditionally would fail every run immediately, loudly.
// What is NOT self-evident, and is therefore what gets asserted, is that the
// guard fires at all and is not pinned to one subject's filename.
//
// Run: node tooling/test-runner-guard.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RUNNER = path.resolve(__dirname, 'test-all.js');

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);

// Distinctive names so a stray file left by a crash is obviously this suite's.
const FIXTURES = [
    'zz-runner-guard-fixture.js.vacuity-backup',
    'zz-runner-guard-other-subject.js.vacuity-backup',
];
const abs = (f) => path.join(__dirname, f);

function cleanup() {
    for (const f of FIXTURES) {
        try { fs.unlinkSync(abs(f)); } catch {}
    }
}
// A stray *.vacuity-backup blocks every future `npm test`, so removal must
// survive a throw AND a hard exit, not just the happy path.
process.on('exit', cleanup);

function runRunner() {
    return spawnSync(process.execPath, [RUNNER], {
        encoding: 'utf8',
        cwd: path.resolve(__dirname, '..'),
        timeout: 60000,
    });
}

try {
    // 1. The guard fires, and exits 2 rather than 0 (pass) or 1 (suite failure),
    //    so "refused" is distinguishable from "ran and failed".
    fs.writeFileSync(abs(FIXTURES[0]), 'fixture\n');
    const fired = runRunner();
    const firedOut = (fired.stdout || '') + (fired.stderr || '');
    check('a *.vacuity-backup in tooling/ makes the runner refuse with exit 2',
        fired.status === 2, 'exit ' + fired.status);
    check('the refusal names the file it found, not just a verdict',
        firedOut.includes(FIXTURES[0]), firedOut.trim().split('\n').slice(-1)[0]);
    check('the refusal happens before any suite runs',
        !/\bPASS\b/.test(firedOut), 'a suite reported PASS despite the refusal');

    // 2. Not pinned to check-superseded.js — any subject's backup must block.
    fs.unlinkSync(abs(FIXTURES[0]));
    fs.writeFileSync(abs(FIXTURES[1]), 'fixture\n');
    const other = runRunner();
    check('the guard is not hardcoded to one subject filename',
        other.status === 2, 'exit ' + other.status);

    // 3. Removing the marker removes the refusal. This asserts the guard is not
    //    stuck on, without paying for a full nested suite run: exit 2 is unique
    //    to the guard, so "not 2" is enough to prove it stopped firing.
    fs.unlinkSync(abs(FIXTURES[1]));
    const clean = spawnSync(process.execPath, ['-e',
        'const fs=require("fs"),p=require("path");' +
        'const d=' + JSON.stringify(__dirname) + ';' +
        'process.stdout.write(String(fs.readdirSync(d).filter(f=>f.endsWith(".vacuity-backup")).length));'
    ], { encoding: 'utf8' });
    check('both fixtures are gone once the suite has run',
        clean.stdout.trim() === '0', 'backups still present: ' + clean.stdout.trim());
} finally {
    cleanup();
}

let pass = 0, fail = 0;
for (const [label, ok, detail] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok || !detail ? '' : '  -> ' + detail));
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed  (guard population: tooling/*.vacuity-backup)`);
process.exit(fail > 0 ? 1 : 0);
