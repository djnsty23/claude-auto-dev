#!/usr/bin/env node
'use strict';
// Tests for tooling/check-suites-can-fail.js: what the sweep PRINTS when a
// baseline run is already red.
//
// WHY THIS SUITE EXISTS. `[measured 2026-09-21]` a full gate on PR #276 went red
// at step 2 with `✗ test-artifact-write-guard.js RED already failing`, although
// the same suite had passed in step 1 of the same run, and re-running the sweep
// at the same head passed it three times of three. The sweep had the failing
// child's stdout and stderr in hand and printed neither, so the one run that
// failed is the one run nobody can read. The timeout path learned this on
// 2026-09-10 (completed() spends a killed child's output on evidence); the
// RED-baseline rows never did.
//
// HOW. The sweep cannot be required: it resolves HEAD and creates a worktree at
// load. So this suite RUNS it, end to end, in a throwaway git repository under
// the OS temp root. The sweep and every module it requires are copied byte for
// byte into that repository beside planted suites this file wrote, so the text
// they print is known exactly and cannot come from anywhere else.
//
// Two repositories, two runs:
//   · CONTROL: everything green. The sweep must exit 0 and print NONE of the
//     planted output, including the red a stubbed subject provokes, because a
//     stub-killed run is the expected red and is not evidence of anything.
//   · RED: a validate.js and a suite that both fail at baseline. The rows and the
//     exit code must be exactly what they were before this evidence existed, and
//     the children's own last lines must reach the sweep's output, bounded.
//
// Every expected string below is a literal this file planted. None is read from
// the sweep's own source, so narrowing what the sweep prints cannot narrow what
// this suite demands in the same edit.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sb = require('./spawn-budget.js');

const TOOLING = __dirname;
const SWEEP = path.join(__dirname, 'check-suites-can-fail.js');
const BUDGET_MS = 120000;

