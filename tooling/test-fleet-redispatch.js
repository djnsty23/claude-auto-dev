#!/usr/bin/env node
'use strict';
// Suite for plugins/autodev-core/scripts/fleet-redispatch.js.
//
// WHY THIS SUITE EXISTS. The subject decides which of a stopped fleet's work to
// propose restarting at a session-limit reset. Both of its wrong answers cost
// real time on this fleet and they are NOT symmetric, so the cases below are
// weighted towards the expensive direction:
//
//   restarting work that is already done  - twice in one week a session was
//     dispatched onto already-merged branches, once for twelve commits
//   restarting work a live session holds  - six same-file collisions in one
//     night, four of them from a coordinator dispatching off a stale picture
//   reporting an unreadable population as a clean zero - nine distinct
//     false-green channels measured in one night
//
// Two layers are exercised, and the split is deliberate. The CLASSIFICATION is
// tested as a pure function against planted evidence, because a suite that
// mocked a live fleet would be asserting things about the mock. The END-TO-END
// cases drive the real binary as a subprocess over real fixture directories -
// a real git repo with a real worktree, real transcripts, a real session store
// - because every seam this tool has (an absent directory, a stale stamp, an
// unparseable record) is an I/O seam and cannot be reached from the pure layer.
//
// THE CONTROL THAT MAKES THE REST MEAN ANYTHING. `--no-run-verify` must not
// execute a verify, and that assertion passes for free if the tool never runs
// one. So every "did not run" case is paired with a POSITIVE control on the
// same fixture that proves the canary fires when it should.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'fleet-redispatch.js');
const {
    VERDICTS, classify, liveness, boundariesCrossed, rank, rankReason, summarise, slugOf,
} = require(SUBJECT);

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail === undefined ? '' : '  (' + detail + ')')); }
}
const MIN = 60000;

// ===========================================================================
// 1. CLASSIFICATION - the expensive direction first.
// ===========================================================================
const rec = { repo: 'r', branch: 'b', state: 'checkpointed', verify: 'true' };
const v = (r, e) => classify(r, e).verdict;

// -- never restart a live session's work ------------------------------------
check('a live session is SKIP-LIVE even when its verify would fail',
    v(rec, { live: true, verify: { code: 1 } }) === VERDICTS.SKIP_LIVE);
check('  and liveness is decided BEFORE the branch is asked whether it landed',
    v(rec, { live: true, landed: 'UNLANDED', verify: { code: 1 } }) === VERDICTS.SKIP_LIVE);
check('UNKNOWN liveness is COULD-NOT-CHECK, never RESTART',
    v(rec, { live: null, verify: { code: 1 } }) === VERDICTS.COULD_NOT_CHECK);
check('  undefined liveness is treated the same as null, not as false',
    v(rec, { verify: { code: 1 } }) === VERDICTS.COULD_NOT_CHECK);
check('  and the reason says an unknown session is not treated as gone',
    /not treated as gone/.test(classify(rec, { live: null }).reason));

// -- never restart work that already landed ---------------------------------
for (const landed of ['LANDED-ANCESTOR', 'LANDED-SQUASH', 'LANDED-CONTENT']) {
    check(`${landed} is skipped even when the record says working`,
        v({ ...rec, state: 'working' }, { live: false, landed }) === VERDICTS.SKIP_LANDED);
}
check('an UNKNOWN landed verdict is NOT landed - it falls through to verify',
    v(rec, { live: false, landed: 'UNKNOWN', verify: { code: 1 } }) === VERDICTS.RESTART);
check('a NULL landed verdict (never asked, or the ask failed) also falls through',
    v(rec, { live: false, landed: null, verify: { code: 1 } }) === VERDICTS.RESTART);
check('BEHIND is not landed either',
    v(rec, { live: false, landed: 'BEHIND', verify: { code: 1 } }) === VERDICTS.RESTART);

// -- `state` is never trusted on its own ------------------------------------
check('verify passing beats a record that says working',
    v({ ...rec, state: 'working' }, { live: false, verify: { code: 0 } }) === VERDICTS.SKIP_VERIFIED);
