#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/brain-panels.js - the tool that denies
// AskUserQuestion in the repos a Brain session coordinates, and puts it back.
// Run: node tooling/test-brain-panels.js
// Exits 1 on any failure; 0 if all pass.
//
// WHY THIS ONE NEEDS TESTING AT ALL.
//
// It had no suite until 2026-08-27, and on that morning a Brain boot found five
// worktrees still carrying a deny on this tool while the tool's own --status
// reported "no marker: this tool has not denied panels anywhere". Every failure
// mode below is that shape: the tool is honest about what it checked and still
// reads as an all-clear, because what it checks is narrower than where the state
// lives.
//
//   Worktree blind -> managedRepos() enumerates direct children of
//                     ~/Downloads/code. A worktree sits at
//                     <repo>/.claude/worktrees/<name>, one level deeper, so
//                     --off never writes it and --on can never clear it. Every
//                     live session in the fleet that morning ran from a
//                     worktree, which is precisely where the tool does not look.
//   False safety net -> the --off banner promised that a SessionEnd hook also
//                     restores, so a crash could not leave this set. No hook
//                     anywhere references brain-panels, and the brain skill says
//                     the absence is DELIBERATE: such a hook fires for every
//                     session, so a managed session ending would revert the very
//                     block constraining it. The line told the operator a crash
//                     was covered when nothing covered it.
//   Coordinator caught -> if the exclusion ever stops working, the coordinator
//                     loses its own panels, which is the one channel that
//                     carries a decision to the user.
//
// THE SEAM, AND WHY IT IS THE ONE THAT SHIPS.
//
// brain-panels.js resolves everything from USERPROFILE:
//
//     HOME   = process.env.USERPROFILE || process.env.HOME
//     CODE   = HOME/Downloads/code
//     MARKER = HOME/.claude/brain-panels-marker.json
//
// That is not a seam somebody added for tests - it is how the shipped script
// finds both its repo set and its marker. Pointing USERPROFILE at a fixture home
// therefore runs the exact bytes that ship, against a fleet of this suite's
// choosing, and cannot touch this machine's real repos or real marker.
//
// EVERY ZERO SITS BESIDE A PLANTED POSITIVE.
//
// "the worktree was not denied" and "the run did nothing at all" are the same
// observation from outside. So each scenario asserting an absence also asserts a
// presence produced by the same run - a top-level repo that must always be
// denied. A run reporting the planted positive and not the case under test is a
// run whose probe demonstrably fires.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'brain-panels.js');
const TOOL = 'AskUserQuestion';

let passed = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail ? '  -> ' + detail : ''));
}

// ---------------------------------------------------------------- fixture home

let fixtureCount = 0;
function makeHome() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-panels-' + (fixtureCount++) + '-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    return home;
}

