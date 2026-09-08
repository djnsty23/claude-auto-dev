#!/usr/bin/env node
// The coverage floor (`npm run check:coverage`) can fail, fails for the right
// reason, and refuses rather than guesses. Drives tooling/find-untested-functions.js
// as a subprocess against a FIXTURE TREE it builds in a temp dir: a one-file
// plugin with two named functions and a runner that calls exactly one of them.
// The measurement is the real one (NODE_V8_COVERAGE on the spawned runner);
// only the tree is small. Sub-second per case.
//
// WHAT IS NOT HERE, and where it is instead. "The check is green on HEAD" is
// asserted by the gate step itself (`npm run gate` and .github/workflows/ci.yml
// both run check:coverage on HEAD), not by this suite, for a structural reason
// rather than a cost one: the check runs test-all.js under coverage, test-all.js
// runs this suite, so a HEAD run inside this suite recurses without end whenever
// the suite is itself under the check. It costs a full suite run as well, tens
// of minutes here (`[measured 2026-09-08]` in
// docs/evidence-coverage-gate-2026-09-08.md). The case exists behind
// AUTODEV_COVERAGE_FULL=1 for a hand run and is SKIPPED loudly otherwise, with
// this paragraph's reason printed, so a reader cannot mistake the skip for a pass.
//
// The fixture file names are deliberately unlike anything under plugins/:
// check-suites-can-fail.js derives a suite's subjects partly from bare
// basenames that are unique in plugins/, and a fixture named `lib.js` could be
// mistaken for a subject this suite never touches.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECK = path.join(ROOT, 'tooling', 'find-untested-functions.js');

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);
const detail = (r) => `status=${r.status} signal=${r.signal} error=${r.error ? r.error.message : 'none'}\n${(r.stdout + r.stderr).slice(-800)}`;
const run = (args, timeout = 60000) => spawnSync(process.execPath, [CHECK, ...args], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024,
});

