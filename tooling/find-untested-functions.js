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
// floor was measured (FLOORS below, one per platform). It is not a claim of quality. COVERAGE
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
// `[measured 2026-09-08]` the floor is 40 (37 at b8eae1f, 39 at f870b15, 40 at
// fcfb8fa on macOS; see FLOORS below), not 2, and the "11 -> 2" above is a
// dated story about the tree as it was then, kept because the reading method is
// the point. The 37 are read one by one in docs/evidence-coverage-gate-2026-09-08.md:
// seven live in long-running watchers a suite kills or runs one-shot (V8 writes
// no dump on a signal, and a --once run never reaches the interval), twelve are
// the gh/git/HTTP half of scripts whose suites stay offline, three are
// --selftest entry points no suite spawns, four are CLI arg readers on scripts
// their suites drive in-process, ten are branches no fixture takes, one runs
// only inside a browser, one is an export with no caller in the tree. Still one
// platform-gated, still one defence-in-depth. Still not a debt.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { spawnSuiteSync } = require('./suite-tmp.js');

const argv = process.argv.slice(2);
// `[measured 2026-09-02]` --help fell through to the full coverage run, so a
// probe for what this does got a sweep instead; check-entrypoints.js gates it.
if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node tooling/find-untested-functions.js [--json] [--gate]\n' +
        '         [--max-untested N] [--max-never-loaded M] [--root DIR] [--platform P]\n' +
        'Runs every suite under coverage and lists plugin functions never entered.\n' +
        'Bare: exit 1 if anything is never entered (informational).\n' +
        '--gate: exit 1 only ABOVE this platform\'s measured floor (npm run check:coverage);\n' +
        '        exit 2 on a platform with no measured floor.\n' +
        '--platform P: grade against P\'s floor instead of this host\'s (printed in the verdict).\n' +
        '--refused FILE: report FILE\'s never-called functions apart and do not grade them (repeatable,\n' +
        '        for fixtures; the host platform\'s REFUSED_BY_DESIGN table applies without it).\n' +
        '--max-untested / --max-never-loaded: explicit ceilings; a malformed value exits 2.\n' +
        '--root DIR: measure DIR (needs DIR/tooling/test-all.js and DIR/plugins/).\n' +
        'Exit 2 = no verdict: the suite went red, or an argument was malformed.');
    process.exit(0);
}
const asJson = argv.includes('--json');

// THE FLOOR. `[measured 2026-09-08]` at fcfb8fa (main), on a GREEN run of the suite
// under coverage (load 9 to 14): 40 named function(s) never called across the
// loaded plugin files, and 1 plugin source file never loaded at all. Measured
// three times the same day as main moved under the PR that wired this: 37 at
// b8eae1f, 39 at f870b15 (#189 fleet-overlap's degrade(), #200
// workflow-run-triage's projectsDir()), 40 at fcfb8fa (#196 production-signals'
// httpGetJson()). Each time this gate at the previous floor exited 1 on the
// rebase, which is the behaviour it exists for, recorded in
// docs/evidence-coverage-gate-2026-09-08.md. The floor was re-measured rather
// than the three functions being driven here, because they belong to other
// sessions' merges and are follow-up tests, not defects. --gate
// fails only ABOVE these. The bare run's own header, further up, explains why
// the count is not a debt to chase to zero (platform-gated code, defence-in-depth
// handlers). Lowering a ceiling is a ratchet decision, recorded in
// docs/decisions.md; raising one is a regression wearing a config edit, so the
// run that needs it should be looked at first. Whoever changes either re-measures
// on a green run and replaces the date and commit above in the same edit.
//
// ONE FLOOR PER PLATFORM, because the census is platform-sensitive and a floor
// measured on one host is not a claim about another. `[measured 2026-09-13]` on
// Windows 11 at b9d0d56 the suite was green and this gate exited 1 at 94 against
// the 40 above, on a markdown-only PR, while ubuntu-latest CI scored 37 on the
// same commit. 61 of the 94 are code that cannot run on win32 by design: the
// mission runtime (mission-store.js refuses without process.getuid, and its
// eight suites run one case there and skip the rest) and agent-browser-cleanup's
// `ps` branch. The single floor read that as "this change added plugin code no
// suite enters" and sent a session to blame main for a platform. Reading in
// docs/evidence-coverage-floor-per-platform-2026-09-13.md.
//
// The 40 was measured on macOS; linux shares it because ubuntu-latest scored the
// same 37 as the Mac at b8eae1f (CI run 34209762305) and 37 at b9d0d56 (run
// 34673906530). A platform with no entry here is NO VERDICT (exit 2) before the
// suite runs, never a pass and never a regression: it has no floor to exceed.
const FLOORS = {
    darwin: { untested: 40, neverLoaded: 1, measured: '2026-09-08 at fcfb8fa' },
    linux: { untested: 40, neverLoaded: 1, measured: '2026-09-08 at fcfb8fa' },
    // `[measured 2026-09-13]` on Windows 11 at 84e0a75: 1061 named functions, 93
    // never called, of which 57 are REFUSED_BY_DESIGN below and 36 are graded
    // (the linux buckets plus four POSIX-gated single functions), 1 never loaded.
    win32: { untested: 36, neverLoaded: 1, measured: '2026-09-13 at 84e0a75' },
};

