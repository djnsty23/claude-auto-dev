#!/usr/bin/env node
// Acceptance test for F5: a suite must execute a wired hook before the hook is
// counted as tested. Expected failure before the fix: a matching path literal
// remains enough for check:hooks even when the suite exits before require(HOOK)
// and before every assertion.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const CHECK = process.env.HOOK_CHECK
    ? path.resolve(process.env.HOOK_CHECK)
    : path.join(ROOT, 'tooling', 'find-untested-hooks.js');

// THIS SUITE REWRITES TRACKED FILES (the vacuous-suite canary below prepends
// to a real suite and restores it on exit), so a direct run of it overlapping
// a stub sweep can silently poison the sweep's verdicts and both restore
// clean — the exact silent-green path the sweep's own exclusion exists to
// prevent. So it participates in the same protocol test-all.js uses: announce
// a per-pid test lock before doing anything, refuse under a live sweep, and
// skip both only when spawned BY the sweep (proven by the nonce in the live
// lock, not by the env var's mere presence). Any suite that mutates tracked
// files must carry this block; suites that only read do not.
{
    const crypto = require('crypto');
    const key = 'check-suites-'
        + crypto.createHash('sha1').update(fs.realpathSync(ROOT)).digest('hex').slice(0, 12);
    const sweepLock = path.join(os.tmpdir(), key + '.lock');
    let sweepChild = false;
    if (process.env.AUTODEV_SWEEP_CHILD) {
        try {
            const lines = fs.readFileSync(sweepLock, 'utf8').split('\n');
            try { process.kill(parseInt(lines[0], 10), 0); } catch (e) { if (e.code !== 'EPERM') throw e; }
            sweepChild = lines[1] === process.env.AUTODEV_SWEEP_CHILD;
        } catch { sweepChild = false; }
    }
    if (!sweepChild) {
        const announce = path.join(os.tmpdir(), key + '.test-' + process.pid + '.lock');
        try {
            fs.writeFileSync(announce, String(process.pid));
            process.on('exit', () => { try { fs.unlinkSync(announce); } catch { /* gone */ } });
        } catch (e) {
            console.error('refusing: could not announce this run (' + (e.code || e.message) + ')');
            process.exit(2);
        }
        let sweepAlive = false;
        let holder = NaN;
        try {
            holder = parseInt(fs.readFileSync(sweepLock, 'utf8'), 10);
            if (Number.isFinite(holder)) {
                try { process.kill(holder, 0); sweepAlive = true; }
                catch (e) { sweepAlive = e.code === 'EPERM'; }
            }
        } catch { /* no sweep lock */ }
        if (sweepAlive) {
            try { fs.unlinkSync(announce); } catch { /* best effort */ }
            console.error('refusing: a stub sweep (pid ' + holder + ') holds this tree, and this');
            console.error('suite rewrites tracked files. Wait for the sweep, then re-run.');
            process.exit(2);
        }
    }
}

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

const runSuite = (file, extraEnv = {}) => spawnSync(process.execPath, [file], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    windowsHide: true,
    timeout: 60000,
});

const insertAfterShebang = (source, insertion) => {
    if (!source.startsWith('#!')) return `${insertion}\n${source}`;
    const lineEnd = source.indexOf('\n');
    if (lineEnd === -1) return `${source}\n${insertion}\n`;
    return `${source.slice(0, lineEnd + 1)}${insertion}\n${source.slice(lineEnd + 1)}`;
};

const rawCoverageContains = (coverageDir, file) => {
    const fileUrl = pathToFileURL(path.resolve(file)).href;
    return fs.readdirSync(coverageDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .some((entry) => fs.readFileSync(path.join(coverageDir, entry.name), 'utf8')
            .includes(fileUrl));
};

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
    const coverageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-red-coverage-'));
    const targetHook = path.join(ROOT, 'plugins', target.plugin, 'hooks', target.name);
    try {
        // Expected failure before the amendment: suiteProblems is advisory, so
        // after a red run's unusable coverage leaves the hook untested, the
        // checker exits 1 instead of the infrastructure-failure status 2. A
        // failed evidence producer makes the whole check indeterminate.
        const exitWrapper = [
            'const acceptanceExit = process.exit.bind(process);',
            'process.exitCode = 1;',
            'process.exit = (code) => acceptanceExit(code === 0 ? 1 : code);',
        ].join('\n');
        fs.writeFileSync(targetSuite, insertAfterShebang(original, exitWrapper));
        const forcedRed = runSuite(targetSuite, { NODE_V8_COVERAGE: coverageDir });
        check('control: the dedicated suite is red after the injected failure',
            forcedRed.status === 1 && forcedRed.signal === null && !forcedRed.error,
            detail(forcedRed));
        check('control: the forced-red suite emits raw V8 coverage for its hook',
            rawCoverageContains(coverageDir, targetHook),
            `coverage dumps=${fs.readdirSync(coverageDir).length}`);
        failedSuiteCheck = runChecker();
    } finally {
        fs.writeFileSync(targetSuite, original);
        fs.rmSync(coverageDir, { recursive: true, force: true });
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
