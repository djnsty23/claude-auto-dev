#!/usr/bin/env node
// find-untested-functions.js — named functions in plugin sources that the test
// suite never executes.
//
// The third question in a series. find-orphan-checks asks "is this assertion
// script run by a runner?". find-untested-hooks asks "is this wired hook the
// SUBJECT of a suite?". Both work at FILE granularity, and a file can have a
// suite while half of what it contains is never called.
//
// THIS DOES NOT REPLACE MUTATION TESTING, and the first version of this comment
// claimed it did. The claim was tested and is false.
//
// COVERAGE MEASURES EXECUTION. MUTATION MEASURES VERIFICATION.
//
// drift-audit.js is the case that proves the difference. Its suite tests only
// "the prd.json half" and a mutation run found 37 mutants surviving in the other
// three audits — yet this tool reports all four as covered, correctly, because
// the script calls them all at top level on every run. They are executed on
// every suite run and asserted on by nothing. Coverage gives them a clean bill.
//
// The two answer different questions and neither subsumes the other:
//   coverage  — was this code ENTERED?      (finds dead code; cheap, exact)
//   mutation  — does any assertion DEPEND    (finds unverified code; slow)
//               on what it does?
//
// Dead code is where mutation is worst: every mutant in a function nobody calls
// survives, so it produces a large undifferentiated survivor pile that costs a
// suite run each to generate. That is the gap this fills.
//
// NODE_V8_COVERAGE makes every node process dump exact per-function hit counts,
// including spawned children, which matters because most suites here drive their
// subject as a subprocess. No heuristics and no name matching: a function is
// either entered or it is not.
//
// Usage:
//   node tooling/find-untested-functions.js          # runs the suite, then reports
//   node tooling/find-untested-functions.js --json
//
// Cost: one full test-all run (~20s) — cheap enough to run often, and cheap
// BECAUSE it answers the narrower question.
//
// Known true-but-fine result: removeWindowsAutostartRegistry() is dead on any
// non-Windows machine by design. Platform-gated code will always show here; that
// is information, not a defect, and the fix is to read the list rather than
// chase the number to zero.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const asJson = process.argv.includes('--json');

// basename -> plugin-relative path, for attributing copies back to their source.
// Ambiguous basenames are dropped rather than guessed.
const SOURCE_BY_BASENAME = (() => {
    const map = new Map(); const dupes = new Set();
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            if (!/\.(js|mjs|cjs)$/.test(e.name)) continue;
            if (map.has(e.name)) dupes.add(e.name);
            else map.set(e.name, path.relative(ROOT, full));
        }
    };
    walk(path.join(ROOT, 'plugins'));
    for (const d of dupes) map.delete(d);
    return map;
})();

// --- 1. run the suite with coverage on -------------------------------------
const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-cov-'));
const run = spawnSync(process.execPath, [path.join(ROOT, 'tooling', 'test-all.js')], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, NODE_V8_COVERAGE: covDir },
});

// --- 2. fold every process's coverage into one map -------------------------
// A function counts as EXECUTED if any process entered it. Suites spawn their
// subjects, so the hits are spread across hundreds of dumps.
const seen = new Map();   // "relPath::functionName" -> {file, name, count}

for (const f of fs.readdirSync(covDir)) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(covDir, f), 'utf8')); } catch { continue; }
    for (const script of data.result || []) {
        if (!script.url || !script.url.startsWith('file://')) continue;
        const abs = decodeURIComponent(script.url.slice('file://'.length));
        if (abs.includes('/node_modules/')) continue;

        // Suites that build a fake plugin root COPY the script into a temp dir
        // and run the copy, so the hit lands outside plugins/. Attributing by
        // basename brings those back: without it memory-db's getStats reads as
        // dead while a suite calls it every run — a false positive that would
        // have sent someone deleting live code.
        let rel;
        if (abs.startsWith(path.join(ROOT, 'plugins'))) {
            rel = path.relative(ROOT, abs);
        } else {
            const owner = SOURCE_BY_BASENAME.get(path.basename(abs));
            if (!owner) continue;          // not one of ours
            rel = owner;
        }

        for (const fn of script.functions || []) {
            // The unnamed top-level wrapper is the module body, not a function
            // anyone declared; counting it would report every file as covered.
            if (!fn.functionName) continue;
            const key = `${rel}::${fn.functionName}`;
            const count = (fn.ranges && fn.ranges[0] && fn.ranges[0].count) || 0;
            const prev = seen.get(key);
            if (!prev || count > prev.count) seen.set(key, { file: rel, name: fn.functionName, count });
        }
    }
}
fs.rmSync(covDir, { recursive: true, force: true });

const all = [...seen.values()];
const dead = all.filter((f) => f.count === 0).sort((a, b) =>
    a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

// --- 3. report --------------------------------------------------------------
if (asJson) {
    console.log(JSON.stringify({
        suitePassed: run.status === 0,
        functionsSeen: all.length,
        executed: all.length - dead.length,
        untested: dead,
    }, null, 2));
    process.exit(dead.length ? 1 : 0);
}

if (run.status !== 0) {
    console.error('\nThe test suite did not pass, so this measurement is not trustworthy.');
    console.error('Fix the suite first — coverage of a failing run says nothing.\n');
    process.exit(2);
}

console.log(`\n${all.length} named function(s) in plugin sources · `
    + `${all.length - dead.length} executed by the suite · ${dead.length} NEVER CALLED\n`);

if (!dead.length) {
    console.log('Every named function in every plugin source is entered by the suite.\n');
    process.exit(0);
}

let lastFile = '';
for (const d of dead) {
    if (d.file !== lastFile) { console.log(`  ${d.file}`); lastFile = d.file; }
    console.log(`      ✗ ${d.name}()`);
}
console.log('\nA function no test enters is not weakly covered — it is unverified.');
console.log('Mutation testing cannot help here: every mutant in dead code survives.\n');
process.exit(1);
