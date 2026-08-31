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

// PRIVATE ISOLATION, as a COPY of the invoking tree (Sol's rounds 13-14).
// This suite mutates a suite file to exercise the checker; doing that in a
// shared tree was unfixable, and a worktree of HEAD tested the wrong
// population — an uncommitted wired hook or suite in the invoking tree was
// invisible to it. A file copy snapshots the tree exactly as it is,
// checker and population alike (under the stub sweep that means the
// stubbed checker, which is what keeps check:suites able to see this
// suite). No git metadata exists to strand: the sandbox is a plain temp
// dir, owned by the marker file it carries, reclaimed at startup when its
// owner pid is dead and removed on exit.
const crypto = require('crypto');
const SB_PREFIX = 'hookcheck-sb-';
const canonPath = (p) => {
    const r = path.resolve(p);
    let real;
    try { real = fs.realpathSync(r); } catch { real = r; }
    return process.platform === 'win32' ? real.toLowerCase() : real;
};
const CANON_ROOT = canonPath(ROOT);

// NO automatic reclamation of other runs' sandboxes (Sol's round-16
// recommendation, adopted whole — the same retreat that ended the lock-
// takeover spiral). Every ownership proof for a plain directory in a shared
// tmpdir is forgeable, and every claim/rollback dance has one more race, so
// this run deletes NOTHING it did not create. A stale sandbox is reported
// with its path and the human who can verify it deletes it.
for (const d of fs.readdirSync(os.tmpdir())) {
    const m = d.match(new RegExp('^' + SB_PREFIX + '(\\d+)-'));
    if (!m) continue;
    let alive = false;
    try { process.kill(parseInt(m[1], 10), 0); alive = true; }
    catch (e) { alive = e.code === 'EPERM'; }
    if (!alive) {
        console.error('note: stale sandbox left by dead pid ' + m[1] + ' at '
            + path.join(os.tmpdir(), d) + ' — verify and delete it manually');
    }
}

// The snapshot would recurse into itself if tmpdir lives inside the source
// tree; refuse rather than copy forever.
if (canonPath(os.tmpdir()) === CANON_ROOT || canonPath(os.tmpdir()).startsWith(CANON_ROOT + path.sep)) {
    console.error('refusing: TMPDIR is inside the source tree — the snapshot would recurse into itself');
    process.exit(2);
}
const SB_SKIP = new Set(['.git', '.claude', 'node_modules']);
// Symlinks and junctions are SKIPPED, not copied: a link pointing outside
// the tree would let sandbox mutations escape the sandbox.
const sbKeep = (src) => !SB_SKIP.has(path.basename(src)) && !fs.lstatSync(src).isSymbolicLink();
// CONTENT+MODE manifest (Sol's round-16 blocker: size+mtime missed
// same-size edits, mode changes, and link swaps). Links are recorded, not
// skipped, so a file-to-link swap between the two source passes cannot
// hide; hashes make same-size edits visible.
const sbManifest = (root) => {
    const out = new Map();
    const walk = (rel) => {
        for (const e of fs.readdirSync(path.join(root, rel || '.'), { withFileTypes: true })) {
            if (SB_SKIP.has(e.name)) continue;
            const r = rel ? rel + '/' + e.name : e.name;
            const fp = path.join(root, r);
            const st = fs.lstatSync(fp);
            if (st.isSymbolicLink()) { out.set(r, 'LINK'); continue; }
            if (e.isDirectory()) walk(r);
            else out.set(r, crypto.createHash('sha1').update(fs.readFileSync(fp)).digest('hex')
                + ':' + (st.mode & 0o777));
        }
    };
    walk('');
    return out;
};
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), SB_PREFIX + process.pid + '-'));
{
    // Three-way proof: source-before, destination, source-after must agree,
    // and the destination traversal must contain no links at all. Any
    // disagreement is a mid-copy change or an escape vector, and the run
    // refuses rather than measures it.
    const before = sbManifest(ROOT);
    fs.cpSync(ROOT, SANDBOX, { recursive: true, filter: sbKeep });
    const dest = sbManifest(SANDBOX);
    const after = sbManifest(ROOT);
    const refuse = (why) => {
        console.error('refusing: ' + why + ' — re-run when the tree is quiet');
        process.exit(2);
    };
    if (before.size !== after.size) refuse('the source tree changed while it was being snapshotted');
    for (const [k, v] of before) if (after.get(k) !== v) refuse('the source tree changed while it was being snapshotted');
    let files = 0;
    for (const [k, v] of before) {
        if (v === 'LINK') { if (dest.has(k)) refuse('a link was copied into the sandbox'); continue; }
        files++;
        if (dest.get(k) !== v) refuse('the sandbox does not match the source it was copied from');
    }
    for (const v of dest.values()) if (v === 'LINK') refuse('the sandbox contains a link');
    if (dest.size !== files) refuse('the sandbox holds files the source manifest does not');
}
process.on('exit', () => {
    // This run created SANDBOX with mkdtemp in this process — the one
    // directory it may delete without any ownership question.
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* reported stale next run */ }
});
const CHECK = path.join(SANDBOX, 'tooling', 'find-untested-hooks.js');
if (process.env.HOOK_CHECK) fs.copyFileSync(path.resolve(process.env.HOOK_CHECK), CHECK);

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