// --- the fixture tree --------------------------------------------------------
// `runnerCalls` is the list of exported functions the fixture runner invokes;
// `extraFile` adds a second plugin source that nothing requires (never loaded);
// `runnerFails` makes the runner print a FAIL line and exit 1.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-gate-fx-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0;
function fixture({ runnerCalls, extraFile = false, runnerFails = false, runnerKilled = false }) {
    const root = path.join(TMP, 'fx' + (++n));
    const scripts = path.join(root, 'plugins', 'fx', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(path.join(root, 'tooling'), { recursive: true });
    fs.writeFileSync(path.join(scripts, 'fixture-census-lib.js'),
        'function enteredByTheRunner() { return 1; }\n' +
        'function neverEnteredByAnything() { return 2; }\n' +
        'module.exports = { enteredByTheRunner, neverEnteredByAnything };\n');
    if (extraFile) {
        fs.writeFileSync(path.join(scripts, 'fixture-census-orphan.js'),
            'function orphanFunction() { return 3; }\nmodule.exports = { orphanFunction };\n');
    }
    const marker = path.join(root, 'runner-ran.marker');
    fs.writeFileSync(path.join(root, 'tooling', 'test-all.js'),
        `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n` +
        "const lib = require('../plugins/fx/scripts/fixture-census-lib.js');\n" +
        runnerCalls.map((f) => `lib.${f}();\n`).join('') +
        (runnerKilled
            ? "process.kill(process.pid, 'SIGKILL');\n"
            : runnerFails
                ? "console.log('FAIL  fixture-broken');\nprocess.exit(1);\n"
                : "console.log('PASS  fixture');\n"));
    return { root, marker };
}
const ranRunner = (fx) => fs.existsSync(fx.marker);

// --- 1. --help returns without measuring anything -------------------------------
{
    const t0 = Date.now();
    const r = run(['--help'], 15000);
    check('--help exits 0 with usage naming --gate and --max-untested',
        r.status === 0 && !r.error && /usage:/.test(r.stdout) && /--gate/.test(r.stdout) && /--max-untested/.test(r.stdout), detail(r));
    check('--help returns in under 5s (it must not run the suite)', Date.now() - t0 < 5000, `${Date.now() - t0}ms`);
}

// --- 2. one never-entered function fails the gate, by name, with the population --
{
    const fx = fixture({ runnerCalls: ['enteredByTheRunner'] });
    const r = run(['--root', fx.root, '--max-untested', '0']);
    check('fixture with one never-entered function: exit 1', r.status === 1 && !r.error, detail(r));
    check('  the never-entered function is NAMED', /✗ neverEnteredByAnything\(\)/.test(r.stdout), detail(r));
    check('  and the entered one is not', !/✗ enteredByTheRunner\(\)/.test(r.stdout), detail(r));
    check('  the file is named', /plugins\/fx\/scripts\/fixture-census-lib\.js/.test(r.stdout), detail(r));
    check('  the population is printed (1 source file, 2 named functions, 1 never called)',
        /1 source file\(s\) in plugins\//.test(r.stdout) && /2 named function\(s\)/.test(r.stdout) && /1 NEVER CALLED/.test(r.stdout), detail(r));
    check('  the verdict names the ceiling it exceeded', /1 never-called function\(s\) exceeds the ceiling of 0/.test(r.stdout), detail(r));
    check('  control: the fixture runner actually ran', ranRunner(fx), fx.marker);

    const j = run(['--root', fx.root, '--max-untested', '0', '--json']);
    let payload = null;
    try { payload = JSON.parse(j.stdout); } catch { /* asserted below */ }
    check('  --json carries the same verdict: exit 1, gate.overUntested, the function listed',
        j.status === 1 && payload && payload.gate && payload.gate.overUntested === true
            && payload.suitePassed === true && payload.functionsSeen === 2 && payload.executed === 1
            && payload.untested.length === 1 && payload.untested[0].name === 'neverEnteredByAnything',
        detail(j));
}

// --- 3. controls: what flips the verdict is the dead function, not the fixture ----
{
    // Same tree, ceiling raised by one: green, and still reports the population.
    const fx = fixture({ runnerCalls: ['enteredByTheRunner'] });
    const r = run(['--root', fx.root, '--max-untested', '1']);
    check('control: the same tree under a ceiling of 1 exits 0', r.status === 0 && !r.error, detail(r));
    check('  and still prints the population and the caveat',
        /2 named function\(s\)/.test(r.stdout) && /coverage measures execution, not verification/.test(r.stdout), detail(r));

    // Same ceiling of 0, runner now calls BOTH functions: green. This is the
    // control that the dead function, and nothing else about the fixture, is
    // what turned case 2 red.
    const both = fixture({ runnerCalls: ['enteredByTheRunner', 'neverEnteredByAnything'] });
    const g = run(['--root', both.root, '--max-untested', '0']);
    check('control: a runner that enters both functions passes a ceiling of 0',
        g.status === 0 && !g.error && /0 NEVER CALLED/.test(g.stdout), detail(g));
    check('  control: that runner ran too', ranRunner(both), both.marker);
}

// --- 4. a file nothing loads is the OTHER ceiling ------------------------------------
{
    const fx = fixture({ runnerCalls: ['enteredByTheRunner', 'neverEnteredByAnything'], extraFile: true });
    const r = run(['--root', fx.root, '--max-untested', '0', '--max-never-loaded', '0']);
    check('a never-loaded plugin file exceeds a never-loaded ceiling of 0: exit 1',
        r.status === 1 && !r.error && /fixture-census-orphan\.js/.test(r.stdout)
            && /1 never-loaded file\(s\) exceeds the ceiling of 0/.test(r.stdout), detail(r));
    check('  and the function census is untouched by it (it cannot count what was never loaded)',
        /0 NEVER CALLED/.test(r.stdout) && /1 NEVER LOADED/.test(r.stdout), detail(r));
    const ok = run(['--root', fx.root, '--max-untested', '0', '--max-never-loaded', '1']);
    check('control: the same tree under a never-loaded ceiling of 1 exits 0', ok.status === 0 && !ok.error, detail(ok));
}

// --- 5. malformed ceilings are exit 2, not 1, and never start the suite ------------
for (const [label, args] of [
    ['a non-numeric ceiling', ['--max-untested', 'abc']],
    ['a negative ceiling', ['--max-untested', '-1']],
    ['a missing ceiling value', ['--max-untested']],
    ['a non-numeric never-loaded ceiling', ['--max-never-loaded', '1.5']],
]) {
    const fx = fixture({ runnerCalls: ['enteredByTheRunner'] });
    const r = run(['--root', fx.root, ...args], 15000);
    check(`${label} exits 2 (no verdict), distinct from a coverage failure`,
        r.status === 2 && !r.error && /needs a non-negative integer/.test(r.stderr), detail(r));
    check('  and did not run the suite', !ranRunner(fx), fx.marker);
}
{
    const r = run(['--root', path.join(TMP, 'does-not-exist'), '--max-untested', '0'], 15000);
    check('a --root with nothing to measure exits 2 rather than reporting an empty census',
        r.status === 2 && !r.error && /nothing to measure/.test(r.stderr), detail(r));
}

// --- 6. a red suite is no verdict, and the failed suite is NAMED ----------------------
{
    const fx = fixture({ runnerCalls: ['enteredByTheRunner'], runnerFails: true });
    const r = run(['--root', fx.root, '--max-untested', '5']);
    check('a red fixture suite exits 2 even though the count is under the ceiling',
        r.status === 2 && !r.error && /not trustworthy/.test(r.stderr), detail(r));
    check('  and names the failed suite', /Failed suite\(s\): fixture-broken/.test(r.stderr), detail(r));
    const j = run(['--root', fx.root, '--max-untested', '5', '--json']);
    let payload = null;
    try { payload = JSON.parse(j.stdout); } catch { /* asserted below */ }
    check('  --json: exit 2, suitePassed false, failedSuites names it',
        j.status === 2 && payload && payload.suitePassed === false
            && Array.isArray(payload.failedSuites) && payload.failedSuites[0] === 'fixture-broken', detail(j));
}

// --- 6b. a KILLED runner is named as killed, not as a failed suite -------------------
// `[measured 2026-09-08]` a census on this machine died 164 s into a 15-minute run
// with no FAIL line, because a peer session ran pkill -9 across worktrees. The
// old message said "did not pass"; a reader re-ran the whole thing to learn
// which. Signals do not round-trip through spawnSync on Windows the same way,
// so the case runs where it is deterministic and says so where it is not.
if (process.platform !== 'win32') {
    const fx = fixture({ runnerCalls: ['enteredByTheRunner'], runnerKilled: true });
    const r = run(['--root', fx.root, '--max-untested', '5']);
    check('a runner killed by SIGKILL exits 2 and says KILLED, naming the signal',
        r.status === 2 && !r.error && /KILLED by SIGKILL/.test(r.stderr) && !/Failed suite\(s\)/.test(r.stderr), detail(r));
    const j = run(['--root', fx.root, '--max-untested', '5', '--json']);
    let payload = null;
    try { payload = JSON.parse(j.stdout); } catch { /* asserted below */ }
    check('  --json: runnerSignal is SIGKILL and suitePassed is false',
        j.status === 2 && payload && payload.runnerSignal === 'SIGKILL' && payload.suitePassed === false, detail(j));
} else {
    console.log('SKIP  killed-runner case on win32 (signal reporting differs; covered on the Linux runner)');
}

// --- 7. --gate carries a dated floor ---------------------------------------------------
{
    const fx = fixture({ runnerCalls: ['enteredByTheRunner', 'neverEnteredByAnything'] });
    const r = run(['--root', fx.root, '--gate']);
    check('--gate prints the floor with a date and a commit',
        r.status === 0 && !r.error && /floor measured \d{4}-\d{2}-\d{2} at [0-9a-f]{7,}/.test(r.stdout), detail(r));
}

// --- 8. HEAD, on request only (see the header for why) --------------------------------
if (process.env.AUTODEV_COVERAGE_FULL === '1' && !process.env.NODE_V8_COVERAGE) {
    const r = run(['--gate', '--json'], 45 * 60 * 1000);
    let payload = null;
    try { payload = JSON.parse(r.stdout); } catch { /* asserted below */ }
    check('HEAD: the gate is green on this tree',
        r.status === 0 && !r.error && payload && payload.suitePassed === true
            && payload.gate && !payload.gate.overUntested && !payload.gate.overNeverLoaded,
        detail(r));
    if (payload) console.log(`HEAD census: ${payload.functionsSeen} named functions, ${payload.untested.length} never called, ${payload.filesNeverLoaded.length} never loaded; floor ${payload.gate.floorMeasured}`);
} else {
    console.log('SKIP  HEAD run: set AUTODEV_COVERAGE_FULL=1 to run it here (tens of minutes; recurses under'
        + ' NODE_V8_COVERAGE). Verified instead by the check:coverage step of npm run gate and CI.');
}

let failed = 0;
for (const [label, ok, d] of cases) {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
    if (!ok) { failed++; console.log('        ' + String(d).replace(/\n/g, '\n        ')); }
}
console.log(`${cases.length - failed}/${cases.length} assertions passed`);
process.exit(failed ? 1 : 0);
