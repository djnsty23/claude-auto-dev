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
function fixture({ runnerCalls, extraFile = false, secondLib = false, runnerFails = false, runnerKilled = false, runnerChatty = false, emptyPlugins = false }) {
    const root = path.join(TMP, 'fx' + (++n));
    const scripts = path.join(root, 'plugins', 'fx', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(path.join(root, 'tooling'), { recursive: true });
    if (!emptyPlugins) fs.writeFileSync(path.join(scripts, 'fixture-census-lib.js'),
        'function enteredByTheRunner() { return 1; }\n' +
        'function neverEnteredByAnything() { return 2; }\n' +
        'module.exports = { enteredByTheRunner, neverEnteredByAnything };\n');
    if (extraFile) {
        fs.writeFileSync(path.join(scripts, 'fixture-census-orphan.js'),
            'function orphanFunction() { return 3; }\nmodule.exports = { orphanFunction };\n');
    }
    // `secondLib` is a second LOADED file whose one function nothing calls, so a
    // case can refuse the first file and still see the second graded.
    if (secondLib) {
        fs.writeFileSync(path.join(scripts, 'fixture-census-second.js'),
            'function secondNeverEntered() { return 4; }\nmodule.exports = { secondNeverEntered };\n');
    }
    const marker = path.join(root, 'runner-ran.marker');
    fs.writeFileSync(path.join(root, 'tooling', 'test-all.js'),
        `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n` +
        (emptyPlugins ? '' : "const lib = require('../plugins/fx/scripts/fixture-census-lib.js');\n") +
        (secondLib ? "require('../plugins/fx/scripts/fixture-census-second.js');\n" : '') +
        runnerCalls.map((f) => `lib.${f}();\n`).join('') +
        (runnerChatty ? "process.stdout.write('x'.repeat(2 * 1024 * 1024) + '\\n');\n" : '') +
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
    // Either separator: the tool prints path.relative(), which is backslashes on
    // Windows. `[measured 2026-09-08]` this was the one red line on windows-latest
    // in CI run 34209762305, with ubuntu green through the coverage step.
    check('  the file is named', /plugins[\/\\]fx[\/\\]scripts[\/\\]fixture-census-lib\.js/.test(r.stdout), detail(r));
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

// --- 6c. a CHATTY runner is a verdict, not a kill -----------------------------------
// `[measured 2026-09-08]` the review of this gate found that a runner printing
// past node's 1 MiB default maxBuffer was killed with SIGTERM and reported as
// KILLED. The output now goes to a file. This runner prints 2 MiB and then its
// PASS line; the gate must read the verdict through it.
{
    const fx = fixture({ runnerCalls: ['enteredByTheRunner', 'neverEnteredByAnything'], runnerChatty: true });
    const r = run(['--root', fx.root, '--max-untested', '0', '--json'], 120000);
    let payload = null;
    try { payload = JSON.parse(r.stdout); } catch { /* asserted below */ }
    check('a runner that prints 2 MiB before its PASS line still yields a verdict: exit 0, not KILLED',
        r.status === 0 && !r.error && payload && payload.suitePassed === true && payload.runnerSignal === null
            && payload.functionsSeen === 2 && payload.executed === 2, detail(r));
    check('  and the output size is reported past the old 1 MiB cliff',
        !!payload && payload.runnerOutputBytes > 1024 * 1024, payload ? String(payload.runnerOutputBytes) : 'unparsed');
}

// --- 6d. an EMPTY census is no verdict --------------------------------------------
// rule-gate-integrity §2, found by the second review (2026-09-08): a plugins/
// directory with no source files scored 0 against the ceiling and passed --gate.
// "No output never differs from no output." Exit 2, the same class as a red
// runner; never 0, never 1.
{
    // --platform linux on every --gate call from here on: the floors are per
    // platform, and these cases are about the census, not about which host
    // happens to run them.
    const fx = fixture({ runnerCalls: [], emptyPlugins: true });
    const r = run(['--root', fx.root, '--gate', '--platform', 'linux']);
    check('a plugins/ directory with no source files is NO VERDICT: exit 2, not a clean floor',
        r.status === 2 && !r.error && /nothing was measured/.test(r.stderr) && /NO VERDICT/.test(r.stderr), detail(r));
    check('  control: the runner ran and passed, so the suite is not what refused', ranRunner(fx), fx.marker);
    const j = run(['--root', fx.root, '--gate', '--platform', 'linux', '--json']);
    let payload = null;
    try { payload = JSON.parse(j.stdout); } catch { /* asserted below */ }
    check('  --json: exit 2, suitePassed true, emptyCensus names the reason, sourceFiles 0',
        j.status === 2 && payload && payload.suitePassed === true && payload.sourceFiles === 0
            && typeof payload.emptyCensus === 'string' && /nothing was measured/.test(payload.emptyCensus), detail(j));
    const bare = run(['--root', fx.root]);
    check('  bare mode refuses the same census rather than printing "every function is entered"',
        bare.status === 2 && !bare.error && !/Every named function/.test(bare.stdout), detail(bare));
    const ok = fixture({ runnerCalls: ['enteredByTheRunner', 'neverEnteredByAnything'] });
    const g = run(['--root', ok.root, '--gate', '--platform', 'linux']);
    check('  control: the two-function fixture under --gate still exits 0', g.status === 0 && !g.error && /2 named function\(s\)/.test(g.stdout), detail(g));
}

// --- 7. --gate carries a dated floor, and names the platform it belongs to ---------------
{
    const fx = fixture({ runnerCalls: ['enteredByTheRunner', 'neverEnteredByAnything'] });
    const r = run(['--root', fx.root, '--gate', '--platform', 'linux']);
    check('--gate prints the floor with its platform, a date and a commit',
        r.status === 0 && !r.error && /linux floor measured \d{4}-\d{2}-\d{2} at [0-9a-f]{7,}/.test(r.stdout), detail(r));
}

// --- 7b. a platform with no measured floor is NO VERDICT, and the host picks the floor ---
// `[measured 2026-09-13]` on Windows the suite was green and --gate exited 1 at 94
// against a floor of 40 measured on macOS: 61 of the 94 cannot run on win32 by
// design. One floor for every host read a platform difference as "this change
// added plugin code no suite enters". A floor is a claim about the platform it was
// measured on, so an unmeasured platform refuses (exit 2) before the suite runs.
{
    const fx = fixture({ runnerCalls: ['enteredByTheRunner'] });
    const r = run(['--root', fx.root, '--gate', '--platform', 'plan9'], 15000);
    check('--gate on a platform with no measured floor exits 2 (no verdict), naming the platform',
        r.status === 2 && !r.error && /NO VERDICT: no coverage floor has been measured for plan9/.test(r.stderr), detail(r));
    check('  and did not run the suite', !ranRunner(fx), fx.marker);

    // Explicit ceilings need no floor, so the same platform grades normally.
    const ex = fixture({ runnerCalls: ['enteredByTheRunner'] });
    const e = run(['--root', ex.root, '--gate', '--platform', 'plan9', '--max-untested', '0', '--max-never-loaded', '0']);
    check('control: the same unmeasured platform with both ceilings explicit still grades (exit 1 on the dead function)',
        e.status === 1 && !e.error && /✗ neverEnteredByAnything\(\)/.test(e.stdout) && ranRunner(ex), detail(e));

    for (const bad of [[], ['Linux!']]) {
        const b = fixture({ runnerCalls: ['enteredByTheRunner'] });
        const m = run(['--root', b.root, '--gate', '--platform', ...bad], 15000);
        check(`a malformed --platform (${bad.length ? JSON.stringify(bad[0]) : 'missing'}) exits 2 and does not run the suite`,
            m.status === 2 && !m.error && /--platform needs a platform name/.test(m.stderr) && !ranRunner(b), detail(m));
    }

    // With no --platform the HOST's platform chooses the floor. Either it has one
    // and the verdict names it, or it has none and the refusal names it; a gate
    // that graded every host against one platform's floor passes neither branch
    // on any host but that one.
    const h = fixture({ runnerCalls: ['enteredByTheRunner', 'neverEnteredByAnything'] });
    const hr = run(['--root', h.root, '--gate', '--json']);
    let hp = null;
    try { hp = JSON.parse(hr.stdout); } catch { /* the refusal branch prints no JSON */ }
    const graded = hr.status === 0 && hp && hp.gate && hp.gate.platform === process.platform && typeof hp.gate.floorMeasured === 'string';
    const refused = hr.status === 2 && new RegExp('no coverage floor has been measured for ' + process.platform + '\\.').test(hr.stderr);
    check(`without --platform the host's floor is used (${process.platform}): graded under it, or refused naming it`,
        !hr.error && (graded || refused), detail(hr));
}

// --- 7c. code a platform refuses by design is its own population, never a silent pass ----
// `[measured 2026-09-13]` the mission runtime's 57 functions are never entered on
// win32 because the store refuses without process.getuid, and a floor that counted
// them would go red on Windows for every mission change. They are reported apart
// and not graded, and a listing whose refusal did not happen is NO VERDICT.
// Fixtures name the file with --refused; the host table never applies to --root.
{
    const LIB = 'plugins/fx/scripts/fixture-census-lib.js';
    const fx = fixture({ runnerCalls: ['enteredByTheRunner'] });
    const r = run(['--root', fx.root, '--max-untested', '0', '--refused', LIB]);
    check('a refused file\'s never-called function is not graded: exit 0 under a ceiling of 0',
        r.status === 0 && !r.error, detail(r));
    check('  and it is printed as its own population, with the count beside the graded one',
        /REFUSED BY DESIGN/.test(r.stdout) && /fixture-census-lib\.js: 1 \(named with --refused\)/.test(r.stdout)
            && /0 never-called function\(s\) vs ceiling 0 \(\+1 refused by design, not graded\)/.test(r.stdout), detail(r));
    check('  and the census still counts it as never called', /1 NEVER CALLED/.test(r.stdout), detail(r));
    const j = run(['--root', fx.root, '--max-untested', '0', '--refused', LIB, '--json']);
    let payload = null;
    try { payload = JSON.parse(j.stdout); } catch { /* asserted below */ }
    check('  --json: exit 0, gate.graded 0, refusedByDesign.count 1, untested still lists the function',
        j.status === 0 && payload && payload.gate && payload.gate.graded === 0
            && payload.refusedByDesign && payload.refusedByDesign.count === 1
            && payload.untested.length === 1 && payload.staleRefused === null, detail(j));
    const plain = run(['--root', fx.root, '--max-untested', '0', '--json']);
    let pp = null;
    try { pp = JSON.parse(plain.stdout); } catch { /* asserted below */ }
    check('control: without --refused the same tree exits 1, and a --root run carries no host exclusions',
        plain.status === 1 && pp && pp.refusedByDesign === null && pp.gate.graded === 1, detail(plain));

    // Refusing one file must not hide a never-called function in another.
    const two = fixture({ runnerCalls: ['enteredByTheRunner'], secondLib: true });
    const t = run(['--root', two.root, '--max-untested', '0', '--refused', LIB]);
    check('a never-called function in a file NOT refused is still graded: exit 1, named',
        t.status === 1 && !t.error && /✗ secondNeverEntered\(\)/.test(t.stdout) && !/✗ neverEnteredByAnything\(\)/.test(t.stdout), detail(t));

    // Stale listings: the refusal they describe did not happen on this run.
    for (const [label, opts, file, why] of [
        ['a refused file that does not exist', { runnerCalls: ['enteredByTheRunner'] }, 'plugins/fx/scripts/no-such-file.js', 'no such file'],
        ['a refused file that was never loaded', { runnerCalls: ['enteredByTheRunner'], extraFile: true }, 'plugins/fx/scripts/fixture-census-orphan.js', 'never loaded'],
        ['a refused file whose functions were all entered', { runnerCalls: ['enteredByTheRunner', 'neverEnteredByAnything'] }, LIB, 'no never-called function'],
    ]) {
        const s = fixture(opts);
        const sr = run(['--root', s.root, '--max-untested', '5', '--max-never-loaded', '5', '--refused', file]);
        check(`${label} is a stale listing: exit 2 (no verdict), naming why`,
            sr.status === 2 && !sr.error && /NO VERDICT: stale refused-by-design listing/.test(sr.stderr)
                && sr.stderr.includes(why), detail(sr));
    }

    const m = fixture({ runnerCalls: ['enteredByTheRunner'] });
    const mr = run(['--root', m.root, '--max-untested', '0', '--refused'], 15000);
    check('a --refused with no path exits 2 and does not run the suite',
        mr.status === 2 && !mr.error && /--refused needs a plugin-relative file path/.test(mr.stderr) && !ranRunner(m), detail(mr));
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