check('  and the reason names the state the record still claimed',
    /still said "working"/.test(classify({ ...rec, state: 'working' }, { live: false, verify: { code: 0 } }).reason));
check('verify failing beats a record that says complete',
    v({ ...rec, state: 'complete' }, { live: false, verify: { code: 1 } }) === VERDICTS.RESTART);
check('  and the reason says the record claimed complete and is not',
    /claimed complete; it is not/.test(classify({ ...rec, state: 'complete' }, { live: false, verify: { code: 1 } }).reason));

// -- a signal that could not be read is never a verdict ----------------------
check('a verify TIMEOUT is neither a pass nor a failure',
    v(rec, { live: false, verify: 'timeout' }) === VERDICTS.COULD_NOT_CHECK);
check('  and it does not become a RESTART by looking like a non-zero exit',
    v(rec, { live: false, verify: 'timeout' }) !== VERDICTS.RESTART);
check('a verify that could not be RUN is COULD-NOT-CHECK',
    v(rec, { live: false, verify: 'unrunnable' }) === VERDICTS.COULD_NOT_CHECK);
check('a record with NO verify cannot be re-checked, so it is COULD-NOT-CHECK',
    v({ repo: 'r', branch: 'b', state: 'working' }, { live: false, verify: 'absent' }) === VERDICTS.COULD_NOT_CHECK);
check('  and a missing verify never becomes a restart proposal',
    v({ repo: 'r', branch: 'b', state: 'working' }, { live: false, verify: 'absent' }) !== VERDICTS.RESTART);
check('a verify with no exit status at all is COULD-NOT-CHECK',
    v(rec, { live: false, verify: {} }) === VERDICTS.COULD_NOT_CHECK);
check('a record that did not parse is COULD-NOT-CHECK, carrying its own reason',
    classify({ __unreadable: 'x.json did not parse' }, {}).reason === 'x.json did not parse');
check('a record naming no branch is COULD-NOT-CHECK, not a restart',
    v({ repo: 'r' }, { live: false, verify: { code: 1 } }) === VERDICTS.COULD_NOT_CHECK);

// -- remaining work an agent cannot advance ----------------------------------
check('blocked work with a failing verify is BLOCKED, not RESTART',
    v({ ...rec, state: 'blocked' }, { live: false, verify: { code: 1 } }) === VERDICTS.BLOCKED);
check('  but blocked work whose verify PASSES is done, not blocked',
    v({ ...rec, state: 'blocked' }, { live: false, verify: { code: 0 } }) === VERDICTS.SKIP_VERIFIED);
check('  and the blocked reason says it waits on a person, not on a session',
    /waits on a person/.test(classify({ ...rec, state: 'blocked' }, { live: false, verify: { code: 1 } }).reason));

// -- a sixth state must SURFACE, not fold into a neighbour --------------------
//
// The failure this reproduces is prd.json's, written in a different file: every
// hand-rolled filter over a five-valued field in this repo has been wrong, and
// always by collapsing one value into the one next to it.
const weird = classify({ ...rec, state: 'paused-for-review' }, { live: false, verify: { code: 1 } });
check('an unrecognised state still classifies rather than throwing',
    weird.verdict === VERDICTS.RESTART);
check('  and the unrecognised state is NAMED in the reason',
    /Unrecognised state "paused-for-review"/.test(weird.reason));
check('  while a recognised state adds no such note',
    !/Unrecognised state/.test(classify(rec, { live: false, verify: { code: 1 } }).reason));

// ===========================================================================
// 2. LIVENESS - two sources, combined asymmetrically.
// ===========================================================================
check('a fresh session-store ping is live',
    liveness({ pingAgeMs: 2000 }, 30 * MIN).live === true);
check('a fresh transcript with no wall at its end is live',
    liveness({ transcriptAgeMs: 60000, walled: false }, 30 * MIN).live === true);
check('a transcript ENDING in the wall is not live, however fresh',
    liveness({ transcriptAgeMs: 1000, walled: true }, 30 * MIN).live === false);
