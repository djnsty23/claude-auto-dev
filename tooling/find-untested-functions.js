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
// READ THE LIST. "Never entered by the suite" is exactly what this measures, and
// it is NOT a synonym for dead code. The first full run reported 11, and reading
// every one gave four different answers and a single deletion candidate:
//
//   5  reachable through memory-db's own CLI dispatch — getRecent, searchTimeline,
//      listSessions, getByType, cleanup are `node memory-db.js recent|timeline|
//      sessions|decisions|cleanup`. User-facing entry points with no test, which
//      is a coverage gap, not dead weight.
//   4  called internally on paths the suite never takes: the classifier's
//      isTrivialBash and isSignificantRead (Bash and Read observations are never
//      seeded), preflight's soft() (no fixture produces a warning), and
//      image-scan's fail() (no fixture errors). Live code, untested branches.
//   1  platform-gated by design — removeWindowsAutostartRegistry() is dead on any
//      non-Windows machine and always will be.
//   1  GENUINELY UNREACHABLE — getSession() is absent from the CLI dispatch and
//      has no caller anywhere in the tree. The only deletion candidate of the 11.
//
// So the honest headline was one, not eleven. Chasing the number to zero would
// have deleted five working CLI commands.
//
// Worked down 11 -> 2 by testing rather than deleting: the CLI dispatch got a
// smoke suite, the classifier's Bash and Read paths got capture events, and
// preflight's soft() got the case it needed (a .github/workflows that exists but
// never mentions preflight — no fixture had a CI directory at all).
//
// THE LAST TWO ARE CORRECT TO LEAVE, and this is the number's floor, not a debt:
//   removeWindowsAutostartRegistry()  platform-gated; dead on any non-Windows
//                                     machine and always will be.
//   user-prompt-image-scan's fail()   defence-in-depth behind inner handlers. A
//                                     transcript_path pointing at a DIRECTORY was
//                                     tried; it exits 0 and stays silent, but an
//                                     inner catch takes the EISDIR first, so the
//                                     outer handler is never the one that runs.
//                                     Reaching it needs a throw outside every
//                                     inner guard, which cannot be forced from
//                                     the outside. The case was kept anyway — it
//                                     pins behaviour worth pinning.
//
// A tool like this has a floor above zero. Read the list; do not chase it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// `[measured 2026-09-02]` --help fell through to the full ~20s coverage run, so a
// probe for what this does got a sweep instead; check-entrypoints.js gates it.
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('usage: node tooling/find-untested-functions.js [--json]\n' +
        'Runs every suite under coverage and lists plugin functions never entered. ~20s.');
    process.exit(0);
}
const asJson = process.argv.includes('--json');

// basename -> plugin-relative path, for attributing copies back to their source.
// Ambiguous basenames are dropped rather than guessed.
// Every plugin source file, deduped by nothing. SOURCE_BY_BASENAME drops
// ambiguous basenames, which is right for ATTRIBUTION and wrong for a
// population: a file this check never sees is exactly the file worth naming.
const ALL_SOURCES = new Set();

