#!/usr/bin/env node
// Suite for plugins/autodev-core/scripts/session-sweep.js
//
// The sweep decides which git worktrees are safe to DELETE. Everything else it
// does is reporting. So this suite exists for one reason: to prove the safety
// check can actually fire, per defect class, and to prove it can also pass —
// a gate that blocks everything is as useless as one that blocks nothing.
//
// Method: build a real git repo with a real remote, plant one real defect per
// worktree, drive a synthetic session store through the REAL script via
// SESSION_SWEEP_STORE, and assert the SPECIFIC label for each case. Asserting
// only "safe === false" would pass when the wrong gate fires, which is how a
// narrowed filter goes silently dead.
//
// Run: node tooling/test-session-sweep.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'session-sweep.js');

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
  if (ok) { passed++; return; }
  failures.push(`${name}\n      expected: ${typeof expected === 'function' ? expected.toString() : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

// --------------------------------------------------------------------- setup

// NOTE: the bare repo lives under a directory literally named `github.com` so the
// worktree's origin URL contains that host. isThirdParty() treats any non-github
// remote as third-party and excludes it — correct in production, and it would
// otherwise mask every case here behind a single exclusion.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-suite-'));
const BARE = path.join(ROOT, 'github.com', 'origin.git');
const MAIN = path.join(ROOT, 'checkout');
// Two workspace dirs under one store root. The app tracks exactly one, and which
// one a record sits in decides whether --archive-orphaned may write it. LIVE is
// anchored by a recent record; OLD carries only stale ones.
const STORE = path.join(ROOT, 'store');
const WS_LIVE = 'live-workspace';
const WS_OLD = 'orphaned-workspace';

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function setup() {
  fs.mkdirSync(path.dirname(BARE), { recursive: true });
  fs.mkdirSync(STORE, { recursive: true });
  sh(`git init --bare --initial-branch=main "${BARE}"`, ROOT);
  sh(`git clone "${BARE}" "${MAIN}"`, ROOT);
  sh('git config user.email suite@example.com', MAIN);
  sh('git config user.name Suite', MAIN);
  fs.writeFileSync(path.join(MAIN, 'README.md'), 'base\n');
  sh('git add README.md', MAIN);
  sh('git commit -q -m base', MAIN);
  sh('git push -q -u origin main', MAIN);
  sh('git remote set-head origin main', MAIN);
}

// Each case returns the worktree path it built (or null for "no worktree").
function makeWorktree(name, branch) {
  const wt = path.join(ROOT, 'wt', name);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  sh(`git worktree add -q -b ${branch} "${wt}" main`, MAIN);
  sh('git config user.email suite@example.com', wt);
  sh('git config user.name Suite', wt);
  return wt;
}

function commitIn(wt, file, msg) {
  fs.writeFileSync(path.join(wt, file), `${msg}\n`);
  sh(`git add ${file}`, wt);
  sh(`git commit -q -m "${msg}"`, wt);
}

const cases = [];

function buildCases() {
  // 1. KNOWN POSITIVE — clean, branch pushed. Proves the gate can PASS.
  //    Without this, a gate that blocks unconditionally scores full marks.
  {
    const wt = makeWorktree('clean-pushed', 'case-clean');
    sh('git push -q -u origin case-clean', wt);
    cases.push({ id: 'clean-pushed', wt, expectRisk: null, expectSafe: true });
  }

  // 2. Uncommitted file — the defect that nearly cost real work today.
  {
    const wt = makeWorktree('dirty', 'case-dirty');
    sh('git push -q -u origin case-dirty', wt);
    fs.writeFileSync(path.join(wt, 'scratch.txt'), 'uncommitted\n');
    cases.push({ id: 'dirty', wt, expectRisk: (r) => /^dirty\(1 file\)$/.test(r), expectSafe: false });
  }

  // 3. Committed but not pushed — branch exists on the remote, HEAD is ahead.
  {
    const wt = makeWorktree('unpushed', 'case-unpushed');
    sh('git push -q -u origin case-unpushed', wt);
    commitIn(wt, 'a.txt', 'local only');
    cases.push({ id: 'unpushed', wt, expectRisk: (r) => /^unpushed\(1\)$/.test(r), expectSafe: false });
  }

  // 4. Branch never pushed, carrying a commit the default branch lacks.
  //    This is the case where `origin/<branch>..HEAD` resolves to nothing and a
  //    naive count reports 0 — an empty result that means the probe could not
  //    run, not that nothing would be lost.
  {
    const wt = makeWorktree('orphan', 'case-orphan');
    commitIn(wt, 'b.txt', 'exists nowhere else');
    cases.push({ id: 'orphan', wt, expectRisk: (r) => /^orphan-commits\(1\)$/.test(r), expectSafe: false });
  }

  // 5. Branch never pushed but carrying NOTHING extra. Must NOT block: this is
  //    the over-blocking direction, and it is what made three real sessions
  //    look unsafe when they had nothing to lose.
  {
    const wt = makeWorktree('local-empty', 'case-local-empty');
    cases.push({ id: 'local-empty', wt, expectRisk: null, expectSafe: true });
  }

  // 6. Worktree path exists but is not a git repo at all. Unknown must fail
  //    CLOSED — never fall through to "safe to delete".
  {
    const wt = path.join(ROOT, 'notgit');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, 'x.txt'), 'not a repo\n');
    cases.push({ id: 'not-a-repo', wt, expectRisk: 'git-unreadable', expectSafe: false });
  }

  // 7. No worktree recorded at all — nothing on disk to lose.
  cases.push({ id: 'no-worktree', wt: null, expectRisk: null, expectSafe: true });

  // 8. The app's own opt-out must win over every other signal.
  cases.push({ id: 'exempt', wt: null, expectRisk: null, expectSafe: false, exempt: true });

  // 9. ARGUMENT injection — a checked-out branch whose name begins with '-'.
  //
  // This is not shell injection and execFileSync does not help: the shell was
  // never the vector. A leading dash makes the value an OPTION to git's own
  // parser when it arrives as a bare positional.
  //
  // Reachable, and this fixture is the proof rather than the claim.
  // `git branch -- '--upload-pack=x'` is refused, but `git update-ref
  // refs/heads/--upload-pack=x HEAD` succeeds, and `symbolic-ref HEAD` then
  // makes it the checked-out branch — which is exactly what the sweep reads
  // with `rev-parse --abbrev-ref HEAD`.
  //
  // The expected label is the fail-CLOSED one. A branch name we will not hand
  // to git is a worktree we cannot clear for deletion, so it must block, and it
  // must block under its OWN label: asserting only `safe === false` would pass
  // when some other gate fires and would go quietly dead if this one stopped.
  {
    const wt = makeWorktree('dash-branch', 'case-dash-seed');
    sh('git update-ref "refs/heads/--upload-pack=whoami" HEAD', wt);
    sh('git symbolic-ref HEAD "refs/heads/--upload-pack=whoami"', wt);
    // The fixture is only meaningful if git really does hand the name back.
    const live = sh('git rev-parse --abbrev-ref HEAD', wt);
    if (live !== '--upload-pack=whoami') {
      failures.push(`dash-branch fixture did not take: rev-parse returned ${JSON.stringify(live)}`);
    }
    cases.push({ id: 'dash-branch', wt, expectRisk: 'branch-name-unsafe', expectSafe: false });
  }
}