check('  and the reason names the wall, so a coordinator knows why it stopped',
    /rate_limit wall/.test(liveness({ transcriptAgeMs: 1000, walled: true }, 30 * MIN).why));
check('a fresh PING outranks a wall - the app still holds the session',
    liveness({ pingAgeMs: 2000, transcriptAgeMs: 1000, walled: true }, 30 * MIN).live === true);
check('a stale ping with no wall is not live',
    liveness({ pingAgeMs: 90 * MIN, walled: null }, 30 * MIN).live === false);
check('NEITHER source readable is null - an unknown session is not gone',
    liveness({ pingAgeMs: null, transcriptAgeMs: null, walled: null }, 30 * MIN).live === null);
check('  and null liveness never reaches RESTART',
    v(rec, { live: liveness({}, 30 * MIN).live, verify: { code: 1 } }) === VERDICTS.COULD_NOT_CHECK);
check('the floor is a parameter, not a constant - a 4h floor keeps a 90m session live',
    liveness({ pingAgeMs: 90 * MIN }, 240 * MIN).live === true);

// ===========================================================================
// 3. THE RESET BOUNDARY - read, never guessed.
// ===========================================================================
const T = (iso) => Date.parse(iso);
const wall = (iso, type) => ({ resetsAtMs: T(iso), rateLimitType: type || 'five_hour', cwd: '/w' });

check('unreadable transcripts are readable:false, NOT "no boundary"',
    boundariesCrossed(null, 0, T('2026-09-08T12:00:00Z')).readable === false);
check('  and undefined is treated the same as null',
    boundariesCrossed(undefined, 0, 1).readable === false);
const measuredEmpty = boundariesCrossed([], T('2026-09-08T00:00:00Z'), T('2026-09-08T12:00:00Z'));
check('an EMPTY read is readable:true with nothing crossed - a measured zero',
    measuredEmpty.readable === true && measuredEmpty.crossed.length === 0);
check('  which is a different answer from the unreadable case above',
    measuredEmpty.readable !== boundariesCrossed(null, 0, 1).readable);

const events = [
    wall('2026-09-07T22:10:00Z'),
    wall('2026-09-07T22:10:00Z'),
    wall('2026-09-06T10:00:00Z'),
    wall('2026-09-08T20:00:00Z'),          // still in the FUTURE at "now"
    wall('2026-09-08T02:00:00Z', 'weekly'), // a different window entirely
];
const g = boundariesCrossed(events, T('2026-09-07T12:00:00Z'), T('2026-09-08T12:00:00Z'));
check('a boundary inside the window is crossed', g.crossed.length === 2);
check('  a boundary BEFORE the last run is not re-crossed',
    !g.crossed.some((e) => e.resetsAtMs === T('2026-09-06T10:00:00Z')));
check('  a boundary still in the FUTURE has not been crossed yet',
    !g.crossed.some((e) => e.resetsAtMs === T('2026-09-08T20:00:00Z')));
check('  and a weekly limit is not a five-hour boundary',
    g.seen === 4);
check('no previous run is UNGATED, not "since the beginning of time"',
    boundariesCrossed(events, null, T('2026-09-08T12:00:00Z')).ungated === true);
check('  and an ungated run crosses nothing rather than crossing everything',
    boundariesCrossed(events, null, T('2026-09-08T12:00:00Z')).crossed.length === 0);
check('crossed boundaries come back in time order',
    boundariesCrossed([wall('2026-09-08T09:00:00Z'), wall('2026-09-08T03:00:00Z')],
        T('2026-09-08T00:00:00Z'), T('2026-09-08T12:00:00Z'))
        .crossed.map((e) => e.resetsAtMs)[0] === T('2026-09-08T03:00:00Z'));

