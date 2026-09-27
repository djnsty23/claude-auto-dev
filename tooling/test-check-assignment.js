#!/usr/bin/env node
'use strict';
// Suite for check-assignment.js.
//
// The case it exists for: a brief that is TRUE of the base it was audited from
// and FALSE on the branch that would do the work. [measured 2026-08-28] a
// coordinator audited origin/main, found a price rendered from `priceUsd` while
// the charge was in EUR, and assigned the fix to a branch that had already made
// it. The audit was not wrong; it was stale relative to the target.
//
// Three verdicts must stay distinguishable — CLEAR (0), REDUNDANT/STALE (3), and
// COULD-NOT-CHECK (2). A checker that reports COULD-NOT-CHECK as clear rebuilds
// the failure it was written to prevent.
//
// Run: node tooling/test-check-assignment.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-assignment.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'check-assignment-'));
const REPO = path.join(ROOT, 'repo');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail ? '\n      -> ' + String(detail).slice(0, 300) : ''));
}

function git(args, cwd = REPO) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const write = (rel, body) => {
    const p = path.join(REPO, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, 'utf8');
};

// ---- a repo with a trunk and a branch that has moved past it ----
fs.mkdirSync(REPO, { recursive: true });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 'suite@example.invalid']);
git(['config', 'user.name', 'suite']);
write('src/plans.ts', 'export const priceUsd = 10;\n');
write('src/card.tsx', 'render(priceUsd);\n');
write('README.md', '# readme\n');
git(['add', '-A']); git(['commit', '-q', '-m', 'base']);

// The branch does the work the coordinator is about to assign.
git(['checkout', '-q', '-b', 'worker']);
write('src/plans.ts', 'export const priceEur = 10; // renamed away from the old name\n');
write('src/card.tsx', 'render(formatPrice(priceEur));\n');
git(['add', '-A']); git(['commit', '-q', '-m', 'rename to eur']);
git(['checkout', '-q', 'main']);

function run(argv, env) {
    const r = spawnSync(process.execPath, [SUBJECT].concat(argv), { encoding: 'utf8', env: env || process.env });
    return { r, out: (r.stdout || '') + (r.stderr || '') };
}
// No origin here, so --base names the trunk explicitly.
const forBranch = (extra, env) => run(['--repo', REPO, '--branch', 'worker', '--base', 'main'].concat(extra), env);

// ------------------------------------------------- THE CASE THIS EXISTS FOR

{
    const { r, out } = forBranch(['--files', 'src/plans.ts,src/card.tsx']);
    check('every named file already touched => LIKELY REDUNDANT', /LIKELY REDUNDANT/.test(out), out);
    check('and it exits 3, not 0', r.status === 3, 'status ' + r.status);
    check('and it names the files rather than just counting them',
        /src\/plans\.ts/.test(out) && /src\/card\.tsx/.test(out), out);
    check('and shows how much changed, so a reader can judge',
        /\(\+\d+ -\d+\)/.test(out), out);
}

{
    // The premise check, on a symbol the branch genuinely removed.
    const { r, out } = forBranch(['--expect', 'priceUsd']);
    check('a symbol the branch removed => STALE', /LIKELY STALE/.test(out), out);
    check('and exits 3', r.status === 3, 'status ' + r.status);
    check('and says the audit was probably right about the WRONG base',
        /right about the base/.test(out.replace(/\s+/g, ' ')), out);
}

// --------------------------------------------------- the known-positive side
//
// Without these, everything above passes against a checker that always says
// REDUNDANT.

{
    const { r, out } = forBranch(['--files', 'README.md']);
    check('an untouched file => CLEAR', /^CLEAR/m.test(out), out);
    check('and exits 0', r.status === 0, 'status ' + r.status);
    check('and CLEAR is scoped, not a claim nobody is working on it',
        /not a claim that/.test(out.replace(/\s+/g, ' ')), out);
}