const SOURCE_BY_BASENAME = (() => {
    const map = new Map(); const dupes = new Set();
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            if (!/\.(js|mjs|cjs)$/.test(e.name)) continue;
            ALL_SOURCES.add(path.relative(ROOT, full));
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
const filesWithCoverage = new Set();   // ran at all, named functions or not

for (const f of fs.readdirSync(covDir)) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(covDir, f), 'utf8')); } catch { continue; }
    for (const script of data.result || []) {
        if (!script.url || !script.url.startsWith('file://')) continue;
        // V8 emits file:///C:/... on Windows - a LEADING SLASH and forward
        // slashes - so a raw startsWith against path.join(ROOT,'plugins') never
        // matched there and every file fell through to basename attribution.
        // That fallback DROPS ambiguous basenames, so the day two plugins share
        // a filename both would vanish from this check without a word.
        let abs = decodeURIComponent(script.url.slice('file://'.length));
        if (abs.charAt(0) === '/' && abs.charAt(2) === ':') abs = abs.slice(1);
        abs = path.resolve(abs);
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

        filesWithCoverage.add(rel);

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

// THE BLIND SPOT THIS CHECK USED TO HIDE.
//
// `seen` is built from V8 coverage dumps, so it holds only files some process
// LOADED. A module no suite requires and no CLI spawn runs contributes nothing
// to the numerator AND nothing to the denominator - it is not weakly covered, it
// is absent. The old headline called that population 'named functions in plugin
// sources' while it had never scanned a source file.
//
// Measured 2026-08-24: fleet-status.js is exactly this. Nothing the suite drives
// requires it, so every function in it read as perfect coverage by not being there.
// THREE buckets, because two conflate distinct facts. A file V8 never recorded
// did not run. A file V8 recorded but that yields no NAMED function ran fine and
// simply has nothing for this census to count - post-tool-typecheck.js is that
// case, 13 script entries and 13 module wrappers. Calling the second 'never
// loaded' is a false positive, and a detector that cries wolf gets muted.
const loadedFiles = new Set([...seen.values()].map((f) => f.file));
const neverLoaded = [...ALL_SOURCES].filter((f) => !filesWithCoverage.has(f)).sort();
const loadedNoNamed = [...filesWithCoverage].filter((f) => !loadedFiles.has(f)).sort();

const all = [...seen.values()];
const dead = all.filter((f) => f.count === 0).sort((a, b) =>
    a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

// --- 3. report --------------------------------------------------------------
if (asJson) {
    console.log(JSON.stringify({
        suitePassed: run.status === 0,
        sourceFiles: ALL_SOURCES.size,
        filesLoaded: loadedFiles.size,
        filesNeverLoaded: neverLoaded,
        filesLoadedNoNamedFunctions: loadedNoNamed,
        functionsSeen: all.length,
        executed: all.length - dead.length,
        untested: dead,
    }, null, 2));
    // F6 (codex audit 2026-08-30): the JSON verdict follows the same policy as
    // the text renderer. A red suite means the measurement is untrustworthy and
    // exits 2 - previously only dead functions fed this exit, so a run that
    // loaded ZERO plugin files reported an empty census as success.
    process.exit(run.status !== 0 ? 2 : (dead.length ? 1 : 0));
}

if (run.status !== 0) {
    console.error('\nThe test suite did not pass, so this measurement is not trustworthy.');
    console.error('Fix the suite first — coverage of a failing run says nothing.\n');
    process.exit(2);
}

console.log(`\n${ALL_SOURCES.size} source file(s) in plugins/ · ${filesWithCoverage.size} executed · ${neverLoaded.length} NEVER LOADED · ${loadedNoNamed.length} ran but declare no named function`);
console.log(`${all.length} named function(s) IN THE LOADED FILES · ${all.length - dead.length} executed · ${dead.length} NEVER CALLED\n`);

if (neverLoaded.length) {
    console.log('  NEVER LOADED - not one line of these ran, so nothing in them is checked:');
    for (const f of neverLoaded) console.log(`      ? ${f}`);
    console.log('  These are UNVERIFIED, not covered - UNLESS a suite drives them as a subprocess it KILLS.');
    console.log('  V8 writes its dump on normal exit, never on SIGTERM, so a long-running');
    console.log('  subject (a monitor, a server) that a suite kills produces no coverage at');
    console.log('  all and lands here despite being exercised. Measured 2026-08-25:');
    console.log('  watch-panels.js and fleet-board.js carry 53 and 62 behavioural assertions');
    console.log('  and appear above. Check for a tooling/test-<name>.js before writing one.');
}
if (loadedNoNamed.length) {
    console.log('  LOADED but contributing no named function to the census:');
    for (const f of loadedNoNamed) console.log(`      - ${f}`);
    console.log('  These RAN. V8 recorded only the module wrapper, so they are outside'
        + ' this check rather than untested by it.' + `\n`);
}

if (!dead.length) {
    console.log(neverLoaded.length
        ? `Every named function in the ${loadedFiles.size} LOADED file(s) is entered by the suite. ${neverLoaded.length} file(s) above were never loaded and remain unchecked.\n`
        : 'Every named function in every plugin source is entered by the suite.\n');
    process.exit(neverLoaded.length ? 1 : 0);
}

let lastFile = '';
for (const d of dead) {
    if (d.file !== lastFile) { console.log(`  ${d.file}`); lastFile = d.file; }
    console.log(`      ✗ ${d.name}()`);
}
console.log('\nA function no test enters is not weakly covered — it is unverified.');
console.log('Mutation testing cannot help here: every mutant in dead code survives.\n');
process.exit(1);