// ===========================================================================
// 4. RANK and SUMMARISE.
// ===========================================================================
const row = (o) => ({ file: o.branch + '.json', record: o });
const ranked = rank([
    row({ repo: 'r', branch: 'no-next', state: 'checkpointed', updated_at: '2026-09-08T10:00:00Z' }),
    row({ repo: 'r', branch: 'working', state: 'working', next_step: 'x', updated_at: '2026-09-08T11:00:00Z' }),
    row({ repo: 'r', branch: 'older', state: 'checkpointed', next_step: 'x', updated_at: '2026-09-01T10:00:00Z' }),
    row({ repo: 'r', branch: 'newer', state: 'checkpointed', next_step: 'x', updated_at: '2026-09-08T10:00:00Z' }),
]).map((r) => r.record.branch);
check('a record with a next_step outranks one without',
    ranked.indexOf('working') < ranked.indexOf('no-next'), ranked.join(','));
check('checkpointed outranks working - a checkpoint is a chosen stopping point',
    ranked.indexOf('newer') < ranked.indexOf('working'), ranked.join(','));
check('the newer of two equal records comes first',
    ranked.indexOf('newer') < ranked.indexOf('older'), ranked.join(','));
check('rank() does not mutate its input',
    (() => { const a = [row({ repo: 'r', branch: 'z' }), row({ repo: 'r', branch: 'a' })]; const before = a.map((x) => x.record.branch).join(); rank(a); return a.map((x) => x.record.branch).join() === before; })());
check('the rank reason states the missing next_step rather than only a position',
    /NO next_step/.test(rankReason(row({ repo: 'r', branch: 'b', state: 'working' }))));
check('  and it does not claim an updated_at it could not read',
    /no readable updated_at/.test(rankReason(row({ repo: 'r', branch: 'b' }))));

const sum = summarise([
    { verdict: VERDICTS.RESTART }, { verdict: VERDICTS.RESTART },
    { verdict: VERDICTS.COULD_NOT_CHECK }, { verdict: 'SOMETHING-NEW' },
]);
check('summarise counts each verdict', sum[VERDICTS.RESTART] === 2 && sum[VERDICTS.COULD_NOT_CHECK] === 1);
check('a verdict added later surfaces in `unrecognised` rather than being absorbed',
    sum.unrecognised.length === 1 && sum.unrecognised[0] === 'SOMETHING-NEW');
check('  and it is NOT silently added to any known count',
    Object.values(VERDICTS).reduce((n, k) => n + sum[k], 0) === 3);
check('the population is the total, not the classified total', sum.total === 4);

// ===========================================================================
// 5. THE SLUG RULE, pinned against literals.
// ===========================================================================
// Used below to build fixture transcript directories. Pinned here so that use
// is a convenience rather than the assertion.
check('the transcript slug replaces / and .', slugOf('/a/b.c') === '-a-b-c');
check('  and the Windows drive colon and backslash, which contain neither',
    slugOf('D:\\proj\\repo') === 'D--proj-repo');

