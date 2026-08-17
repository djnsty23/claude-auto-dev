#!/usr/bin/env node
// Tests for validate.js checks that are not covered by simply running it green.
//
// Run: node tooling/test-validate.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VALIDATE = path.join(ROOT, 'tooling', 'validate.js');

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

const runValidate = () => spawnSync(process.execPath, [VALIDATE], { encoding: 'utf8', cwd: ROOT });

// Baseline: the repo must be green, or nothing below distinguishes anything.
const base = runValidate();
check('validate is green on a clean tree', base.status === 0);

// The stale-mutation-backup check. This is the only guard against the one defect
// class no test can catch — a mutant that survives its suite is by definition
// invisible to it. Three reached the public remote on 2026-08-16 while every
// gate stayed green.
//
// The marker file is created inside the repo, so it is removed in a finally:
// leaving one behind would fail every later run of this very check.
const marker = path.join(ROOT, 'plugins', 'autodev-core', 'scripts', '.test-subject.js.vacuity-backup');
let withMarker;
try {
    fs.writeFileSync(marker, 'placeholder');
    withMarker = runValidate();
} finally {
    fs.rmSync(marker, { force: true });
}

check('a stale .vacuity-backup makes validate FAIL', withMarker.status === 1);
// Asserted as a line of its OWN, not merely present in the output. The weaker
// `.includes(name)` version was vacuous: the restore-hint line also contains the
// filename, so deleting the listing line entirely left the assertion green. One
// output line masking another — the same shape check-suites-can-fail cannot see.
check('  and the failure lists the file on its own line',
    (withMarker.stdout || '').split('\n').some((l) => {
        const t = l.trim();
        return t.endsWith('.test-subject.js.vacuity-backup') && !t.includes('restore with');
    }));
check('  and gives a restore command', /restore with: git checkout --/.test(withMarker.stdout || ''));

// Removing it must clear the failure, or the check is a one-way trap.
const after = runValidate();
check('removing the backup clears the failure', after.status === 0);

// find-untested-hooks.js — a hook wired into hooks.json that no suite drives.
//
// Asserted against the real repo rather than a fixture, because the script
// resolves its root from __dirname and pointing it elsewhere would mean testing
// a different code path than the one that runs.
//
// The property that matters is not the count — that changes as hooks get tests.
// It is that a hook mentioned ONLY in a comment does not read as covered.
// post-tool-typecheck.js looked tested for exactly that reason, and the stale
// comment naming it is still in tooling/test-knowledge-injection.js today.
{
    const HOOKS = path.join(ROOT, 'tooling', 'find-untested-hooks.js');
    const r = spawnSync(process.execPath, [HOOKS, '--json'], { encoding: 'utf8', cwd: ROOT });
    let out = null;
    try { out = JSON.parse(r.stdout); } catch { /* stays null */ }

    check('find-untested-hooks emits parseable JSON', out !== null);
    check('  it finds the wired hooks at all', (out?.wired || 0) > 0);

    const names = (out?.untested || []).map((u) => u.name);

    // A comment mention must not count as coverage.
    //
    // Pinned to a hook that HAS no suite, not to a named one. The first version
    // asserted post-tool-typecheck.js was untested; writing its suite made that
    // assertion fail, which is the correct outcome arriving as a broken test.
    // An assertion tied to a fact the work is meant to change is a chore, so
    // this asserts the PROPERTY instead: whatever is currently untested must
    // still be reported, and comments must not rescue it.
    // Correct when the list is empty, and the empty case is now the real one:
    // every wired hook has a suite. An earlier version required length > 0 to
    // avoid a vacuous pass, which pinned it to hooks BEING untested — so
    // finishing the work broke the test. That is the second time in two turns;
    // the fix is to assert the invariant and cover emptiness separately below.
    check('every reported hook really has no resolving suite',
        (out?.untested || []).every((u) => (u.covering || []).length === 0));

    // Non-vacuous companion: every wired hook is accounted for either way, so
    // this fails if the tool starts returning nothing at all.
    check('every wired hook is reported with its covering suites',
        (out?.wiredRows || []).length === (out?.wired || -1) && (out?.wired || 0) > 0);

    // post-tool-typecheck.js is the case that motivated this tool: it was named
    // in another suite's stale header comment and driven by nothing. It now has
    // a real suite, so it must be reported as COVERED — and covered by that
    // suite specifically, which is what proves resolution works rather than a
    // filename happening to appear somewhere.
    const ptt = (out?.wiredRows || []).find?.((r) => r.name === 'post-tool-typecheck.js');
    check('a hook that gained a suite is no longer reported',
        !names.includes('post-tool-typecheck.js'));
    check('  and comments alone never made it look covered',
        ptt === undefined || (ptt.covering || []).includes('test-post-tool-typecheck.js'));

    // A hook a suite genuinely drives must NOT be listed. stop-auto-check.js is
    // resolved by path.join in test-stop-auto-check.js.
    check('a hook a suite actually drives is not listed',
        !names.includes('stop-auto-check.js'));

    // Exit code carries the answer, for anyone wiring this into a gate later.
    check('exits non-zero while any hook is untested',
        names.length > 0 ? r.status === 1 : r.status === 0);
}

// checkHookSpawnsHidden — a hook spawn that can pop a console window on Windows.
//
// Asserted on the check's OWN output line, not on the exit status. The fixture is
// a real file dropped into hooks/, so other checks can react to it too, and an
// exit-1 assertion would then pass for the wrong reason — a mutation caught by a
// different gate proves nothing about the gate under test.
{
    const hooksDir = path.join(ROOT, 'plugins', 'autodev-core', 'hooks');
    const fixture = path.join(hooksDir, 'zz-spawn-fixture.js');
    const spawnLine = (out) => (out || '').split('\n').find((l) => /Hook spawns|hook spawn site/.test(l)) || '';

    // Baseline: the real hooks are all hidden, and the PASS line prints the
    // population it scanned rather than a bare verdict.
    const cleanLine = spawnLine(base.stdout);
    check('the spawn check passes on the real hooks', /^\[PASS\].*Hook spawns:/.test(cleanLine.trim()));
    check('  and reports the population it scanned', /\d+ site\(s\) across \d+ hook file\(s\)/.test(cleanLine));

    let exposed, hidden;
    try {
        // An execSync with NO windowsHide — the exact defect.
        fs.writeFileSync(fixture,
            "const { execSync } = require('child_process');\n" +
            "execSync('git status', { stdio: 'ignore' });\n");
        exposed = runValidate();

        // Same file, same call, windowsHide added: the finding must clear. This is
        // the half that proves the check reads the option rather than the call name.
        fs.writeFileSync(fixture,
            "const { execSync } = require('child_process');\n" +
            "execSync('git status', { stdio: 'ignore', windowsHide: true });\n");
        hidden = runValidate();
    } finally {
        fs.rmSync(fixture, { force: true });
    }

    const exposedLine = spawnLine(exposed.stdout);
    check('an unhidden hook spawn is reported as a FAIL', /^\[FAIL\]/.test(exposedLine.trim()));
    check('  and names the offending file and line',
        (exposed.stdout || '').split('\n').some((l) => /zz-spawn-fixture\.js:2\s+execSync/.test(l)));
    check('adding windowsHide clears that finding',
        /^\[PASS\].*Hook spawns:/.test(spawnLine(hidden.stdout).trim()));
}

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
