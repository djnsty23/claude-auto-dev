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

// DERIVED, not declared. The first version of this file hand-listed which source
// each suite tests, and got it wrong for three of twelve — twice producing a
// STALE row pointing at a file that does not exist, and once accusing a suite of
// being vacuous when the accusation was really "you mapped me to a file I never
// touch". A map of guesses is exactly the failure this script exists to find,
// one level up.
//
// So: read what the suite actually references. Every suite in this repo names
// its subject as a path literal — `hooks/stop-auto-check.js`,
// `'..','plugins','autodev-memory','hooks','memory-capture.js'`, or a require of
// a relative path. Collect all three shapes and resolve them against the repo.
const SUBJECT_OVERRIDES = {
    // Only for a suite whose subject genuinely cannot be read off its source.
    //
    // Derivation looks for plugin sources, because that is what every suite
    // tested until now. These two test TOOLING instead — a shell hook and the
    // validator — so they derived nothing and were reported NO-SUBJECT, which
    // means this script was silently not checking them at all. That is the
    // "silent skip" failure this whole file exists to prevent, reappearing in it.
    'test-githooks.js': ['tooling/githooks/commit-msg'],
    'test-validate.js': ['tooling/validate.js'],

    // Same failure, found again 2026-08-21 — and found by reading this comment
    // rather than the output, because NO-SUBJECT's note ("references no plugin
    // source — nothing to stub") reads like a category of suite that has nothing
    // to check. It is not. It is the silent-skip signature, and three more
    // tooling suites were sitting behind it, unverified, while the summary line
    // said "0 cannot fail".
    //
    // If you add a suite over anything in tooling/, it lands here or it is not
    // checked at all. deriveSubjects() only scans plugins/ and templates/.
    'test-runner-guard.js': ['tooling/test-all.js'],
    'test-superseded.js': ['tooling/check-superseded.js'],
    'test-version-drift.js': ['tooling/check-version-drift.js'],
};

