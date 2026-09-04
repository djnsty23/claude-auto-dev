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
// `--legacy` since 2026-09-02: `--off` is retired and refuses without it. It is
// kept here rather than removed because writing a deny is the ONLY way to create
// the state the --on, --expire and --status scenarios restore from. Deleting the
// write path would delete the coverage of the restore path with it, which is
// the half that still has to work — a deny written by an earlier version of this
// tool must remain findable and clearable.
const OFF = ['--off', '--legacy', '--hours', '8', '--reason', 'suite fixture run'];

function run(home, args, cwd) {
    return spawnSync(process.execPath, [SUBJECT].concat(args), {
        env: Object.assign({}, process.env, { USERPROFILE: home, HOME: home }),
        encoding: 'utf8',
        cwd: cwd || process.cwd(),
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

    check('4c coordinator ROOT CHECKOUT is NOT denied', !denies(coordinator),
        'the panel is how the coordinator reaches the user');

    // `[measured 2026-08-29]` this assertion used to demand the OPPOSITE, and
    // that is how three spawned sessions ended up stopped on panels nobody was
    // watching. A worktree cut from the coordinator's clone is a spawned
    // session's workspace, not the coordinator's; sparing it by NAME spares the
    // wrong thing, because a name identifies a clone and never a directory.
    check('4d a coordinator WORKTREE the Brain is not in IS denied', denies(coordWt),
        'a spawned session lives here and a panel is a full stop for it');
}

// ---------------- 4bis. the directory the process is IN is spared, whatever its name

{
    const home = makeHome();
    const managed = makeRepo(home, 'someproj');
    const coordinator = makeRepo(home, 'claude-auto-dev');
    const brainWt = makeWorktree(coordinator, 'brain-lives-here');
    const otherWt = makeWorktree(coordinator, 'spawned-session');

    // Run the subject FROM the worktree a Brain would be sitting in. Name rules
    // cannot distinguish these two directories; only cwd can.
    run(home, OFF, brainWt);

    check('4e planted positive: an ordinary managed repo IS denied', denies(managed),
        'without this, 4f and 4g pass on a subject that denied nothing at all');
    check('4f the worktree the process runs IN is NOT denied', !denies(brainWt),
        'a coordinator that cannot ask has lost the channel that carries a decision');
    check('4g a SIBLING coordinator worktree IS denied', denies(otherWt),
        'same clone, same name, different directory - only one of them is the Brain');
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
    //
    // `--legacy` is present for 2026-09-02's retirement, and it is load-bearing
    // rather than incidental. Without it every assertion in this scenario would
    // be satisfied by the RETIREMENT refusal instead of the window-and-reason
    // one, so the window check could be deleted entirely and scenario 9 would
    // stay green. That is the same "passes while measuring something else"
    // failure the fixture-home comment below was written for, arriving through
    // a different door.
    const bare = run(home, ['--off', '--legacy']);
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
    const noReason = run(h2, ['--off', '--legacy', '--hours', '8']);
    check('9c --hours without --reason is refused', noReason.status !== 0,
        'exit ' + noReason.status);
    check('9d the refused no-reason run denied nothing', !denies(r2));

    const h3 = makeHome(); const r3 = makeRepo(h3, 'someproj');
    const noHours = run(h3, ['--off', '--legacy', '--reason', 'overnight fleet run']);
    check('9e --reason without --hours is refused', noHours.status !== 0,
        'a reason without a window still outlives its coordination');
    check('9f the refused no-hours run denied nothing', !denies(r3));

    // Planted positive. Without it every assertion above passes on a subject that
    // refuses unconditionally, which is a worse tool than the one being fixed.
    const h4 = makeHome(); const r4 = makeRepo(h4, 'someproj');
    const ok = run(h4, ['--off', '--legacy', '--hours', '8', '--reason', 'overnight fleet run']);
    check('9g planted positive: --off with both arguments succeeds', ok.status === 0 && denies(r4),
        'exit ' + ok.status + ' stdout=' + JSON.stringify(ok.stdout));
}

// ---------- 9bis. --off is RETIRED, and the retirement is not unconditional
//
// This scenario exists because 9g is a planted positive guarding against "a
// subject that refuses unconditionally", and the retirement below is exactly
// the change that could turn this tool into one. So both halves are asserted:
// the documented invocation refuses, AND the escape hatch still writes.
//
// The retirement is real rather than cosmetic — a Brain following the usage text
// can no longer deny panels — and it is a speed bump rather than a wall, because
// removing the write path would remove the only way to CREATE the state that
// every restore scenario in this file depends on.
{
    const h = makeHome();
    const repo = makeRepo(h, 'someproj');

    // Fully specified, and still refused: nothing is missing except --legacy.
    const retired = run(h, ['--off', '--hours', '8', '--reason', 'overnight fleet run']);
    check('9h a COMPLETE --off is refused now that it is retired', retired.status === 2,
        'exit ' + retired.status);
    check('9i the refusal points at the replacement, not just at itself',
        /AWAY\.md/.test(retired.stderr || '') && /away-state/.test(retired.stderr || ''),
        JSON.stringify((retired.stderr || '').slice(0, 120)));
    check('9j it says the restore half is NOT retired, so nobody deletes a live deny',
        /--on, --expire and --status are NOT retired/.test(retired.stderr || ''));
    check('9k the refused run denied nothing', !denies(repo),
        'a refusal that still writes is worse than no refusal');

    // The control that keeps 9h honest: same argv plus --legacy, and it works.
    // Without this, 9h passes against a --off that refuses for any reason at all.
    const h2 = makeHome(); const r2 = makeRepo(h2, 'someproj');
    const legacy = run(h2, ['--off', '--legacy', '--hours', '8', '--reason', 'overnight fleet run']);
    check('9l planted positive: --legacy still writes, so 9h is about the retirement',
        legacy.status === 0 && denies(r2), 'exit ' + legacy.status);
}

// ---------- 10. the deny is self-describing, beside the settings it applies to

{
    const home = makeHome();
    const repo = makeRepo(home, 'someproj');
    const wt = makeWorktree(repo, 'a-worktree');

    run(home, ['--off', '--legacy', '--hours', '8', '--reason', 'overnight fleet run']);

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
    run(home, ['--off', '--legacy', '--hours', '8', '--reason', 'overnight fleet run']);

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
    run(home, ['--off', '--legacy', '--hours', '8', '--reason', 'overnight fleet run']);

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

// ---------- 13. --off refuses to silently deny a LIVE session's panels

// Plant a transcript so scanFleet sees a session in `dir`. fleet-status derives
// its root from USERPROFILE, the same seam the rest of this suite uses, so this
// stays inside the fixture home.
function plantSession(home, dir, minutesIdle) {
    const slug = 'C--fixture-' + path.basename(dir);
    const d = path.join(home, '.claude', 'projects', slug);
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, 'sess-' + path.basename(dir) + '.jsonl');
    const ts = new Date(Date.now() - minutesIdle * 60000).toISOString();
    fs.writeFileSync(f, JSON.stringify({
        cwd: dir, sessionId: 'fixture-' + path.basename(dir), timestamp: ts,
        message: { role: 'assistant', content: [] },
    }) + '\n', 'utf8');
    const t = new Date(Date.now() - minutesIdle * 60000);
    fs.utimesSync(f, t, t);   // idleMinutes comes from the file's mtime
    return f;
}

{
    const home = makeHome();
    const repo = makeRepo(home, 'someproj');
    const busy = makeWorktree(repo, 'has-a-live-session');
    const quiet = makeWorktree(repo, 'nobody-here');
    plantSession(home, busy, 1);        // 1 minute idle = working

    const r = run(home, OFF);
    check('13a --off refuses while a live session holds a target', r.status !== 0,
        'exit ' + r.status + ' - silently denying a running session its only channel to the'
        + ' operator is the failure this exists to stop');
    check('13b it names the location it refused over', /has-a-live-session/.test((r.stdout || '') + (r.stderr || '')),
        'a refusal that does not say WHICH is not actionable');
    check('13c nothing was denied by the refused run', !denies(busy) && !denies(quiet),
        'a refusal that still writes is worse than no refusal');

    // --force is the deliberate override, and it must still work: the overnight
    // case cannot depend on a message channel whose p90 delivery is ~48 minutes.
    const f = run(home, OFF.concat(['--force']));
    check('13d --force proceeds', f.status === 0, 'exit ' + f.status);
    check('13e planted positive: --force denied the live location', denies(busy));
    check('13f planted positive: --force denied the quiet one too', denies(quiet));
}

// ---------- 14. a QUIET location is denied without ceremony

{
    const home = makeHome();
    const repo = makeRepo(home, 'someproj');
    const quiet = makeWorktree(repo, 'nobody-here');
    plantSession(home, quiet, 4000);   // ~2.8 days idle = cold, not live

    const r = run(home, OFF);
    // The discriminating control for scenario 13: without this, 13a passes on a
    // subject that refuses unconditionally, which would make --off unusable.
    check('14a a cold session does not block --off', r.status === 0, 'exit ' + r.status);
    check('14b and the location IS denied', denies(quiet));
}

// ---------- 15. liveness it CANNOT determine is treated as the dangerous case

{
    // Copy the subject somewhere fleet-status.js is NOT beside it, so its
    // require fails for real. No production seam, no stub, no env flag - the
    // failure is genuine and the shipped bytes are unmodified.
    //
    // This scenario exists because a mutation survived without it: disabling the
    // could-not-tell branch left the suite green at 55/55. An untested safety
    // branch is not a safety branch.
    const home = makeHome();
    const repo = makeRepo(home, 'someproj');
    const lone = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-lonely-'));
    const copy = path.join(lone, 'brain-panels.js');
    fs.copyFileSync(SUBJECT, copy);

    const r = spawnSync(process.execPath, [copy].concat(OFF), {
        env: Object.assign({}, process.env, { USERPROFILE: home, HOME: home }),
        encoding: 'utf8',
    });
    const out = (r.stdout || '') + (r.stderr || '');

    check('15a unknown liveness REFUSES rather than proceeding', r.status !== 0,
        'exit ' + r.status + ' - an unrecognised state must be the dangerous case');
    check('15b it says liveness could not be determined', /could not determine/i.test(out), out.slice(0, 160));
    check('15c nothing was denied', !denies(repo));

    // Planted positive: the same copy, same broken require, must still proceed
    // under --force. Without this, 15a passes on a subject that refuses always.
    const f = spawnSync(process.execPath, [copy].concat(OFF).concat(['--force']), {
        env: Object.assign({}, process.env, { USERPROFILE: home, HOME: home }),
        encoding: 'utf8',
    });
    check('15d planted positive: --force still works with liveness unknown',
        f.status === 0 && denies(repo), 'exit ' + f.status);
}

// ---------- 16. --expire prunes the MARKER too, or --on resurrects what expired

// Added after running the repo's own check:vacuity against this suite: 36 of 90
// mutants survived, and the sharpest was a dropped negation in expire()'s marker
// prune - `filter(e => !gone.has(e.repo))` becoming `filter(e => gone.has(...))`.
// That inversion keeps exactly the expired entries and drops the live ones, so a
// later --on puts back the deny --expire just cleared. Nothing asserted on it.

{
    const home = makeHome();
    const stale = makeRepo(home, 'staleproj');
    const live = makeRepo(home, 'liveproj');
    run(home, OFF);

    const rp = path.join(stale, '.claude', 'panel-deny.json');
    const rec = readJSON(rp);
    check('16z precondition: a sibling record exists to age', !!rec);
    if (rec) {
        rec.expiresAt = new Date(Date.now() - 3600 * 1000).toISOString();
        fs.writeFileSync(rp, JSON.stringify(rec, null, 2) + '\n', 'utf8');
    }

    run(home, ['--expire']);
    const marker = readJSON(path.join(home, '.claude', 'brain-panels-marker.json'));
    const inMarker = (dir) => !!(marker && (marker.repos || []).some((e) => e.repo === dir));

    check('16a the expired entry is GONE from the marker', !inMarker(stale),
        'left in, --on below puts the deny straight back');
    check('16b the live entry SURVIVES in the marker', inMarker(live),
        'pruned wrongly, --on can no longer restore a deny this tool set - the '
        + 'exact inversion a dropped negation produces');

    // The behavioural consequence, which is what actually matters and what no
    // amount of inspecting the marker proves.
    run(home, ['--on']);
    check('16c --on does NOT resurrect the expired deny', !denies(stale),
        'expire cleared it and on brought it back: the round trip is broken');
    check('16d --on DID restore the live one', !denies(live),
        'planted positive - if --on restored nothing, 16c passes for the wrong reason');
}

// ---------- 17. malformed state on disk must not crash the tool

// The vacuity run left a cluster of survivors in the null-safety chains
// (`j && j.permissions && Array.isArray(...)`), because every fixture until now
// was well formed, so mutating a guard changed nothing. This exercises the
// guards with input that is actually broken.
//
// Not chasing the remaining survivors beyond this: they are defensive branches
// whose failure mode is a crash on input this covers, and section 7 of
// rule-diagnosis is explicit that fewer gates better diagnosed beats more.

{
    const home = makeHome();
    const good = makeRepo(home, 'goodproj');
    const bad = makeRepo(home, 'badproj');
    const weird = makeRepo(home, 'weirdproj');

    fs.mkdirSync(path.join(bad, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(bad), '{ this is not json', 'utf8');
    // Valid JSON, wrong SHAPE - permissions.deny a string rather than an array.
    writeSettings(weird, { permissions: { deny: 'AskUserQuestion' } });

    const r = run(home, ['--status']);
    check('17a --status survives a corrupt settings file', r.status === 0,
        'exit ' + r.status + ' stderr=' + JSON.stringify((r.stderr || '').slice(0, 120)));
    check('17b and reports a population rather than dying', /scanned/.test(r.stdout || ''),
        (r.stdout || '').slice(0, 120));

    // A deny recorded as a STRING is not a deny list. Treating it as one would
    // be a false positive; ignoring it silently would be a false negative. The
    // tool should not count it, because it cannot act on it either.
    check('17c a wrong-shaped deny is not counted as denied', !denies(weird));

    const o = run(home, OFF);
    check('17d --off still works alongside malformed neighbours', o.status === 0,
        'exit ' + o.status);
    check('17e planted positive: the well-formed repo IS denied', denies(good));
    check('17f the corrupt file was not silently overwritten with a deny',
        fs.readFileSync(settingsPath(bad), 'utf8').startsWith('{ this is not json')
        || denies(bad),
        'either it was left alone or it was rewritten - both are defensible, but '
        + 'it must not be half-written');
}

// ------------------------------------------- 18. the code directory is not fixed
//
// THE BUG THIS SUITE COULD NOT SEE, AND WHY. Every fixture above builds its repos
// under HOME/Downloads/code, which is precisely the path the subject used to
// hardcode. The suite therefore CREATED the assumption it was meant to test, and
// the layout could never be wrong here. [measured 2026-08-28] on a Mac whose
// checkouts live in ~/Code, readdirSync threw, the catch returned [], and --off
// printed "panels DENIED in 0 location(s)" while writing a marker recording
// "repos": []. A six-hour window was believed to be constraining five live
// sessions and was constraining nothing.
//
// These scenarios build repos somewhere ELSE on purpose.

{
    // ~/Code, the macOS layout that broke it.
    const home = makeHome();
    const dir = path.join(home, 'Code', 'alpha');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });

    const r = run(home, OFF.concat(['--force']));
    check('18a: ~/Code layout is discovered, not skipped', denies(dir),
        'stdout: ' + (r.stdout || '').slice(0, 200) + ' stderr: ' + (r.stderr || '').slice(0, 200));
    check('18b: and it does not report a zero', !/DENIED in 0 location/.test(r.stdout || ''), r.stdout);
}

{
    // A candidate with no case twin. ~/Code alone cannot prove the list is
    // respected: macOS is case-INSENSITIVE, so ~/Code and ~/code are one
    // directory and deleting either candidate leaves the other matching. The
    // mutation "drop ~/Code from the list" survived scenario 18a for exactly that
    // reason - the same /var vs /private/var family of trap this repo already
    // tracks. ~/Projects has no such twin, so dropping it is visible here.
    const home = makeHome();
    const dir = path.join(home, 'Projects', 'gamma');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });

    const r = run(home, OFF.concat(['--force']));
    check('18i: ~/Projects is discovered too', denies(dir),
        'stdout: ' + (r.stdout || '').slice(0, 200) + ' stderr: ' + (r.stderr || '').slice(0, 200));
}