let pass = 0, fail = 0, infra = 0;
const failures = [];
function check(label, ok, detail) {
    if (ok) pass++; else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : '  (' + detail + ')'}`);
}

// The sweep plus the closure of its relative requires, read from the source
// rather than listed, so a module the sweep starts requiring tomorrow is copied
// too instead of failing this suite for a reason unrelated to its claim. The
// regex also matches requires written inside COMMENTS (the sweep's own prose
// names `./check-foo.js` as an example), so only files that exist are followed:
// copying one extra real module is harmless, and a missing one is not a module.
function sweepModules() {
    const seen = new Set();
    const walk = (name) => {
        if (seen.has(name) || !fs.existsSync(path.join(TOOLING, name))) return;
        seen.add(name);
        const src = fs.readFileSync(path.join(TOOLING, name), 'utf8');
        for (const m of src.matchAll(/require\(['"]\.\/([\w.-]+\.js)['"]\)/g)) walk(m[1]);
    };
    walk(path.basename(SWEEP));
    return [...seen];
}

const SUBJECT = 'module.exports = { answer: () => 42 };\n';

// Passes at baseline, fails when its subject is stubbed: an 'ok' row.
const GREEN_SUITE = [
    "const s = require(require('path').join(__dirname, '..', 'plugins', 'demo', 'subject.js'));",
    "if (typeof s.answer === 'function' && s.answer() === 42) { console.log('G-PASS.'); process.exit(0); }",
    "console.log('G-FAIL.'); process.exit(1);",
    '',
].join('\n');

// Red at baseline, with more stdout lines than any sane bound, one of them far
// too long to print whole, and an exit status no other path produces.
const RED_SUITE = [
    "require(require('path').join(__dirname, '..', 'plugins', 'demo', 'subject.js'));",
    "for (let i = 1; i <= 49; i++) console.log('R-OUT-' + String(i).padStart(3, '0') + '.');",
    "console.log('R-OUT-050.' + 'x'.repeat(20000));",
    "console.error('R-ERR-1.'); console.error('R-ERR-2.'); console.error('R-ERR-3.');",
    'process.exit(3);',
    '',
].join('\n');

// validate.js is checked on its own path (checkValidator), with its own RED row.
const GREEN_VALIDATE = [
    "const v = require('fs').readFileSync(require('path').join(__dirname, '..', 'VERSION'), 'utf8').trim();",
    "if (v === '0.0.0-canary') { console.log('V-CANARY-FIRED.'); process.exit(1); }",
    "console.log('V-BASELINE.');",
    '',
].join('\n');

// Writes to stderr only, so an empty stdout is part of what is reported.
const RED_VALIDATE = "console.error('V-RED-ERR-1.'); console.error('V-RED-ERR-2.'); process.exit(1);\n";

function makeRepo(label, files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suites-red-evidence-' + label + '-'));
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    git('init', '-q');
    git('config', 'user.name', 'suite');
    git('config', 'user.email', 'suite@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', path.join(dir, 'no-hooks'));
    for (const name of sweepModules()) {
        fs.mkdirSync(path.join(dir, 'tooling'), { recursive: true });
        fs.copyFileSync(path.join(TOOLING, name), path.join(dir, 'tooling', name));
    }
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text, 'utf8');
    }
    git('add', '--', '.');
    const c = git('commit', '-q', '-m', 'fixture');
    // Fixture context, not just contents: a repo that silently failed to commit,
    // or that resolved to an ancestor checkout, would make every assertion below
    // about the wrong tree.
    const top = git('rev-parse', '--show-toplevel').stdout.trim();
    const canon = (p) => { const r = fs.realpathSync.native(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
    const clean = git('status', '--porcelain').stdout.trim();
    check(`${label}: the fixture is its own committed, clean repository`,
        c.status === 0 && top && canon(top) === canon(dir) && clean === '',
        `commit ${c.status}, toplevel ${top ? 'differs' : 'missing'}, dirty ${JSON.stringify(clean.slice(0, 80))}`);
    return dir;
}

// --help must answer before any work. `[measured 2026-09-24]` it fell through to
// the full sweep: 150 s and a check-suites-wt-* worktree before a kill by pid.
// check:entrypoints could not see that, because its scratch copy has no .git
// and the sweep died at its first git call. So this runs --help inside a real,
// clean, committed repository, where a fall-through DOES sweep, and plants a
// suite that records where it ran and then outlasts the budget. A sweep that
// ignores --help therefore trips every check below: it is killed at the budget,
// prints no usage, leaves a registered worktree, and the marker names it.
const HELP_BUDGET_MS = 10000;   // what check-entrypoints.js grants every --help probe
const markerSuite = (marker) => [
    "require(require('path').join(__dirname, '..', 'plugins', 'demo', 'subject.js'));",
    `require('fs').appendFileSync(${JSON.stringify(marker)}, __dirname + '\\n');`,
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${HELP_BUDGET_MS + 1000});`,
    '',
].join('\n');

// Temp-root entries a sweep with this pid would have created.
const sweepDirsFor = (pid) => fs.readdirSync(os.tmpdir())
    .filter((d) => d.startsWith('check-suites-wt-' + pid + '-'))
    .map((d) => path.join(os.tmpdir(), d));

// Exit 2 is the sweep's INDETERMINATE, and on the CONTROL it stays
// infrastructure: a box that cannot create the private worktree says nothing
// about evidence. Once the control has produced a verdict, the environment is
// proven, so on the RED run exit 2 is a verdict: the fixture has no concurrent
// writer, and the one thing left that can turn two REDs into an indeterminate
// run is the sweep reporting its evidence as a conflict. Classified as
// infrastructure there, that regression exited this suite 2 and never reached
// the assertion written to catch it (measured by mutation while writing this).
function runSweep(dir, exit2IsVerdict) {
    const r = sb.runBudgeted(process.execPath, [path.join(dir, 'tooling', path.basename(SWEEP))], {
        cwd: dir, encoding: 'utf8', timeout: BUDGET_MS, windowsHide: true, input: '',
    });
    if (sb.classify(r, exit2IsVerdict ? 'exit2' : undefined) !== 'verdict') {
        infra++;
        console.log('INDETERMINATE  sweep run produced no verdict: ' + sb.reason(r) + ' ' + sb.lastWords(r, 300));
        return null;
    }
    return { code: r.status, all: (r.stdout || '') + '\n' + (r.stderr || '') };
}

