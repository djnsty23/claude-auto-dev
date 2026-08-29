#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/fleet-stop-watch.js — the fleet-wide
// watch that emits SESSION STOPPED / SESSION RESUMED, one line per transition.
// Run: node tooling/test-fleet-stop-watch.js
// Exits 1 on any failure; 0 if all pass.
//
// ---------------------------------------------------------------------------
// WHY THIS ONE NEEDS TESTING AT ALL
//
// Every failure mode of a watcher is SILENT, and here three of them are worse
// than silent because they train the operator to stop reading the channel:
//
//   Reports the reader     the watch names the Brain's own session, the line
//                          wakes it, the wake writes a transcript line, and the
//                          next tick reports it again. A self-loop with a
//                          one-minute period. This is not hypothetical: it was
//                          a KNOWN DEFECT of the hand-rolled version, written
//                          down in brain/SKILL.md and implemented nowhere.
//   Reports a busy session the parent transcript is quiet while subagents write.
//                          `[measured 2026-08-29]` 7 of the 8 sessions on this
//                          machine with subagent transcripts had a parent gap
//                          over three minutes with subagents active inside it,
//                          the worst 17.5 minutes with 320 writes.
//   Reports nothing        which is indistinguishable from a healthy quiet fleet
//                          until something proves the probe can fire.
//
// So EVERY assertion of silence below sits in the same child process as a
// PLANTED POSITIVE — a session that must produce its line in that same run. A
// run that reports the planted line and not the case under test is a run whose
// probe demonstrably works. Silence on its own is never accepted as evidence.
//
// ---------------------------------------------------------------------------
// THE SEAMS, AND WHY THEY ARE THE ONES THAT SHIP
//
// Nothing here is copied, stubbed or patched; the exact bytes that ship are run
// against a world of this suite's choosing, through the two resolutions the
// shipped script already uses to find its data:
//
//   HOME/USERPROFILE       fleet-stop-watch.js builds its transcript root as
//                          `path.join(HOME, '.claude', 'projects')`. That is not
//                          a testing hook someone added — it is how the script
//                          finds transcripts on a real machine.
//   CLAUDE_SESSION_STORE   claude-paths.js documents this as the seam suites
//                          drive, and VALIDATES it: a path that is not there
//                          resolves to null rather than being trusted, so this
//                          is not a free pass around the real resolution.
//
// ---------------------------------------------------------------------------
// WHY REAL TIME AND REAL MTIMES, RATHER THAN AN INJECTED CLOCK
//
// The subject classifies on `Date.now() - mtime`. A fixture is only worth
// anything if its shape is one production actually produces, and production
// produces a quiet session in exactly one way: the file stops being written and
// time passes. So these tests set mtimes with fs.utimesSync and let the wall
// clock cross the threshold — the same two ingredients, in the same order.
//
// There is no injected clock and no `--now` flag, deliberately. A seam that lets
// the suite decide what "now" means would make the timing assumptions true by
// construction, which is the trap that left three checks in this repo dead with
// green suites: each fixture built the world its subject assumed.
//
// The cost is real seconds. `--quiet-minutes 0.1` (six) buys a wide margin over
// a node start-up of ~40ms while keeping the whole suite under half a minute.
//
// ---------------------------------------------------------------------------
// WHY THE BRANCH-CHANGE CASE IS THE ONE THAT PROVES THE KEYING
//
// The design brief said to key sessions on TITLE, stripping a trailing
// "[branch]", because a rebasing session flapped GONE/APPEARED. Measured against
// the live store, no title carries a branch at all — fleet-status.js's text
// renderer appends it — and titles are NOT unique: two live sessions shared one.
// The subject therefore keys on cliSessionId, the transcript's own filename.
//
// The obvious test for that — "a branch change must not produce a spurious
// line" — is VACUOUS. Under label-keying a rebase does not produce a spurious
// line, it produces a MISSED one, so such a test passes under both schemes.
// What discriminates is a session that goes quiet, changes branch, and then
// RESUMES: under cliSessionId the resume is reported, and under label-keying the
// new key is a first sighting, which is silent by design. `restoresAfterRebase`
// below is that test, and it is the reason to trust the keying rather than
// merely to have exercised it.

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUBJECT = path.resolve(
    __dirname, '..', 'plugins', 'autodev-core', 'scripts', 'fleet-stop-watch.js',
);