// ===========================================================================
// 6. END-TO-END. Real directories, the real binary, as a subprocess.
// ===========================================================================
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-redispatch-'));
const P = (...a) => path.join(TMP, ...a);
const mk = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// A real repo with a real worktree on the branch the record names. Without one
// the tool cannot run a verify anywhere, and every case would pass as
// COULD-NOT-CHECK for the wrong reason.
const REPO = mk(P('code', 'repoA'));
git(REPO, ['init', '-q', '-b', 'main', '.']);
fs.writeFileSync(path.join(REPO, 'a.txt'), 'hi\n');
git(REPO, ['add', 'a.txt']);
git(REPO, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-qm', 'init']);
git(REPO, ['branch', 'feat/x']);
const WT = P('code', 'wtA');
git(REPO, ['worktree', 'add', '-q', WT, 'feat/x']);

const HOMEDIR = mk(P('home'));
const PROJECTS = mk(P('home', '.claude', 'projects'));
const STORE = mk(P('store'));
const INTENT = mk(P('intent'));
const STAMP = P('home', '.claude', 'stamp');

// A transcript for the worktree whose LAST row is the wall - the shape a
// session stopped by the limit actually leaves behind.
const WALLROW = {
    type: 'assistant', timestamp: '2026-09-07T21:52:16.154Z',
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit" }] },
    quotaLimits: { status: 'rejected', resetsAt: 1788819000, rateLimitType: 'five_hour' },
    error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429,
    cwd: WT, sessionId: 'sid-1', gitBranch: 'feat/x',
};
const tdir = mk(path.join(PROJECTS, slugOf(WT)));
fs.writeFileSync(path.join(tdir, 'sid-1.jsonl'),
    JSON.stringify({ type: 'user', timestamp: '2026-09-07T21:00:00Z', cwd: WT }) + '\n'
    + JSON.stringify(WALLROW) + '\n');
// Age it well past the liveness floor, so the fixture is a stopped session.
const old = new Date(Date.now() - 6 * 3600 * 1000);
fs.utimesSync(path.join(tdir, 'sid-1.jsonl'), old, old);

const CANARY = P('verify-ran');
function writeRecord(o) {
    fs.writeFileSync(path.join(INTENT, 'repoA--feat-x.json'), JSON.stringify(o, null, 1));
}
function run(args, env) {
    const res = spawnSync(process.execPath, [SUBJECT,
        '--intent-dir', INTENT, '--stamp-file', STAMP, '--all', ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            HOME: HOMEDIR,
            CLAUDE_CONFIG_DIR: path.join(HOMEDIR, '.claude'),
            CLAUDE_SESSION_STORE: STORE,
            AUTODEV_CODE_DIR: P('code'),
        },
        timeout: 120000,
    });
    return { code: res.status, out: (res.stdout || '') + (res.stderr || ''), signal: res.signal };
}

// -- the absent directory is NOT a zero --------------------------------------
const ABSENT = P('nope');
const rAbsent = spawnSync(process.execPath, [SUBJECT, '--intent-dir', ABSENT, '--stamp-file', STAMP, '--all'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: HOMEDIR, CLAUDE_CONFIG_DIR: path.join(HOMEDIR, '.claude'), CLAUDE_SESSION_STORE: STORE, AUTODEV_CODE_DIR: P('code') },
    timeout: 60000,
});
check('an ABSENT intent directory exits 3, not 0', rAbsent.status === 3, 'exit=' + rAbsent.status);
check('  and says in words that it is not zero records',
    /not zero records/.test(rAbsent.stdout || ''));
check('  and never prints a restart proposal',
    !/PROPOSED, IN ORDER/.test(rAbsent.stdout || ''));

// -- the control: an EMPTY directory IS a zero, and says so ------------------
const EMPTY = mk(P('intent-empty'));
const rEmpty = spawnSync(process.execPath, [SUBJECT, '--intent-dir', EMPTY, '--stamp-file', STAMP, '--all'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: HOMEDIR, CLAUDE_CONFIG_DIR: path.join(HOMEDIR, '.claude'), CLAUDE_SESSION_STORE: STORE, AUTODEV_CODE_DIR: P('code') },
    timeout: 60000,
});
check('an EMPTY intent directory exits 0 - it really is nothing to do', rEmpty.status === 0, 'exit=' + rEmpty.status);
check('  and calls itself a measured zero rather than an empty scan',
    /measured zero/.test(rEmpty.stdout || ''));
check('  so the two cases are distinguishable, which is the whole point',
    rAbsent.status !== rEmpty.status);

// -- a verify that FAILS is a restart proposal, and the verify really ran ----
try { fs.unlinkSync(CANARY); } catch { /* first run */ }
writeRecord({
    repo: 'repoA', branch: 'feat/x', session_id: 'sid-1',
    brief: 'land the thing', current_step: 'wrote the code', next_step: 'run the gate',
    verify: `printf ran > ${JSON.stringify(CANARY)}; exit 1`,
    state: 'checkpointed', updated_at: '2026-09-07T21:52:00Z',
});
const rFail = run([]);
check('a failing verify makes the record a RESTART candidate, exit 2',
    rFail.code === 2, 'exit=' + rFail.code + ' ' + rFail.out.slice(-300));
check('  POSITIVE CONTROL: the verify was actually executed', fs.existsSync(CANARY));
check('  the proposal names the repo and branch',
    /repoA @ feat\/x/.test(rFail.out));
