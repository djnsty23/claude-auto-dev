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

function run(argv) {
    const r = spawnSync(process.execPath, [SUBJECT].concat(argv), { encoding: 'utf8' });
    return { r, out: (r.stdout || '') + (r.stderr || '') };
}
// No origin here, so --base names the trunk explicitly.
const forBranch = (extra) => run(['--repo', REPO, '--branch', 'worker', '--base', 'main'].concat(extra));

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

// -------------------------------------------------------------------- report

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* leave it */ }

const total = passed + failures.length;
if (failures.length) {
    console.error(`check-assignment: ${passed}/${total} passed, ${failures.length} FAILED\n`);
    for (const f of failures) console.error('  x ' + f);
    process.exit(1);
}
console.log(`check-assignment: ${passed}/${total} passed — redundant, stale, clear, partial, and every could-not-check route`);
