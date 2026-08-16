#!/usr/bin/env node
// check-suites-can-fail.js — does each test suite actually fail when the thing
// it tests is broken?
//
// This repo keeps writing the rule "a gate nobody has watched fire is a
// hypothesis" and then hand-canarying one change at a time. This runs the check
// for every suite at once, so a suite that quietly stops testing anything gets
// caught the day it happens rather than the day someone happens to try.
//
// It is not subtle. For each suite it finds the source file(s) that suite
// exercises, replaces each with a STUB that still parses and still exports the
// right shape but does nothing, and asserts the suite goes red. A suite that
// stays green against a stub is testing nothing.
//
// This is the coarsest possible mutation: if a suite survives it, no finer
// mutation will find anything either. It is deliberately not full mutation
// testing — that is slow, noisy, and the failure this repo has actually hit
// twice was total (a signature mismatch that made every suite spawn a bare
// `node`, and a binary-file guard written as `includes(' ')`).
//
// Every file is restored from git afterwards and the tree is verified clean.
//
// Usage: node tooling/check-suites-can-fail.js [--verbose]

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

// Which source file each suite is the test for. Explicit, because inferring it
// from the name is exactly the kind of guess that produces a vacuous check.
// A suite with no entry is reported as UNMAPPED rather than silently skipped.
const SUBJECTS = {
    'test-drift-audit.js': ['plugins/autodev-core/scripts/drift-audit.js'],
    'test-orphan-checks.js': ['plugins/autodev-core/scripts/find-orphan-checks.js'],
    'test-stop-auto-check.js': ['plugins/autodev-core/hooks/stop-auto-check.js'],
    'test-inbox.js': ['plugins/autodev-core/hooks/inbox-notify.js', 'plugins/autodev-core/scripts/inbox-watch.js'],
    'test-pre-tool-filter.js': ['plugins/autodev-core/hooks/pre-tool-filter.js'],
    'test-image-scan-hook.js': ['plugins/autodev-core/hooks/user-prompt-image-scan.js'],
    'test-session-start-hook.js': ['plugins/autodev-core/hooks/session-start.js'],
    'test-session-carrier.js': ['plugins/autodev-memory/scripts/session-carrier.js'],
    'test-knowledge.js': ['plugins/autodev-memory/scripts/knowledge.js'],
    'test-knowledge-injection.js': ['plugins/autodev-memory/hooks/memory-inject.js'],
    'test-semantic-search.js': ['plugins/autodev-memory/scripts/semantic-search.js'],
    'test-preflight-template.js': ['plugins/autodev-core/templates/preflight.js'],
};

// A stub that parses, runs, exits 0, and does nothing. Anything a suite asserts
// about behaviour has to fail against this.
const STUB = `#!/usr/bin/env node
// STUB installed by check-suites-can-fail.js — restored immediately.
module.exports = {};
process.exit(0);
`;

const git = (args) => execSync('git ' + args, { cwd: ROOT, encoding: 'utf8' });

// Refuse to run on a dirty tree: this script writes stubs over real files and
// restores them with `git checkout --`, which would destroy uncommitted work.
const dirty = git('status --porcelain').trim();
if (dirty) {
    console.error('\nRefusing to run: the working tree has uncommitted changes.\n');
    console.error('This script overwrites source files with stubs and restores them from git,');
    console.error('which would discard your edits. Commit or stash first.\n');
    console.error(dirty.split('\n').slice(0, 10).join('\n'));
    process.exit(2);
}

const suites = fs.readdirSync(__dirname)
    .filter((f) => /^test-.*\.js$/.test(f))
    .sort();

const runSuite = (suite) => spawnSync(process.execPath, [path.join(__dirname, suite)], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000,
});

const rows = [];

for (const suite of suites) {
    const subjects = SUBJECTS[suite];
    if (!subjects) { rows.push({ suite, status: 'UNMAPPED', note: 'no subject recorded — add one to SUBJECTS' }); continue; }

    const missing = subjects.filter((s) => !fs.existsSync(path.join(ROOT, s)));
    if (missing.length) { rows.push({ suite, status: 'STALE', note: `subject missing: ${missing.join(', ')}` }); continue; }

    // Baseline: it must be green before the mutation means anything.
    if (runSuite(suite).status !== 0) {
        rows.push({ suite, status: 'RED', note: 'already failing — fix it before trusting this result' });
        continue;
    }

    const survived = [];
    for (const rel of subjects) {
        const full = path.join(ROOT, rel);
        const original = fs.readFileSync(full);
        try {
            fs.writeFileSync(full, STUB);
            if (runSuite(suite).status === 0) survived.push(rel);
        } finally {
            fs.writeFileSync(full, original);
        }
    }

    rows.push(survived.length
        ? { suite, status: 'VACUOUS', note: `passes with ${survived.join(', ')} stubbed out` }
        : { suite, status: 'ok', note: `fails when any of ${subjects.length} subject(s) is stubbed` });
}

// The restore is the dangerous part; prove it worked rather than assuming.
const after = git('status --porcelain').trim();
if (after) {
    console.error('\nFILES NOT RESTORED — restoring from git:\n' + after);
    git('checkout -- .');
    const still = git('status --porcelain').trim();
    if (still) { console.error('STILL DIRTY:\n' + still); process.exit(2); }
}

console.log('\nCan each suite fail?\n');
let bad = 0;
for (const r of rows) {
    const mark = r.status === 'ok' ? '✓' : r.status === 'UNMAPPED' ? '·' : '✗';
    if (r.status === 'VACUOUS' || r.status === 'RED') bad++;
    console.log(`  ${mark} ${r.suite.padEnd(30)} ${r.status.padEnd(9)} ${VERBOSE || r.status !== 'ok' ? r.note : ''}`);
}
const unmapped = rows.filter((r) => r.status === 'UNMAPPED').length;
console.log(`\n${rows.length} suite(s) · ${bad} cannot fail or are already red · ${unmapped} unmapped · tree restored clean\n`);
process.exit(bad ? 1 : 0);
