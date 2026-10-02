#!/usr/bin/env node
'use strict';
// Suite for the TEST-EDITS section of plugins/autodev-core/scripts/check-pr-ready.js.
//
// WHY. A worker told to make a red suite green can edit the test instead of the
// code, and a green rollup then says nothing about the fix. Nothing flagged that.
// The section lists every assertion line a PR removes or rewrites in a test file,
// every test file it deletes, and every skip/only/todo it adds, but only when the
// PR also changes code: a test-only PR is the legitimate way to change a test.
//
// It is ADVISORY, so the central control is that the exit code is the same with
// and without test edits. Every fixture is a hand-written diff, not one derived
// from the detector's own patterns (gate-integrity section 3), and gh is stubbed
// with a --require preload because a `gh` stub on PATH cannot exist on win32
// (see test-check-pr-ready.js).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-pr-ready.js');

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail === undefined ? '' : '  (' + detail + ')')); }
}

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ready-test-edits-')));
const preload = path.join(tmp, 'gh-stub.js');
const prFile = path.join(tmp, 'pr.json');
const diffFile = path.join(tmp, 'pr.diff');
// `gh pr diff` answers from PR_READY_DIFF, every other gh call from PR_READY_FIXTURE.
// An unset PR_READY_DIFF makes `gh pr diff` fail the way a dead gh does.
fs.writeFileSync(preload, [
    "const cp = require('child_process');",
    'const original = cp.execFileSync;',
    'cp.execFileSync = function(command, args, options) {',
    "  if (command !== 'gh') return original.call(this, command, args, options);",
    "  if (args[0] === 'pr' && args[1] === 'diff') {",
    "    if (!process.env.PR_READY_DIFF) throw new Error('gh pr diff: stubbed failure');",
    "    return require('fs').readFileSync(process.env.PR_READY_DIFF, 'utf8');",
    '  }',
    "  return require('fs').readFileSync(process.env.PR_READY_FIXTURE, 'utf8');",
    '};',
].join('\n'));
fs.writeFileSync(prFile, JSON.stringify({
    number: 7, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    baseRefName: 'main', headRefName: 'claude/fix', files: [{ path: 'src/app.js' }],
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
}));

function invoke(diff, { json = true } = {}) {
    const env = { ...process.env, PR_READY_FIXTURE: prFile };
    if (diff === null) delete env.PR_READY_DIFF;
    else { fs.writeFileSync(diffFile, diff); env.PR_READY_DIFF = diffFile; }
    const r = spawnSync(process.execPath, ['--require', preload, SUBJECT, '7', '--repo', tmp, ...(json ? ['--json'] : [])],
        { cwd: tmp, encoding: 'utf8', env });
    let result = null;
    if (json) { try { result = JSON.parse(r.stdout); } catch { result = null; } }
    return { exit: r.status, result, stdout: r.stdout || '', detail: JSON.stringify({ status: r.status, stdout: (r.stdout || '').slice(0, 1500), stderr: (r.stderr || '').slice(0, 500) }) };
}

// The code half every mixed fixture carries: one real source edit.
const SRC_HUNK = [
    'diff --git a/src/app.js b/src/app.js',
    'index 1111111..2222222 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -1,3 +1,3 @@',
    ' function add(a, b) {',
    '-  return a - b;',
    '+  return a + b;',
    ' }',
].join('\n');

// An assert.equal line rewritten so it can no longer fail: old line 11.
const TEST_EDIT_HUNK = [
    'diff --git a/test/app.test.js b/test/app.test.js',
    'index 3333333..4444444 100644',
    '--- a/test/app.test.js',
    '+++ b/test/app.test.js',
    "@@ -10,4 +10,4 @@ const assert = require('assert');",
    " test('adds', () => {",
    '-  assert.equal(add(1, 2), 3);',
    '+  assert.equal(add(1, 2), add(1, 2));',
    ' });',
    ' const unrelated = 1;',
].join('\n');

// The inverse: the same file gains an assertion and loses nothing.
const TEST_ADD_HUNK = [
    'diff --git a/test/app.test.js b/test/app.test.js',
    'index 3333333..5555555 100644',
    '--- a/test/app.test.js',
    '+++ b/test/app.test.js',
    "@@ -10,3 +10,4 @@ const assert = require('assert');",
    " test('adds', () => {",
    '   assert.equal(add(1, 2), 3);',
    '+  assert.equal(add(2, 2), 4);',
    ' });',
].join('\n');

const edits = (r) => (r.result && Array.isArray(r.result.testEdits) ? r.result.testEdits : null);