check('  and carries the next_step, so the restart does not start blind',
    /run the gate/.test(rFail.out));
check('  the population is printed beside the count',
    /1 of 1 to restart/.test(rFail.out), rFail.out.slice(-400));
check('  and it says nothing was started',
    /Nothing here has been started/.test(rFail.out));

// -- --no-run-verify does not execute anything (paired with the control above)
try { fs.unlinkSync(CANARY); } catch { /* ignore */ }
const rDry = run(['--no-run-verify']);
check('--no-run-verify executes no verify', !fs.existsSync(CANARY));
check('  and reports COULD-NOT-CHECK rather than inventing a verdict',
    rDry.code === 3, 'exit=' + rDry.code);

// -- a verify that PASSES retires the work, whatever the record claims -------
try { fs.unlinkSync(CANARY); } catch { /* ignore */ }
writeRecord({
    repo: 'repoA', branch: 'feat/x', session_id: 'sid-1', brief: 'land the thing',
    next_step: 'run the gate', verify: `printf ran > ${JSON.stringify(CANARY)}; exit 0`,
    state: 'working', updated_at: '2026-09-07T21:52:00Z',
});
const rPass = run([]);
check('a passing verify retires a record that still says "working", exit 0',
    rPass.code === 0, 'exit=' + rPass.code + ' ' + rPass.out.slice(-300));
check('  POSITIVE CONTROL: that verify ran too', fs.existsSync(CANARY));
check('  and it is listed under NOT RESTARTED, not silently dropped',
    /SKIP-VERIFIED/.test(rPass.out));

// -- an unparseable record is COULD-NOT-CHECK, and is COUNTED ----------------
fs.writeFileSync(path.join(INTENT, 'repoA--broken.json'), '{ this is not json');
const rBroken = run([]);
check('an unparseable record exits 3 even though the other record passed',
    rBroken.code === 3, 'exit=' + rBroken.code);
check('  and it is named under COULD NOT CHECK',
    /COULD NOT CHECK[\s\S]*repoA--broken\.json/.test(rBroken.out));
check('  while the population still counts it: 2 records, not 1',
    /POPULATION: 2 intent records/.test(rBroken.out), rBroken.out.slice(-500));
fs.unlinkSync(path.join(INTENT, 'repoA--broken.json'));

// -- a live session is never proposed ----------------------------------------
// The store record is what the app writes while it holds the session; a fresh
// `lastActivityAt` is the app saying "still running".
const sdir = mk(path.join(STORE, 'ws', 'proj'));
fs.writeFileSync(path.join(sdir, 'local_live.json'), JSON.stringify({
    sessionId: 'local_live', cliSessionId: 'sid-1', cwd: WT, branch: 'feat/x',
    lastActivityAt: Date.now() - 5000, isArchived: false,
}));
try { fs.unlinkSync(CANARY); } catch { /* ignore */ }
writeRecord({
    repo: 'repoA', branch: 'feat/x', session_id: 'sid-1', brief: 'land the thing',
    next_step: 'run the gate', verify: `printf ran > ${JSON.stringify(CANARY)}; exit 1`,
    state: 'checkpointed', updated_at: '2026-09-07T21:52:00Z',
});
const rLive = run([]);
check('a live session is SKIP-LIVE end to end, even with a failing verify',
    /SKIP-LIVE/.test(rLive.out) && rLive.code === 0, 'exit=' + rLive.code);
check('  and its verify is never even run - liveness is decided first',
    !fs.existsSync(CANARY));
fs.writeFileSync(path.join(sdir, 'local_live.json'), JSON.stringify({
    sessionId: 'local_live', cliSessionId: 'sid-1', cwd: WT, branch: 'feat/x',
    lastActivityAt: Date.now() - 5000, isArchived: true,
}));
const rArchived = run([]);
check('  CONTROL: the SAME fresh ping on an ARCHIVED record is not live',
    !/SKIP-LIVE/.test(rArchived.out) && rArchived.code === 2, 'exit=' + rArchived.code);