// A session record old enough to be STALE under the 14d hand-started clock.
function writeSession(c, i) {
  const rec = {
    sessionId: `local_suite-${i}-${c.id}`,
    title: `suite:${c.id}`,
    cwd: c.wt || MAIN,
    originCwd: MAIN,
    isArchived: false,
    lastActivityAt: Date.now() - 40 * 86400000,
    createdAt: Date.now() - 60 * 86400000,
  };
  if (c.wt) rec.worktreePath = c.wt;
  if (c.exempt) rec.autoArchiveExempt = true;
  if (c.scheduledTaskId) rec.scheduledTaskId = c.scheduledTaskId;
  // The repo slug is deliberately unresolvable, so refreshPrStates() fails for
  // it and the cached state below is what gets used. That exercises the
  // documented fallback rather than requiring network in the suite.
  if (c.prs) rec.prs = c.prs;
  if (c.ageDays != null) rec.lastActivityAt = Date.now() - c.ageDays * 86400000;
  const dir = path.join(STORE, c.workspace || WS_LIVE, 'sub');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${rec.sessionId}.json`);
  // Minified, exactly as the app writes it: --archive-orphaned does a string
  // replace on `"isArchived":false`, so the spacing has to match reality.
  fs.writeFileSync(file, JSON.stringify(rec), 'utf8');
  c.__file = file;
  return rec.sessionId;
}

// ---------------------------------------------------------------------- run

// An unreadable store must REFUSE, never report a zero. [measured 2026-08-28]
// the default path was `~/.config/Claude/...`, which does not exist on macOS,
// so the store read as empty and the script printed "POPULATION: 0" followed by
// "BLOCKED — work exists in exactly one place: 0 (none — every finished own-repo
// session is committed and pushed)". That last line is the hazard: an
// affirmative all-clear about a directory the process never opened. Asserting
// only the exit code would pass a version that still printed the all-clear
// first, so the absence of those strings is asserted by name.
function checkUnreadableStoreRefuses() {
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, SESSION_SWEEP_STORE: path.join(ROOT, 'no-such-store-dir') },
  });
  check('unreadable store: exits non-zero', res.status !== 0, true);
  check('unreadable store: exit code is 2', res.status, 2);
  check('unreadable store: says COULD NOT READ', /COULD NOT READ/.test(res.stderr || ''), true);
  check('unreadable store: names the path it tried', (res.stderr || '').includes('no-such-store-dir'), true);
  check('unreadable store: prints NO population count', /POPULATION:/.test(res.stdout || ''), false);
  check('unreadable store: prints NO safe-to-archive verdict', /SAFE TO ARCHIVE/.test(res.stdout || ''), false);
  check('unreadable store: prints NO blocked all-clear', /BLOCKED/.test(res.stdout || ''), false);
}

// The known-positive control for the above. A refusal test alone cannot tell a
// correct guard from a script that refuses unconditionally, so a store that IS
// readable must still produce a population.
function checkReadableStoreStillScans() {
  const okStore = path.join(ROOT, 'readable-empty-store');
  fs.mkdirSync(okStore, { recursive: true });
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, SESSION_SWEEP_STORE: okStore, SESSION_SWEEP_OWNER: '' },
  });
  check('readable store: exits 0', res.status, 0);
  check('readable store: prints a population line', /POPULATION:/.test(res.stdout || ''), true);
}

// Every other case in this suite drives SESSION_SWEEP_STORE, so the DEFAULT path
// is the one thing they can never see — a mutation reverting the macOS branch
// survived the whole suite. Run with the override unset and HOME faked, and read
// the path back out of the refusal, which names it.
function checkPlatformDefaultPath() {
  const fakeHome = path.join(ROOT, 'fake-home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
  delete env.SESSION_SWEEP_STORE;
  delete env.XDG_CONFIG_HOME;
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env });
  const said = (res.stderr || '') + (res.stdout || '');

  const expected = process.platform === 'darwin'
    ? path.join(fakeHome, 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
    : process.platform === 'win32'
      ? path.join(env.APPDATA || fakeHome, 'Claude', 'claude-code-sessions')
      : path.join(fakeHome, '.config', 'Claude', 'claude-code-sessions');

  check(`default store path for ${process.platform}`, said.includes(expected), true);
  // The macOS regression specifically: ~/.config must NOT be where it looks.
  if (process.platform === 'darwin') {
    check('darwin does not fall back to ~/.config', said.includes(path.join(fakeHome, '.config')), false);
  }
}

// Plant an isolated store of raw records and read the sweep's own JSON back.
// Separate from the main fixture on purpose: these two guards are about how
// records relate to EACH OTHER and to transcripts on disk, neither of which the
// per-worktree cases model.
function sweepWith(records, tag, extraEnv) {
  const store = path.join(ROOT, `store-${tag}`);
  const dir = path.join(store, 'live-ws', 'sub');
  fs.mkdirSync(dir, { recursive: true });
  for (const r of records) {
    fs.writeFileSync(path.join(dir, `${r.sessionId}.json`), JSON.stringify(r), 'utf8');
  }
  const res = spawnSync(process.execPath, [SCRIPT, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, SESSION_SWEEP_STORE: store, SESSION_SWEEP_OWNER: '', ...extraEnv },
  });
  try { return JSON.parse(res.stdout); }
  catch { failures.push(`sweepWith(${tag}): unparseable JSON\n${(res.stdout || res.stderr || '').slice(0, 400)}`); return []; }
}

const staleRec = (id, dir, extra) => ({
  sessionId: `local_${id}`, title: id, cwd: dir, originCwd: dir, worktreePath: dir,
  isArchived: false, lastActivityAt: Date.now() - 40 * 86400000,
  createdAt: Date.now() - 60 * 86400000, ...extra,
});

// archive_session DELETES the worktree, so a worktree named by two live records
// is one archive away from being pulled out from under the other. [measured
// 2026-08-28] "Census lcd.js" and "Fix dead regex in ask.js" both named
// .../worktrees/mito-keys while a third session worked there; both read as 8.7d
// idle and would have swept.
function checkSharedWorktreeBlocks() {
  // Deliberately NOT created on disk. A worktree that no longer exists is
  // already disposable, so the existence check short-circuits and whatever risk
  // survives is the one these two guards produced — nothing else can mask it.
  const shared = path.join(ROOT, 'shared-wt');
  const solo = path.join(ROOT, 'solo-wt');

  const rows = sweepWith([
    staleRec('shared-a', shared),
    staleRec('shared-b', shared),
    staleRec('solo', solo),
  ], 'shared');

  const a = rows.find((r) => r.sessionId === 'local_shared-a');
  const b = rows.find((r) => r.sessionId === 'local_shared-b');
  const c = rows.find((r) => r.sessionId === 'local_solo');

  check('shared worktree: first record is not safe', a && a.safe, false);
  check('shared worktree: second record is not safe', b && b.safe, false);
  // By name, not merely falsy — "dirty" and "shared" are both unsafe and only
  // one of them is the thing this guard exists to catch.
  check('shared worktree: labelled shared-worktree', a && a.risk, (v) => /^shared-worktree\(2 sessions\)$/.test(v || ''));
  check('shared worktree: names the count', b && b.risk, (v) => /2 sessions/.test(v || ''));
  // The control that makes the three above mean something: a worktree nobody
  // else names must NOT pick up this label, or the guard is just blocking all.
  check('sole occupant is not labelled shared', c && c.risk, (v) => !/shared-worktree/.test(v || ''));
}

// `lastActivityAt` is a liveness ping the app refreshes only while IT holds the
// session, and it FREEZES rather than failing otherwise. [measured 2026-08-28]
// two records read as nine days idle while that worktree's transcript had been
// written three minutes earlier. The idle clock alone therefore cannot stand
// between a running session and rm -rf of its worktree.
function checkLiveTranscriptBlocks() {
  // Not created on disk, for the same reason as the shared-worktree case: an
  // absent worktree is already disposable, so any risk left is this guard's.
  const wtLive = path.join(ROOT, 'live-transcript-wt');
  const wtCold = path.join(ROOT, 'cold-transcript-wt');

  // Transcripts live at <config>/projects/<cwd with / and . turned into ->.
  const cfg = path.join(ROOT, 'fake-claude-config');
  const plant = (wt, ageMinutes) => {
    // Same transform as session-sweep's own slug, including the Windows
    // backslash and drive colon. Without them this mkdir embeds `C:` in the
    // middle of a path, which is legal on POSIX and an ENOENT on Windows.
    const d = path.join(cfg, 'projects', wt.replace(/[/.:\\\\]/g, '-'));
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, 'transcript.jsonl');
    fs.writeFileSync(f, '{}\n', 'utf8');
    const when = new Date(Date.now() - ageMinutes * 60000);
    fs.utimesSync(f, when, when);
  };
  plant(wtLive, 5);        // five minutes ago — someone is in there
  plant(wtCold, 60 * 24 * 9); // nine days ago — genuinely finished

  const rows = sweepWith(
    [staleRec('live-tx', wtLive), staleRec('cold-tx', wtCold)],
    'transcript',
    { CLAUDE_CONFIG_DIR: cfg },
  );

  const live = rows.find((r) => r.sessionId === 'local_live-tx');
  const cold = rows.find((r) => r.sessionId === 'local_cold-tx');

  check('fresh transcript: not safe despite a 40d idle clock', live && live.safe, false);
  check('fresh transcript: labelled live-transcript', live && live.risk, (v) => /^live-transcript\(\d+m ago\)$/.test(v || ''));
  // The known-positive control. Without it a guard that blocked every record
  // would pass both assertions above.
  check('cold transcript: still sweeps', cold && cold.safe, true);
  check('cold transcript: carries no risk label', cold && cold.risk, null);
}

function run() {
  setup();
  buildCases();

  checkUnreadableStoreRefuses();
  checkReadableStoreStillScans();
  checkPlatformDefaultPath();
  checkSharedWorktreeBlocks();
  checkLiveTranscriptBlocks();

  // Two extra records for the ephemeral clock: same 5-day idle, differing only
  // by whether a schedule launched them. Derived from the same age so the pair
  // cannot drift apart and quietly stop testing the distinction.
  const EPH_AGE = 5;
  cases.push({ id: 'sched-stale', wt: null, scheduledTaskId: 'suite-task', ageDays: EPH_AGE, expectState: 'STALE' });
  cases.push({ id: 'hand-active', wt: null, ageDays: EPH_AGE, expectState: 'ACTIVE' });

  // A settled PR bypasses the idle clock, so "merged" alone would call a session
  // finished while its author is still in it — measured on two real sessions
  // whose PRs had merged three minutes earlier. The floor requires finished AND
  // cold. All three records carry identical PRs and differ only in age, so a bug
  // that ignores the floor cannot satisfy the set.
  //
  // What the floor guards is a liveness PING, not a workday: `lastActivityAt`
  // freezes when a session stops running, so hours of it mean "the app is not
  // running this", not "someone is typing slowly". `merged-idle` is the
  // regression — at 2h it sat inside the old 12-HOUR floor and read ACTIVE,
  // which left finished sessions unarchivable for half a day. This fixture was
  // itself part of the bug: `merged-warm` used to be 0.1 DAYS (2.4h), which
  // encoded exactly the wrong model of what "still warm" means.
  const MERGED_PRS = [{ prNumber: 1, repo: 'suite-nonexistent/repo', state: 'MERGED' }];
  const WARM_MIN = 3;         // the measured incident, exactly
  const IDLE_MIN = 2 * 60;    // finished, and the app has stopped pinging it
  cases.push({ id: 'merged-warm', wt: null, prs: MERGED_PRS, ageDays: WARM_MIN / 1440, expectState: 'ACTIVE' });
  cases.push({ id: 'merged-idle', wt: null, prs: MERGED_PRS, ageDays: IDLE_MIN / 1440, expectState: 'MERGED' });
  cases.push({ id: 'merged-cold', wt: null, prs: MERGED_PRS, ageDays: 3, expectState: 'MERGED' });

  // Anchors WS_LIVE as the workspace the app is using: it owns the newest record.
  cases.push({ id: 'ws-anchor', wt: null, ageDays: 0, expectState: 'ACTIVE' });
  // Two identical safe rows differing ONLY by workspace. --archive-orphaned must
  // write the orphaned one and must NOT touch the live one — the app holds live
  // records in memory, so writing them is both futile and a corruption risk.
  cases.push({ id: 'orphan-ws-safe', wt: null, workspace: WS_OLD, ageDays: 40, expectState: 'STALE' });
  cases.push({ id: 'live-ws-safe', wt: null, workspace: WS_LIVE, ageDays: 40, expectState: 'STALE' });

  const ids = cases.map((c, i) => writeSession(c, i));

  const res = spawnSync(process.execPath, [SCRIPT, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, SESSION_SWEEP_STORE: STORE, SESSION_SWEEP_OWNER: '' },
    timeout: 180000,
  });

  if (res.status !== 0) {
    failures.push(`script exited ${res.status}\n${(res.stderr || '').slice(0, 600)}`);
    return;
  }

  let rows;
  try { rows = JSON.parse(res.stdout); }
  catch (e) { failures.push(`unparseable JSON: ${e.message}\n${res.stdout.slice(0, 400)}`); return; }

  // Population assertion: if the store were mis-read, every per-case assertion
  // below would vacuously "pass" on an empty set.
  check('all planted sessions were read', rows.length, cases.length);

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const row = rows.find((r) => r.sessionId === ids[i]);
    if (!row) { failures.push(`${c.id}: no row returned`); continue; }

    if (c.expectState) {
      check(`${c.id}: state`, row.state, c.expectState);
      continue;
    }
    check(`${c.id}: risk label`, row.risk, c.expectRisk);
    check(`${c.id}: safe`, row.safe, c.expectSafe);
    check(`${c.id}: not misfiled as third-party`, row.thirdParty, false);
  }

  // The ephemeral pair must actually DIFFER, or both assertions above could be
  // satisfied by a bug that ignores the clock entirely.
  const sched = rows.find((r) => r.sessionId === ids[cases.findIndex((c) => c.id === 'sched-stale')]);
  const hand = rows.find((r) => r.sessionId === ids[cases.findIndex((c) => c.id === 'hand-active')]);
  check('ephemeral clock separates the pair', sched && hand && sched.state !== hand.state, true);

  const byId = (id) => rows.find((r) => r.sessionId === ids[cases.findIndex((c) => c.id === id)]);
  const warm = byId('merged-warm');
  const idle = byId('merged-idle');
  const cold = byId('merged-cold');
  check('merged floor separates the pair', warm && cold && warm.state !== cold.state, true);
  // The regression this floor's SIZE caused: settled, quiet for hours, and
  // still called ACTIVE. Same PRs as the warm record, so only idle time can
  // explain a difference.
  check('merged floor releases a session idle for hours', idle && idle.state, 'MERGED');

  // The pair must STRADDLE the floor the subject actually ships with. Restating
  // the number here would let the two halves drift onto the same side of it and
  // leave a green that asserts nothing — so read it out of the subject. If it
  // cannot be found, FAIL rather than skip: a reassuring skip converts absent
  // coverage into reported coverage.
  const floorSrc = fs.readFileSync(SCRIPT, 'utf8').match(/DEFAULT_MERGED_MIN_MINUTES\s*=\s*(\d+(?:\.\d+)?)/);
  check('floor default is readable from the subject', !!floorSrc, true);
  const FLOOR_MIN = floorSrc ? parseFloat(floorSrc[1]) : NaN;
  check(`warm fixture (${WARM_MIN}m) sits INSIDE the shipped floor`, WARM_MIN < FLOOR_MIN, true);
  check(`idle fixture (${IDLE_MIN}m) sits OUTSIDE the shipped floor`, IDLE_MIN > FLOOR_MIN, true);

  // The floor is a number read off the command line, and NaN would make every
  // `<` comparison false — disabling it SILENTLY rather than loudly. Drive a
  // garbage value through the real flag and assert the warm record is still
  // held back. Fails open otherwise, which is the direction that loses work.
  const bad = spawnSync(process.execPath, [SCRIPT, '--json', '--merged-min-minutes', 'garbage'], {
    encoding: 'utf8',
    env: { ...process.env, SESSION_SWEEP_STORE: STORE, SESSION_SWEEP_OWNER: '' },
    timeout: 180000,
  });
  let badRows = [];
  try { badRows = JSON.parse(bad.stdout || '[]'); } catch { /* asserted below */ }
  check('unparseable floor value: still classified a population', badRows.length, cases.length);
  const badWarm = badRows.find((r) => r.sessionId === ids[cases.findIndex((c) => c.id === 'merged-warm')]);
  check('unparseable floor value falls back, floor still holds', badWarm && badWarm.state, 'ACTIVE');

  // ---- --write-resume -----------------------------------------------------
  // Runs BEFORE --archive-orphaned on purpose: that flag marks SAFE records
  // archived, which drops them out of `live` and would leave this with nothing
  // to write. The stub is the handoff a reader gets INSTEAD of the transcript,
  // so an empty or unattributed one is the failure worth catching.
  {
    const RESUME_CWD = path.join(ROOT, 'resume-cwd');
    fs.mkdirSync(RESUME_CWD, { recursive: true });
    const w = spawnSync(process.execPath, [SCRIPT, '--write-resume'], {
      encoding: 'utf8',
      cwd: RESUME_CWD,               // stubs land under the CALLER's cwd
      env: { ...process.env, SESSION_SWEEP_STORE: STORE, SESSION_SWEEP_OWNER: '' },
      timeout: 180000,
    });
    const out = w.stdout || '';
    check('write-resume exits 0', w.status, 0);

    // Derived from the same run's own JSON verdicts, never restated: if the
    // safe set changes, the expectation moves with it instead of going stale.
    const safeRows = rows.filter((r) => r.safe);
    check('the safe set is non-empty, so the count below is not vacuous', safeRows.length > 0, true);
    check('it reports one stub per SAFE row',
      new RegExp(`Wrote ${safeRows.length} resume stub`).test(out), true);

    const outDir = path.join(RESUME_CWD, '.claude', 'handoffs');
    const written = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.md')) : [];
    check('that many files really exist on disk', written.length, safeRows.length);

    // The clean-pushed case is SAFE, so it must have a stub — and the stub has
    // to carry what a reader needs to pick the work back up. A file that exists
    // but names no session is worse than none.
    const stubFile = path.join(outDir, 'resume-suite-clean-pushed.md');
    check('the SAFE clean-pushed session got a stub', fs.existsSync(stubFile), true);
    const stub = fs.existsSync(stubFile) ? fs.readFileSync(stubFile, 'utf8') : '';
    const cleanId = ids[cases.findIndex((c) => c.id === 'clean-pushed')];
    check('the stub is titled for the session', stub.includes('# RESUME — suite:clean-pushed'), true);
    check('the stub names the session id it belongs to', stub.includes(cleanId), true);
    check('the stub carries the verdict that made it safe', /\| verdict \| STALE/.test(stub), true);
    check('the stub records the worktree risk explicitly', stub.includes('| worktree risk | none |'), true);
    check('the stub points at the worktree on disk',
      stub.includes(cases.find((c) => c.id === 'clean-pushed').wt), true);

    // A BLOCKED row must never get a stub: a handoff for a session whose work
    // exists in exactly one place reads as "archived and handed over".
    check('no stub for the dirty (blocked) session',
      fs.existsSync(path.join(outDir, 'resume-suite-dirty.md')), false);
  }

  // ---- --archive-orphaned -------------------------------------------------
  const orphanCase = cases.find((c) => c.id === 'orphan-ws-safe');
  const liveCase = cases.find((c) => c.id === 'live-ws-safe');
  const readArchived = (c) => {
    try { return JSON.parse(fs.readFileSync(c.__file, 'utf8')).isArchived; }
    catch { return 'unreadable'; }
  };

  // Without the flag, nothing may be written at all.
  check('no flag: orphaned record untouched', readArchived(orphanCase), false);
  check('no flag: live record untouched', readArchived(liveCase), false);

  const w = spawnSync(process.execPath, [SCRIPT, '--archive-orphaned'], {
    encoding: 'utf8',
    env: { ...process.env, SESSION_SWEEP_STORE: STORE, SESSION_SWEEP_OWNER: '' },
    timeout: 180000,
  });
  if (w.status !== 0) {
    failures.push(`--archive-orphaned exited ${w.status}\n${(w.stderr || '').slice(0, 400)}`);
  } else {
    check('archive-orphaned: orphaned record IS archived', readArchived(orphanCase), true);
    // The one that matters. A pass here with the previous line failing would
    // mean the write works but hits the wrong workspace.
    check('archive-orphaned: LIVE record NOT archived', readArchived(liveCase), false);
    check('archive-orphaned: file still parses', typeof readArchived(orphanCase), 'boolean');
  }
}

function cleanup() {
  try { sh(`git worktree prune`, MAIN); } catch { /* best effort */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows file locks */ }
}

try {
  run();
} catch (e) {
  failures.push(`suite crashed: ${e.message}`);
} finally {
  cleanup();
}

const total = passed + failures.length;
if (failures.length) {
  console.error(`session-sweep: ${passed}/${total} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`session-sweep: ${passed}/${total} passed — ${cases.length} planted worktree states, every safety label asserted by name`);