// CODE A PLATFORM REFUSES BY DESIGN, reported as its own population rather than
// folded into that platform's floor. `[measured 2026-09-13]` the mission runtime
// added 57 named functions across four files in three days (stories B05 to B08),
// and every one is never entered on win32 because mission-store.js
// sqliteRuntime() refuses with runtime-unavailable when process.getuid is
// missing. A win32 floor that COUNTED them would go red on Windows for every
// mission change, while linux, where the same suites run their POSIX+SQLite
// cases, grades those functions properly. Re-measuring the win32 floor on each
// of those PRs is the "regression wearing a config edit" the paragraph above
// warns about, repeated until nobody reads the number.
//
// So when this repo is measured on the listed platform, and only while the
// stated precondition holds on the host, never-called functions in these files
// are printed as a separate count per file and not graded. Everything else stays
// in the count, including the four platform-gated FUNCTIONS in other files
// (prd-requirements validateSnapshot, agent-browser-cleanup's ps branch): those
// are single functions that do not grow with a runtime under construction.
//
// Two guards keep this from becoming a place to hide code. A listed file that
// does not exist, was never loaded, or has NO never-called function on this run
// is a stale listing and NO VERDICT (exit 2): the refusal it names did not
// happen here. And the entries are whole files in this table, each with its
// reason, so widening the list is a reviewed edit here and never a flag in
// package.json. `--refused FILE` exists for the fixture suite and is printed in
// every verdict it affects.
const REFUSED_BY_DESIGN = {
    win32: {
        precondition: 'process.getuid is not a function',
        holds: () => typeof process.getuid !== 'function',
        reason: 'mission-store.js refuses with runtime-unavailable without POSIX ownership checks; linux and darwin grade it',
        files: [
            'plugins/autodev-core/scripts/mission-deliver.js',
            'plugins/autodev-core/scripts/mission-dispatch.js',
            'plugins/autodev-core/scripts/mission-store.js',
            'plugins/autodev-core/scripts/mission-supervisor.js',
        ],
    },
};

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
// --platform grades against another platform's floor. It exists so a suite can
// reach the unmeasured-platform refusal from any host; the platform used is
// printed in every gate verdict, so an override cannot pass for this host.
const platformArg = valueOf('--platform');
if (platformArg === null || (platformArg !== undefined && !/^[a-z0-9]+$/.test(platformArg))) {
    console.error(`--platform needs a platform name such as linux, darwin or win32, got ${platformArg === null ? 'nothing' : JSON.stringify(platformArg)}`);
    process.exit(2);
}
const platform = platformArg ?? process.platform;
const explicitUntested = ceilingOf('--max-untested');
const explicitNeverLoaded = ceilingOf('--max-never-loaded');
const FLOOR = FLOORS[platform] || null;
if (gateMode && !FLOOR && (explicitUntested === null || explicitNeverLoaded === null)) {
    console.error(`[coverage] NO VERDICT: no coverage floor has been measured for ${platform}.`);
    console.error('The census is platform-sensitive (code gated to one platform is never entered on');
    console.error(`another), so a floor from ${Object.keys(FLOORS).join(' or ')} says nothing about ${platform}. Measure one`);
    console.error('on a green run and add it to FLOORS in tooling/find-untested-functions.js, or pass');
    console.error('--max-untested and --max-never-loaded explicitly. The suite was not run.');
    process.exit(2);
}
const maxUntested = explicitUntested ?? (gateMode ? FLOOR.untested : null);
const maxNeverLoaded = explicitNeverLoaded ?? (gateMode ? FLOOR.neverLoaded : null);
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

