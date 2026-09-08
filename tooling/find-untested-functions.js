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
//   node tooling/find-untested-functions.js --gate   # npm run check:coverage
//   node tooling/find-untested-functions.js --max-untested N [--max-never-loaded M]
//   node tooling/find-untested-functions.js --root DIR ...   # measure another tree
//
// Cost: one full test-all run. The header said "~20s" from the day this was
// written until 2026-09-08, and `[measured 2026-09-08]` a plain npm test takes
// 328 s on this machine and the run under coverage 327 s
// (load averages beside each in docs/evidence-coverage-gate-2026-09-08.md). It is
// still cheap BECAUSE it answers the narrower question; it is not cheap in
// wall-clock, and the number in a header rots like any other.
//
// THE GATE (--gate, wired as `npm run check:coverage` in the gate chain and CI).
// Bare, this tool is INFORMATIONAL: it exits 1 whenever anything is never
// entered, which was true on every commit since it was written, so nothing in
// the gate ran it and the count could grow without anything going red. --gate
// turns it into a FLOOR AGAINST REGRESSION: it fails only when a change pushes
// the never-called or never-loaded count ABOVE what HEAD scored the day the
// floor was measured (FLOOR below). It is not a claim of quality. COVERAGE
// MEASURES EXECUTION, NOT VERIFICATION, exactly as the paragraph above says: a
// function can be entered every run while nothing asserts anything about it,
// and this gate is green for that function. It answers one question only:
// "did this change add a plugin function that no suite enters?"
//
// The ceilings are COUNTS, not a percentage. `--min-entered 95` was costed at b8eae1f:
// 737 of 774 is 95.2 %, rounds DOWN to 95, and 5 % of 774 is 38, so a
// percentage floor lets one more never-entered function in before it fires
// and grows that allowance with every function added. A count fires on the
// first newcomer. The two never-loaded and never-called ceilings are separate
// because they measure different things (a file no suite loads contributes
// NOTHING to the function census, so it cannot move the first number).
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
//
// `[measured 2026-09-08]` the floor is 39 (37 at b8eae1f, two more by f870b15;
// see FLOOR below), not 2, and the "11 -> 2" above is a
// dated story about the tree as it was then, kept because the reading method is
// the point. The 37 are read one by one in docs/evidence-coverage-gate-2026-09-08.md:
// seven live in long-running watchers a suite kills or runs one-shot (V8 writes
// no dump on a signal, and a --once run never reaches the interval), eleven are
// the gh/git-shelling half of scripts whose suites stay offline, three are
// --selftest entry points no suite spawns, four are CLI arg readers on scripts
// their suites drive in-process, eight are branches no fixture takes, one runs
// only inside a browser, one is an export with no caller in the tree. Still one
// platform-gated, still one defence-in-depth. Still not a debt.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
// `[measured 2026-09-02]` --help fell through to the full coverage run, so a
// probe for what this does got a sweep instead; check-entrypoints.js gates it.
if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node tooling/find-untested-functions.js [--json] [--gate]\n' +
        '         [--max-untested N] [--max-never-loaded M] [--root DIR]\n' +
        'Runs every suite under coverage and lists plugin functions never entered.\n' +
        'Bare: exit 1 if anything is never entered (informational).\n' +
        '--gate: exit 1 only ABOVE the measured floor (npm run check:coverage).\n' +
        '--max-untested / --max-never-loaded: explicit ceilings; a malformed value exits 2.\n' +
        '--root DIR: measure DIR (needs DIR/tooling/test-all.js and DIR/plugins/).\n' +
        'Exit 2 = no verdict: the suite went red, or an argument was malformed.');
    process.exit(0);
}
const asJson = argv.includes('--json');

// THE FLOOR. `[measured 2026-09-08]` at f870b15 (main), on a GREEN run of the suite
// under coverage, quiet (load 3 to 8): 39 named function(s) never called across the
// loaded plugin files, and 1 plugin source file never loaded at all. The first
// measurement, the same day at b8eae1f, read 37; between the two, main merged
// #189 and #200, each carrying one function no suite enters (fleet-overlap's
// degrade(), workflow-run-triage's projectsDir()), and this gate at the old
// floor exited 1 on the rebase. That rejection was the first real one and is
// recorded in docs/evidence-coverage-gate-2026-09-08.md; the floor was
// re-measured rather than the two functions being driven here, because they
// belong to other sessions' merges and are follow-up tests, not defects. --gate
// fails only ABOVE these. The bare run's own header, further up, explains why
// the count is not a debt to chase to zero (platform-gated code, defence-in-depth
// handlers). Lowering a ceiling is a ratchet decision, recorded in
// docs/decisions.md; raising one is a regression wearing a config edit, so the
// run that needs it should be looked at first. Whoever changes either re-measures
// on a green run and replaces the date and commit above in the same edit.
const FLOOR = { untested: 39, neverLoaded: 1, measured: '2026-09-08 at f870b15' };

