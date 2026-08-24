#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/fleet-publish.js - the only script in
// this repo that writes into a git repository and pushes it.
// Run: node tooling/test-fleet-publish.js
// Exits 1 on any failure; 0 if all pass.
//
// WHY THIS SUITE EXISTS, and what it is actually guarding.
//
// Two behaviours here are expensive to get wrong, and neither fails loudly.
//
//   summarise()  is a PRIVACY BOUNDARY. Whatever it returns is written to a
//                file that a sync task commits and pushes, so a field added in
//                good faith - a title, a cwd, a branch, the text of a pending
//                question - leaves the machine and does not come back. The
//                boundary it actually draws is "counts, durations, and this
//                machine's own name": host, platform, publishedAt, windowDays,
//                sessions, blocked, oldestBlockedMin, byState, schema, and
//                nothing else.
//
//                So the privacy check does not compare against a hand-written
//                list of bad words. It derives EVERY string the fleet scan
//                produced for the same fixture - titles, cwds, branches,
//                worktree names, session ids, panel questions, option labels -
//                and asserts that none of them survives into the published
//                record. A new leaky field fails it without anyone remembering
//                to extend a list. The population of derived strings is printed
//                and asserted non-trivial, so an empty forbidden list cannot
//                pass as a clean sweep.
//
//   meaningful() is the only thing between a 5-minute timer and a commit-and-
//                push loop. It compares the record with publishedAt removed,
//                because publishedAt differs on every single run. A suite that
//                let an identical record through would be the expensive one:
//                the guard would read as tested and push forever.
//
// WHAT IS PINNED
//
//   --print      writes nothing at all, not even the output directory.
//   summarise    the exact field set, the counts, the byState tally, the
//                windowDays passthrough, and that oldestBlockedMin is the
//                OLDEST panel rather than the newest or the first.
//   meaningful   first run pushes; an identical record does not; a record that
//                differs only in publishedAt does not; changed counts do.
//   push         one file per commit by pathspec, a fixed commit subject, an
//                untracked neighbour left untouched (never `git add -A`), and
//                every git failure non-fatal with the file still on disk.
//   default      no --push means no commit, even when the counts changed.
//   --read       newest first, non-JSON skipped, unparseable skipped, and the
//                oldest-waiting clause present only when there is one.
//
// Everything is asserted on a child process's stdout, its exit status, the file
// it wrote, or the state of a real git repository built in a temp dir. Nothing
// requires the subject in-process and no assertion reads the subject's source.
//
// The fleet is a FIXTURE, never this machine. USERPROFILE/HOME, APPDATA and
// AUTODEV_FLEET_DIR are read at module load by fleet-status.js, and
// AUTODEV_FLEET_PUBLISH_DIR redirects the output. A suite that read the live
// fleet would assert "2 sessions" on a coin toss - and would push to a real
// repository, which is not a thing a test may do.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const SUBJECT = path.join(SCRIPTS, 'fleet-publish.js');
const FLEET_STATUS = path.join(SCRIPTS, 'fleet-status.js');
const HOST = os.hostname();

let pass = 0, fail = 0;

function check(label, ok, detail) {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  (' + detail + ')'}`);
}