// The refused-by-design set for this run: the HOST platform's table entry, when
// this repo is the tree measured (a --root fixture has none of its files), the
// platform graded is the host's (a --platform override does not borrow another
// platform's exclusions) and the precondition holds; plus any --refused FILE.
const refusedFiles = new Map();   // posix-style plugin-relative path -> reason
const hostRefused = REFUSED_BY_DESIGN[process.platform];
const refusedPrecondition = hostRefused && rootArg === undefined && platform === process.platform && hostRefused.holds()
    ? hostRefused.precondition : null;
if (refusedPrecondition) for (const f of hostRefused.files) refusedFiles.set(f, hostRefused.reason);
for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--refused') continue;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { console.error('--refused needs a plugin-relative file path'); process.exit(2); }
    refusedFiles.set(v.split('\\').join('/'), 'named with --refused');
}

// --- 1. run the suite with coverage on -------------------------------------
const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-cov-'));
// The runner's output goes to a FILE, never through spawnSync's buffer.
// `[measured 2026-09-08]` the review of this gate bracketed a cliff at node's
// 1 MiB default maxBuffer: a runner that prints past it is killed with SIGTERM
// and would have been reported below as KILLED, which is the same misreading
// of a non-verdict this exit-2 path exists to stop. The whole gate prints
// 258 KB today, so nothing had hit it yet; the day a suite gets chatty is the
// day this would have started lying. A file has no ceiling, and stdout to a
// file is synchronous on every platform, so the tail is never truncated either.
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-cov-log-'));
const runnerLog = path.join(logDir, 'runner.log');
const logFd = fs.openSync(runnerLog, 'w');
// Through suite-tmp.js like every suite spawn: test-all.js gives each suite its
// own temp root, and this gives the runner one, so nothing it or they leave in
// os.tmpdir() survives. NODE_V8_COVERAGE is absolute and outside that root.
const run = spawnSuiteSync(process.execPath, [path.join(ROOT, 'tooling', 'test-all.js')], {
    cwd: ROOT,
    stdio: ['ignore', logFd, logFd],
    // CLAUDE_CONFIG_DIR is dropped for the reason test-all.js gives: a suite
    // faking HOME would otherwise still resolve the operator's real profile.
    env: (({ CLAUDE_CONFIG_DIR, ...rest }) => ({ ...rest, NODE_V8_COVERAGE: covDir }))(process.env),
});
fs.closeSync(logFd);
const runnerOut = fs.readFileSync(runnerLog, 'utf8');
// A red or killed run KEEPS its log. The summary below names the failed suite
// and the last twelve lines, and the failing assertion is almost never in
// either: it sits above the summary, in the suite's own block. Deleting the
// file left a reader holding a name and no reason, and the only way to learn
// the reason was to re-run a census that costs a full suite pass. A green run
// has nothing to explain, so its log is removed as before.
const runGreen = run.status === 0 && !run.signal;
if (runGreen) fs.rmSync(logDir, { recursive: true, force: true });
const keptLog = runGreen ? null : runnerLog;

// WHICH suites failed, when the run is red. The runner prints a summary block
// of `PASS  <label>` / `FAIL  <label>` lines; before this the exit-2 path said
// only "the suite did not pass", which under a loaded machine (three suites
// here are load-sensitive) left the reader re-running the whole thing to learn
// a name. The runner's last lines are kept for a runner that never reached its
// summary (a crash, a refusal).
const failedSuites = runnerOut.split('\n')
    .map((l) => l.match(/^FAIL {2}(.+?)\s*$/)).filter(Boolean).map((m) => m[1]);
const runnerTail = runnerOut.trim().split('\n').slice(-12).join('\n');

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