{
    // AUTODEV_CODE_DIR overrides everything, including a present ~/Code.
    const home = makeHome();
    const decoy = path.join(home, 'Code', 'decoy');
    fs.mkdirSync(path.join(decoy, '.git'), { recursive: true });
    const elsewhere = path.join(home, 'somewhere-else');
    const real = path.join(elsewhere, 'beta');
    fs.mkdirSync(path.join(real, '.git'), { recursive: true });

    const r = spawnSync(process.execPath, [SUBJECT].concat(OFF, ['--force']), {
        env: Object.assign({}, process.env, { USERPROFILE: home, HOME: home, AUTODEV_CODE_DIR: elsewhere }),
        encoding: 'utf8',
    });
    check('18c: AUTODEV_CODE_DIR is honoured', denies(real), (r.stdout || '') + (r.stderr || ''));
    check('18d: and the default candidate is NOT also swept', !denies(decoy), r.stdout);
}

{
    // The refusal. A deny matching nothing must not report success, and must not
    // leave a marker claiming a constraint that does not exist — that marker is
    // what made the failure invisible.
    const home = makeHome();
    const empty = path.join(home, 'no-repos-here');
    fs.mkdirSync(empty, { recursive: true });

    const r = spawnSync(process.execPath, [SUBJECT].concat(OFF, ['--force']), {
        env: Object.assign({}, process.env, { USERPROFILE: home, HOME: home, AUTODEV_CODE_DIR: empty }),
        encoding: 'utf8',
    });
    check('18e: zero locations exits non-zero', r.status !== 0, 'status ' + r.status);
    check('18f: zero locations says REFUSING', /REFUSING: 0 locations/.test(r.stderr || ''), r.stderr);
    check('18g: does NOT print a success line', !/panels DENIED/.test(r.stdout || ''), r.stdout);
    check('18h: writes no marker', !fs.existsSync(path.join(home, '.claude', 'brain-panels-marker.json')),
        'a marker claiming a constraint that does not exist is how this stayed invisible');
}