function eq(label, actual, expected) {
    check(label, actual === expected,
        `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function has(label, haystack, needle) {
    check(label, String(haystack).includes(needle),
        `${JSON.stringify(needle)} not in ${JSON.stringify(String(haystack).slice(0, 400))}`);
}

function lacks(label, haystack, needle) {
    check(label, !String(haystack).includes(needle),
        `${JSON.stringify(needle)} unexpectedly present in ${JSON.stringify(String(haystack).slice(0, 400))}`);
}

function matches(label, haystack, re) {
    check(label, re.test(String(haystack)),
        `${re} did not match ${JSON.stringify(String(haystack).slice(0, 400))}`);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-publish-'));

// Pointing git's global and system config at a path that does not exist makes
// git read them as empty. Without this the operator's own config - signing,
// a global hooksPath, commit templates - decides whether the subject's commit
// succeeds, which would make this suite pass or fail for reasons that have
// nothing to do with the code under test.
const NOGIT = path.join(fixture, 'no-such-gitconfig');
const NOHOOKS = path.join(fixture, 'nohooks');

// The planted identifiers. Every one of these is content the published record
// must never carry. They are asserted explicitly AND rediscovered by the
// derivation below, so the suite fails whether or not someone maintains a list.
const SECRETS = [
    'SECRETPROJDIR', 'SECRETCWDONE', 'SECRETBRANCHONE', 'SECRETQUESTIONONE',
    'SECRETHEADERONE', 'SECRETOPTIONLABEL', 'SECRETOPTIONDESC', 'SECRETCWDTWO',
    'SECRETQUESTIONTWO', 'SECRETCWDTHREE', 'SECRETTITLE', 'SECRETWORKTREE',
    'SECRETORIGINCWD', 'secretmodelname', 'secreteffortname', 'local_SECRETADDR',
    'SECRETPRSTATE',
];

// Real session ids are UUIDs and fleet-status.js joins on them verbatim, so a
// fixture using friendly names would exercise a shape nothing ships.
const LID1 = 'a1111111-1111-4111-8111-111111111111';   // blocked, panel 200m old
const LID2 = 'a2222222-2222-4222-8222-222222222222';   // blocked, panel 40m old
const LID3 = 'a3333333-3333-4333-8333-333333333333';   // no panel
const QID1 = 'b1111111-1111-4111-8111-111111111111';
const QID2 = 'b2222222-2222-4222-8222-222222222222';
const QID3 = 'b3333333-3333-4333-8333-333333333333';
const QID4 = 'b4444444-4444-4444-8444-444444444444';
const XID1 = 'c1111111-1111-4111-8111-111111111111';   // blocked, unusable askedAt

function homeDirs(name) {
    const home = path.join(fixture, name);
    const dirs = {
        home,
        projects: path.join(home, '.claude', 'projects'),
        store: path.join(home, 'appdata', 'Claude', 'claude-code-sessions'),
        beats: path.join(home, 'beats'),
    };
    fs.mkdirSync(dirs.projects, { recursive: true });
    fs.mkdirSync(dirs.store, { recursive: true });
    fs.mkdirSync(dirs.beats, { recursive: true });
    return dirs;
}

function writeTranscript(dir, id, lines, ageMinutes) {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, id + '.jsonl');
    fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const t = new Date(Date.now() - ageMinutes * 60000);
    fs.utimesSync(p, t, t);
    return p;
}

function isoMinutesAgo(m) {
    return new Date(Date.now() - m * 60000).toISOString();
}

function panel(id, sessionId, ts, question, header, optLabel, optDesc) {
    const rec = {
        type: 'assistant', sessionId,
        message: {
            role: 'assistant',
            content: [{
                type: 'tool_use', name: 'AskUserQuestion', id,
                input: { questions: [{ question, header, multiSelect: false,
                    options: [{ label: optLabel, description: optDesc }] }] },
            }],
        },
    };
    // A panel line with NO timestamp is how the unusable-askedAt case is built.
    if (ts !== null) rec.timestamp = ts;
    return rec;
}

function line(role, sessionId, ts, body, extra) {
    return Object.assign({ type: role, sessionId, timestamp: ts,
        message: { role, content: body } }, extra || {});
}

const LOUD = homeDirs('loud');
const QUIET = homeDirs('quiet');
const BADTS = homeDirs('badts');

const PUBLISH_LOUD = path.join(fixture, 'publish-loud');
const PUBLISH_BADTS = path.join(fixture, 'publish-badts');
const PRINT_ONLY = path.join(fixture, 'print-only', 'fleet');
const READ_DIR = path.join(fixture, 'read-dir');
const READ_EMPTY = path.join(fixture, 'read-empty');
const READ_MISSING = path.join(fixture, 'read-missing');

// The repo the subject commits into. `push()` derives the repo from the PARENT
// of the publish dir, so the publish dir must sit one level inside it.
const REPO = path.join(fixture, 'repo');
const REPO_FLEET = path.join(REPO, 'fleet');
const NOREMOTE = path.join(fixture, 'noremote');
const NOREMOTE_FLEET = path.join(NOREMOTE, 'fleet');
const NOTAREPO_FLEET = path.join(fixture, 'notarepo', 'fleet');

function buildLoud() {
    const proj = path.join(LOUD.projects, 'SECRETPROJDIR');

    writeTranscript(proj, LID1, [
        line('user', LID1, isoMinutesAgo(220), 'start',
            { cwd: 'C:/clients/SECRETCWDONE/app', gitBranch: 'feature/SECRETBRANCHONE' }),
        panel('toolu_one', LID1, isoMinutesAgo(200),
            'Ship SECRETQUESTIONONE to prod?', 'SECRETHEADERONE',
            'SECRETOPTIONLABEL', 'SECRETOPTIONDESC'),
    ], 10);

    writeTranscript(proj, LID2, [
        line('user', LID2, isoMinutesAgo(45), 'start', { cwd: 'C:/clients/SECRETCWDTWO/app' }),
        panel('toolu_two', LID2, isoMinutesAgo(40),
            'Retry SECRETQUESTIONTWO?', 'Retry', 'Yes', 'go on'),
    ], 5);

    writeTranscript(proj, LID3, [
        line('assistant', LID3, isoMinutesAgo(60), 'done', { cwd: 'C:/clients/SECRETCWDTHREE/app' }),
    ], 60);

    fs.writeFileSync(path.join(LOUD.store, 'local_one.json'), JSON.stringify({
        sessionId: 'local_SECRETADDR', cliSessionId: LID1, title: 'SECRETTITLE',
        worktreeName: 'SECRETWORKTREE', originCwd: 'C:/clients/SECRETORIGINCWD',
        model: 'secretmodelname', effort: 'secreteffortname',
        lastActivityAt: Date.now(), isArchived: false,
        prs: [{ number: 987654, state: 'SECRETPRSTATE' }],
    }));
}

function buildBadTs() {
    // The ONLY blocked session here has a panel with no timestamp at all, so
    // Date.parse(askedAt) is NaN. It must still be counted as blocked while
    // contributing no duration.
    writeTranscript(path.join(BADTS.projects, 'proj'), XID1, [
        line('user', XID1, isoMinutesAgo(20), 'start', { cwd: 'C:/work/x' }),
        panel('toolu_x', XID1, null, 'no timestamp on this panel', 'X', 'A', 'a'),
    ], 20);
}

function buildQuiet() {
    const proj = path.join(QUIET.projects, 'proj');
    // No desktop records and no heartbeats, so addressableId is null and the
    // 'stalled' branches cannot fire. Both ages sit far from every classify
    // boundary, so two runs seconds apart produce byte-identical counts - which
    // is the precondition for testing the push guard at all.
    writeTranscript(proj, QID1, [line('assistant', QID1, isoMinutesAgo(30), 'resting',
        { cwd: 'C:/work/q1' })], 30);          // waiting
    writeTranscript(proj, QID2, [line('assistant', QID2, isoMinutesAgo(2000), 'old',
        { cwd: 'C:/work/q2' })], 2000);        // cold
}

function addQuietSession(id, ageMinutes) {
    writeTranscript(path.join(QUIET.projects, 'proj'), id,
        [line('assistant', id, isoMinutesAgo(ageMinutes), 'resting', { cwd: 'C:/work/' + id })],
        ageMinutes);
}

function buildRead() {
    fs.mkdirSync(READ_DIR, { recursive: true });
    fs.mkdirSync(READ_EMPTY, { recursive: true });
    fs.writeFileSync(path.join(READ_DIR, 'alpha.json'), JSON.stringify({
        host: 'alpha', platform: 'darwin', publishedAt: isoMinutesAgo(30),
        windowDays: 2, sessions: 5, blocked: 2, oldestBlockedMin: 47,
        byState: { blocked: 2, waiting: 3 }, schema: 1,
    }));
    fs.writeFileSync(path.join(READ_DIR, 'bravo.json'), JSON.stringify({
        host: 'bravo', platform: 'linux', publishedAt: isoMinutesAgo(120),
        windowDays: 2, sessions: 3, blocked: 0, oldestBlockedMin: null,
        byState: { waiting: 3 }, schema: 1,
    }));
    fs.writeFileSync(path.join(READ_DIR, 'charlie.json'), '{ not json at all');
    fs.writeFileSync(path.join(READ_DIR, 'notes.txt'), 'host: TXTMACHINE\n');
}

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

function env(dirs, publishDir) {
    return {
        ...process.env,
        USERPROFILE: dirs.home,
        HOME: dirs.home,
        APPDATA: path.join(dirs.home, 'appdata'),
        AUTODEV_FLEET_DIR: dirs.beats,
        AUTODEV_FLEET_PUBLISH_DIR: publishDir,
        GIT_CONFIG_GLOBAL: NOGIT,
        GIT_CONFIG_SYSTEM: NOGIT,
    };
}

function cli(args, dirs, publishDir) {
    const r = spawnSync(process.execPath, [SUBJECT, ...args],
        { encoding: 'utf8', env: env(dirs, publishDir), cwd: fixture });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function published(publishDir) {
    try { return JSON.parse(fs.readFileSync(path.join(publishDir, HOST + '.json'), 'utf8')); }
    catch { return null; }
}

function publishedRaw(publishDir) {
    try { return fs.readFileSync(path.join(publishDir, HOST + '.json'), 'utf8'); }
    catch { return ''; }
}

function git(cwd, args) {
    const r = spawnSync('git', args, {
        cwd, encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: NOGIT, GIT_CONFIG_SYSTEM: NOGIT },
    });
    return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function commitCount(repo) {
    const r = git(repo, ['rev-list', '--count', 'HEAD']);
    return r.status === 0 ? Number(r.stdout) : -1;
}

function remoteCommitCount(bare) {
    const r = git(fixture, ['--git-dir', bare, 'rev-list', '--count', '--all']);
    return r.status === 0 ? Number(r.stdout) : -1;
}

function makeRepo(dir, withOrigin) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'fleet-test@example.invalid']);
    git(dir, ['config', 'user.name', 'Fleet Test']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    git(dir, ['config', 'core.hooksPath', NOHOOKS.split(path.sep).join('/')]);
    fs.writeFileSync(path.join(dir, 'README.md'), 'fixture repo\n');
    git(dir, ['add', '--', 'README.md']);
    git(dir, ['commit', '-q', '-m', 'init']);
    if (!withOrigin) return null;
    const bare = dir + '-origin.git';
    git(fixture, ['init', '--bare', '-q', bare]);
    git(dir, ['remote', 'add', 'origin', bare.split(path.sep).join('/')]);
    git(dir, ['push', '-q', 'origin', 'HEAD']);
    return bare;
}

/**
 * Every string the fleet scan produced for this fixture - the exact material
 * summarise() must not forward. Derived rather than listed, so a field added to
 * the record is caught even if nobody updates this suite.
 */
function forbiddenStrings(dirs, allow) {
    const r = spawnSync(process.execPath, [FLEET_STATUS, '--json'],
        { encoding: 'utf8', env: env(dirs, path.join(fixture, 'unused')) });
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch { return null; }
    const out = new Set();
    const walk = (n) => {
        if (typeof n === 'string') { out.add(n); return; }
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (n && typeof n === 'object') { Object.keys(n).forEach((k) => walk(n[k])); }
    };
    walk(parsed);
    // The classify vocabulary is legitimately republished as byState keys, and
    // host/platform are the two identifying-but-deliberate fields this file
    // documents. Everything else is content.
    const ok = new Set(['blocked', 'working', 'stalled', 'waiting', 'done', 'cold', ...allow]);
    return [...out].filter((s) => s.length >= 5 && !ok.has(s));
}

// ---------------------------------------------------------------------------

try {
    fs.mkdirSync(NOHOOKS, { recursive: true });
    buildLoud();
    buildQuiet();
    buildBadTs();
    buildRead();

    // -----------------------------------------------------------------------
    // --print writes NOTHING. Not the file, not the directory.
    // -----------------------------------------------------------------------
    {
        const r = cli(['--print'], LOUD, PRINT_ONLY);
        eq('--print exits 0', r.status, 0);
        eq('--print creates no output directory', fs.existsSync(PRINT_ONLY), false);
        let rec = null;
        try { rec = JSON.parse(r.stdout); } catch { /* asserted next */ }
        check('--print emits parseable JSON on stdout', !!rec,
            JSON.stringify(r.stdout.slice(0, 300)));

        // ---- the privacy boundary ----
        eq('the record carries exactly the documented fields',
            rec && Object.keys(rec).sort().join(','),
            ['blocked', 'byState', 'host', 'oldestBlockedMin', 'platform',
                'publishedAt', 'schema', 'sessions', 'windowDays'].sort().join(','));

        const raw = JSON.stringify(rec);
        SECRETS.forEach((s) => lacks(`no planted identifier "${s}" reaches the record`, raw, s));
        lacks('no transcript session id reaches the record', raw, LID1);
        lacks('no fixture path reaches the record', raw, fixture);

        const forbidden = forbiddenStrings(LOUD, [rec.host, rec.platform]);
        check('the forbidden list was derived from a readable fleet scan', Array.isArray(forbidden),
            'fleet-status --json did not parse');
        // A zero-length list would make the sweep below vacuous: it would sweep
        // nothing and report clean. Assert the population instead of trusting it.
        check(`the derived forbidden list is non-trivial (${forbidden ? forbidden.length : 0} strings)`,
            !!forbidden && forbidden.length >= 15,
            `only ${forbidden ? forbidden.length : 0} strings derived`);
        const leaked = (forbidden || []).filter((s) => raw.includes(s));
        check(`none of the ${forbidden ? forbidden.length : 0} strings the fleet scan produced survives into the record`,
            leaked.length === 0, 'leaked: ' + JSON.stringify(leaked.slice(0, 5)));

        // ---- the counts it DOES publish ----
        eq('sessions is the session count', rec && rec.sessions, 3);
        eq('blocked is the count of sessions with an unanswered panel', rec && rec.blocked, 2);
        eq('byState tallies the blocked sessions', rec && rec.byState.blocked, 2);
        eq('byState tallies the resting one', rec && rec.byState.waiting, 1);
        eq('byState holds no other state', rec && Object.keys(rec.byState).length, 2);
        eq('windowDays defaults to 2', rec && rec.windowDays, 2);
        eq('schema is stamped', rec && rec.schema, 1);
        eq('host is this machine', rec && rec.host, HOST);
        eq('platform is this runtime', rec && rec.platform, process.platform);
        matches('publishedAt is an ISO timestamp', rec && rec.publishedAt,
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

        // The OLDEST panel, not the newest and not the first in the list. The
        // two blocked fixtures are 200m and 40m old and the 40m one sorts first.
        check('oldestBlockedMin reports the OLDEST waiting panel, not the newest',
            rec && rec.oldestBlockedMin >= 199 && rec.oldestBlockedMin <= 202,
            `got ${rec && rec.oldestBlockedMin}, expected ~200`);
    }
    {
        const r = cli(['--print', '--days', '30'], LOUD, PRINT_ONLY);
        let rec = null; try { rec = JSON.parse(r.stdout); } catch { /* asserted */ }
        eq('--days is carried into the record', rec && rec.windowDays, 30);
        eq('--days widens the scan window rather than only the label', rec && rec.sessions, 3);
    }
    {
        const r = cli(['--print'], BADTS, PRINT_ONLY);
        let rec = null; try { rec = JSON.parse(r.stdout); } catch { /* asserted */ }
        eq('a panel with an unusable askedAt still counts as blocked', rec && rec.blocked, 1);
        eq('...and yields no duration rather than a wrong one', rec && rec.oldestBlockedMin, null);
        eq('...and the session is still counted', rec && rec.sessions, 1);
    }

    // -----------------------------------------------------------------------
    // Writing the file, and the default that must never commit
    // -----------------------------------------------------------------------
    {
        const r = cli([], LOUD, PUBLISH_LOUD);
        eq('a plain run exits 0', r.status, 0);
        has('...and reports the counts it wrote', r.stdout, 'published 2 blocked / 3 sessions');
        has('...naming the file', r.stdout, path.join(PUBLISH_LOUD, HOST + '.json'));
        has('...and says who will send it', r.stdout, 'ClaudeMemorySync commits and pushes this within ~4h');
        lacks('a plain run does not claim to have pushed', r.stdout, 'pushed');

        const raw = publishedRaw(PUBLISH_LOUD);
        check('the file exists on disk', raw.length > 0, 'file empty or missing');
        SECRETS.forEach((s) => lacks(`the file on disk carries no "${s}"`, raw, s));
        const rec = published(PUBLISH_LOUD);
        eq('the file parses back to the same blocked count', rec && rec.blocked, 2);
        eq('...and the same session count', rec && rec.sessions, 3);
        eq('no .tmp file is left behind',
            fs.existsSync(path.join(PUBLISH_LOUD, HOST + '.json.tmp')), false);
    }

    // -----------------------------------------------------------------------
    // --push against a real repository with a real (local, bare) origin
    // -----------------------------------------------------------------------
    const gitProbe = git(fixture, ['--version']);
    if (gitProbe.status !== 0) {
        // Not a skip. This suite cannot verify the push path without git, and a
        // check that cannot run has not passed.
        check('git is available, so the push path can be verified', false,
            'git --version failed: ' + gitProbe.stderr);
    } else {
        const bare = makeRepo(REPO, true);
        fs.mkdirSync(REPO_FLEET, { recursive: true });
        // An unrelated untracked file, to prove the commit is by pathspec.
        fs.writeFileSync(path.join(REPO, 'other.txt'), 'someone else was working here\n');
        eq('the fixture repo starts with one commit', commitCount(REPO), 1);

        // First run: no previous record at all.
        {
            const r = cli(['--push'], QUIET, REPO_FLEET);
            eq('the first --push exits 0', r.status, 0);
            has('...treats a missing previous record as changed', r.stdout, 'counts changed');
            has('...and pushes', r.stdout, 'pushed');
            lacks('...without reporting a failure', r.stdout, 'push failed');
            eq('...creating exactly one commit', commitCount(REPO), 2);
            eq('...which reached the remote', remoteCommitCount(bare), 2);
            eq('the commit subject names the machine',
                git(REPO, ['log', '-1', '--format=%s']).stdout,
                'chore(fleet): status from ' + HOST);
            eq('the commit contains only the fleet file',
                git(REPO, ['show', '--name-only', '--format=', 'HEAD']).stdout,
                'fleet/' + HOST + '.json');
            has('an untracked neighbour is NOT swept into the commit',
                git(REPO, ['status', '--porcelain']).stdout, '?? other.txt');

            const rec = published(REPO_FLEET);
            eq('the pushed record has the quiet fleet session count', rec && rec.sessions, 2);
            eq('...and no blocked sessions', rec && rec.blocked, 0);
            eq('...so no oldest-waiting duration', rec && rec.oldestBlockedMin, null);
            eq('byState counts the resting session', rec && rec.byState.waiting, 1);
            eq('byState counts the cold one', rec && rec.byState.cold, 1);
        }

        // Second run, unchanged counts. This is the push-loop guard.
        {
            const before = published(REPO_FLEET);
            const r = cli(['--push'], QUIET, REPO_FLEET);
            eq('a second --push with identical counts exits 0', r.status, 0);
            has('...reports the counts as unchanged', r.stdout, 'counts unchanged');
            lacks('...and does not push', r.stdout, 'pushed');
            eq('...leaving the commit count where it was', commitCount(REPO), 2);
            eq('...and the remote untouched', remoteCommitCount(bare), 2);

            const after = published(REPO_FLEET);
            check('the file is still rewritten, so publishedAt moves',
                !!before && !!after && before.publishedAt !== after.publishedAt,
                `${before && before.publishedAt} vs ${after && after.publishedAt}`);
            eq('...while the counts stay put', after && after.sessions, 2);
        }

        // A previous record that differs ONLY in publishedAt. This is the exact
        // comparison meaningful() exists to make, stated on its own so it cannot
        // be satisfied by the run above happening to be quick.
        {
            const rec = published(REPO_FLEET);
            rec.publishedAt = '2020-01-01T00:00:00.000Z';
            fs.writeFileSync(path.join(REPO_FLEET, HOST + '.json'), JSON.stringify(rec, null, 1) + '\n');
            const r = cli(['--push'], QUIET, REPO_FLEET);
            has('a previous record differing only in publishedAt is NOT a change',
                r.stdout, 'counts unchanged');
            lacks('...so nothing is pushed', r.stdout, 'pushed');
            eq('...and no commit is made', commitCount(REPO), 2);
        }

        // The SAME comparison, for the field that actually broke it.
        //
        // oldestBlockedMin is IN the published record and ticks up every minute a
        // panel stays open. meaningful() removed only publishedAt, so while
        // anything was blocked the key differed on every run and a timed --push
        // committed and pushed each time. The publishedAt case above cannot see
        // this: publishedAt was already excluded, so it was green throughout.
        //
        // Measured 2026-08-24: two records differing only 199 vs 200 read as
        // 'counts changed - pushed'.
        {
            const rec = published(REPO_FLEET);
            rec.publishedAt = '2019-01-01T00:00:00.000Z';
            rec.oldestBlockedMin = (rec.oldestBlockedMin || 0) + 1;
            fs.writeFileSync(path.join(REPO_FLEET, HOST + '.json'), JSON.stringify(rec, null, 1) + '\n');
            const r = cli(['--push'], QUIET, REPO_FLEET);
            has('a blocked panel merely AGEING is not a change', r.stdout, 'counts unchanged');
            lacks('...so the passage of time alone never pushes', r.stdout, 'pushed');
            eq('...and makes no commit', commitCount(REPO), 2);
        }

        // Changed counts must get through. A guard that never lets anything
        // through is as broken as one that lets everything through.
        {
            addQuietSession(QID3, 100);
            const r = cli(['--push'], QUIET, REPO_FLEET);
            has('a new session changes the counts', r.stdout, 'counts changed');
            has('...and is pushed', r.stdout, 'pushed');
            eq('...producing a second commit', commitCount(REPO), 3);
            eq('...which reaches the remote', remoteCommitCount(bare), 3);
            eq('the record reflects the new count', published(REPO_FLEET).sessions, 3);
        }

        // The default is write-only even when the counts DID change.
        {
            addQuietSession(QID4, 200);
            const r = cli([], QUIET, REPO_FLEET);
            eq('a run without --push exits 0', r.status, 0);
            has('...still writes the new count', r.stdout, 'published 0 blocked / 4 sessions');
            lacks('...and never mentions pushing', r.stdout, 'pushed');
            eq('...making no commit despite the change', commitCount(REPO), 3);
            eq('...and leaving the remote alone', remoteCommitCount(bare), 3);
            eq('the file on disk carries the new count', published(REPO_FLEET).sessions, 4);
        }

        // A push that cannot reach a remote is non-fatal, and the file survives.
        {
            makeRepo(NOREMOTE, false);
            fs.mkdirSync(NOREMOTE_FLEET, { recursive: true });
            const r = cli(['--push'], QUIET, NOREMOTE_FLEET);
            eq('a failed push still exits 0', r.status, 0);
            has('...and says the file was written anyway',
                r.stdout, 'push failed (file still written locally)');
            eq('...with the record readable on disk', published(NOREMOTE_FLEET).sessions, 4);
        }
        {
            // Not a git repository at all: `git add` fails on the first call.
            fs.mkdirSync(NOTAREPO_FLEET, { recursive: true });
            const r = cli(['--push'], QUIET, NOTAREPO_FLEET);
            eq('a publish dir outside any repo still exits 0', r.status, 0);
            has('...reporting the failure rather than throwing',
                r.stdout, 'push failed (file still written locally)');
            eq('...and the file is written regardless', published(NOTAREPO_FLEET).sessions, 4);
        }
    }

    // -----------------------------------------------------------------------
    // --read: the cross-machine view
    // -----------------------------------------------------------------------
    {
        const r = cli(['--read'], QUIET, READ_DIR);
        eq('--read exits 0', r.status, 0);
        has('it prints the population it found', r.stdout, '2 machine(s) publishing to ' + READ_DIR);
        matches('a machine line carries its counts, its oldest wait and its age',
            r.stdout,
            /^alpha {10}2 blocked \/ 5 sessions {2}oldest waiting 47m {3}\(as of (29|30|31)m ago\)$/m);
        matches('a machine with nothing blocked omits the oldest-wait clause',
            r.stdout,
            /^bravo {10}0 blocked \/ 3 sessions {3}\(as of (119|120|121)m ago\)$/m);
        check('the newest publisher is listed first',
            r.stdout.indexOf('alpha') < r.stdout.indexOf('bravo'),
            JSON.stringify(r.stdout.slice(0, 400)));
        lacks('an unparseable record is skipped rather than crashing the report',
            r.stdout, 'charlie');
        lacks('a non-JSON file in the directory is ignored', r.stdout, 'TXTMACHINE');
    }
    {
        const r = cli(['--read'], QUIET, READ_EMPTY);
        eq('--read on an empty directory exits 0', r.status, 0);
        has('...and says so', r.stdout, 'no published status in ' + READ_EMPTY);
    }
    {
        const r = cli(['--read'], QUIET, READ_MISSING);
        eq('--read on a directory that does not exist exits 0', r.status, 0);
        has('...and says so rather than throwing', r.stdout, 'no published status in ' + READ_MISSING);
        eq('...and does not create it', fs.existsSync(READ_MISSING), false);
    }
    {
        // --read must not scan or write anything.
        const before = publishedRaw(PUBLISH_BADTS);
        const r = cli(['--read'], BADTS, PUBLISH_BADTS);
        eq('--read writes no record of its own', publishedRaw(PUBLISH_BADTS), before);
        eq('--read creates no publish directory', fs.existsSync(PUBLISH_BADTS), false);
        eq('--read exits 0 with no publish dir', r.status, 0);
    }

} finally {
    try {
        fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (e) {
        console.log('note: could not remove fixture ' + fixture + ': ' + e.message);
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