// Split the never-called list into what this run grades and what the platform
// refuses by design. `dead` keeps its meaning wherever it is reported (every
// function never entered); only the gate comparison reads `graded`.
const posix = (rel) => rel.split(path.sep).join('/');
const refusedDead = dead.filter((d) => refusedFiles.has(posix(d.file)));
const graded = dead.filter((d) => !refusedFiles.has(posix(d.file)));
const refusedByFile = [...refusedFiles.keys()].sort().map((file) => ({
    file,
    reason: refusedFiles.get(file),
    exists: [...ALL_SOURCES].some((s) => posix(s) === file),
    loaded: [...filesWithCoverage].some((s) => posix(s) === file),
    neverCalled: refusedDead.filter((d) => posix(d.file) === file).length,
}));
// A listing that describes a refusal which did not happen on this run.
const staleRefused = refusedByFile.filter((r) => !r.exists || !r.loaded || r.neverCalled === 0);

// --- 3. report --------------------------------------------------------------
// process.exitCode, never process.exit(), after anything was written to stdout:
// stdout to a PIPE is asynchronous on POSIX (Linux and darwin) and exit() drops
// the unflushed tail (65536 bytes survived on darwin) (CLAUDE.md, "process.exit() after printing TRUNCATES"). The gate's
// own output is ~2 KB today; the second review named this as latent, and the
// change is one wrapper. Every early exit below is a return, and the code is
// set once at the end.
function report() {
// The gate verdict, computed once for both renderers. Bare mode ignores it.
const overUntested = maxUntested !== null && graded.length > maxUntested;
const overNeverLoaded = maxNeverLoaded !== null && neverLoaded.length > maxNeverLoaded;
// THE POPULATION FLOOR (rule-gate-integrity §2, found by the second review of
// this gate, 2026-09-08): a census that read NO plugin files, or read files and
// saw no named function in any of them, scored 0 against the ceiling and
// reported a clean floor. A walker that silently stops finding files would have
// passed --gate forever. "No output never differs from no output", so an empty
// census is NO VERDICT (exit 2), the same class as a red runner, never a pass
// and never a regression.
const emptyCensus = ALL_SOURCES.size === 0
    ? 'read 0 plugin files under plugins/, so nothing was measured'
    : (all.length === 0
        ? `read ${ALL_SOURCES.size} plugin file(s) but saw no named function in any loaded one, so nothing was measured`
        : null);
const staleVerdict = staleRefused.length
    ? 'stale refused-by-design listing: ' + staleRefused.map((r) => `${r.file} (${!r.exists ? 'no such file' : !r.loaded ? 'never loaded' : 'no never-called function'})`).join(', ')
    : null;

const refusedByDesign = refusedFiles.size ? {
    platform: process.platform, precondition: refusedPrecondition,
    count: refusedDead.length, files: refusedByFile,
} : null;
const gate = gating ? {
    maxUntested, maxNeverLoaded, overUntested, overNeverLoaded,
    platform,
    floorMeasured: gateMode && FLOOR ? FLOOR.measured : null,
    graded: graded.length,
} : null;

if (asJson) {
    console.log(JSON.stringify({
        suitePassed: run.status === 0,
        failedSuites,
        runnerSignal: run.signal || null,
        runnerOutputBytes: Buffer.byteLength(runnerOut),
        runnerLog: keptLog,
        emptyCensus,
        gate,
        sourceFiles: ALL_SOURCES.size,
        filesLoaded: loadedFiles.size,
        filesNeverLoaded: neverLoaded,
        filesLoadedNoNamedFunctions: loadedNoNamed,
        functionsSeen: all.length,
        executed: all.length - dead.length,
        untested: dead,
        refusedByDesign,
        staleRefused: staleVerdict,
    }, null, 2));
    // F6 (codex audit 2026-08-30): the JSON verdict follows the same policy as
    // the text renderer. A red suite means the measurement is untrustworthy and
    // exits 2 - previously only dead functions fed this exit, so a run that
    // loaded ZERO plugin files reported an empty census as success.
    if (run.status !== 0) return 2;
    if (emptyCensus) return 2;
    if (staleVerdict) return 2;
    return gating ? ((overUntested || overNeverLoaded) ? 1 : 0) : (dead.length ? 1 : 0);
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
    console.error(`(runner output: ${Buffer.byteLength(runnerOut)} bytes, read from a file, no buffer ceiling)`);
    console.error('The full runner log is kept at ' + keptLog + ' (every assertion from every suite, not only the tail).');
    console.error('');
    return 2;
}

if (emptyCensus) {
    console.error(`\n${ALL_SOURCES.size} source file(s) in plugins/ · ${all.length} named function(s) seen`);
    console.error('[coverage] NO VERDICT: ' + emptyCensus + '.');
    console.error('A ceiling compared against nothing is met by construction; this is exit 2, not a pass.');
    return 2;
}

if (staleVerdict) {
    console.error('\n[coverage] NO VERDICT: ' + staleVerdict + '.');
    console.error('A file excluded because this platform refuses it must exist, load, and leave at least one');
    console.error('function unentered, or the refusal it names did not happen here. Correct or remove the');
    console.error('entry in REFUSED_BY_DESIGN (tooling/find-untested-functions.js). This is exit 2, not a pass.');
    return 2;
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

if (refusedByDesign) {
    console.log(`  REFUSED BY DESIGN on ${process.platform}${refusedPrecondition ? ` (${refusedPrecondition})` : ''}: ${refusedDead.length} never-called function(s), NOT graded here:`);
    for (const r of refusedByFile) console.log(`      ~ ${r.file}: ${r.neverCalled} (${r.reason})`);
    console.log('');
}

if (gating) {
    const cap = (n) => (n === null ? 'no ceiling' : `ceiling ${n}`);
    console.log(`[coverage] ${graded.length} never-called function(s) vs ${cap(maxUntested)}`
        + (refusedDead.length ? ` (+${refusedDead.length} refused by design, not graded)` : '')
        + ` · ${neverLoaded.length} never-loaded file(s) vs ${cap(maxNeverLoaded)}`
        + (gateMode && FLOOR ? ` · ${platform} floor measured ${FLOOR.measured}` : ''));
    if (overUntested || overNeverLoaded) {
        if (overUntested) {
            let lastFile = '';
            for (const d of graded) {
                if (d.file !== lastFile) { console.log(`  ${d.file}`); lastFile = d.file; }
                console.log(`      ✗ ${d.name}()`);
            }
        }
        console.log(`\n[coverage] FAIL: ${overUntested ? `${graded.length} never-called function(s) exceeds the ceiling of ${maxUntested}` : ''}`
            + (overUntested && overNeverLoaded ? '; ' : '')
            + `${overNeverLoaded ? `${neverLoaded.length} never-loaded file(s) exceeds the ceiling of ${maxNeverLoaded}` : ''}.`);
        console.log(`Measured on ${platform}. This change added plugin code that no suite enters on this`);
        console.log('platform. Drive it from a suite (a subprocess run counts; NODE_V8_COVERAGE follows');
        console.log('children). A whole file this platform refuses by design belongs in REFUSED_BY_DESIGN');
        console.log('with its reason; anything else that moved the floor is re-measured on a green run and');
        console.log(`written to FLOORS.${platform} in tooling/find-untested-functions.js with the new date and commit.`);
        return 1;
    }
    console.log('[coverage] at or below the floor. This is a floor against regression, not a claim of');
    console.log('quality: coverage measures execution, not verification. Every function counted as');
    console.log('entered may still be asserted on by nothing; check:vacuity is the tool for that question.');
    return 0;
}

if (!dead.length) {
    console.log(neverLoaded.length
        ? `Every named function in the ${loadedFiles.size} LOADED file(s) is entered by the suite. ${neverLoaded.length} file(s) above were never loaded and remain unchecked.\n`
        : 'Every named function in every plugin source is entered by the suite.\n');
    return neverLoaded.length ? 1 : 0;
}

let lastFile = '';
for (const d of dead) {
    if (d.file !== lastFile) { console.log(`  ${d.file}`); lastFile = d.file; }
    console.log(`      ✗ ${d.name}()`);
}
console.log('\nA function no test enters is not weakly covered — it is unverified.');
console.log('Mutation testing cannot help here: every mutant in dead code survives.\n');
return 1;
}

process.exitCode = report();
