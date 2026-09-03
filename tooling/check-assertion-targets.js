#!/usr/bin/env node
'use strict';
/**
 * check-assertion-targets.js - does each planted defect kill the assertion that
 * NAMES it?
 *
 * A suite going red proves something fired. It does not prove the RIGHT thing
 * fired, and the difference is where the holes are. This takes a manifest of
 * one-line mutations, each declaring the assertion it should trip, applies them
 * one at a time, and reports whether that assertion is the one that objected.
 *
 * WHY IT IS NOT check:vacuity OR check:suites. Those two ask whether a suite can
 * fail at all, by mutating a whole subject or stubbing it. Both are coarse on
 * purpose, and a suite passes them while still being blind to a specific branch.
 * This asks a narrower question: given THIS defect, does THAT assertion catch
 * it. Coarse mutation finds a suite that tests nothing; this finds the one
 * branch a thorough suite forgot.
 *
 * WHAT IT FOUND, which is why it exists. `[measured 2026-09-03]` run against
 * tooling/test-rendered-layout-gate.js, a suite written by someone who knew the
 * relevant rules cold, it turned up four real faults:
 *
 *   SURVIVED      an exemption no fixture exercised - untested by construction,
 *                 which is the shape of a gate that cannot fail, appearing in
 *                 the suite rather than in the subject.
 *   SURVIVED      a number printed in TWO places with only one asserted. The
 *                 unasserted one was the per-width table, which is the row a
 *                 reader actually scans.
 *   MISTARGETED   a mutant that went red on a different assertion, exposing a
 *                 probe that suppressed the very signal its guard needed.
 *   CRASHED       two assertions that dereferenced a finding they assumed
 *                 existed, so a broken subject crashed the suite instead of
 *                 failing it. A crash carries no diagnosis, and to a parser
 *                 counting failures it reads as ZERO of them.
 *
 * That last verdict is its own state here for exactly that reason: a red with no
 * assertion summary is not a kill, and folding it into one hides a suite that
 * cannot report.
 *
 * SAFETY. It rewrites real source files. It refuses to start when any file it
 * would touch is dirty in git, restores every file in a `finally`, and re-checks
 * the tree afterwards - a run that cannot prove it put things back says so
 * loudly rather than exiting quietly.
 *
 *   node tooling/check-assertion-targets.js <manifest.json> [...]
 *   node tooling/check-assertion-targets.js --all        # every manifest
 *   node tooling/check-assertion-targets.js --selftest
 *   node tooling/check-assertion-targets.js --json
 *
 * Exit: 0 every mutant killed by its own assertion, 1 any other verdict,
 * 2 could not run.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_DIR = path.join(ROOT, 'tooling', 'mutants');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const VERDICT = {
    KILLED: 'KILLED',
    SURVIVED: 'SURVIVED',
    MISTARGETED: 'MISTARGETED',
    CRASHED: 'CRASHED',
    ANCHOR_MISSING: 'ANCHOR-MISSING',
};

/** A suite prints `FAIL  <n> of <m>`; a crash prints no such line at all. */
const FAIL_SUMMARY = /^\s*FAIL\s+(\d+)\s+of\s+(\d+)/m;

function loadManifest(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw.suite || !Array.isArray(raw.mutants)) {
        throw new Error(`${file}: needs a "suite" and a "mutants" array`);
    }
    for (const m of raw.mutants) {
        for (const k of ['id', 'name', 'file', 'from', 'expect']) {
            if (typeof m[k] !== 'string') throw new Error(`${file}: mutant ${m.id || '?'} is missing "${k}"`);
        }
        if (typeof m.to !== 'string') throw new Error(`${file}: mutant ${m.id} is missing "to" (use "" to delete)`);
    }
    return Object.assign({ manifestPath: file }, raw);
}

function manifestFiles() {
    const named = argv.filter((a) => !a.startsWith('--'));
    if (named.length) return named.map((f) => path.resolve(f));
    if (!fs.existsSync(MANIFEST_DIR)) return [];
    return fs.readdirSync(MANIFEST_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => path.join(MANIFEST_DIR, f));
}