const dirs = [];
try {
    // ---- HELP: usage, exit 0, and no sweep ----------------------------------
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suites-help-marker-'));
    dirs.push(markerDir);
    const marker = path.join(markerDir, 'ran-in.txt');
    const helpRepo = makeRepo('help', {
        'VERSION': '1.0.0\n',
        'tooling/validate.js': GREEN_VALIDATE,
        'plugins/demo/subject.js': SUBJECT,
        'tooling/test-planted-marker.js': markerSuite(marker),
    });
    dirs.push(helpRepo);
    for (const flag of ['--help', '-h']) {
        fs.rmSync(marker, { force: true });
        const t0 = Date.now();
        // No retry: a second full budget would only wait out a fall-through twice.
        const r = sb.runBudgeted(process.execPath, [path.join(helpRepo, 'tooling', path.basename(SWEEP)), flag], {
            cwd: helpRepo, encoding: 'utf8', timeout: HELP_BUDGET_MS, retryOnTimeout: false, windowsHide: true, input: '',
        });
        const ms = Date.now() - t0;
        const ranIn = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
        const registered = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: helpRepo, encoding: 'utf8' })
            .stdout.split('\n').filter((l) => l.startsWith('worktree ')).length;
        const leftover = r.pid ? sweepDirsFor(r.pid) : [];
        // A killed fall-through strands its worktree and exit handler; clear it
        // here, by the child's own pid, so a red run leaves nothing behind.
        dirs.push(...leftover);
        // Killed with no marker is a box too slow to start node, not a verdict.
        if (sb.timedOut(r) && !ranIn) {
            infra++;
            console.log(`INDETERMINATE  ${flag} produced no verdict: ${sb.reason(r)} ${sb.lastWords(r, 300)}`);
            continue;
        }
        check(`help: ${flag} returns inside the ${HELP_BUDGET_MS} ms entrypoint budget`, !sb.timedOut(r), ms + ' ms');
        check(`help: ${flag} exits 0`, r.status === 0, 'exit ' + r.status + ' signal ' + r.signal);
        check(`help: ${flag} prints usage naming the flags the sweep accepts`,
            /^usage: node tooling\/check-suites-can-fail\.js/m.test(r.stdout || '')
                && /--verbose/.test(r.stdout) && /--all-subjects/.test(r.stdout),
            JSON.stringify((r.stdout || '').slice(0, 200)));
        check(`help: ${flag} creates no check-suites-wt-* worktree`,
            !ranIn && registered === 1 && leftover.length === 0,
            `planted suite ran in ${JSON.stringify(ranIn)}, ${registered} worktree(s) registered, ${leftover.length} left under the temp root`);
    }

    // ---- CONTROL: every row green, nothing extra printed --------------------
    const control = makeRepo('control', {
        'VERSION': '1.0.0\n',
        'tooling/validate.js': GREEN_VALIDATE,
        'plugins/demo/subject.js': SUBJECT,
        'tooling/test-planted-green.js': GREEN_SUITE,
    });
    dirs.push(control);
    const c = runSweep(control, false);
    if (c) {
        // The positive half first: without it, "printed nothing" is also what a
        // sweep that ran nothing says.
        check('control: validate.js is verified able to fail',
            /✓ validate\.js\s/.test(c.all), c.all.slice(-600));
        check('control: the planted green suite is verified able to fail',
            /✓ test-planted-green\.js\s/.test(c.all), c.all.slice(-600));
        check('control: the summary counts both rows as verified',
            /2 suite\(s\) · 2 verified able to fail · 0 NOT verified/.test(c.all), c.all.slice(-400));
        check('control: the sweep exits 0', c.code === 0, 'exit ' + c.code);
        const leaked = ['G-PASS.', 'G-FAIL.', 'V-BASELINE.', 'V-CANARY-FIRED.'].filter((s) => c.all.includes(s));
        check('control: no child output is printed, not even the red a stubbed subject provokes',
            leaked.length === 0, 'printed: ' + leaked.join(', '));
    }

    // ---- RED: two baselines fail, and each says why --------------------------
    const red = makeRepo('red', {
        'VERSION': '1.0.0\n',
        'tooling/validate.js': RED_VALIDATE,
        'plugins/demo/subject.js': SUBJECT,
        'tooling/test-planted-green.js': GREEN_SUITE,
        'tooling/test-planted-red.js': RED_SUITE,
    });
    dirs.push(red);
    const r = c ? runSweep(red, true) : null;
    if (r) {
        // The verdict is unchanged: the same rows, the same summary, exit 1 and
        // not 2. Evidence must never turn a finding into an indeterminate run.
        check('red: the suite row is exactly the RED row it always was',
            /✗ test-planted-red\.js\s+RED\s+already failing — fix it before trusting this result\n/.test(r.all),
            r.all.slice(-800));
        check('red: the validate.js row is exactly the RED row it always was',
            /✗ validate\.js\s+RED\s+already failing\n/.test(r.all), r.all.slice(-800));
        check('red: the summary still counts both REDs as not verified',
            /3 suite\(s\) · 1 verified able to fail · 2 NOT verified/.test(r.all), r.all.slice(-400));
        check('red: the sweep exits 1, a finding, not 2', r.code === 1, 'exit ' + r.code);
        check('red: no mid-sweep conflict was raised by reporting the evidence',
            !r.all.includes('INDETERMINATE') && !r.all.includes('[CONFLICT]'), r.all.slice(-600));

        // The evidence itself.
        check('red: the suite\'s exit status is reported', /test-planted-red\.js[^\n]*exited 3/.test(r.all),
            r.all.slice(0, 600));
        check('red: validate.js\'s exit status is reported', /validate[^\n]*exited 1/.test(r.all),
            r.all.slice(0, 600));
        const want = ['R-OUT-011.', 'R-OUT-049.', 'R-OUT-050.', 'R-ERR-1.', 'R-ERR-2.', 'R-ERR-3.', 'V-RED-ERR-1.', 'V-RED-ERR-2.'];
        const missing = want.filter((s) => !r.all.includes(s));
        check('red: the last stdout lines and every stderr line of both children reach the output',
            missing.length === 0, 'missing: ' + missing.join(', '));

        // Bounded, and bounded to the TAIL: the first ten of fifty lines fall off.
        const early = ['R-OUT-001.', 'R-OUT-010.'].filter((s) => r.all.includes(s));
        check('red: stdout is bounded to its last 40 lines', early.length === 0, 'printed: ' + early.join(', '));
        const longest = Math.max(...r.all.split('\n').map((l) => l.length));
        check('red: one 20,000-character line is clipped rather than printed whole',
            longest < 2000, 'longest line ' + longest);

        // The green suite beside them stays silent in the same run.
        const leaked = ['G-PASS.', 'G-FAIL.'].filter((s) => r.all.includes(s));
        check('red: the green suite in the same run prints nothing extra', leaked.length === 0,
            'printed: ' + leaked.join(', '));
    }
} finally {
    for (const d of dirs) {
        try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp root */ }
    }
}

console.log(`\n${pass} passed, ${fail} failed${infra ? `, ${infra} indeterminate` : ''}`);
if (fail) console.log('Failed: ' + failures.join(' | '));
process.exitCode = fail ? 1 : (infra ? 2 : 0);