// ------------------------------- 19. a deny --on cannot remember, and must clear
//
// `git worktree add` copies the repo root's `.claude/` directory. A worktree
// created AFTER a deny therefore comes up already denying, carrying a copy of the
// sibling record, and it cannot possibly be in the marker — the marker was written
// before it existed.
//
// [measured 2026-08-28] a deny set on a managed repo root at 14:25 was inherited
// by two worktrees created at 18:35 and 18:38. --on iterated the marker alone,
// printed "panels restored", and left both denied. Two fresh sessions silently
// lost their only channel to the operator.
//
// Every assertion below failed before the two-pass restore existed.

{
    const home = makeHome();
    const repo = makeRepo(home, 'orchard');
    const known = makeWorktree(repo, 'known-at-deny-time');

    const off = run(home, OFF.concat(['--force']));
    check('19a: fixture precondition — the deny took', denies(repo), off.stdout + off.stderr);

    // The worktree the operator's tooling creates an hour later, inheriting
    // .claude/ wholesale: the deny AND its sibling record.
    const late = makeWorktree(repo, 'created-after-the-deny');
    fs.mkdirSync(path.join(late, '.claude'), { recursive: true });
    fs.copyFileSync(settingsPath(repo), settingsPath(late));
    fs.copyFileSync(path.join(repo, '.claude', 'panel-deny.json'),
        path.join(late, '.claude', 'panel-deny.json'));
    check('19b: fixture precondition — the late worktree inherited the deny', denies(late));

    const on = run(home, ['--on']);
    const out = (on.stdout || '') + (on.stderr || '');

    check('19c: the recorded location is restored', !denies(repo), out.slice(0, 300));
    check('19d: the known worktree is restored', !denies(known), out.slice(0, 300));
    // THE ASSERTION. Not in the marker, still denied, must still be cleared.
    check('19e: the LATE worktree is cleared even though the marker never saw it',
        !denies(late), out.slice(0, 400));
    check('19f: and --on says so rather than clearing it silently',
        /NOT in the marker/.test(out), out.slice(0, 400));
    check('19g: it verifies by re-reading, and reports zero still denying',
        /verified: 0 of \d+ scanned/.test(out), out.slice(0, 400));

    // The second bug in the same function: the inline restore never deleted the
    // sibling record, so a cleared location still looked denied to --status.
    check('19h: sibling record removed from the recorded repo',
        !fs.existsSync(path.join(repo, '.claude', 'panel-deny.json')));
    check('19i: sibling record removed from the late worktree',
        !fs.existsSync(path.join(late, '.claude', 'panel-deny.json')));
}

