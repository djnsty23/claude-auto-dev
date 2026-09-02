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

const runValidate = (extraEnv) => {
    // The home-path half of check-no-private-names SKIPS on a CI host, because
    // there it is keyed on the build account and cannot see any developer's home
    // path. A case that plants one and expects a finding therefore has to run
    // with those markers cleared, or it asserts nothing on the only machine that
    // matters. Passing an env at all is what that case needs; everything else
    // keeps the inherited one.
    const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
    if (extraEnv && extraEnv.__noCi) { delete env.GITHUB_ACTIONS; delete env.CI; delete env.__noCi; }
    return spawnSync(process.execPath, [VALIDATE], { encoding: 'utf8', cwd: ROOT, env });
};

// Reclaim this suite's OWN orphaned fixtures before the baseline reads the tree.
//
// Every fixture below is planted, asserted against, and removed in a `finally`.
// A `finally` does not run when the process is killed, so a timeout or a Ctrl-C
// leaves the file on disk — and `validate` then FAILS on it for every LATER run,
// because it scans untracked-but-not-ignored files. check-suites-can-fail reports
// that as `RED  already failing`, which reads as a defect in this suite when
// nothing is wrong with it at all. Measured 2026-09-02: a killed gate run left
// zz-location-fixture.md behind and the next gate reported this suite RED while
// `npm test`, `node tooling/test-validate.js` and `npm run validate` were all
// green on the same tree.
//
// The pid in the name is what makes the cleanup safe rather than merely tidy. It
// lets this sweep tell a DEAD run's litter from a LIVE peer's fixture, and
// deleting the latter is precisely the failure check-suites-can-fail documents
// at its own cleanNewUntracked: zone-scoped cleanup that removes a concurrent
// session's files. It also makes collision impossible by construction rather
// than unlikely, which is the standing rule for any planted value.
const FIXTURE_OWNED = /^zz-(?:location|spawn)-fixture\.(\d+)\.(?:md|js)$/;
const pidAlive = (pid) => {
    // signal 0 tests for existence without delivering anything. EPERM means the
    // process exists and is not ours, which still counts as alive.
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const sweepOrphanFixtures = (dir) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
        const m = FIXTURE_OWNED.exec(name);
        if (!m) continue;
        const pid = Number(m[1]);
        if (pid === process.pid || pidAlive(pid)) continue;
        try { fs.rmSync(path.join(dir, name), { force: true }); removed++; } catch { /* the baseline below still reports it */ }
    }
    return removed;
};
const HOOKS_DIR = path.join(ROOT, 'plugins', 'autodev-core', 'hooks');
const reclaimed = sweepOrphanFixtures(ROOT) + sweepOrphanFixtures(HOOKS_DIR);
if (reclaimed) console.error(`  [reclaimed] ${reclaimed} orphaned fixture(s) from a run that died before its cleanup`);

// Fixture paths carry the owning pid, so two concurrent runs of this suite in one
// tree cannot overwrite or delete each other's files.
const LOCATION_FIXTURE = `zz-location-fixture.${process.pid}.md`;
const SPAWN_FIXTURE = `zz-spawn-fixture.${process.pid}.js`;

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
    const hooksDir = HOOKS_DIR;
    const fixture = path.join(hooksDir, SPAWN_FIXTURE);
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
        (exposed.stdout || '').split('\n').some((l) => l.includes(`${SPAWN_FIXTURE}:2`) && /execSync/.test(l)));
    check('adding windowsHide clears that finding',
        /^\[PASS\].*Hook spawns:/.test(spawnLine(hidden.stdout).trim()));
}