// A repo is a directory under Downloads/code holding a .git entry. A worktree is
// the same thing nested at <repo>/.claude/worktrees/<name>, and git marks it with
// a .git FILE rather than a directory - reproduced here so the fixture matches
// what the tool meets on disk.
function makeRepo(home, name) {
    const dir = path.join(home, 'Downloads', 'code', name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    return dir;
}

function makeWorktree(repoDir, name) {
    const dir = path.join(repoDir, '.claude', 'worktrees', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ' + path.join(repoDir, '.git', 'worktrees', name) + '\n', 'utf8');
    return dir;
}

function settingsPath(dir) {
    return path.join(dir, '.claude', 'settings.local.json');
}

function writeSettings(dir, obj) {
    const p = settingsPath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    return p;
}

// Read any JSON, or null. Used for the sibling deny records as well as settings.
function readJSON(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function readSettings(dir) {
    try { return JSON.parse(fs.readFileSync(settingsPath(dir), 'utf8')); } catch { return null; }
}

function denies(dir) {
    const j = readSettings(dir);
    return !!(j && j.permissions && Array.isArray(j.permissions.deny) && j.permissions.deny.includes(TOOL));
}

// The valid --off invocation. Scenarios 1-8 are about what --off DOES; scenario 9
// is about what it REFUSES, and deliberately builds its own bare arguments.
const OFF = ['--off', '--hours', '8', '--reason', 'suite fixture run'];

function run(home, args) {
    return spawnSync(process.execPath, [SUBJECT].concat(args), {
        env: Object.assign({}, process.env, { USERPROFILE: home, HOME: home }),
        encoding: 'utf8',
    });
}

// ------------------------------------------------------- 1. worktree blindness

{
    const home = makeHome();
    const repo = makeRepo(home, 'someproj');
    const wt = makeWorktree(repo, 'feature-branch-a1b2c3');

    const r = run(home, OFF);

    // Planted positive: without this, "the worktree was not denied" is
    // indistinguishable from "--off did nothing".
    check('1a planted positive: top-level repo IS denied', denies(repo),
        'exit ' + r.status + ' stdout=' + JSON.stringify(r.stdout));

    check('1b worktree IS denied', denies(wt),
        'sessions run from worktrees; a deny that misses them protects nobody');
}

// ------------------------------------------------- 2. round trip clears both

{
    const home = makeHome();
    const repo = makeRepo(home, 'someproj');
    const wt = makeWorktree(repo, 'feature-branch-a1b2c3');

    run(home, OFF);

    // The INTERMEDIATE state is asserted first on purpose. Without it, 2b and 2c
    // pass against a subject that never denied the worktree at all - "cleared"
    // and "never set" are the same observation, and the whole scenario would be
    // vacuous exactly where the bug lives.
    check('2a precondition: worktree IS denied before --on runs', denies(wt),
        'if this fails, 2b and 2c below prove nothing');

    const r = run(home, ['--on']);

    check('2b planted positive: top-level repo no longer denied after --on', !denies(repo),
        'exit ' + r.status + ' stdout=' + JSON.stringify(r.stdout));

    check('2c worktree no longer denied after --on', !denies(wt),
        'a deny that --on cannot reach outlives every session able to restore it');

    // The tool created both files, so it must remove them rather than leave an
    // empty shell that reads as somebody deliberate.
    check('2d settings file the tool created is removed, not emptied',
        !fs.existsSync(settingsPath(wt)));
}

// --------------------------------------- 3. a prior deny is preserved verbatim

{
    const home = makeHome();
    const repo = makeRepo(home, 'someproj');
    writeSettings(repo, { permissions: { allow: ['Bash(ls *)'], deny: ['WebFetch'] } });

    run(home, OFF);
    check('3a planted positive: the tool added its deny alongside the existing one',
        denies(repo) && readSettings(repo).permissions.deny.includes('WebFetch'));

    run(home, ['--on']);
    const after = readSettings(repo);
    check('3b prior deny survives the round trip',
        !!after && after.permissions.deny.length === 1 && after.permissions.deny[0] === 'WebFetch',
        'restore must not delete a rule somebody else added: ' + JSON.stringify(after));
    check('3c prior allow survives the round trip',
        !!after && Array.isArray(after.permissions.allow) && after.permissions.allow[0] === 'Bash(ls *)');
}

// -------------------------------------------- 4. the coordinator keeps panels

{
    const home = makeHome();
    const managed = makeRepo(home, 'someproj');
    const managedWt = makeWorktree(managed, 'ordinary-work');
    const coordinator = makeRepo(home, 'claude-auto-dev');
    const coordWt = makeWorktree(coordinator, 'brain-session');

    run(home, OFF);

    check('4a planted positive: the managed repo IS denied', denies(managed));

    // The second planted positive is what stops 4c being vacuous. A subject that
    // denies no worktree anywhere would satisfy "coordinator worktree is not
    // denied" for entirely the wrong reason.
    check('4b planted positive: a MANAGED worktree IS denied', denies(managedWt),
        'without this, 4d passes on a subject blind to every worktree');

    check('4c coordinator repo is NOT denied', !denies(coordinator),
        'the panel is how the coordinator reaches the user');
    check('4d coordinator WORKTREE is NOT denied', !denies(coordWt),
        'excluding the repo but not its worktrees silences the coordinator anyway');
}

// ------------------------------- 5. the banner promises no hook that is absent

{
    const home = makeHome();
    makeRepo(home, 'someproj');
    const r = run(home, OFF);
    const out = (r.stdout || '') + (r.stderr || '');

    // GROUND TRUTH FIRST. The banner is only wrong relative to the repo, so the
    // repo is what gets measured: no hooks.json anywhere may reference this
    // script. If one is ever wired, this assertion fails and 5b below should be
    // revisited rather than the hook deleted.
    const hookDir = path.join(__dirname, '..', 'plugins');
    let hookRefs = 0;
    for (const plugin of fs.readdirSync(hookDir, { withFileTypes: true })) {
        if (!plugin.isDirectory()) continue;
        const hj = path.join(hookDir, plugin.name, 'hooks', 'hooks.json');
        try { if (fs.readFileSync(hj, 'utf8').includes('brain-panels')) hookRefs++; } catch { /* no hooks */ }
    }
    check('5a ground truth: no hooks.json references brain-panels', hookRefs === 0,
        hookRefs + ' hooks file(s) wire it, so the banner claim below may now be true');

    // A first version of this anchored on the words "session end" and then fired
    // on the CORRECTED banner, because explaining why no hook exists requires
    // naming the hook. The invariant is not a vocabulary, it is a claim: nothing
    // may assert that a hook performs the restore. A sentence denying it is the
    // wanted outcome and must pass.
    const promise = /\b(a|an|the)\s+\S*\s*hook\s+\S*\s*restores?\b/i;
    check('5b --off asserts no automatic restore that does not exist',
        !promise.test(out),
        'banner said: ' + JSON.stringify(out.split('\n').filter((l) => promise.test(l))));

    // Planted positives. Without these, 5b passes on a command that printed
    // nothing at all, and passes equally on one that dropped the subject.
    check('5c planted positive: --off still explains how to restore',
        /--on/.test(out), 'stdout=' + JSON.stringify(out));
    check('5d planted positive: the regex in 5b can actually fire',
        promise.test('  A SessionEnd hook also restores, so a crash does not leave this set.'),
        'a detector that cannot match the original defect proves nothing');
}

// ------------------------------------------- 6. a second --off refuses loudly

{
    const home = makeHome();
    const repo = makeRepo(home, 'someproj');
    run(home, OFF);
    const r = run(home, OFF);

    check('6a second --off exits 3', r.status === 3, 'exit was ' + r.status);
    check('6b the deny is still there, not doubled',
        denies(repo) && readSettings(repo).permissions.deny.length === 1);
}

// ------------------------------- 7. --status sees a deny it did not itself set

{
    const home = makeHome();
    const repo = makeRepo(home, 'someproj');
    const denied = makeWorktree(repo, 'set-by-someone-else');
    const clean = makeWorktree(repo, 'nobody-touched-this');

    // Set by hand, exactly as the five found on 2026-08-27 were: no marker
    // exists, so the marker-only report has nothing to say about it.
    writeSettings(denied, { permissions: { deny: [TOOL] } });

    const r = run(home, ['--status']);
    const out = (r.stdout || '') + (r.stderr || '');

    check('7a status reports the deny it did not set', /set-by-someone-else/.test(out),
        'the old marker-only report read as an all-clear here: ' + JSON.stringify(out));

    // Planted negative, impossible by construction rather than merely absent:
    // this worktree has no settings file at all, so a scan that reported it
    // would be inventing findings.
    check('7b status does not report a location that is not denied',
        !/nobody-touched-this/.test(out), out);

    check('7c status prints the population it scanned', /scanned/.test(out),
        'a bare count cannot be told apart from a scan that found nothing');

    // The report must not become a delete. "Not in my marker" and "stale" are
    // different claims; only one is safe to act on blind.
    check('7d status does not clear what it reports', denies(denied),
        'reporting is not licence to prune a rule somebody else set deliberately');
}

// ------------------- 8. the classifier separates a bulk write from a lone one

{
    const home = makeHome();
    const repo = makeRepo(home, 'someproj');
    const bulkA = makeWorktree(repo, 'bulk-a');
    const bulkB = makeWorktree(repo, 'bulk-b');
    const lone = makeWorktree(repo, 'lone-hand');

    for (const d of [bulkA, bulkB, lone]) writeSettings(d, { permissions: { deny: [TOOL] } });

    // Set the times EXPLICITLY rather than trusting three writes to land in the
    // same millisecond or in different ones. A planted signal that depends on
    // how fast the fixture happens to run is not a planted signal.
    const shared = new Date(Date.now() - 30 * 3600 * 1000);
    const alone = new Date(Date.now() - 5 * 3600 * 1000);
    fs.utimesSync(settingsPath(bulkA), shared, shared);
    fs.utimesSync(settingsPath(bulkB), shared, shared);
    fs.utimesSync(settingsPath(lone), alone, alone);

    const out = (run(home, ['--status']).stdout || '');
    const lineFor = (name) => (out.split('\n').find((l) => l.includes(name)) || '');

    check('8a a bulk write is called an orphan', /orphan/.test(lineFor('bulk-a')),
        'line was: ' + JSON.stringify(lineFor('bulk-a')));
    check('8b it counts the whole cluster, not just the sibling',
        /orphan, bulk write of 2 /.test(lineFor('bulk-b')),
        'line was: ' + JSON.stringify(lineFor('bulk-b')));

    // The discriminating half. Without this, 8a passes on a classifier that
    // labels EVERYTHING an orphan, which is the shape that would license a
    // blind prune of a rule somebody set deliberately.
    check('8c a lone recent write is NOT called an orphan', !/orphan/.test(lineFor('lone-hand')),
        'line was: ' + JSON.stringify(lineFor('lone-hand')));
    check('8d a lone recent write is flagged as possibly deliberate',
        /deliberate\?/.test(lineFor('lone-hand')), 'line was: ' + JSON.stringify(lineFor('lone-hand')));
}

// ---------- 9. --off refuses without an explicit window and a reason

{
    const home = makeHome();
    const repo = makeRepo(home, 'someproj');

    // Deliberately bare. Do NOT replace with OFF: this scenario is the one that
    // asserts the refusal, so the whole point is the missing arguments.
    const bare = run(home, ['--off']);
    check('9a bare --off is refused', bare.status !== 0,
        'a deny with no stated window is the one that outlives its coordination');
    check('9b nothing was denied by the refused run', !denies(repo),
        'a refusal that still writes is worse than no refusal');

    // EACH attempt below gets its OWN fixture home. Sharing one lets the first
    // --off create a marker, after which every later attempt hits the
    // marker-exists refusal (exit 3) rather than the check under test - so the
    // assertion passes while measuring something else. Caught on the baseline
    // run, where 9c passed against a subject with no reason-check at all.
    const h2 = makeHome(); const r2 = makeRepo(h2, 'someproj');
    const noReason = run(h2, ['--off', '--hours', '8']);
    check('9c --hours without --reason is refused', noReason.status !== 0,
        'exit ' + noReason.status);
    check('9d the refused no-reason run denied nothing', !denies(r2));

    const h3 = makeHome(); const r3 = makeRepo(h3, 'someproj');
    const noHours = run(h3, ['--off', '--reason', 'overnight fleet run']);
    check('9e --reason without --hours is refused', noHours.status !== 0,
        'a reason without a window still outlives its coordination');
    check('9f the refused no-hours run denied nothing', !denies(r3));

    // Planted positive. Without it every assertion above passes on a subject that
    // refuses unconditionally, which is a worse tool than the one being fixed.
    const h4 = makeHome(); const r4 = makeRepo(h4, 'someproj');
    const ok = run(h4, ['--off', '--hours', '8', '--reason', 'overnight fleet run']);
    check('9g planted positive: --off with both arguments succeeds', ok.status === 0 && denies(r4),
        'exit ' + ok.status + ' stdout=' + JSON.stringify(ok.stdout));
}

// ---------- 10. the deny is self-describing, beside the settings it applies to

{
    const home = makeHome();
    const repo = makeRepo(home, 'someproj');
    const wt = makeWorktree(repo, 'a-worktree');

    run(home, ['--off', '--hours', '8', '--reason', 'overnight fleet run']);

    // THE WHOLE POINT. On 2026-08-27 five denies were found whose central marker
    // was gone, so nothing could say when they were set, by whom, or whether they
    // were still wanted. State and its justification have to travel together.
    for (const [label, dir] of [['repo', repo], ['worktree', wt]]) {
        const rec = readJSON(path.join(dir, '.claude', 'panel-deny.json'));
        check('10' + (label === 'repo' ? 'a' : 'b') + ' ' + label + ' carries a sibling record',
            !!rec, 'no panel-deny.json beside the settings file');
        check('10' + (label === 'repo' ? 'c' : 'd') + ' ' + label + ' record states when it expires',
            !!(rec && rec.expiresAt && rec.setAt && rec.reason),
            JSON.stringify(rec));
    }
}

// ---------- 11. an EXPIRED deny is a fault, not a state

{
    const home = makeHome();
    const repo = makeRepo(home, 'someproj');
    run(home, ['--off', '--hours', '8', '--reason', 'overnight fleet run']);

    // Age it past its window by rewriting the record, then delete the central
    // marker to reproduce exactly what was found on disk that morning.
    const rp = path.join(repo, '.claude', 'panel-deny.json');
    const rec = readJSON(rp);
    // A missing record must FAIL this scenario, never throw. A suite that dies
    // here reports nothing about scenario 12, which is most of a baseline run's
    // value thrown away at the first unbuilt feature.
    check('11z precondition: a sibling record exists to age', !!rec,
        'absent, so 11a-c below cannot run; that is scenario 10 failing, surfaced here too');
    if (rec) {
        rec.expiresAt = new Date(Date.now() - 3600 * 1000).toISOString();
        fs.writeFileSync(rp, JSON.stringify(rec, null, 2) + '\n', 'utf8');
    }
    try { fs.unlinkSync(path.join(home, '.claude', 'brain-panels-marker.json')); } catch { /* none */ }

    const out = (run(home, ['--status']).stdout || '');
    check('11a status names the expired deny', /someproj/.test(out), out);
    check('11b status calls it EXPIRED rather than reporting it as a state',
        /EXPIRED/.test(out), 'a reassuring label on a fault is how this survived 26 hours: ' + out);
    check('11c status still works with NO central marker',
        !/^\s*$/.test(out) && /scan:/.test(out),
        'the marker being lost is the case this must survive');
}

// ---------- 12. --expire clears the expired and spares the live

{
    const home = makeHome();
    const stale = makeRepo(home, 'staleproj');
    const live = makeRepo(home, 'liveproj');
    run(home, ['--off', '--hours', '8', '--reason', 'overnight fleet run']);

    // Age ONLY staleproj. liveproj is the discriminating control: a sweep that
    // clears everything would satisfy 12a and is exactly the blind prune this
    // whole path exists to prevent.
    const rp = path.join(stale, '.claude', 'panel-deny.json');
    const rec = readJSON(rp);
    check('12z precondition: a sibling record exists to age', !!rec,
        'absent, so the discriminating control below cannot be set up');
    if (rec) {
        rec.expiresAt = new Date(Date.now() - 3600 * 1000).toISOString();
        fs.writeFileSync(rp, JSON.stringify(rec, null, 2) + '\n', 'utf8');
    }

    const r = run(home, ['--expire']);
    check('12a the expired deny is cleared', !denies(stale), 'exit ' + r.status + ' ' + r.stdout);
    check('12b the LIVE deny is untouched', denies(live),
        'clearing an unexpired deny discards a decision somebody made on purpose');
    check('12c the cleared sibling record is removed too',
        !fs.existsSync(path.join(stale, '.claude', 'panel-deny.json')));
    check('12d the live sibling record survives',
        fs.existsSync(path.join(live, '.claude', 'panel-deny.json')));
}

// ------------------------------------------------------------------- report

console.log('population: ' + (passed + failures.length) + ' assertions across 12 scenarios, subject '
    + path.relative(process.cwd(), SUBJECT));
if (failures.length) {
    console.log('FAIL ' + failures.length + ', pass ' + passed);
    for (const f of failures) console.log('  x ' + f);
    process.exit(1);
}
console.log('PASS ' + passed);