{
    // No marker at all — the 26-hour incident in this file's header. --on used to
    // exit early on a missing marker, so the obvious command could not clear the
    // exact situation the header describes.
    const home = makeHome();
    const repo = makeRepo(home, 'orphaned');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(repo),
        JSON.stringify({ permissions: { deny: ['AskUserQuestion'] } }, null, 2) + '\n', 'utf8');
    check('19j: fixture precondition — denied with no marker', denies(repo));

    const on = run(home, ['--on']);
    check('19k: a marker-less deny is still cleared', !denies(repo),
        ((on.stdout || '') + (on.stderr || '')).slice(0, 300));
}

{
    // The known-positive control. Without it, 19e and 19k would both pass against
    // a version that simply deleted every settings file it could find.
    const home = makeHome();
    const repo = makeRepo(home, 'untouched');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    const mine = { permissions: { deny: ['Bash(rm:*)'] }, model: 'opus' };
    fs.writeFileSync(settingsPath(repo), JSON.stringify(mine, null, 2) + '\n', 'utf8');

    const on = run(home, ['--on']);
    const out = (on.stdout || '') + (on.stderr || '');
    check('19l: a settings file we never touched survives --on',
        fs.existsSync(settingsPath(repo)), out.slice(0, 300));
    check('19m: and its own rules are left exactly as they were',
        JSON.stringify(readSettings(repo)) === JSON.stringify(mine),
        JSON.stringify(readSettings(repo)));
    check('19n: with nothing denying, --on reports a real all-clear',
        /real all-clear/.test(out), out.slice(0, 300));
}