let pass = 0, fail = 0;
const failures = [];

function check(label, ok, detail) {
    if (ok) { pass++; return; }
    fail++;
    failures.push(label + (detail ? '  -> ' + detail : ''));
}

// ---------------------------------------------------------------------------
// Fixture construction.
//
// Built from the shapes the app actually writes, sampled from this machine:
// a transcript is JSONL whose records carry sessionId / cwd / gitBranch /
// timestamp, and a desktop record is `local_<uuid>.json` joined to the
// transcript ONLY by its cliSessionId field. Nothing here is shaped by what the
// subject happens to read — the subject stats transcripts and never parses
// them, so a wrong record shape could not be papered over by the fixture.
// ---------------------------------------------------------------------------

function makeHome(tag) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fsw-' + tag + '-'));
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    fs.mkdirSync(path.join(home, 'store'), { recursive: true });
    return home;
}

/** `~/.claude/projects/<slug>/<cliSessionId>.jsonl`, as the app lays it out. */
function transcript(home, slug, id, gitBranch) {
    const dir = path.join(home, '.claude', 'projects', slug);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, id + '.jsonl');
    const lines = [
        { type: 'bridge-session', sessionId: id, lastSequenceNum: '0' },
        {
            type: 'attachment', uuid: 'u-' + id, timestamp: new Date().toISOString(),
            userType: 'external', entrypoint: 'claude-desktop',
            cwd: '/Users/x/Code/' + slug, sessionId: id,
            version: '2.1.247', gitBranch: gitBranch || 'main',
        },
    ];
    fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return p;
}

/** A subagent transcript, at the depth the app nests them. */
function subagent(home, slug, id, agent) {
    const dir = path.join(home, '.claude', 'projects', slug, id, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'agent-' + agent + '.jsonl');
    fs.writeFileSync(p, JSON.stringify({ type: 'user', sessionId: id, timestamp: new Date().toISOString() }) + '\n');
    return p;
}

/** The desktop session record, keyed to a transcript only by cliSessionId. */
function record(home, id, title, extra) {
    const p = path.join(home, 'store', 'local_' + id + '.json');
    fs.writeFileSync(p, JSON.stringify(Object.assign({
        sessionId: 'local_' + id,
        cliSessionId: id,
        title,
        isArchived: false,
        lastActivityAt: Date.now(),
        model: 'opus', effort: 'high',
    }, extra || {}), null, 1));
    return p;
}

/** Age a file by `seconds`. How production makes a session look quiet. */
function age(file, seconds) {
    const t = new Date(Date.now() - seconds * 1000);
    fs.utimesSync(file, t, t);
}

/** Mark a file written right now. How production makes a session look active. */
function touch(file) {
    const t = new Date();
    fs.utimesSync(file, t, t);
}

// ---------------------------------------------------------------------------
// Driving the subject.
//
// The long-running mode is the one that ships, so the transition tests drive it
// rather than --once: a suite that only ever exercised the one-shot path would
// leave the interval loop — the whole product — unproven.
// ---------------------------------------------------------------------------