function gitStatus(root, files) {
    const r = spawnSync('git', ['status', '--porcelain', '--'].concat(files), { cwd: root, encoding: 'utf8' });
    return (r.stdout || '').trim();
}

/**
 * Apply each mutant in turn and record which assertion objected.
 * @param {object} manifest
 * @param {string} root  repository the manifest's paths are relative to
 */
function runManifest(manifest, root) {
    const suite = path.resolve(root, manifest.suite);
    const subjects = [...new Set(manifest.mutants.map((m) => path.resolve(root, m.file)))];

    for (const f of [suite].concat(subjects)) {
        if (!fs.existsSync(f)) return { error: `missing file: ${path.relative(root, f)}` };
    }

    // A dirty subject means a mutation could be mistaken for the author's own
    // edit, and a failed restore would silently keep it.
    const dirtyBefore = gitStatus(root, subjects);
    if (dirtyBefore && !has('--allow-dirty')) {
        return {
            error: 'refusing to run: these files have uncommitted changes, and this '
                + 'script rewrites them:\n  ' + dirtyBefore.split('\n').join('\n  ')
                + '\ncommit them first, or pass --allow-dirty if you accept the risk',
        };
    }

    const originals = new Map(subjects.map((f) => [f, fs.readFileSync(f, 'utf8')]));
    const runSuite = () => {
        const r = spawnSync(process.execPath, [suite], { cwd: root, encoding: 'utf8' });
        return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
    };

    const results = [];
    let baseline = null;
    try {
        baseline = runSuite();
        if (baseline.status !== 0) {
            return { error: 'refusing to mutate against a RED baseline - fix the suite first', baseline };
        }

        for (const m of manifest.mutants) {
            const file = path.resolve(root, m.file);
            const src = originals.get(file);
            if (!src.includes(m.from)) {
                results.push({ id: m.id, name: m.name, verdict: VERDICT.ANCHOR_MISSING, failed: 0,
                    detail: `anchor not found in ${m.file} - the mutant is stale` });
                continue;
            }
            if (src.split(m.from).length - 1 > 1) {
                results.push({ id: m.id, name: m.name, verdict: VERDICT.ANCHOR_MISSING, failed: 0,
                    detail: `anchor appears more than once in ${m.file} - make it unique` });
                continue;
            }

            fs.writeFileSync(file, src.replace(m.from, m.to), 'utf8');
            const r = runSuite();
            fs.writeFileSync(file, src, 'utf8');

            const summary = FAIL_SUMMARY.exec(r.out);
            const failed = summary ? Number(summary[1]) : 0;
            let verdict;
            if (r.status === 0) verdict = VERDICT.SURVIVED;
            else if (!summary) verdict = VERDICT.CRASHED;
            else if (new RegExp(m.expect).test(r.out)) verdict = VERDICT.KILLED;
            else verdict = VERDICT.MISTARGETED;

            results.push({
                id: m.id, name: m.name, verdict, failed,
                detail: verdict === VERDICT.MISTARGETED
                    ? 'first objections: ' + (r.out.match(/^\s*- .*/gm) || []).slice(0, 3).map((s) => s.trim()).join(' | ')
                    : verdict === VERDICT.CRASHED
                        ? 'the suite exited non-zero with no assertion summary - a crash is not a diagnosis'
                        : '',
            });
        }
    } finally {
        for (const [f, src] of originals) {
            try { fs.writeFileSync(f, src, 'utf8'); } catch { /* reported below */ }
        }
    }

    const dirtyAfter = gitStatus(root, subjects);
    return {
        results,
        baselineLine: (baseline.out || '').trim().split('\n')[0] || '',
        restored: dirtyAfter === dirtyBefore,
        dirtyAfter,
    };
}

// ---------------------------------------------------------------- selftest
//
// It has to prove it can report every BAD verdict, not just KILLED. A runner
// that only ever prints KILLED is indistinguishable from one that cannot tell
// the difference, which is the failure this whole script exists to find.