// ------------------------------- 20. the record carries no settings contents
//
// The deny record is a sibling INSIDE the repo it describes, and this repo is
// public. It used to store `before` — the prior settings.local.json, verbatim —
// which on a coordinator's machine carries permission entries naming the paths of
// every other repo that machine works on. The leak did not come from anything
// this tool wrote; it came from copying settings it did not author.
//
// Asserted on the RAW TEXT rather than on the absence of a `before` key. A key
// check passes the moment the field is renamed or nested, and the property that
// matters is that the path is not in the file at all, however it got there.

{
    const home = makeHome();
    const repo = makeRepo(home, 'someproj');
    const SECRET = '~/Code/a-private-thing';
    const prior = { permissions: { deny: ['SomeoneElsesRule'], allow: ['Bash(git -C ' + SECRET + ' status)'] } };
    writeSettings(repo, prior);

    const r = run(home, OFF);
    const recPath = path.join(repo, '.claude', 'panel-deny.json');
    const raw = fs.existsSync(recPath) ? fs.readFileSync(recPath, 'utf8') : '';

    // Planted positive. Without it, "the path is not in the record" is
    // indistinguishable from "the fixture never had the path", from "--off did
    // nothing", and from "the record was never written".
    check('20a planted positive: the settings really do carry the path',
        (readSettings(repo).permissions.allow || []).join(' ').includes(SECRET),
        JSON.stringify(readSettings(repo)));
    check('20b planted positive: --off ran and denied', denies(repo),
        'exit ' + r.status + ' ' + (r.stderr || '').slice(0, 200));
    check('20c planted positive: a record was written', raw.length > 0, recPath);

    check('20d the record does not contain the private path', !raw.includes(SECRET),
        raw.slice(0, 400));
    check('20e nor any home-relative path at all', !/~\//.test(raw), raw.slice(0, 400));
    check('20f it still carries what a restore needs',
        (() => { const j = readJSON(recPath); return !!(j && j.expiresAt && j.setAt && j.reason && j.created); })(),
        raw.slice(0, 400));
}

// ------------------------------- 21. a reason naming a path is refused at write
//
// Dropping `before` closes the mechanical half. The other half is typed: --reason
// is free text, stored verbatim in that same in-repo record. One real reason
// named four repositories. Refusing at write time is the only moment anyone is
// positioned to fix it — afterwards the file exists and the tree gate is the
// backstop, not the fix.

{
    const home = makeHome();
    const repo = makeRepo(home, 'someproj');

    const bad = run(home, ['--off', '--legacy', '--hours', '8', '--reason', 'silencing ~/Code/a-private-thing overnight']);
    check('21a a reason containing a path is refused', bad.status !== 0,
        'exit ' + bad.status + ' ' + (bad.stdout || '').slice(0, 200));
    check('21b the refused run denied nothing', !denies(repo));
    check('21c and wrote no record', !fs.existsSync(path.join(repo, '.claude', 'panel-deny.json')));
    check('21d it says which fragment it objected to',
        /~\/Code/.test(bad.stderr || ''), (bad.stderr || '').slice(0, 300));

    // The other half of the decision. A rule that refuses every reason would pass
    // 21a while making --off unusable, which is the same defect one level up.
    const good = run(home, ['--off', '--legacy', '--hours', '8', '--reason', 'overnight fleet run']);
    check('21e a reason that names no path is still accepted', good.status === 0,
        'exit ' + good.status + ' ' + (good.stderr || '').slice(0, 200));
    check('21f and it denied', denies(repo));
}

// ------------------------------- 22. restore is subtractive, so it cannot revert
//
// The reason the fix is a better restore rather than a scrubbed copy of the old
// one. Replaying `before` verbatim is a lost update: it reverts anything written
// to that file DURING the deny window. A deny window is precisely when several
// sessions are being coordinated, so that is not a hypothetical.
//
// This scenario fails against a verbatim restore, which is what makes it worth
// having: 22d is the assertion the old implementation could not pass.

{
    const home = makeHome();
    const repo = makeRepo(home, 'someproj');
    writeSettings(repo, { permissions: { deny: ['SomeoneElsesRule'] } });

    run(home, OFF);
    check('22a planted positive: denied', denies(repo));

    // Another session edits the same file while the deny stands.
    const during = readSettings(repo);
    during.permissions.allow = ['Bash(npm test)'];
    writeSettings(repo, during);

    run(home, ['--on']);

    const after = readSettings(repo);
    check('22b the deny entry is gone', !denies(repo), JSON.stringify(after));
    check('22c the rule that was there before survives',
        !!(after && after.permissions && (after.permissions.deny || []).includes('SomeoneElsesRule')),
        JSON.stringify(after));
    check('22d the edit made DURING the window survives',
        !!(after && after.permissions && (after.permissions.allow || []).includes('Bash(npm test)')),
        JSON.stringify(after));
}

// ------------------------------- 23. the record is written before the deny
//
// Two files, one intent, and a process can die between them. Written
// deny-then-record, a crash leaves a deny with nothing beside it: UNACCOUNTED,
// which no session may clear. Written record-then-deny, a crash leaves a record
// with no deny, which nothing reads. `[measured 2026-09-04]` ten denies across
// two repos from one bulk write, no record beside any, stuck until the operator
// personally authorised clearing them. This scenario forces the crash: the
// settings path is a DIRECTORY, so the deny write throws, and the assertion is
// about what was on disk when it did. Reverting the order fails 23b.

{
    const home = makeHome();
    // Alphabetical enumeration puts 'aaa-broken' first, so the crash happens
    // before the healthy repo is reached and the run can write nothing there.
    const broken = makeRepo(home, 'aaa-broken');
    const healthy = makeRepo(home, 'zzz-healthy');
    fs.mkdirSync(settingsPath(broken), { recursive: true });

    const r = run(home, OFF);
    check('23a the run crashed on the unwritable location', r.status !== 0, 'exit ' + r.status);
    check('23b the record was on disk before the deny was attempted',
        fs.existsSync(path.join(broken, '.claude', 'panel-deny.json')));
    check('23c the crashed location does not deny', !denies(broken));
    check('23d nothing past the crash was written', !denies(healthy)
        && !fs.existsSync(path.join(healthy, '.claude', 'panel-deny.json')));

    // A record with no deny must be invisible to the scan: --status classifies
    // locations that DENY, so a stranded record is not a phantom finding.
    const st = run(home, ['--status']);
    check('23e --status reports the crashed location as neither denied nor unaccounted',
        /currently deny AskUserQuestion across 2 scanned, 0 live, 0 EXPIRED, 0 unaccounted/.test(st.stdout || ''),
        (st.stdout || '').slice(0, 300));

    // Control: with nothing broken, the same run leaves record AND deny.
    const home2 = makeHome();
    const ok = makeRepo(home2, 'someproj');
    const r2 = run(home2, OFF);
    check('23f control - a healthy run writes both', r2.status === 0 && denies(ok)
        && fs.existsSync(path.join(ok, '.claude', 'panel-deny.json')), 'exit ' + r2.status);
}

// ------------------------------------------------------------------- report

// DERIVED, not hand-maintained. It read a hardcoded `22` until 2026-09-02, and
// it was already wrong by one before anything was added to this file: scenario
// `4bis` existed and was never counted. A population line exists so a reader can
// tell a real run from a no-op, and one that cannot move when the population
// moves is the same silent-rot failure it was written to prevent — measured here
// as 24 against a claim of 22.
//
// Counting the section headers in this file rather than the checks, because a
// scenario is the unit a reader is being told about. `[0-9]+[a-z]*` on purpose:
// `4bis` and `9bis` are real scenarios and a digits-only pattern drops them,
// which is how the count went stale in the first place.
const SCENARIOS = (fs.readFileSync(__filename, 'utf8')
    .match(/^\/\/ -+ [0-9]+[a-z]*\./gm) || []).length;

console.log('population: ' + (passed + failures.length) + ' assertions across ' + SCENARIOS + ' scenarios, subject '
    + path.relative(process.cwd(), SUBJECT));
if (failures.length) {
    console.log('FAIL ' + failures.length + ', pass ' + passed);
    for (const f of failures) console.log('  x ' + f);
    process.exit(1);
}
console.log('PASS ' + passed);