function startWatch(home, args, env) {
    const child = spawn(process.execPath, [SUBJECT].concat(args || []), {
        env: Object.assign({}, process.env, {
            HOME: home,
            USERPROFILE: home,
            CLAUDE_SESSION_STORE: path.join(home, 'store'),
            // Cleared so this machine's OWN session id cannot leak in and
            // silently exclude a fixture session, or fail to.
            CLAUDE_CODE_SESSION_ID: '',
            AUTODEV_SELF_SESSION: '',
        }, env || {}),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = { stdout: '', stderr: '', exited: false };
    child.stdout.on('data', (d) => { out.stdout += d; });
    // Captured SEPARATELY and never inherited. A child whose stderr is left on
    // the default stdio prints onto the parent's, which would make a run look
    // silent here while it was speaking on a stream nobody asserted about —
    // and "zero bytes on BOTH streams" is the property this file exists to hold.
    child.stderr.on('data', (d) => { out.stderr += d; });
    child.on('exit', () => { out.exited = true; });
    out.kill = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    return out;
}

/** Resolve once `test(out)` holds, or after `ms`. Returns whether it held. */
function until(out, test, ms) {
    return new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
            if (test(out)) return resolve(true);
            if (Date.now() - started >= ms) return resolve(false);
            setTimeout(tick, 50);
        };
        tick();
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = (s) => s.split('\n').filter(Boolean);
const saw = (out, re) => re.test(out.stdout);

// ---------------------------------------------------------------------------
// RUN 1 — the transition matrix.
//
// One child, five sessions, every assertion of silence sharing the run with a
// planted positive that must speak. Sessions all start ACTIVE, so the first
// scan baselines them running and every line after that is a real transition.
// ---------------------------------------------------------------------------

async function transitionMatrix() {
    const home = makeHome('matrix');
    const ids = {
        alpha: 'aaaaaaaa-0000-4000-8000-000000000001',
        selfie: 'bbbbbbbb-0000-4000-8000-000000000002',
        fanout: 'cccccccc-0000-4000-8000-000000000003',
        rebase: 'dddddddd-0000-4000-8000-000000000004',
        vanish: 'eeeeeeee-0000-4000-8000-000000000005',
        nameless: 'ffffffff-0000-4000-8000-000000000006',
    };

    const t = {};
    t.alpha = transcript(home, '-Users-x-Code-alpha', ids.alpha, 'main');
    t.selfie = transcript(home, '-Users-x-Code-autodev', ids.selfie, 'main');
    t.fanout = transcript(home, '-Users-x-Code-fanout', ids.fanout, 'main');
    t.rebase = transcript(home, '-Users-x-Code-rebase', ids.rebase, 'feat/one');
    t.vanish = transcript(home, '-Users-x-Code-vanish', ids.vanish, 'main');
    t.nameless = transcript(home, '-Users-x-Code-nameless-repo-here', ids.nameless, 'main');
    const fan = subagent(home, '-Users-x-Code-fanout', ids.fanout, 'a1');

    record(home, ids.alpha, 'alpha: a plain session');
    record(home, ids.selfie, 'the brain itself');
    record(home, ids.fanout, 'fanout: runs subagents');
    record(home, ids.rebase, 'rebase: changes branches');
    record(home, ids.vanish, 'vanish: gets archived');
    // `nameless` deliberately has NO desktop record, so the display fallback is
    // exercised rather than assumed.

    const out = startWatch(home, ['--interval', '1', '--quiet-minutes', '0.1', '--self', ids.selfie]);

    // Keep the fan-out's SUBAGENT fresh while its parent goes quiet. This is the
    // 17.5-minute measurement in miniature, and the parent is deliberately never
    // touched again.
    let keepFanning = true;
    (async () => { while (keepFanning) { touch(fan); await sleep(400); } })();

    // --- alpha, rebase and nameless cross the threshold; selfie and fanout must not.
    const gotStops = await until(out, (o) => saw(o, /SESSION STOPPED {2}alpha:/) && saw(o, /SESSION STOPPED {2}rebase:/), 15000);
    check('a quiet session emits SESSION STOPPED', gotStops, out.stdout.slice(0, 400) || '(no output at all)');
    check('STOPPED carries the addressable id, not the cliSessionId',
        saw(out, new RegExp('SESSION STOPPED {2}alpha:.*:: local_' + ids.alpha)),
        out.stdout.slice(0, 300));
    check('STOPPED names the session by its stored title', saw(out, /SESSION STOPPED {2}alpha: a plain session/));
    check('a session with no desktop record still reports, under a fallback name',
        saw(out, /SESSION STOPPED {2}nameless-repo-here/), out.stdout.slice(0, 400));

    // The two silences, asserted in the same breath as the positives above.
    check('the self session is never reported (planted positive fired in this run)',
        !saw(out, /the brain itself/), out.stdout.slice(0, 400));
    check('a parent gone quiet under live subagents is NOT reported stopped',
        !saw(out, /SESSION STOPPED {2}fanout:/), out.stdout.slice(0, 400));

    // --- RESUMED, for a session whose branch did NOT change.
    touch(t.alpha);
    const gotResume = await until(out, (o) => saw(o, /SESSION RESUMED {2}alpha:/), 8000);
    check('a session that writes again emits SESSION RESUMED', gotResume, out.stdout.slice(-400));

    // --- The discriminating case: quiet, then a BRANCH CHANGE, then active.
    // A rebase rewrites gitBranch in the transcript and can rename the session;
    // both are done here so a label-keyed variant would see a brand-new key.
    transcript(home, '-Users-x-Code-rebase', ids.rebase, 'feat/two-rebased');
    record(home, ids.rebase, 'rebase: changes branches [feat/two-rebased]');
    touch(t.rebase);
    const gotRebaseResume = await until(out, (o) => saw(o, /SESSION RESUMED {2}rebase:/), 8000);
    check('a session that resumes ACROSS a branch change still emits RESUMED',
        gotRebaseResume, out.stdout.slice(-500));

    // --- The fan-out stops for real once its subagents stop too.
    keepFanning = false;
    age(fan, 30);
    age(t.fanout, 30);
    const gotFanStop = await until(out, (o) => saw(o, /SESSION STOPPED {2}fanout:/), 8000);
    check('a fan-out DOES report stopped once its subagents go quiet too',
        gotFanStop, out.stdout.slice(-400));

    // --- A transcript that disappears produces no line at all.
    //
    // Scoped to what is written AFTER the deletion. `vanish` legitimately
    // reported STOPPED earlier in this same run, alongside alpha and rebase —
    // asserting over the whole transcript failed on that correct line, which is
    // the assertion being wrong rather than the subject. Its own earlier STOPPED
    // is also what makes this test non-vacuous: the session is demonstrably one
    // this watch was tracking when it was removed.
    check('the vanishing session was actually being tracked before it went',
        saw(out, /SESSION STOPPED {2}vanish:/), out.stdout.slice(0, 400));
    const beforeUnlink = out.stdout.length;
    fs.unlinkSync(t.vanish);
    touch(t.alpha);
    await until(out, (o) => (o.stdout.match(/SESSION RESUMED {2}alpha:/g) || []).length >= 2, 8000);
    check('a vanished transcript emits no GONE/APPEARED line',
        !/vanish/.test(out.stdout.slice(beforeUnlink)), out.stdout.slice(beforeUnlink));

    // --- Steady state is silent. Freeze the world and prove nothing accrues,
    // while the process is still demonstrably alive and scanning.
    const before = lines(out.stdout).length;
    await sleep(3000);
    check('a scan with no transition adds no lines',
        lines(out.stdout).length === before,
        'grew from ' + before + ' to ' + lines(out.stdout).length);

    check('nothing is ever written to stderr', out.stderr === '', JSON.stringify(out.stderr.slice(0, 200)));
    check('every emitted line is a STOPPED, a RESUMED or a WATCHER line',
        lines(out.stdout).every((l) => /^(SESSION STOPPED|SESSION RESUMED|WATCHER-)/.test(l)),
        lines(out.stdout).filter((l) => !/^(SESSION STOPPED|SESSION RESUMED|WATCHER-)/.test(l)).join(' | '));

    out.kill();
    fs.rmSync(home, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// RUN 2 — self-exclusion arms itself from the environment.
//
// `[measured 2026-08-29]` CLAUDE_CODE_SESSION_ID in a live session equals its
// own transcript's basename, which is what lets the exclusion arm with no flag
// and therefore not be forgotten. Same planted-positive discipline.
// ---------------------------------------------------------------------------

async function selfFromEnvironment() {
    const home = makeHome('env');
    const me = '11111111-0000-4000-8000-00000000000a';
    const other = '22222222-0000-4000-8000-00000000000b';
    transcript(home, '-Users-x-Code-autodev', me, 'main');
    transcript(home, '-Users-x-Code-other', other, 'main');
    record(home, me, 'the brain itself');
    record(home, other, 'somebody else entirely');

    const out = startWatch(home, ['--interval', '1', '--quiet-minutes', '0.1'], { CLAUDE_CODE_SESSION_ID: me });
    const fired = await until(out, (o) => saw(o, /SESSION STOPPED {2}somebody else/), 15000);
    check('CLAUDE_CODE_SESSION_ID excludes the running session', fired && !saw(out, /the brain itself/),
        'planted=' + fired + ' output=' + out.stdout.slice(0, 300));
    check('env self-exclusion says nothing on stderr', out.stderr === '', JSON.stringify(out.stderr.slice(0, 200)));
    check('an armed self-exclusion prints no WATCHER-NOTE', !saw(out, /WATCHER-NOTE/), out.stdout.slice(0, 300));
    out.kill();
    fs.rmSync(home, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// RUN 3 — with no self identifiable, say so ONCE, and keep working.
//
// Failing open here is not the same trade as in watch-panels.js: a missed ping
// there costs one notice, whereas an unarmed exclusion here costs a permanent
// self-loop. So the disarmed state must be audible, and audible exactly once —
// a caveat repeated every minute is noise that gets the channel muted.
// ---------------------------------------------------------------------------

async function disarmedSelfIsAudible() {
    const home = makeHome('noself');
    const only = '33333333-0000-4000-8000-00000000000c';
    transcript(home, '-Users-x-Code-solo', only, 'main');
    record(home, only, 'the only session here');

    const out = startWatch(home, ['--interval', '1', '--quiet-minutes', '0.1']);
    const fired = await until(out, (o) => saw(o, /SESSION STOPPED {2}the only session/), 15000);
    check('a disarmed self-exclusion still watches the fleet', fired, out.stdout.slice(0, 300));
    check('a disarmed self-exclusion announces itself',
        saw(out, /WATCHER-NOTE self-exclusion disarmed/), out.stdout.slice(0, 300));
    await sleep(2500);
    check('and announces itself exactly once, not every scan',
        (out.stdout.match(/WATCHER-NOTE/g) || []).length === 1,
        'count=' + (out.stdout.match(/WATCHER-NOTE/g) || []).length);
    check('the disarmed note goes to stdout, leaving stderr empty', out.stderr === '',
        JSON.stringify(out.stderr.slice(0, 200)));
    out.kill();
    fs.rmSync(home, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// RUN 4 — a bad --quiet-minutes must not turn everything into "working".
//
// `NaN >= x` is false, so an unparseable threshold would classify every session
// as active and the watch would go permanently, healthily silent. The fixture
// starts ALREADY quiet by five minutes and then writes, so the assertion needs
// no wall-clock wait: a RESUMED can only be emitted if the baseline scan judged
// it quiet under the fallback default of three minutes.
// ---------------------------------------------------------------------------

async function unparseableThresholdFallsBackToDefault() {
    const home = makeHome('badnum');
    const id = '44444444-0000-4000-8000-00000000000d';
    const t = transcript(home, '-Users-x-Code-thresh', id, 'main');
    record(home, id, 'threshold fallback session');
    age(t, 300);

    const out = startWatch(home, ['--interval', '1', '--quiet-minutes', 'not-a-number']);
    await sleep(1200);                 // the baseline scan
    touch(t);
    const fired = await until(out, (o) => saw(o, /SESSION RESUMED {2}threshold fallback/), 8000);
    check('an unparseable --quiet-minutes falls back to the default, not to NaN', fired,
        out.stdout.slice(0, 400) || '(silent: everything read as running)');
    out.kill();
    fs.rmSync(home, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// RUN 5 — one-shot arming over an already-quiet fleet writes ZERO BYTES.
//
// Both streams, asserted separately. The control that makes this mean something
// is RUN 1: the same file, run the same way, spoke on stdout there.
// ---------------------------------------------------------------------------

function armingIsSilent() {
    const home = makeHome('arm');
    for (let i = 0; i < 4; i++) {
        const id = '55555555-0000-4000-8000-00000000000' + i;
        const t = transcript(home, '-Users-x-Code-quiet' + i, id, 'main');
        record(home, id, 'long-finished session ' + i);
        age(t, 86400);                 // a day quiet, as a dead session is
    }
    const r = spawnSync(process.execPath, [SUBJECT, '--once', '--self', 'nobody'], {
        env: Object.assign({}, process.env, {
            HOME: home, USERPROFILE: home,
            CLAUDE_SESSION_STORE: path.join(home, 'store'),
            CLAUDE_CODE_SESSION_ID: '', AUTODEV_SELF_SESSION: '',
        }),
        encoding: 'utf8',
    });
    check('arming over a sleeping fleet writes zero bytes to stdout',
        r.stdout === '', JSON.stringify((r.stdout || '').slice(0, 200)));
    check('arming over a sleeping fleet writes zero bytes to stderr',
        r.stderr === '', JSON.stringify((r.stderr || '').slice(0, 200)));
    check('arming exits 0', r.status === 0, 'status=' + r.status);
    fs.rmSync(home, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// RUN 5b — arming the LOOP over a sleeping fleet stays silent past scan one.
//
// RUN 5 uses --once, and --once cannot catch the mutant that matters here:
// baseline every session as "running" regardless of its mtime, and a single
// scan is still silent while the SECOND scan announces STOPPED for a fleet that
// has been asleep for a day. That is precisely the arming noise the design
// forbids, so it needs a run that survives to scan two.
//
// Found by mutating the subject rather than by reading it: this test exists
// because `running: !quiet` -> `running: true` passed the whole suite.
// ---------------------------------------------------------------------------

async function armingTheLoopIsSilent() {
    const home = makeHome('armloop');
    for (let i = 0; i < 3; i++) {
        const id = '77777777-0000-4000-8000-00000000000' + i;
        const t = transcript(home, '-Users-x-Code-asleep' + i, id, 'main');
        record(home, id, 'asleep for a day ' + i);
        age(t, 86400);
    }
    // The planted positive: alive at arming, quiet shortly after. Without it,
    // "no STOPPED lines" would be satisfied by a watcher that cannot speak.
    const live = '77777777-0000-4000-8000-0000000000ff';
    const lt = transcript(home, '-Users-x-Code-awake', live, 'main');
    record(home, live, 'awake at arming');

    const out = startWatch(home, ['--interval', '1', '--quiet-minutes', '0.1', '--self', 'nobody']);
    const fired = await until(out, (o) => saw(o, /SESSION STOPPED {2}awake at arming/), 15000);
    check('the planted positive fires, so this run can speak', fired, out.stdout.slice(0, 300));
    check('a fleet asleep at arming is never announced, however many scans pass',
        !/asleep for a day/.test(out.stdout), out.stdout.slice(0, 400));
    check('arming the loop writes nothing to stderr', out.stderr === '', JSON.stringify(out.stderr.slice(0, 200)));
    touch(lt);
    await until(out, (o) => saw(o, /SESSION RESUMED {2}awake at arming/), 8000);
    check('and the sleepers stay unannounced after a later transition elsewhere',
        !/asleep for a day/.test(out.stdout), out.stdout.slice(0, 400));
    out.kill();
    fs.rmSync(home, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// RUN 6 — a missing transcript root is an ERROR, never a quiet fleet.
//
// The confident-zero failure claude-paths.js was written to stop: a watch
// pointed at a directory that is not there reports a permanently silent fleet
// and looks exactly like a healthy one.
// ---------------------------------------------------------------------------

function missingRootSpeaks() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fsw-noroot-'));
    const r = spawnSync(process.execPath, [SUBJECT, '--once', '--self', 'nobody'], {
        env: Object.assign({}, process.env, {
            HOME: home, USERPROFILE: home,
            CLAUDE_SESSION_STORE: '', CLAUDE_CODE_SESSION_ID: '', AUTODEV_SELF_SESSION: '',
        }),
        encoding: 'utf8',
    });
    check('a missing transcript root reports WATCHER-ERROR rather than silence',
        /WATCHER-ERROR no transcript root/.test(r.stdout || ''),
        JSON.stringify((r.stdout || '').slice(0, 200)));
    check('a missing transcript root still exits 0 (a report, not a gate)',
        r.status === 0, 'status=' + r.status);
    fs.rmSync(home, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// RUN 7 — subagent mtimes are found at the depth the app nests them.
//
// Direct, on the exported helper, because RUN 1 proves the POLICY and this
// proves the traversal that policy depends on. A wrong depth here would make
// the fan-out protection quietly inert while RUN 1's timing still passed.
// ---------------------------------------------------------------------------

function subagentTraversal() {
    const home = makeHome('walk');
    const id = '66666666-0000-4000-8000-00000000000e';
    transcript(home, '-Users-x-Code-deep', id, 'main');
    const shallow = subagent(home, '-Users-x-Code-deep', id, 'lvl1');
    const nestedDir = path.join(home, '.claude', 'projects', '-Users-x-Code-deep', id, 'subagents', 'agent-lvl1', 'subagents');
    fs.mkdirSync(nestedDir, { recursive: true });
    const nested = path.join(nestedDir, 'agent-lvl2.jsonl');
    fs.writeFileSync(nested, '{}\n');

    const { newestUnder } = require(SUBJECT);
    const sessionDir = path.join(home, '.claude', 'projects', '-Users-x-Code-deep', id);

    age(shallow, 600);
    age(nested, 600);
    const old = newestUnder(sessionDir, 0);
    touch(nested);
    const fresh = newestUnder(sessionDir, 0);
    check('a NESTED subagent write counts as session activity', fresh > old + 1000,
        'old=' + old + ' fresh=' + fresh);

    age(nested, 600);
    touch(shallow);
    check('a top-level subagent write counts as session activity',
        newestUnder(sessionDir, 0) > old + 1000);

    check('a session directory with nothing in it yields no activity',
        newestUnder(path.join(home, '.claude', 'projects', 'does-not-exist'), 0) === 0);
    fs.rmSync(home, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------

async function main() {
    // A hang must be LEGIBLE. Without this the worst case is a gate that never
    // returns, which reads as an infrastructure problem rather than as this
    // suite, and `npm test` has no per-suite timeout to fall back on.
    const watchdog = setTimeout(() => {
        console.log('fleet-stop-watch: SUITE TIMED OUT after 150s with ' + pass + ' passed, ' + fail + ' failed');
        process.exit(1);
    }, 150_000);
    watchdog.unref();

    armingIsSilent();
    missingRootSpeaks();
    subagentTraversal();

    // The four long runs are concurrent: each owns a private temp HOME, a
    // private store and its own child, so they share nothing but the clock —
    // and the clock is what they spend. Sequentially this suite cost 37s of
    // every `npm test`; concurrently it is bounded by its longest single run.
    await Promise.all([
        transitionMatrix(),
        selfFromEnvironment(),
        disarmedSelfIsAudible(),
        unparseableThresholdFallsBackToDefault(),
        armingTheLoopIsSilent(),
    ]);
    clearTimeout(watchdog);

    // Always print the population, never a bare verdict: a report that prints
    // only "PASS" is indistinguishable from one that ran nothing.
    console.log('fleet-stop-watch: ' + pass + ' passed, ' + fail + ' failed (' + (pass + fail) + ' checks)');
    for (const f of failures) console.log('  FAIL ' + f);
    process.exit(fail ? 1 : 0);
}

main().catch((err) => {
    console.log('fleet-stop-watch: suite crashed: ' + (err && err.stack || err));
    process.exit(1);
});