function selftest() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-targets-'));
    let bad = 0;
    const say = (ok, msg, detail) => {
        if (!ok) bad++;
        console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}${!ok && detail !== undefined ? ' -> ' + JSON.stringify(detail) : ''}`);
    };
    try {
        spawnSync('git', ['init', '-q'], { cwd: dir });
        fs.writeFileSync(path.join(dir, 'subject.js'), [
            'exports.add = (a, b) => a + b;',
            'exports.label = () => "hello";',
            'exports.unread = () => "nothing asserts this";',
            '',
        ].join('\n'), 'utf8');
        fs.writeFileSync(path.join(dir, 'suite.js'), [
            'const s = require("./subject.js");',
            'let passed = 0; const failures = [];',
            'const check = (n, c) => { if (c) { passed++; return; } failures.push(n); };',
            'check("addition is addition", s.add(2, 2) === 4);',
            'check("the label reads hello", s.label() === "hello");',
            'if (failures.length) {',
            '  console.error("FAIL  " + failures.length + " of " + (passed + failures.length));',
            '  for (const f of failures) console.error("    - " + f);',
            '  process.exit(1);',
            '}',
            'console.log("PASS  " + passed + " assertions");',
            '',
        ].join('\n'), 'utf8');
        spawnSync('git', ['add', '-A'], { cwd: dir });
        spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture'], { cwd: dir });

        const manifest = {
            suite: 'suite.js',
            mutants: [
                // Killed by the assertion that names it.
                { id: 'S1', name: 'addition breaks', file: 'subject.js',
                  from: 'a + b', to: 'a - b', expect: 'addition is addition' },
                // Red, but a DIFFERENT assertion objects.
                { id: 'S2', name: 'label breaks, expect points at addition', file: 'subject.js',
                  from: '"hello"', to: '"goodbye"', expect: 'addition is addition' },
                // Nothing asserts this function at all.
                { id: 'S3', name: 'an unasserted export', file: 'subject.js',
                  from: '"nothing asserts this"', to: '"changed"', expect: 'addition is addition' },
                // Breaks the suite's ability to report rather than its verdict.
                { id: 'S4', name: 'the subject stops loading', file: 'subject.js',
                  from: 'exports.add', to: 'throw new Error("boom"); exports.add', expect: 'addition is addition' },
                // A stale anchor.
                { id: 'S5', name: 'an anchor that is not there', file: 'subject.js',
                  from: 'this string does not occur', to: 'x', expect: 'addition is addition' },
            ],
        };
        const out = runManifest(manifest, dir);
        say(!out.error, 'the runner completes against a green baseline', out.error);
        const by = {};
        for (const r of out.results || []) by[r.id] = r.verdict;

        say(by.S1 === VERDICT.KILLED, 'a mutant killed by its own assertion reads KILLED', by.S1);
        // The four that matter. A runner that cannot report these is a runner
        // that always says KILLED.
        say(by.S2 === VERDICT.MISTARGETED, 'a mutant caught by a DIFFERENT assertion reads MISTARGETED', by.S2);
        say(by.S3 === VERDICT.SURVIVED, 'a mutant nothing asserts reads SURVIVED', by.S3);
        say(by.S4 === VERDICT.CRASHED, 'a suite that crashes rather than failing reads CRASHED', by.S4);
        say(by.S5 === VERDICT.ANCHOR_MISSING, 'a stale anchor reads ANCHOR-MISSING', by.S5);
        say(out.restored === true, 'the subject is restored afterwards', out.dirtyAfter);
        say(fs.readFileSync(path.join(dir, 'subject.js'), 'utf8').includes('a + b'),
            'and the restore is verified by reading the file, not by trusting the write');

        // The dirty-tree guard fires BEFORE the red-baseline one, so proving the
        // second needs a red suite on a CLEAN tree. Committing the break is the
        // only way to reach it - the first version of this case left the file
        // dirty and measured the wrong guard, which the selftest caught.
        fs.writeFileSync(path.join(dir, 'subject.js'),
            // NOT `a * b`: the fixture asserts add(2, 2) === 4 and 2 * 2 is also 4,
            // so that "break" leaves the suite green and this case would have
            // measured nothing. A planted defect has to actually be one.
            fs.readFileSync(path.join(dir, 'subject.js'), 'utf8').replace('a + b', 'a - b'), 'utf8');
        const dirtyRed = runManifest(manifest, dir);
        say(/uncommitted changes/.test(dirtyRed.error || ''),
            'a dirty subject is refused before anything is rewritten', dirtyRed.error);

        spawnSync('git', ['add', '-A'], { cwd: dir });
        spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'break it'], { cwd: dir });
        const red = runManifest(manifest, dir);
        say(/RED baseline/.test(red.error || ''), 'a red baseline is refused, not measured', red.error);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    console.log(`\n[selftest] 10 case(s) over 5 planted mutants, ${bad ? bad + ' FAILED' : 'all passed'} - every verdict this script can emit is exercised.`);
    return bad ? 1 : 0;
}

// -------------------------------------------------------------------- main

function usage() {
    console.log(`check-assertion-targets.js - does each planted defect kill the assertion that NAMES it?

  node tooling/check-assertion-targets.js <manifest.json> [...]
  node tooling/check-assertion-targets.js --all        every manifest in tooling/mutants/
  node tooling/check-assertion-targets.js --selftest
  node tooling/check-assertion-targets.js --json
  node tooling/check-assertion-targets.js --allow-dirty