try {
    // ---- acceptance 3: a src change plus one edited assert.equal line ----------
    let r = invoke(SRC_HUNK + '\n' + TEST_EDIT_HUNK + '\n');
    const e = edits(r);
    check('a code change plus one edited assert.equal line lists exactly that line',
        e && e.length === 1 && e[0].file === 'test/app.test.js' && e[0].line === 11
        && e[0].kind === 'assertion-removed' && e[0].text.trim() === 'assert.equal(add(1, 2), 3);', r.detail);
    check('  the population counts the test file touched and the one assertion line removed',
        r.result && r.result.testEditsPopulation && r.result.testEditsPopulation.testFilesTouched === 1
        && r.result.testEditsPopulation.codeFilesTouched === 1 && r.result.testEditsPopulation.assertionLinesRemoved === 1, r.detail);
    check('  it is advisory: the verdict stays READY and the exit stays 0', r.exit === 0 && r.result && r.result.verdict === 'READY', r.detail);

    // The control for "advisory": the same PR with no test edit exits the same.
    const clean = invoke(SRC_HUNK + '\n');
    check('the same PR with no test edit lists nothing and exits the same', edits(clean) && edits(clean).length === 0 && clean.exit === r.exit, clean.detail);

    // The text report carries the section with file:line and the old text.
    const text = invoke(SRC_HUNK + '\n' + TEST_EDIT_HUNK + '\n', { json: false });
    check('the text report prints TEST-EDITS 1 with file:line and the old text',
        /TEST-EDITS 1\b/.test(text.stdout) && text.stdout.includes('test/app.test.js:11') && text.stdout.includes('assert.equal(add(1, 2), 3);'), text.detail);
    check('  and prints the population it read', /1 test file\(s\) touched/.test(text.stdout) && /1 assertion line\(s\) removed/.test(text.stdout), text.detail);

    // ---- acceptance 3, inverse: an assertion only added -------------------------
    r = invoke(SRC_HUNK + '\n' + TEST_ADD_HUNK + '\n');
    check('the same diff with the assertion only ADDED lists nothing', edits(r) && edits(r).length === 0, r.detail);
    check('  while the population still saw the test file', r.result && r.result.testEditsPopulation && r.result.testEditsPopulation.testFilesTouched === 1, r.detail);

    // ---- acceptance 3, test-only ------------------------------------------------
    r = invoke(TEST_EDIT_HUNK + '\n');
    check('a test-only diff lists nothing, even with an assertion edited', edits(r) && edits(r).length === 0, r.detail);
    check('  and says it is test-only rather than reading as a clean scan',
        r.result && r.result.testEditsPopulation && r.result.testEditsPopulation.testOnly === true
        && r.result.testEditsPopulation.assertionLinesRemoved === 1, r.detail);

    // ---- the other shapes: deleted file, skip added, the repo's own vocabulary ----
    const DELETED = [
        'diff --git a/src/__tests__/math.spec.ts b/src/__tests__/math.spec.ts',
        'deleted file mode 100644',
        'index 6666666..0000000',
        '--- a/src/__tests__/math.spec.ts',
        '+++ /dev/null',
        '@@ -1,3 +0,0 @@',
        "-it('multiplies', () => {",
        '-  expect(mul(2, 3)).toBe(6);',
        '-});',
    ].join('\n');
    r = invoke(SRC_HUNK + '\n' + DELETED + '\n');
    const del = edits(r) || [];
    check('a test file deleted outright is listed as one file-deleted entry',
        del.filter((x) => x.kind === 'file-deleted' && x.file === 'src/__tests__/math.spec.ts').length === 1, r.detail);
    check('  and its assertion lines are not listed a second time', del.filter((x) => x.kind === 'assertion-removed').length === 0, r.detail);

    const SKIP = [
        'diff --git a/tests/flow.test.js b/tests/flow.test.js',
        'index 7777777..8888888 100644',
        '--- a/tests/flow.test.js',
        '+++ b/tests/flow.test.js',
        '@@ -4,3 +4,3 @@',
        ' ',
        "-test('logs in', async () => {",
        "+test.skip('logs in', async () => {",
        '   await login();',
    ].join('\n');
    r = invoke(SRC_HUNK + '\n' + SKIP + '\n');
    const sk = edits(r) || [];
    check('an added .skip is listed at its new line', sk.some((x) => x.kind === 'skip-added' && x.file === 'tests/flow.test.js' && x.line === 5), r.detail);

    // This repo's suites assert with check(label, cond): 6748 lines across 173
    // suites on 2026-10-02, against 141 assert lines. A detector blind to it is
    // blind to this repo.
    const OWN = [
        'diff --git a/tooling/test-thing.js b/tooling/test-thing.js',
        'index 9999999..aaaaaaa 100644',
        '--- a/tooling/test-thing.js',
        '+++ b/tooling/test-thing.js',
        '@@ -20,3 +20,2 @@',
        " const r = run(['x']);",
        "-check('x exits 0', r.status === 0, r.stderr);",
        ' cleanup();',
    ].join('\n');
    r = invoke(SRC_HUNK + '\n' + OWN + '\n');
    check('a removed check(...) line in tooling/test-*.js is listed', (edits(r) || []).some((x) => x.file === 'tooling/test-thing.js' && x.line === 21), r.detail);

    // A removed line in a test file that asserts nothing is not flagged.
    const PLAIN = [
        'diff --git a/test/app.test.js b/test/app.test.js',
        'index 3333333..bbbbbbb 100644',
        '--- a/test/app.test.js',
        '+++ b/test/app.test.js',
        '@@ -13,2 +13,1 @@',
        ' });',
        '-const unrelated = 1;',
    ].join('\n');
    r = invoke(SRC_HUNK + '\n' + PLAIN + '\n');
    check('a removed test-file line with no assertion is not listed', edits(r) && edits(r).length === 0, r.detail);

    // ---- gh pr diff failing is "could not tell", never an empty clean list ----
    r = invoke(null);
    check('a failed gh pr diff gives testEdits null, not an empty list', r.result && r.result.testEdits === null, r.detail);
    check('  and leaves the verdict and exit alone', r.exit === 0 && r.result && r.result.verdict === 'READY', r.detail);
    const t2 = invoke(null, { json: false });
    check('  and the text report says it could not read the diff', /TEST-EDITS could not tell/.test(t2.stdout), t2.detail);
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