{
    const { r, out } = forBranch(['--expect', 'priceEur']);
    check('a symbol the branch DOES have => not stale', !/LIKELY STALE/.test(out), out);
    check('and exits 0', r.status === 0, 'status ' + r.status);
    check('and it prints WHERE it matched, because a grep cannot tell code from a comment',
        /appears in \d+ file\(s\)/.test(out) && /src\/plans\.ts/.test(out), out);
    check('and warns that a removal note still matches',
        /describing its REMOVAL/.test(out), out);
}

{
    // A partial hit is not redundant. Treating "some files touched" as done is
    // how a real assignment gets dropped.
    const { r, out } = forBranch(['--files', 'src/plans.ts,README.md']);
    check('one touched, one untouched => CLEAR, not redundant', r.status === 0, out);
    check('and it still reports the touched one', /ALREADY TOUCHED\s+src\/plans\.ts/.test(out), out);
}

// ------------------------------------------- COULD NOT CHECK is never CLEAR

{
    const { r, out } = run(['--repo', REPO, '--branch', 'no-such-branch', '--files', 'README.md']);
    check('an unknown branch exits 2', r.status === 2, 'status ' + r.status);
    check('and says explicitly it is NOT clear to assign', /NOT "clear to assign"/.test(out), out);
    check('and does not print a CLEAR verdict', !/^CLEAR/m.test(out), out);
}

{
    const { r, out } = run(['--repo', path.join(ROOT, 'not-a-repo'), '--branch', 'worker']);
    check('a non-repo exits 2', r.status === 2, 'status ' + r.status);
    check('and says it is NOT clear to assign', /NOT "clear to assign"/.test(out), out);
}

{
    const { r, out } = run(['--repo', REPO, '--branch', 'worker', '--base', 'main']);
    check('no --files and no --expect exits 2, not 0', r.status === 2, 'status ' + r.status);
    check('and says a check with no premise checks nothing',
        /checks nothing/.test(out.replace(/\s+/g, ' ')), out);
}

{
    const { r } = run(['--repo', REPO]);
    check('a missing --branch is refused', r.status === 2, 'status ' + r.status);
}

// ------------------------------------- A FAILED git CALL IS NOT AN EMPTY ONE
//
// The wrapper was `catch { return null; }`, and the premise check read null as
// "git printed nothing". So a grep that died printed `STALE "<sym>" is NOT on
// that branch` and exited 3 for a symbol that IS on it, and a diff that died
// made every named file "untouched" and exited 0, CLEAR.
//
// Real failures of the real git binary, each beside a control that shows the
// same question answering while git works:
//   1. `git grep` exits 128. GIT_CONFIG_* sets grep.threads=-1, which only grep
//      reads, so the ref lookup and the diff before it still answer. A PATH
//      shim is not an option: Windows resolves a bare `git` to .com or .exe only.
//   2. `git grep` exits 0 or 1 because an object it had to read is gone.
//      [measured git 2.54] it says so on stderr and nowhere else.
//   3. `git merge-base` exits 128 on a --base that does not resolve.
//   4. git cannot be started at all (ENOENT).

const grepDies = Object.assign({}, process.env,
    { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'grep.threads', GIT_CONFIG_VALUE_0: '-1' });

{
    // The control for this premise is 'a symbol the branch DOES have' above.
    const { r, out } = forBranch(['--expect', 'priceEur'], grepDies);
    check('a git grep that exits 128 on a present symbol is not STALE', !/STALE/.test(out), out);
    check('...and exits 2, "could not check", not 3', r.status === 2, 'status ' + r.status);
    // git localises its messages, so the assertions key on what it cannot
    // translate: the status, and the config key it names.
    check('...naming git\'s exit status and its own error',
        /git grep exited 128/.test(out) && /grep\.threads/.test(out), out);
    check('...and never says CLEAR', !/^CLEAR/m.test(out), out);
}

{
    // Absent for real, so the old reading was right by accident. It still
    // cannot be concluded from a search that did not run.
    const { r, out } = forBranch(['--expect', 'priceUsd'], grepDies);
    check('a git grep that exits 128 on an absent symbol is not STALE either', !/STALE/.test(out) && r.status === 2, out);
}