A manifest is JSON:

  { "suite": "tooling/test-x.js",
    "mutants": [ { "id": "M1", "name": "...", "file": "src/x.js",
                   "from": "<unique source text>", "to": "<replacement, may be empty>",
                   "expect": "<regex matching the assertion that should object>" } ] }

Verdicts: KILLED, MISTARGETED (red, wrong assertion), SURVIVED (still green),
CRASHED (red with no assertion summary), ANCHOR-MISSING (stale mutant).

Exit: 0 all KILLED, 1 anything else, 2 could not run.`);
}

function main() {
    if (has('--help') || has('-h')) { usage(); return 0; }
    if (has('--selftest')) return selftest();

    const files = manifestFiles();
    if (!files.length) {
        usage();
        console.error(`\nNo manifests found in ${path.relative(ROOT, MANIFEST_DIR)} and none named.`);
        return 2;
    }

    const report = [];
    let bad = 0;
    let mutants = 0;
    for (const f of files) {
        let manifest;
        try { manifest = loadManifest(f); }
        catch (e) { console.error(e.message); bad++; continue; }

        const out = runManifest(manifest, ROOT);
        if (out.error) {
            console.error(`${path.relative(ROOT, f)}: ${out.error}`);
            bad++;
            continue;
        }
        mutants += out.results.length;
        for (const r of out.results) if (r.verdict !== VERDICT.KILLED) bad++;
        if (!out.restored) {
            console.error(`${path.relative(ROOT, f)}: TREE NOT RESTORED - ${out.dirtyAfter}`);
            bad++;
        }
        report.push({ manifest: path.relative(ROOT, f), suite: manifest.suite, ...out });
    }

    if (has('--json')) {
        console.log(JSON.stringify({ manifests: report }, null, 2));
    } else {
        for (const r of report) {
            console.log(`\n${r.manifest}  ->  ${r.suite}`);
            console.log(`  baseline: ${r.baselineLine}`);
            for (const m of r.results) {
                console.log(`  ${m.verdict.padEnd(15)} ${m.id}  ${m.name}`);
                if (m.detail) console.log(`  ${''.padEnd(15)} ${m.detail}`);
            }
            console.log(`  tree restored: ${r.restored}`);
        }
        // The population, so a quiet result is distinguishable from a run that
        // examined nothing.
        const tally = {};
        for (const r of report) for (const m of r.results) tally[m.verdict] = (tally[m.verdict] || 0) + 1;
        const parts = Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing to run';
        console.log(`\n${files.length} manifest(s), ${mutants} mutant(s): ${parts}.`);
        if (bad) {
            console.log('A mutant that is not KILLED names a hole: SURVIVED means nothing asserts it,');
            console.log('MISTARGETED means a different assertion got there first, CRASHED means the');
            console.log('suite cannot report on it at all.');
        }
    }
    return bad ? 1 : 0;
}

module.exports = { runManifest, loadManifest, VERDICT, FAIL_SUMMARY };

if (require.main === module) process.exit(main());