check('  so SKIP-LIVE above came from liveness, not from the fixture always skipping',
    /PROPOSED, IN ORDER/.test(rArchived.out));
fs.unlinkSync(path.join(sdir, 'local_live.json'));

// -- the boundary gate no-ops rather than restarting mid-work ----------------
//
// The fixture wall names resetsAt 1788819000 (2026-09-07T22:10:00Z). A stamp
// written AFTER that moment means the boundary was already handled.
fs.writeFileSync(STAMP, '2026-09-07T23:00:00Z\n');
try { fs.unlinkSync(CANARY); } catch { /* ignore */ }
const rGated = spawnSync(process.execPath, [SUBJECT, '--intent-dir', INTENT, '--stamp-file', STAMP], {
    encoding: 'utf8',
    env: { ...process.env, HOME: HOMEDIR, CLAUDE_CONFIG_DIR: path.join(HOMEDIR, '.claude'), CLAUDE_SESSION_STORE: STORE, AUTODEV_CODE_DIR: P('code') },
    timeout: 60000,
});
check('a boundary already handled makes the run a no-op, exit 0',
    rGated.status === 0 && /NO RESET BOUNDARY/.test(rGated.stdout || ''), 'exit=' + rGated.status);
check('  and a gated no-op runs no verify at all', !fs.existsSync(CANARY));
check('  while still printing how many boundaries it read, not just silence',
    /boundaries recorded/.test(rGated.stdout || ''));

// The control: a stamp BEFORE the boundary must let the same fixture through.
fs.writeFileSync(STAMP, '2026-09-07T12:00:00Z\n');
const rUngated = spawnSync(process.execPath, [SUBJECT, '--intent-dir', INTENT, '--stamp-file', STAMP], {
    encoding: 'utf8',
    env: { ...process.env, HOME: HOMEDIR, CLAUDE_CONFIG_DIR: path.join(HOMEDIR, '.claude'), CLAUDE_SESSION_STORE: STORE, AUTODEV_CODE_DIR: P('code') },
    timeout: 60000,
});
check('CONTROL: a stamp before the boundary lets the same fixture through',
    !/NO RESET BOUNDARY/.test(rUngated.stdout || ''), rUngated.stdout.slice(0, 300));
check('  so the gate above discriminates, rather than always no-opping',
    rGated.status !== rUngated.status || rGated.stdout !== rUngated.stdout);

// -- the stamp is written only when asked ------------------------------------
fs.writeFileSync(STAMP, '2026-09-07T12:00:00Z\n');
run([]);
check('a run without --stamp leaves the stamp alone',
    fs.readFileSync(STAMP, 'utf8').trim() === '2026-09-07T12:00:00Z');
run(['--stamp']);
check('  and --stamp advances it',
    fs.readFileSync(STAMP, 'utf8').trim() !== '2026-09-07T12:00:00Z');

// -- JSON output carries the same distinctions -------------------------------
const rJson = run(['--json']);
let parsed = null;
try { parsed = JSON.parse(rJson.out); } catch { /* left null */ }
check('--json emits parseable JSON on stdout', parsed !== null, rJson.out.slice(0, 200));
check('  carrying the population and the summary',
    !!parsed && parsed.population.records === 1 && typeof parsed.summary === 'object');
check('  and the boundary readability, so a consumer cannot mistake it for zero',
    !!parsed && parsed.boundary.readable === true);

// -- the repo's own macOS truncation trap ------------------------------------
//
// `process.exit()` after writing to stdout delivers exactly 65536 bytes through
// a PIPE on darwin and still exits 0. This subject prints and must therefore
// never call it; the source is asserted directly because a byte-count test on
// this tool's small output would pass by construction.
const src = fs.readFileSync(SUBJECT, 'utf8');
check('the subject never calls process.exit() - it sets process.exitCode',
    !/(^|[^.\w])process\.exit\s*\(/.test(src));
check('  and it does set process.exitCode', /process\.exitCode\s*=/.test(src));

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* leave it */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