function deriveSubjects(suiteFile) {
    const src = fs.readFileSync(suiteFile, 'utf8');
    const found = new Set();

    // 1. A slash-separated path literal inside the repo: 'plugins/…/foo.js'
    for (const m of src.matchAll(/['"`]((?:\.\.\/)*(?:plugins|templates)\/[\w./-]+\.js)['"`]/g)) {
        found.add(m[1].replace(/^(\.\.\/)+/, ''));
    }
    // 2. path.join / path.resolve segment lists: 'plugins', 'autodev-core', 'hooks', 'x.js'
    for (const m of src.matchAll(/path\.(?:join|resolve)\(([^)]*)\)/g)) {
        const parts = [...m[1].matchAll(/['"`]([\w.-]+)['"`]/g)].map((x) => x[1]);
        const i = parts.indexOf('plugins');
        if (i >= 0 && parts[parts.length - 1].endsWith('.js')) {
            found.add(parts.slice(i).join('/'));
        }
    }
    // 3. A bare require of a repo-relative module, with or without .js
    for (const m of src.matchAll(/require\(['"`]((?:\.\.\/)+[\w./-]+)['"`]\)/g)) {
        const p = m[1].replace(/^(\.\.\/)+/, '');
        if (/^(plugins|templates)\//.test(p)) found.add(p.endsWith('.js') ? p : p + '.js');
    }

    // 4. A bare BASENAME, for suites that build the path in two steps:
    //      const PLUGIN_ROOT = path.resolve(__dirname, '..', 'plugins', 'autodev-core');
    //      const HOOK        = path.join(PLUGIN_ROOT, 'hooks', 'stop-auto-check.js');
    //    Rules 1-3 see neither half. Four of twelve suites are written this way,
    //    and without this they derive nothing and get waved through as
    //    NO-SUBJECT — the silent-skip failure this whole script is about.
    //
    //    Safe because it demands a UNIQUE match: a basename resolving to two
    //    files under plugins/ is ambiguous and ignored rather than guessed.
    for (const m of src.matchAll(/['"`]([\w-]+\.js)['"`]/g)) {
        const hits = allPluginFiles().filter((p) => path.basename(p) === m[1]);
        if (hits.length === 1) found.add(hits[0]);
    }

    return [...found].filter((p) => fs.existsSync(path.join(ROOT, p)));
}

let _pluginFiles = null;
function allPluginFiles() {
    if (_pluginFiles) return _pluginFiles;
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const rel = dir + '/' + e.name;
            if (e.isDirectory()) walk(rel);
            else if (e.name.endsWith('.js')) out.push(rel);
        }
    };
    for (const top of ['plugins']) {
        if (fs.existsSync(path.join(ROOT, top))) walk(top);
    }
    return (_pluginFiles = out);
}

// A stub that parses, does nothing, and exports nothing.
//
// NO process.exit() — the first version had one, and it made this checker lie.
// A suite that `require()`s its subject runs the stub IN ITS OWN PROCESS, so
// `process.exit(0)` killed the test runner before a single assertion ran and the
// suite "passed". Two suites were reported VACUOUS on that basis and neither
// was. A checker whose failure mode is a false accusation is worse than none;
// this one caught itself on its first run.
//
// Spawned subjects still exit 0 here — a script with no code does — so dropping
// the call costs nothing and removes the trap.
const STUB = `#!/usr/bin/env node
// STUB installed by check-suites-can-fail.js — restored immediately.
module.exports = {};
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

// The runner is checked differently, and it matters more than any single suite.
//
// test-all.js has no subject to stub — it runs the others. It is also the file
// that HAS failed this way: it was declared `run(label, file, args)` and called
// as `run(label, [...])`, so `args` was undefined and every suite spawned a bare
// `node`. Twelve suites reported PASS having executed nothing, and CI was green
// on an empty test run.
//
// So: make one child suite fail, and assert the runner notices.
function checkRunner(suite) {
    const victim = suites.find((s) => s !== suite && deriveSubjects(path.join(__dirname, s)).length);
    if (!victim) return { suite, status: 'NO-SUBJECT', note: 'no child suite to fail' };

    const full = path.join(__dirname, victim);
    const original = fs.readFileSync(full);
    try {
        fs.writeFileSync(full, '#!/usr/bin/env node\nconsole.log("canary");\nprocess.exit(1);\n');
        const r = runSuite(suite);
        return r.status !== 0
            ? { suite, status: 'ok', note: `reports failure when ${victim} fails` }
            : { suite, status: 'VACUOUS', note: `stays GREEN while ${victim} exits 1 — it is not running them` };
    } finally {
        fs.writeFileSync(full, original);
    }
}

// validate.js is a gate too, and it is not a test-*.js file so the loop below
// never sees it. It guards plugin structure, version sync, hook wiring and the
// private-names denylist — the checks that stop a broken marketplace shipping —
// and until now nothing proved it could fail.
//
// Its subject is the repo itself, so the mutation is a repo mutation: break the
// version sync, which every plugin manifest depends on, and assert it goes red.
function checkValidator() {
    const suite = 'validate.js';
    const file = path.join(ROOT, 'VERSION');
    if (!fs.existsSync(file)) return { suite, status: 'NO-SUBJECT', note: 'no VERSION file' };

    const run = () => spawnSync(process.execPath, [path.join(__dirname, 'validate.js')], {
        cwd: ROOT, encoding: 'utf8', timeout: 300000,
    });
    if (run().status !== 0) return { suite, status: 'RED', note: 'already failing' };

    const original = fs.readFileSync(file);
    try {
        fs.writeFileSync(file, '0.0.0-canary\n');
        return run().status !== 0
            ? { suite, status: 'ok', note: 'goes red on a version-sync break' }
            : { suite, status: 'VACUOUS', note: 'stays GREEN with VERSION desynced from every manifest' };
    } finally {
        fs.writeFileSync(file, original);
    }
}

rows.push(checkValidator());

for (const suite of suites) {
    if (suite === 'test-all.js') { rows.push(checkRunner(suite)); continue; }

    const subjects = SUBJECT_OVERRIDES[suite] || deriveSubjects(path.join(__dirname, suite));
    if (!subjects.length) {
        rows.push({ suite, status: 'NO-SUBJECT', note: 'references no plugin source — nothing to stub' });
        continue;
    }

    // Baseline: it must be green before the mutation means anything.
    if (runSuite(suite).status !== 0) {
        rows.push({ suite, status: 'RED', note: 'already failing — fix it before trusting this result' });
        continue;
    }

    // VACUOUS only if stubbing EVERY derived subject leaves it green.
    //
    // Not "any subject survived". A suite legitimately references files it does
    // not exercise — test-knowledge-injection names observation-classifier.js in
    // a comment explaining that it DELIBERATELY does not copy it, so stubbing
    // that file cannot and should not turn the suite red. Demanding every
    // subject kill the suite would report that as vacuous, which is the same
    // false-accusation failure the stub's process.exit() produced.
    //
    // The property under test is "this suite can fail", and one killed subject
    // proves it.
    const killed = [];
    for (const rel of subjects) {
        const full = path.join(ROOT, rel);
        const original = fs.readFileSync(full);
        try {
            fs.writeFileSync(full, STUB);
            if (runSuite(suite).status !== 0) killed.push(rel);
        } finally {
            fs.writeFileSync(full, original);
        }
    }

    rows.push(killed.length
        ? { suite, status: 'ok', note: `goes red when ${killed.length}/${subjects.length} subject(s) are stubbed` }
        : { suite, status: 'VACUOUS', note: `stays GREEN with all ${subjects.length} subject(s) stubbed out` });
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
    const mark = r.status === 'ok' ? '✓' : r.status === 'NO-SUBJECT' ? '·' : '✗';
    if (r.status === 'VACUOUS' || r.status === 'RED') bad++;
    console.log(`  ${mark} ${r.suite.padEnd(30)} ${r.status.padEnd(9)} ${VERBOSE || r.status !== 'ok' ? r.note : ''}`);
}
const unmapped = rows.filter((r) => r.status === 'NO-SUBJECT').length;
console.log(`\n${rows.length} suite(s) · ${bad} cannot fail or are already red · ${unmapped} with no subject · tree restored clean\n`);
process.exit(bad ? 1 : 0);