{
    // The files half answers while the premise half cannot: the redundant
    // verdict is still true of what was checked, and it names what was not.
    const { r, out } = forBranch(['--files', 'src/plans.ts,src/card.tsx', '--expect', 'priceEur'], grepDies);
    check('a finding from the files half survives a failed premise', /LIKELY REDUNDANT/.test(out) && r.status === 3, out);
    check('...and says one of the three could NOT be checked', /1 of the 3 could NOT be checked/.test(out), out);
}

{
    const loose = path.join(ROOT, 'loose');
    fs.mkdirSync(loose);
    git(['init', '-q', '-b', 'main'], loose);
    git(['config', 'user.email', 'suite@example.invalid'], loose);
    git(['config', 'user.name', 'suite'], loose);
    fs.mkdirSync(path.join(loose, 'src'));
    fs.writeFileSync(path.join(loose, 'src', 'readable.ts'), 'export const STILL_HERE = 1;\n');
    fs.writeFileSync(path.join(loose, 'src', 'unreadable.ts'), 'export const LOST = 1; // STILL_HERE\n');
    git(['add', '-A'], loose); git(['commit', '-q', '-m', 'base'], loose);
    const at = (extra) => run(['--repo', loose, '--branch', 'main', '--base', 'main'].concat(extra));

    const control = at(['--expect', 'LOST']);
    check('control: LOST reads present while its object is readable', control.r.status === 0, control.out);

    const sha = git(['rev-parse', 'main:src/unreadable.ts'], loose).trim();
    const obj = path.join(loose, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
    fs.chmodSync(obj, 0o644); // git writes loose objects read-only, and Windows will not unlink one
    fs.unlinkSync(obj);
    const gone = spawnSync('git', ['-C', loose, 'cat-file', '-e', sha]);
    check('fixture check: git really cannot read the object', gone.status !== 0, 'status ' + gone.status);

    const lost = at(['--expect', 'LOST']);
    check('a grep that could not read an object is not STALE (it exits 1)', !/STALE/.test(lost.out) && lost.r.status === 2, lost.out);
    check('...naming the object git could not read', lost.out.includes(sha), lost.out);
    // Exits 0: it matched src/readable.ts. The search still skipped a file.
    const partial = at(['--expect', 'STILL_HERE']);
    check('a partial match over an unreadable tree is not CLEAR (it exits 0)', !/^CLEAR/m.test(partial.out) && partial.r.status === 2, partial.out);
}

{
    const control = forBranch(['--files', 'README.md']);
    check('control: README.md reads untouched against a real base', control.r.status === 0, control.out);
    const { r, out } = run(['--repo', REPO, '--branch', 'worker', '--base', 'no-such-base', '--files', 'README.md']);
    check('a diff against a base that does not resolve is not "untouched"', !/untouched/.test(out), out);
    check('...and not CLEAR: it exits 2', r.status === 2 && !/^CLEAR/m.test(out), 'status ' + r.status + '\n' + out);
    check('...naming git\'s error and the base it could not resolve',
        /git merge-base exited 128/.test(out) && /no-such-base/.test(out), out);
}

{
    const noGit = {};
    for (const k of Object.keys(process.env)) if (k.toUpperCase() !== 'PATH') noGit[k] = process.env[k];
    noGit.PATH = path.join(ROOT, 'no-git-here');
    fs.mkdirSync(noGit.PATH);
    const { r, out } = forBranch(['--expect', 'priceEur'], noGit);
    check('when git cannot be started, the run exits 2', r.status === 2, 'status ' + r.status);
    check('...naming the spawn error, not "branch not found"',
        /ENOENT/.test(out) && !/not found locally/.test(out), out);
}

// -------------------------------------------------------------------- report

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* leave it */ }

const total = passed + failures.length;
if (failures.length) {
    console.error(`check-assignment: ${passed}/${total} passed, ${failures.length} FAILED\n`);
    for (const f of failures) console.error('  x ' + f);
    process.exit(1);
}
console.log(`check-assignment: ${passed}/${total} passed — redundant, stale, clear, partial, every could-not-check route, and four real git failures`);
