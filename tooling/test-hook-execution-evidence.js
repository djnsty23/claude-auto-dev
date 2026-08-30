#!/usr/bin/env node
// Acceptance test for F5: a suite must execute a wired hook before the hook is
// counted as tested. Expected failure before the fix: a matching path literal
// remains enough for check:hooks even when the suite exits before require(HOOK)
// and before every assertion.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECK = process.env.HOOK_CHECK
    ? path.resolve(process.env.HOOK_CHECK)
    : path.join(ROOT, 'tooling', 'find-untested-hooks.js');

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);
const detail = (r) => `status=${r.status} signal=${r.signal} error=${r.error?.message || 'none'}`;

const runChecker = () => {
    const result = spawnSync(process.execPath, [CHECK, '--json'], {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 180000,
    });
    let json = null;
    try { json = JSON.parse(result.stdout); } catch { /* reported by controls */ }
    return { result, json };
};

const runSuite = (file) => spawnSync(process.execPath, [file], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
});

const baseline = runChecker();
check('control: the committed hook checker has a parseable green baseline',
    baseline.result.status === 0 && baseline.json?.wiredRows?.length > 0,
    detail(baseline.result));

// Pick a one-to-one row dynamically. Keeping the hook basename out of this
// suite's source prevents the source-reference detector from treating this
// acceptance test itself as coverage for the hook it is challenging.
const suiteUse = new Map();
for (const row of baseline.json?.wiredRows || []) {
    for (const suite of row.covering || []) {
        suiteUse.set(suite, (suiteUse.get(suite) || 0) + 1);
    }
}
const target = (baseline.json?.wiredRows || []).find((row) =>
    row.covering?.length === 1 && suiteUse.get(row.covering[0]) === 1);
check('control: the population contains a hook with one dedicated suite',
    !!target,
    'no one-to-one hook/suite row is available for the execution mutation');

let mutatedCheck = null;
let targetSuite = null;
let original = null;
if (target) {
    targetSuite = path.join(ROOT, 'tooling', target.covering[0]);
    original = fs.readFileSync(targetSuite, 'utf8');
    const ordinary = runSuite(targetSuite);
    check('control: the dedicated suite is green before the mutation',
        ordinary.status === 0 && ordinary.signal === null && !ordinary.error,
        detail(ordinary));

    try {
        // Preserve the exact path-resolving literal the old checker recognizes,
        // then exit before the hook load. A correct execution-based checker must
        // reject this even though the mutated suite itself exits successfully.
        fs.writeFileSync(targetSuite, [
            '#!/usr/bin/env node',
            "const path = require('path');",
            `const HOOK = path.resolve(__dirname, '..', 'plugins', ${JSON.stringify(target.plugin)}, 'hooks', ${JSON.stringify(target.name)});`,
            "console.log('vacuous fixture exited before its subject');",
            'process.exit(0);',
            'require(HOOK);',
            '',
        ].join('\n'));

        const vacuous = runSuite(targetSuite);
        check('control: the vacuous replacement exits 0 without loading its hook',
            vacuous.status === 0 && vacuous.signal === null && !vacuous.error,
            detail(vacuous));
        mutatedCheck = runChecker();
    } finally {
        fs.writeFileSync(targetSuite, original);
    }

    const restored = runSuite(targetSuite);
    check('control: the dedicated suite is restored after the mutation',
        restored.status === 0 && restored.signal === null && !restored.error,
        detail(restored));
}

if (target && mutatedCheck) {
    const untestedNames = (mutatedCheck.json?.untested || []).map((row) => row.name);
    check('check:hooks marks the referenced-but-unexecuted hook untested',
        untestedNames.includes(target.name),
        `untested=${JSON.stringify(untestedNames)}`);
    check('check:hooks exits 1 when a wired hook is never executed',
        mutatedCheck.result.status === 1 && mutatedCheck.result.signal === null
            && !mutatedCheck.result.error,
        detail(mutatedCheck.result));
}

let failedSuiteCheck = null;
if (target && targetSuite && original) {
    try {
        // Expected failure before the amendment: execution ranges from a suite
        // that exits nonzero still count as proof, while suiteProblems is only
        // advisory. A failed evidence producer makes the check indeterminate:
        // discard that run's coverage and exit 2.
        fs.writeFileSync(targetSuite, [
            'const acceptanceExit = process.exit.bind(process);',
            'process.exitCode = 1;',
            'process.exit = (code) => acceptanceExit(code === 0 ? 1 : code);',
            original,
        ].join('\n'));
        const forcedRed = runSuite(targetSuite);
        check('control: the dedicated suite is red after the injected failure',
            forcedRed.status === 1 && forcedRed.signal === null && !forcedRed.error,
            detail(forcedRed));
        failedSuiteCheck = runChecker();
    } finally {
        fs.writeFileSync(targetSuite, original);
    }

    const restored = runSuite(targetSuite);
    check('control: the dedicated suite is restored after the red-suite mutation',
        restored.status === 0 && restored.signal === null && !restored.error,
        detail(restored));
}

if (target && failedSuiteCheck) {
    const failedRow = (failedSuiteCheck.json?.wiredRows || [])
        .find((row) => row.name === target.name);
    check('coverage from a failed candidate suite is discarded',
        !failedRow?.covering?.includes(target.covering[0])
            && (failedSuiteCheck.json?.untested || []).some((row) => row.name === target.name),
        `covering=${JSON.stringify(failedRow?.covering)} untested=${JSON.stringify((failedSuiteCheck.json?.untested || []).map((row) => row.name))}`);
    check('a failed candidate suite makes check:hooks exit 2',
        failedSuiteCheck.result.status === 2 && failedSuiteCheck.result.signal === null
            && !failedSuiteCheck.result.error,
        detail(failedSuiteCheck.result));
}

let pass = 0;
let fail = 0;
for (const [label, ok, why] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok || !why ? '' : '  -> ' + why));
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