// A flag that takes a value. A missing or malformed value is exit 2 (no
// verdict), which is deliberately distinct from exit 1 (a coverage regression):
// a typo in a ceiling must not read as a red gate, and must not read as green.
function valueOf(flag) {
    const i = argv.indexOf(flag);
    return i < 0 ? undefined : (argv[i + 1] === undefined ? null : argv[i + 1]);
}
function ceilingOf(flag) {
    const v = valueOf(flag);
    if (v === undefined) return null;
    if (v === null || !/^\d+$/.test(v)) {
        console.error(`${flag} needs a non-negative integer, got ${v === null ? 'nothing' : JSON.stringify(v)}`);
        process.exit(2);
    }
    return Number(v);
}
const gateMode = argv.includes('--gate');
const maxUntested = ceilingOf('--max-untested') ?? (gateMode ? FLOOR.untested : null);
const maxNeverLoaded = ceilingOf('--max-never-loaded') ?? (gateMode ? FLOOR.neverLoaded : null);
const gating = maxUntested !== null || maxNeverLoaded !== null;

// --root measures another tree: a fixture tree in a suite, or a scratch copy.
// It must look like this repo where the census looks: plugins/ to walk and
// tooling/test-all.js to run. Anything else is exit 2, not an empty census.
const rootArg = valueOf('--root');
if (rootArg === null) { console.error('--root needs a directory'); process.exit(2); }
const ROOT = rootArg === undefined ? path.resolve(__dirname, '..') : path.resolve(rootArg);
if (rootArg !== undefined && !(fs.existsSync(path.join(ROOT, 'plugins')) && fs.existsSync(path.join(ROOT, 'tooling', 'test-all.js')))) {
    console.error(`--root ${ROOT} has no plugins/ or no tooling/test-all.js, so there is nothing to measure`);
    process.exit(2);
}

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

// WHICH suites failed, when the run is red. The runner prints a summary block
// of `PASS  <label>` / `FAIL  <label>` lines; before this the exit-2 path said
// only "the suite did not pass", which under a loaded machine (three suites
// here are load-sensitive) left the reader re-running the whole thing to learn
// a name. The runner's last lines are kept for a runner that never reached its
// summary (a crash, a refusal).
const failedSuites = (run.stdout || '').split('\n')
    .map((l) => l.match(/^FAIL {2}(.+?)\s*$/)).filter(Boolean).map((m) => m[1]);
const runnerTail = ((run.stdout || '') + (run.stderr || '')).trim().split('\n').slice(-12).join('\n');

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
// The gate verdict, computed once for both renderers. Bare mode ignores it.
const overUntested = maxUntested !== null && dead.length > maxUntested;
const overNeverLoaded = maxNeverLoaded !== null && neverLoaded.length > maxNeverLoaded;
const gate = gating ? {
    maxUntested, maxNeverLoaded, overUntested, overNeverLoaded,
    floorMeasured: gateMode ? FLOOR.measured : null,
} : null;

if (asJson) {
    console.log(JSON.stringify({
        suitePassed: run.status === 0,
        failedSuites,
        runnerSignal: run.signal || null,
        gate,
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
    if (run.status !== 0) process.exit(2);
    process.exit(gating ? ((overUntested || overNeverLoaded) ? 1 : 0) : (dead.length ? 1 : 0));
}

if (run.status !== 0) {
    console.error('\nThe test suite did not pass, so this measurement is not trustworthy.');
    console.error('Fix the suite first — coverage of a failing run says nothing.');
    if (run.signal) {
        // `[measured 2026-09-08]` a census here died 164 s into a 15-minute run
        // with 24 of 88 files loaded and no FAIL line: a peer session's
        // pkill -9 across worktrees. Status was null, which the old message
        // reported as "did not pass". A killed runner is a different fact from
        // a red one and a reader should not have to re-run to learn which.
        console.error('The runner was KILLED by ' + run.signal + ' (no suite failed; something outside this run ended it).');
    } else if (failedSuites.length) console.error('Failed suite(s): ' + failedSuites.join(', '));
    else console.error('The runner printed no FAIL line; its last lines were:\n' + runnerTail);
    console.error('');
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

if (gating) {
    const cap = (n) => (n === null ? 'no ceiling' : `ceiling ${n}`);
    console.log(`[coverage] ${dead.length} never-called function(s) vs ${cap(maxUntested)} · ${neverLoaded.length} never-loaded file(s) vs ${cap(maxNeverLoaded)}`
        + (gateMode ? ` · floor measured ${FLOOR.measured}` : ''));
    if (overUntested || overNeverLoaded) {
        if (overUntested) {
            let lastFile = '';
            for (const d of dead) {
                if (d.file !== lastFile) { console.log(`  ${d.file}`); lastFile = d.file; }
                console.log(`      ✗ ${d.name}()`);
            }
        }
        console.log(`\n[coverage] FAIL: ${overUntested ? `${dead.length} never-called function(s) exceeds the ceiling of ${maxUntested}` : ''}`
            + (overUntested && overNeverLoaded ? '; ' : '')
            + `${overNeverLoaded ? `${neverLoaded.length} never-loaded file(s) exceeds the ceiling of ${maxNeverLoaded}` : ''}.`);
        console.log('This change added plugin code that no suite enters. Drive it from a suite (a');
        console.log('subprocess run counts; NODE_V8_COVERAGE follows children). If the floor itself');
        console.log('moved for a reason, re-measure on a green run and update FLOOR in');
        console.log('tooling/find-untested-functions.js with the new date and commit in the same edit.');
        process.exit(1);
    }
    console.log('[coverage] at or below the floor. This is a floor against regression, not a claim of');
    console.log('quality: coverage measures execution, not verification. Every function counted as');
    console.log('entered may still be asserted on by nothing; check:vacuity is the tool for that question.');
    process.exit(0);
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
