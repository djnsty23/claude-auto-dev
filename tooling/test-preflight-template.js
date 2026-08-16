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

let pass = 0, fail = 0;
for (const [label, okk] of cases) {
    console.log((okk ? 'PASS' : 'FAIL') + '  ' + label);
    okk ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
