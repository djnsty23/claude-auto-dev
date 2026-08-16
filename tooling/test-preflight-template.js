#!/usr/bin/env node
// Tests for the preflight template autodev scaffolds into projects.
//
// The template's own fourth law is "a gate never seen to fail is not known to
// work", so each of its three structural laws is exercised here by making it
// fail on purpose:
//
//   1. A gate that throws must be a HARD failure, not a warning. (A repo shipped
//      a green preflight because a renamed file turned a real gate into a skip.)
//   2. A stale KNOWN_RED entry — one whose check now passes — must fail the run.
//   3. The file must fail when nothing is wired to run it.
//
// Run: node tooling/test-preflight-template.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEMPLATE = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'templates', 'preflight.js');
const SRC = fs.readFileSync(TEMPLATE, 'utf8');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-test-')));
const cases = [];
const check = (label, ok) => cases.push([label, ok]);

let n = 0;
// Build a throwaway project with an optionally patched preflight.
function project({ wired = true, patch = (s) => s } = {}) {
    const dir = path.join(TMP, 'p' + ++n);
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'ok.js'), 'const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'probe',
        scripts: wired ? { preflight: 'node scripts/preflight.js' } : { test: 'echo hi' },
    }));
    fs.writeFileSync(path.join(dir, 'scripts', 'preflight.js'), patch(SRC));
    return dir;
}

function run(dir) {
    const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'preflight.js')], {
        encoding: 'utf8', cwd: dir,
    });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// --- Baseline: a correctly wired project passes.
let r = run(project());
check('wired project passes', r.status === 0);
check('reports PASS', /preflight: PASS/.test(r.out));

// --- Law: nothing runs it -> hard fail.
r = run(project({ wired: false }));
check('unwired preflight fails', r.status === 1);
check('says it is decoration', /decoration/.test(r.out));

// --- Law 1: a gate that throws is HARD, not a warning.
r = run(project({
    patch: (s) => s.replace(
        "gate('syntax', 'every shipped script parses', () => {",
        "gate('syntax', 'every shipped script parses', () => {\n    throw new Error('simulated broken gate');"
    ),
}));
check('a throwing gate fails the run', r.status === 1);
check('a throwing gate is reported as DID NOT RUN', /GATE DID NOT RUN/.test(r.out));
check('a throwing gate is not downgraded to a warning', !/⚠ .*simulated broken gate/.test(r.out));

// --- Law 3: a stale KNOWN_RED entry fails the run.
r = run(project({
    patch: (s) => s.replace(
        'const KNOWN_RED = {',
        "const KNOWN_RED = {\n    ghost: 'tracked against S1-001, but nothing reports it any more',"
    ),
}));
check('stale KNOWN_RED fails the run', r.status === 1);
check('stale KNOWN_RED is named', /STALE KNOWN_RED/.test(r.out));
check('stale entry identified by id', /ghost/.test(r.out));

// --- A genuinely tracked failure is tolerated, not fatal.
r = run(project({
    patch: (s) => s
        .replace('const KNOWN_RED = {', "const KNOWN_RED = {\n    flaky: 'blocked on S2-004',")
        .replace(
            "gate('gates-ran'",
            "gate('flaky', 'demonstrates a tracked failure', () => { trackedFail('flaky', 'still broken'); });\n\ngate('gates-ran'"
        ),
}));
check('tracked red does not fail the run', r.status === 0);
check('tracked red is surfaced as known', /known red \[flaky\]/.test(r.out));

// --- A real failure in an untracked gate still fails.
r = run(project({
    patch: (s) => s.replace(
        "gate('gates-ran'",
        "gate('real', 'demonstrates an untracked failure', () => { trackedFail('real', 'genuinely broken'); });\n\ngate('gates-ran'"
    ),
}));
check('untracked failure fails the run', r.status === 1);
check('untracked failure names the gate', /\[real\] genuinely broken/.test(r.out));

// --- Syntax gate catches a real parse error.
const broken = project();
fs.writeFileSync(path.join(broken, 'src', 'bad.js'), 'const = ;\n');
r = run(broken);
check('syntax gate catches an unparseable file', r.status === 1 && /does not parse/.test(r.out));

// --- a CI workflow that exists but never runs preflight is a SOFT warning.
//
// soft() was reported never entered: the warning at the end of the gates-ran
// gate sits inside `if (fs.existsSync(ciDir))`, and no fixture had a .github at
// all, so the whole block was skipped. A repo WITH CI that does not call
// preflight is the case worth warning about — it looks covered and is not.
{
    const dir = project();
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'),
        'jobs:\n  build:\n    steps:\n      - run: npm test\n');
    const r = run(dir);
    check('CI that never mentions preflight is warned about', /only guards local runs/.test(r.out));
    check('  and it is a warning, not a failure', r.status === 0);

    // And CI that DOES reference it says so instead.
    const dir2 = project();
    fs.mkdirSync(path.join(dir2, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir2, '.github', 'workflows', 'ci.yml'),
        'jobs:\n  build:\n    steps:\n      - run: npm run preflight\n');
    const r2 = run(dir2);
    check('CI that runs preflight is acknowledged', /referenced by CI/.test(r2.out));
    check('  and does not warn', !/only guards local runs/.test(r2.out));
}

// --- the syntax gate must not walk into node_modules.
//
// `e.name === 'node_modules' || e.name.startsWith('.')` mutated to `&&` skips
// nothing, and the gate then parse-checks every dependency in the tree. On a
// real project that is thousands of files and a guaranteed failure from some
// dependency shipping non-parsing source — a gate that always fails is a gate
// that gets removed. No fixture had a node_modules, so the mutant survived.
{
    const dir = project();
    // Syntactically broken files where the walker must never look.
    fs.mkdirSync(path.join(dir, 'src', 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'node_modules', 'dep', 'broken.js'), 'function ( { ]]];\n');
    fs.mkdirSync(path.join(dir, 'src', '.cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', '.cache', 'broken.js'), 'function ( { ]]];\n');

    // run() already merges stdout+stderr into `out`. An earlier version of this
    // block read r.stdout, which this helper does not return — so `out` was
    // undefined, the regex matched nothing, and the assertion passed vacuously
    // while the mutant lived. Read the helper before assuming its shape.
    const r = run(dir);
    const out = r.out || '';
    check('syntax gate ignores node_modules and dot-dirs',
        !/node_modules/.test(out) && !/\.cache/.test(out));

    // And it must still catch a broken file that IS in scope, or the guard above
    // could be "skip everything" and both assertions would pass.
    const dir2 = project();
    fs.writeFileSync(path.join(dir2, 'src', 'genuinely-broken.js'), 'function ( { ]]];\n');
    const r2 = run(dir2);
    check('  but a broken file in scope IS still caught', /genuinely-broken/.test(r2.out || ''));
}

let pass = 0, fail = 0;
for (const [label, okk] of cases) {
    console.log((okk ? 'PASS' : 'FAIL') + '  ' + label);
    okk ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