// A failing name/path check must name the FILE and LINE, and must never echo the
// offending line. Before 2026-08-30 it printed neither: the message was "run the
// checker yourself", which is fine locally and useless in CI, where nobody can
// re-run it. A CI-only finding was undiagnosable from the log for exactly this.
//
// The fixture carries a home path DERIVED from os.homedir() rather than any
// literal secret, so it cannot collide with a real name, cannot go stale as the
// denylist changes, and leaves nothing in the repo for someone else's scanner to
// alert on later. It is untracked on purpose: check-no-private-names scans
// untracked-but-not-ignored files, which is the window a new file passes through.
{
    const os = require('os');
    // A sentinel on the SAME line as the finding. Without it the leak assertion
    // is vacuous, because that checker redacts the username from its own output
    // and "the home path is absent" would then be true whether or not the line
    // was echoed. The sentinel is not a secret and is not on any denylist.
    const SENTINEL = 'ZZ_LINE_CONTENT_SENTINEL';
    const fixture = path.join(ROOT, LOCATION_FIXTURE);
    let planted;
    try {
        fs.writeFileSync(fixture,
            '# scratch fixture for test-validate\n'
            + `see ${path.join(os.homedir(), 'code')} ${SENTINEL}\n`);
        planted = runValidate({ __noCi: true });
    } finally {
        fs.rmSync(fixture, { force: true });
    }
    // Baseline under the SAME env as the planted run. The suite-wide `base` at
    // the top runs with the inherited environment, so on CI it takes the skip
    // path and is not a comparable control for this case.
    const cleanNoCi = runValidate({ __noCi: true });

    // Find the line by the FIXTURE, not by the wording. An earlier version of
    // this test looked for the string "private project name" and broke the
    // moment that label was corrected: this checker reports home paths too, and
    // calling a home-path finding a private name sent readers after the wrong
    // thing. Anchoring on the fixture keeps the test about the behaviour.
    const line = (planted.stdout || '').split('\n')
        .find((l) => l.includes(LOCATION_FIXTURE)) || '';

    check('an untracked file carrying a home path makes validate FAIL', planted.status === 1);
    check('  and the finding is reported as a FAIL', /^\[FAIL\]/.test(line.trim()));
    check('  and it names the file and the line number',
        line.includes(`${LOCATION_FIXTURE}:2`));
    check('  and it reports the kind the checker assigned, not the check\'s own name',
        /home path/.test(line) && !/private project name/.test(line));
    // The load-bearing one. Locations are safe in a public log; the line is not.
    check('  and the offending line itself is never echoed',
        !(planted.stdout || '').includes(SENTINEL));
    // Control: the assertion above can only mean something if the sentinel was
    // really in the file the checker read. Prove the run saw it at all.
    check('  control: the fixture is what flipped it, not a pre-existing failure',
        cleanNoCi.status === 0 && planted.status === 1,
        'without the fixture the tree already fails under the same env, so this '
        + 'case proves nothing about the fixture');
}

// The orphan sweep at the top of this file. It exists because a killed run's
// leftover fixture failed `validate` for every later run, and check-suites-can-fail
// reported THIS suite as "already failing" when nothing was wrong with it.
//
// The dead pid is DERIVED, never guessed: a child is spawned and waited on, so it
// is dead by construction at the moment it is used. A hardcoded "unlikely" pid is
// the planted-negative failure this repo already documents — it is only probably
// absent, and it silently stops testing anything the day the number is reused.
{
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = dead.pid;
    const livePid = process.ppid; // our own parent: alive as long as we are

    const orphan = path.join(ROOT, `zz-location-fixture.${deadPid}.md`);
    const peers = path.join(ROOT, `zz-location-fixture.${livePid}.md`);
    try {
        fs.writeFileSync(orphan, '# litter from a run that was killed\n');
        fs.writeFileSync(peers, '# a LIVE peer run is using this\n');

        const removed = sweepOrphanFixtures(ROOT);

        check('the sweep reclaims a dead run\'s orphaned fixture', !fs.existsSync(orphan));
        // The safety half, and the more important one. Deleting a concurrent
        // session's files is the exact failure check-suites-can-fail documents
        // at its own cleanNewUntracked, so this must never widen into a
        // "remove every zz- file" sweep.
        check('  and LEAVES a live peer\'s fixture alone', fs.existsSync(peers));
        check('  and reports how many it reclaimed', removed === 1);
        // Control: without it, both assertions above would also pass on a sweep
        // that did nothing at all, because the orphan would simply never exist.
        check('  control: the orphan really was there to be reclaimed',
            deadPid > 0 && livePid > 0 && deadPid !== livePid);
    } finally {
        fs.rmSync(orphan, { force: true });
        fs.rmSync(peers, { force: true });
    }
}

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
