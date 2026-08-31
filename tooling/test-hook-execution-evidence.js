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

// PRIVATE ISOLATION (Sol's round-13 blocker). This suite mutates a tracked
// suite file to exercise the checker, and no restore discipline makes that
// safe in a shared tree — forced termination strands mutants, and the
// hardlink return has an unwindable window. So every mutation happens in a
// sandbox worktree of HEAD, created here and removed on exit. The checker
// under test is COPIED IN from this tree (or from HOOK_CHECK), never taken
// from HEAD: under the stub sweep this suite runs against a stubbed
// checker, and a sandbox built purely from HEAD would silently test the
// wrong file and blind check:suites to this suite.
const crypto = require('crypto');
const gitq = (args) => {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + ((r.stderr || '').trim() || r.status));
    return r.stdout;
};
const SANDBOX = (() => {
    const sha = gitq(['rev-parse', 'HEAD']).trim();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hookcheck-sb-' + process.pid + '-'));
    fs.rmdirSync(dir);
    try { gitq(['worktree', 'add', '--detach', dir, sha]); }
    catch (e) { console.error('could not create the sandbox worktree: ' + e.message); process.exit(2); }
    process.on('exit', () => {
        try { gitq(['worktree', 'remove', '--force', dir]); }
        catch { try { fs.rmSync(dir, { recursive: true, force: true }); gitq(['worktree', 'prune']); } catch { /* stranded; the dir names its owner pid */ } }
    });
    return dir;
})();
const CHECK_SRC = process.env.HOOK_CHECK
    ? path.resolve(process.env.HOOK_CHECK)
    : path.join(ROOT, 'tooling', 'find-untested-hooks.js');
const CHECK = path.join(SANDBOX, 'tooling', 'find-untested-hooks.js');
fs.copyFileSync(CHECK_SRC, CHECK);

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);
const detail = (r) => `status=${r.status} signal=${r.signal} error=${r.error?.message || 'none'}`;

const runChecker = () => {
    const result = spawnSync(process.execPath, [CHECK, '--json'], {
        cwd: SANDBOX,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 180000,
    });
    let json = null;
    try { json = JSON.parse(result.stdout); } catch { /* reported by controls */ }
    return { result, json };
};

const runSuite = (file, extraEnv = {}) => spawnSync(process.execPath, [file], {
    cwd: SANDBOX,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    windowsHide: true,
    timeout: 60000,
});

// Rename-based mutation inside the sandbox: the original is renamed aside
// (never rewritten), the mutant is created O_EXCL, and the original returns
// via link(). Artifact names are random, never PID-derived — PID reuse plus
// a replacing rename could clobber a preserved artifact from an earlier
// run. Unexpected states are reported and fail the run via
// process.exitCode, never silently absorbed.
let mutSeq = 0;
const installMutant = (file, content) => {
    const orig = file + '.orig-' + crypto.randomBytes(6).toString('hex');
    fs.renameSync(file, orig);
    try { fs.writeFileSync(file, content, { flag: 'wx' }); }
    catch (e) {
        try { fs.linkSync(orig, file); fs.unlinkSync(orig); }
        catch { console.error('original preserved at ' + orig); }
        throw e;
    }
    return orig;
};
const removeMutant = (file, orig, wrote) => {
    try {
        const cap = file + '.cap-' + crypto.randomBytes(6).toString('hex');
        let claimed = false;
        try { fs.renameSync(file, cap); claimed = true; }
        catch { console.error('NOT CLEANED: ' + file + ' was deleted while mutated'); process.exitCode = 1; }
        if (claimed) {
            if (fs.readFileSync(cap, 'utf8') === wrote) fs.unlinkSync(cap);
            else {
                console.error('NOT CLEANED: foreign content on ' + file + ' captured at ' + cap);
                process.exitCode = 1;
            }
        }
        fs.linkSync(orig, file);
        fs.unlinkSync(orig);
    } catch (e) {
        console.error('RESTORE INCOMPLETE for ' + file + ' (' + (e.code || e.message)
            + '); the original is at ' + orig);
        process.exitCode = 1;
    }
};

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
    targetSuite = path.join(SANDBOX, 'tooling', target.covering[0]);
    original = fs.readFileSync(targetSuite, 'utf8');
    const ordinary = runSuite(targetSuite);
    check('control: the dedicated suite is green before the mutation',
        ordinary.status === 0 && ordinary.signal === null && !ordinary.error,
        detail(ordinary));

    try {
        // Preserve the exact path-resolving literal the old checker recognizes,
        // then exit before the hook load. A correct execution-based checker must
        // reject this even though the mutated suite itself exits successfully.
        const vacuousSrc = [
            '#!/usr/bin/env node',
            "const path = require('path');",
            `const HOOK = path.resolve(__dirname, '..', 'plugins', ${JSON.stringify(target.plugin)}, 'hooks', ${JSON.stringify(target.name)});`,
            "console.log('vacuous fixture exited before its subject');",
            'process.exit(0);',
            'require(HOOK);',
            '',
        ].join('\n');
        var vacuousOrig = installMutant(targetSuite, vacuousSrc);
        var vacuousWrote = vacuousSrc;

        const vacuous = runSuite(targetSuite);
        check('control: the vacuous replacement exits 0 without loading its hook',
            vacuous.status === 0 && vacuous.signal === null && !vacuous.error,
            detail(vacuous));
        mutatedCheck = runChecker();
    } finally {
        if (vacuousOrig) removeMutant(targetSuite, vacuousOrig, vacuousWrote);
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
    const targetHook = path.join(SANDBOX, 'plugins', target.plugin, 'hooks', target.name);
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
        const redSrc = insertAfterShebang(original, exitWrapper);
        var redOrig = installMutant(targetSuite, redSrc);
        var redWroteNow = redSrc;
        const forcedRed = runSuite(targetSuite, { NODE_V8_COVERAGE: coverageDir });
        check('control: the dedicated suite is red after the injected failure',
            forcedRed.status === 1 && forcedRed.signal === null && !forcedRed.error,
            detail(forcedRed));
        check('control: the forced-red suite emits raw V8 coverage for its hook',
            rawCoverageContains(coverageDir, targetHook),
            `coverage dumps=${fs.readdirSync(coverageDir).length}`);
        failedSuiteCheck = runChecker();
    } finally {
        if (redOrig) removeMutant(targetSuite, redOrig, redWroteNow);
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
// A red cleanup (process.exitCode set by removeMutant) must survive a green
// check run — exit(0) here would override it (Sol's round-12 blocker).
process.exit(fail > 0 ? 1 : (process.exitCode || 0));
