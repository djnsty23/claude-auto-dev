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
const { execFileSync, execSync, spawnSync } = require('child_process');
const { classify, reason, runBudgeted, tally, exitCode } = require('./spawn-budget.js');

const SCRIPT = process.env.SESSION_SWEEP_TEST_SCRIPT || path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'session-sweep.js');

let passed = 0;
let preserveStates = 0;
const failures = [];
let infra = 0;
const indeterminate = [];

// A child that produced no verdict is INFRASTRUCTURE, not a finding about
// session-sweep.js. Measured 2026-09-08 by forcing a budgeted spawn here to
// return `status=null signal=SIGTERM ETIMEDOUT`: this suite printed
// `session-sweep: 20/21 passed, 1 FAILED` with `✗ script exited null` -- a
// killed child counted as the script exiting wrongly.
//
// Only the four spawns that already carried a 180s budget go through this. The
// unbudgeted ones cannot be killed by a budget and are left alone.
function settle(r, what, expect) {
  if (classify(r, expect) === 'infrastructure') {
    infra++;
    indeterminate.push(what + ' (' + reason(r) + ')');
    console.error('infrastructure: ' + what + ' produced no verdict (' + reason(r)
      + '; ' + r.attempts + ' attempt(s), budget ' + r.budgetMs + 'ms)');
  }
  return r;
}

function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
  if (ok) {
    passed++;
    if (/^(F[1-5]|S1|B1|W[1-5]|guard )/.test(name)) console.log('PASS ' + name);
    return;
  }
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
  const excludes = path.join(ROOT, 'empty-excludes');
  fs.writeFileSync(excludes, '');
  sh(`git config core.excludesFile "${excludes}"`, MAIN);
  sh('git config user.email suite@example.com', MAIN);
  sh('git config user.name Suite', MAIN);
  fs.writeFileSync(path.join(MAIN, 'README.md'), 'base\n');
  // The ignore list is part of the base so the local-only cases below can plant
  // a real gitignored file: one a session would lose, one a build regenerates.
  fs.writeFileSync(path.join(MAIN, '.gitignore'), '.env.local\nnode_modules/\n.next/\n.claude/\n');
  sh('git add README.md .gitignore', MAIN);
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

  // 3b. The unpushed check itself fails. The branch is on origin, but this
  //     clone has no `origin/<branch>` ref, which is the state of a branch
  //     pushed from another clone and never fetched here. `git log
  //     origin/<branch>..HEAD` then exits 128. The sweep read that as "nothing
  //     unpushed" and cleared the worktree, with a commit that exists nowhere
  //     else. Case 3 is the control: the same shape with the ref present.
  {
    const wt = makeWorktree('unpushed-unfetched', 'case-unfetched');
    sh('git push -q -u origin case-unfetched', wt);
    sh('git update-ref -d refs/remotes/origin/case-unfetched', wt);
    commitIn(wt, 'u.txt', 'local only, never fetched');
    // git localises its messages, so the label is matched on what it cannot
    // translate: the command, the status, and the revision range.
    cases.push({
      id: 'unpushed-unfetched', wt, expectSafe: false,
      expectRisk: (r) => /^unpushed-uncheckable\(git log exited 128: /.test(r || '') && /origin\/case-unfetched\.\.HEAD/.test(r),
    });
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

  // 4b. Clean, pushed, and holding a gitignored file that exists nowhere else.
  //     `git status --porcelain` is silent about it, so the sweep read this
  //     worktree as SAFE and the archive that followed deleted the only copy.
  //     [measured 2026-09-16] a session's `.env.local`, holding a service key
  //     no other checkout had, went with its worktree when its PR merged and
  //     the app auto-archived the session. Nothing about the sweep had fired.
  {
    const wt = makeWorktree('local-only', 'case-local-only');
    sh('git push -q -u origin case-local-only', wt);
    fs.writeFileSync(path.join(wt, '.env.local'), 'SECRET=only-here\n');
    cases.push({ id: 'local-only', wt, expectRisk: (r) => /^local-only\(1 file: \.env\.local\)$/.test(r), expectSafe: false });
  }

  // 4c. The control for 4b: ignored files a build, an install or the harness
  //     itself writes back must NOT block, or every worktree that ever ran
  //     `npm install` is stuck for good. One of each, and the build dir sits
  //     under a package directory, because a root-anchored pattern missed
  //     `site/.next/` on a real worktree.
  {
    const wt = makeWorktree('ignored-regenerable', 'case-ignored-regen');
    sh('git push -q -u origin case-ignored-regen', wt);
    fs.mkdirSync(path.join(wt, 'node_modules', 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    fs.mkdirSync(path.join(wt, 'site', '.next'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'site', '.next', 'trace'), 'build output\n');
    fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.claude', 'knowledge-surfaced'), 'sid\tarea\n');
    fs.writeFileSync(path.join(wt, '.claude', 'COMMIT_MSG_v0001.txt'), 'scratch\n');
    cases.push({ id: 'ignored-regenerable', wt, expectRisk: null, expectSafe: true });
  }

  // 4d. A report under `.claude/` is NOT harness scratch: it is the session's
  //     only copy of what it found, and the label must name the FILE so the
  //     reader can copy it out. The fixture ignores `.claude/` wholesale, so
  //     `git status` prints one directory entry and the sweep has to open it;
  //     the harness state file beside the report must not be named.
  {
    const wt = makeWorktree('local-only-report', 'case-local-only-report');
    sh('git push -q -u origin case-local-only-report', wt);
    fs.mkdirSync(path.join(wt, '.claude', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.claude', 'reports', 'audit.md'), 'findings\n');
    fs.writeFileSync(path.join(wt, '.claude', 'knowledge-surfaced'), 'sid\tarea\n');
    cases.push({ id: 'local-only-report', wt, expectRisk: (r) => /^local-only\(1 file: \.claude\/reports\/audit\.md\)$/.test(r), expectSafe: false });
  }

  // 5. Branch never pushed but carrying NOTHING extra. Must NOT block: this is
  //    the over-blocking direction, and it is what made three real sessions
  //    look unsafe when they had nothing to lose.
  {
    const wt = makeWorktree('local-empty', 'case-local-empty');
    cases.push({ id: 'local-empty', wt, expectRisk: null, expectSafe: true });
  }

  // 6. A folder without .git has local residue and stays blocked until preserved.
  {
    const wt = path.join(ROOT, 'notgit');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, 'x.txt'), 'not a repo\n');
    cases.push({ id: 'not-a-repo', wt, expectRisk: 'leftover-dir(1 files)', expectSafe: false });
  }
  {
    const wt = path.join(ROOT, 'broken-git');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: missing-git-directory\n');
    cases.push({ id: 'broken-git', wt, expectRisk: 'git-unreadable', expectSafe: false });
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

// DONE, unbound PRs, and --self. The PR list comes from SESSION_SWEEP_PR_FIXTURE,
// so gh is never called and no real PR can reach a verdict here.
//
// The safety claim under test is the unbound-open case: an open PR the app never
// bound must keep its session OUT of DONE. [measured 2026-09-13] three live
// sessions owned open PRs that their records did not carry.
function checkDoneUnboundAndSelf() {
  const slug = 'github.com/origin';   // what repoSlugOf reads off BARE's path
  const fixtureFile = path.join(ROOT, 'pr-fixture.json');
  fs.writeFileSync(fixtureFile, JSON.stringify({ [slug]: [
    { number: 7, state: 'OPEN', headRefName: 'feat-open', url: 'https://github.com/o/r/pull/7' },
    { number: 8, state: 'MERGED', headRefName: 'feat-merged', url: 'https://github.com/o/r/pull/8' },
    { number: 9, state: 'OPEN', headRefName: 'main', url: 'https://github.com/o/r/pull/9' },
  ] }), 'utf8');
  const env = { SESSION_SWEEP_PR_FIXTURE: fixtureFile };
  const H = 60 * 60000;
  const rec = (id, extra) => ({
    sessionId: `local_${id}`, title: id, cwd: MAIN, originCwd: MAIN,
    isArchived: false, createdAt: Date.now() - 2 * 86400000, ...extra,
  });

  const rows = sweepWith([
    rec('done-cold', { branch: 'nothing-open', lastActivityAt: Date.now() - 5 * H }),
    rec('done-warm', { branch: 'nothing-open', lastActivityAt: Date.now() - 30 * 60000 }),
    rec('sched-cold', { branch: 'nothing-open', scheduledTaskId: 'suite', lastActivityAt: Date.now() - 5 * H }),
    rec('unbound-open', { branch: 'feat-open', lastActivityAt: Date.now() - 5 * H }),
    rec('unbound-merged', { branch: 'feat-merged', lastActivityAt: Date.now() - 5 * H }),
    rec('bound-open', { branch: 'feat-open', lastActivityAt: Date.now() - 5 * H,
      prs: [{ prNumber: 7, repo: slug, state: 'OPEN' }] }),
    rec('on-trunk', { branch: 'main', lastActivityAt: Date.now() - 5 * H }),
  ], 'done', env);
  const by = (id) => rows.find((r) => r.sessionId === `local_${id}`) || {};
  const nums = (r) => (r.unboundPrs || []).map((p) => p.prNumber).join(',');

  check('done: population read', rows.length, 7);
  check('done: cold PR-less session is DONE', by('done-cold').state, 'DONE');
  check('done: DONE with nothing on disk is SAFE', by('done-cold').safe, true);
  check('done: the warm control stays ACTIVE', by('done-warm').state, 'ACTIVE');
  check('done: a scheduled session keeps its own clock', by('sched-cold').state, 'ACTIVE');
  check('unbound: an open PR on the branch keeps it out of DONE', by('unbound-open').state, 'PR-OPEN');
  check('unbound: the open PR is reported by number', nums(by('unbound-open')), '7');
  check('unbound: a merged unbound PR settles the session', by('unbound-merged').state, 'MERGED');
  check('unbound: an already-bound PR is not re-reported', nums(by('bound-open')), '');
  // bound-open binds #7, so unbound-open's report must say so, or a bind request
  // sent from it would double the binding.
  check('unbound: a PR bound by another session names that session',
    ((by('unbound-open').unboundPrs || [])[0] || {}).boundTo, 'bound-open');
  check('unbound: a PR nobody binds carries no boundTo',
    ((by('unbound-merged').unboundPrs || [])[0] || {}).boundTo, null);
  check('unbound: a trunk branch claims no PR', nums(by('on-trunk')), '');

  // ---- --self
  // The clean case carries a FRESH transcript on purpose: it is the caller's own
  // and must not block, while every other guard still must.
  const cfg = path.join(ROOT, 'self-config');
  const plantFresh = (wt) => {
    const d = path.join(cfg, 'projects', wt.replace(/[/.:\\\\]/g, '-'));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 't.jsonl'), '{}\n', 'utf8');
  };
  const clean = makeWorktree('self-clean', 'case-self-clean');
  sh('git push -q -u origin case-self-clean', clean);
  plantFresh(clean);
  const dirty = makeWorktree('self-dirty', 'case-self-dirty');
  sh('git push -q -u origin case-self-dirty', dirty);
  fs.writeFileSync(path.join(dirty, 'wip.txt'), 'uncommitted\n');
  const withPr = makeWorktree('self-pr', 'feat-open');
  sh('git push -q -u origin feat-open', withPr);
  // --self is the question a session asks right before archive_session, which
  // is the call that deletes the worktree, so the local-only guard has to
  // answer here too and name the file the session must copy out first.
  const localOnly = makeWorktree('self-local-only', 'case-self-local-only');
  sh('git push -q -u origin case-self-local-only', localOnly);
  fs.writeFileSync(path.join(localOnly, '.env.local'), 'SECRET=only-here\n');
  const nobody = path.join(ROOT, 'self-nobody');
  fs.mkdirSync(nobody, { recursive: true });

  const selfStore = path.join(ROOT, 'store-self');
  const selfDir = path.join(selfStore, 'live-ws', 'sub');
  fs.mkdirSync(selfDir, { recursive: true });
  for (const [id, wt] of [['self-clean', clean], ['self-dirty', dirty], ['self-pr', withPr], ['self-local-only', localOnly]]) {
    const r = rec(id, { cwd: wt, worktreePath: wt, lastActivityAt: Date.now() });
    fs.writeFileSync(path.join(selfDir, `${r.sessionId}.json`), JSON.stringify(r), 'utf8');
  }
  const selfRun = (cwd) => {
    const r = spawnSync(process.execPath, [SCRIPT, '--self'], {
      cwd, encoding: 'utf8',
      env: { ...process.env, SESSION_SWEEP_STORE: selfStore, SESSION_SWEEP_OWNER: '', CLAUDE_CONFIG_DIR: cfg, ...env },
    });
    try { return JSON.parse(r.stdout); }
    catch { failures.push(`--self in ${cwd}: unparseable\n${(r.stdout || r.stderr || '').slice(0, 300)}`); return { blockers: [] }; }
  };

  const a = selfRun(clean);
  check('self: a clean pushed session may settle', a.settle, true);
  check('self: its own fresh transcript does not block', (a.blockers || []).join(), '');
  const b = selfRun(dirty);
  check('self: a dirty worktree may not settle', b.settle, false);
  check('self: the dirty blocker is named', (b.blockers || []).some((x) => /^dirty\(1 file\)$/.test(x)), true);
  const c = selfRun(withPr);
  check('self: an unbound open PR blocks by number', (c.blockers || []).includes('pr-unsettled(#7)'), true);
  const e = selfRun(localOnly);
  check('self: a gitignored local-only file may not settle', e.settle, false);
  check('self: the local-only blocker names the file', (e.blockers || []).some((x) => /^local-only\(1 file: \.env\.local\)$/.test(x)), true);
  const d = selfRun(nobody);
  check('self: a cwd with no record fails closed', (d.blockers || []).join(), 'no-session-for-cwd');
  check('self: and does not settle', d.settle, false);
}

// A second failure of the same unpushed check, injected rather than reached:
// GIT_CONFIG_* sets log.date=bogus, which only `git log` reads, so status,
// rev-parse and ls-remote before it still answer and the log alone exits 128.
// Its own store and its own worktree, because the variable reaches every git
// call in the run, and the graded store must stay clean. The same worktree
// swept without it is the control.
function checkUnpushedLogDies() {
  const wt = makeWorktree('log-dies', 'case-log-dies');
  sh('git push -q -u origin case-log-dies', wt);
  commitIn(wt, 'l.txt', 'local only');

  const control = sweepWith([staleRec('log-dies-control', wt)], 'log-dies-control');
  const c = control.find((r) => r.sessionId === 'local_log-dies-control');
  check('log dies, control: the unpushed commit is counted while git works', c && c.risk, 'unpushed(1)');

  const logDies = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'log.date', GIT_CONFIG_VALUE_0: 'bogus' };
  const rows = sweepWith([staleRec('log-dies', wt)], 'log-dies', logDies);
  const r = rows.find((x) => x.sessionId === 'local_log-dies');
  check('log dies: a failed unpushed check is not safe', r && r.safe, false);
  check('log dies: labelled unpushed-uncheckable, naming git\'s status and its error',
    r && r.risk, (v) => /^unpushed-uncheckable\(git log exited 128: /.test(v || '') && /bogus/.test(v));

  // --self is the route a session takes to archive itself.
  const self = spawnSync(process.execPath, [SCRIPT, '--self'], {
    cwd: wt, encoding: 'utf8',
    env: { ...process.env, SESSION_SWEEP_STORE: path.join(ROOT, 'store-log-dies'), SESSION_SWEEP_OWNER: '', ...logDies },
  });
  let verdict = null;
  try { verdict = JSON.parse(self.stdout); } catch { /* left null, and the checks below say so */ }
  check('log dies, --self: the session may not settle', verdict && verdict.settle, false);
  check('log dies, --self: the blocker names the failed check',
    verdict && (verdict.blockers || []).some((b) => /^unpushed-uncheckable\(git log exited 128/.test(b)), true);
}

// The pipe delivers every byte.
//
// node's process.stdout is ASYNCHRONOUS when it is a pipe on POSIX (Linux and
// macOS alike; only win32 is synchronous), and process.exit() does not
// drain a pending async write. A run that prints past the 64KiB OS pipe buffer
// and then exits hands its caller exactly 65536 bytes under exit status 0 — the
// shape rendered-layout-gate.js shipped with until 2026-09-07. This output is
// consumed by a model that then calls archive_session on what it read, so a
// truncated --json is a list of sessions to archive with the tail silently
// removed.
//
// TWO ASSERTIONS, and the first is what stops the second passing by
// construction: the output must EXCEED one pipe buffer, and the piped byte count
// must equal the same run redirected to a FILE, where the write is synchronous
// on every platform.
//
// Its own store, not the graded one: 200 records here would bury the 17 planted
// worktree states every other case asserts by name. The records point at
// directories that do not exist, so classification never shells out to git —
// 200 rows for 38ms, which is what makes this affordable beside a suite that
// plants real worktrees.
function checkPipeDeliversEveryByte() {
  const PIPE_BUF = 64 * 1024;
  const store = path.join(ROOT, 'pipe-store', 'acct', 'bucket');
  fs.mkdirSync(store, { recursive: true });
  for (let i = 0; i < 200; i++) {
    const id = 'local_fixture-session-' + String(i).padStart(4, '0');
    fs.writeFileSync(path.join(store, id + '.json'), JSON.stringify({
      sessionId: id,
      isArchived: false,
      title: 'a fixture session title of about the length people really give them, number ' + i,
      cwd: path.join(ROOT, 'no-such-worktree', 'a-fairly-long-worktree-directory-name-' + i),
      originCwd: path.join(ROOT, 'no-such-origin', 'a-fairly-long-repo-directory-name-' + i),
      branch: 'claude/a-long-but-ordinary-generated-branch-name-' + i,
      lastActiveAt: new Date(Date.now() - 40 * 86400000).toISOString(),
    }));
  }
  const env = { ...process.env, SESSION_SWEEP_STORE: path.join(ROOT, 'pipe-store') };
  const viaFileBytes = (args) => {
    const out = path.join(ROOT, 'via-file.out');
    const fd = fs.openSync(out, 'w');
    spawnSync(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', fd, 'ignore'], env });
    fs.closeSync(fd);
    return fs.statSync(out).size;
  };
  const piped = spawnSync(process.execPath, [SCRIPT, '--json'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  const pipeBytes = Buffer.byteLength(piped.stdout || '', 'utf8');
  const fileBytes = viaFileBytes(['--json']);
  let rows = null;
  try { rows = JSON.parse(piped.stdout); } catch { /* reported below */ }

  check(`--json exceeds one pipe buffer (${fileBytes} bytes), so the next check is not vacuous`,
    fileBytes > PIPE_BUF, true);
  check(`--json through a PIPE delivers every byte it writes to a FILE (pipe ${pipeBytes}, file ${fileBytes})`,
    pipeBytes === fileBytes, true);
  check('--json still parses at that size, under exit 0',
    Array.isArray(rows) && rows.length === 200 && piped.status === 0, true);

  // The human table shares the exit path, so it shares the defect. BE CLEAR
  // WHAT THIS LINE CATCHES: it is a stream of small console.log calls, which
  // drain opportunistically while the parent reads, so it strands far less at
  // the exit than the single JSON write — measurably so on the sibling suites,
  // where the equivalent line stays green under the mutation even above the
  // buffer. It states the equality; it is not cover for this defect.
  const tablePipe = spawnSync(process.execPath, [SCRIPT],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  check('the human table through a PIPE also delivers every byte',
    Buffer.byteLength(tablePipe.stdout || '', 'utf8') === viaFileBytes([]), true);
}

// archive_session and get_session resolve a session id in the live workspace
// only. [measured 2026-10-02] after an account switch every SAFE row of a real
// sweep sat in the previous account's workspace, and get_session answered "not
// found" for each one tried. So SAFE has to mean reachable as well as clean.
//
// Three workspaces, each holding one finished record with nothing on disk to
// lose: the live one (newest activity), a warm one (active within two days, so
// another account is using it) and a cold one (orphaned). Only the live record
// may be SAFE. The other two stay `clean`, which is what --archive-orphaned
// reads, and that flag must still write the orphaned record and only it.
function checkWorkspaceReachability() {
  const H = 60 * 60000;
  const nowhere = path.join(ROOT, 'reach-nowhere');   // never created: no git, no transcript
  const rec = (id, ageMs) => ({
    sessionId: `local_${id}`, title: id, cwd: nowhere, originCwd: nowhere,
    isArchived: false, lastActivityAt: Date.now() - ageMs, createdAt: Date.now() - 60 * 86400000,
  });
  const put = (store, ws, r) => {
    const dir = ws ? path.join(store, ws, 'sub') : store;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${r.sessionId}.json`);
    fs.writeFileSync(file, JSON.stringify(r), 'utf8');
    return file;
  };
  const sweep = (store, args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SESSION_SWEEP_STORE: store, SESSION_SWEEP_OWNER: '' },
  });
  const parse = (res, tag) => {
    try { return JSON.parse(res.stdout); }
    catch { failures.push(`${tag}: unparseable JSON\n${(res.stdout || res.stderr || '').slice(0, 400)}`); return []; }
  };

  const store = path.join(ROOT, 'store-reach');
  const files = {
    live: put(store, 'ws-live', rec('reach-live', 5 * H)),          // DONE, newest: the live workspace
    warm: put(store, 'ws-warm', rec('reach-warm', 24 * H)),         // DONE, 19h behind: warm, not orphaned
    cold: put(store, 'ws-cold', rec('reach-cold', 40 * 86400000)),  // STALE, 40d behind: orphaned
  };
  const rows = parse(sweep(store, ['--json']), 'reachability --json');
  const by = (id) => rows.find((r) => r.sessionId === `local_${id}`) || {};
  const live = by('reach-live');
  const warm = by('reach-warm');
  const cold = by('reach-cold');

  check('reach: population read', rows.length, 3);
  check('reach: every record is finished', [live.state, warm.state, cold.state].join(), 'DONE,DONE,STALE');
  check('reach: every record is clean', [live.clean, warm.clean, cold.clean].join(), 'true,true,true');
  check('reach: each row names its workspace', [live.workspace, warm.workspace, cold.workspace].join(), 'ws-live,ws-warm,ws-cold');
  check('reach: the live record is reachable', live.reachable, true);
  check('reach: the live record is SAFE', live.safe, true);
  check('reach: the warm other-account record is not reachable', warm.reachable, false);
  check('reach: the warm other-account record is not SAFE', warm.safe, false);
  check('reach: the orphaned record is not reachable', cold.reachable, false);
  check('reach: the orphaned record is not SAFE', cold.safe, false);

  // The human table is what a reader hands to archive_session.
  const table = sweep(store, []);
  const out = table.stdout || '';
  const lineOf = (title) => out.split('\n').find((l) => l.includes(title)) || '';
  check('reach table: exits 0', table.status, 0);
  check('reach table: the live row reads SAFE', /\bSAFE\b/.test(lineOf('reach-live')), true);
  check('reach table: the warm row reads other-ws', /\bother-ws\b/.test(lineOf('reach-warm')), true);
  check('reach table: the cold row reads orphaned-ws', /\borphaned-ws\b/.test(lineOf('reach-cold')), true);
  check('reach table: SAFE counts the live row out of the three clean ones', /SAFE TO ARCHIVE: 1 of 3 finished and clean/.test(out), true);
  check('reach table: counts orphaned-ws under SAFE', /^ {2}orphaned-ws: 1 \(/m.test(out), true);
  check('reach table: counts other-ws under SAFE', /^ {2}other-ws: 1 \(/m.test(out), true);
  check('reach table: says archive_session cannot see them', /archive_session cannot see orphaned-ws or other-ws rows/.test(out), true);
  // A clean row outside the live workspace has nothing to lose, so it must not
  // land under BLOCKED with a null risk beside it.
  check('reach table: no clean row is listed as BLOCKED', /BLOCKED[^\n]*: 0\n/.test(out), true);

  // --archive-orphaned: the cold record only, read back from disk.
  const readArchived = (f) => {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')).isArchived; } catch { return 'unreadable'; }
  };
  const w = sweep(store, ['--archive-orphaned']);
  check('reach archive-orphaned: exits 0', w.status, 0);
  check('reach archive-orphaned: the orphaned record IS archived', readArchived(files.cold), true);
  check('reach archive-orphaned: the live record is NOT archived', readArchived(files.live), false);
  check('reach archive-orphaned: the warm other-account record is NOT archived', readArchived(files.warm), false);
  check('reach archive-orphaned: the warm record is skipped with its route named',
    /reach-warm: not the live workspace and not orphaned: archive it from the account that uses it/.test(w.stdout || ''), true);

  // No workspace directory anywhere: the live workspace is undetermined, and a
  // clean record stays SAFE exactly as it did before workspaces counted.
  const flat = path.join(ROOT, 'store-reach-flat');
  put(flat, null, rec('flat-only', 40 * 86400000));
  const f = parse(sweep(flat, ['--json']), 'undetermined --json').find((r) => r.sessionId === 'local_flat-only') || {};
  check('undetermined workspace: the clean record is still SAFE', f.safe, true);
  check('undetermined workspace: and reads reachable', f.reachable, true);
  check('undetermined workspace: names no workspace', f.workspace, null);

  // A live workspace exists, and one record sits outside every workspace
  // directory. Nothing says archive_session can resolve it, so it fails closed.
  const mixed = path.join(ROOT, 'store-reach-mixed');
  put(mixed, 'ws-live', rec('mixed-live', 5 * H));
  put(mixed, null, rec('mixed-loose', 40 * 86400000));
  const m = parse(sweep(mixed, ['--json']), 'unknown workspace --json');
  const loose = m.find((r) => r.sessionId === 'local_mixed-loose') || {};
  check('unknown workspace beside a live one: clean', loose.clean, true);
  check('unknown workspace beside a live one: not reachable', loose.reachable, false);
  check('unknown workspace beside a live one: not SAFE', loose.safe, false);
  check('unknown workspace beside a live one: the live control is SAFE',
    (m.find((r) => r.sessionId === 'local_mixed-live') || {}).safe, true);
}

function checkPreserveRegressions() {
  const store = path.join(ROOT, 'preserve-store', 'live', 'sub');
  const archives = path.join(ROOT, 'preserved archives');
  const fixture = path.join(ROOT, 'preserve-prs.json');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(fixture, '{}');
  const records = [];
  const put = (id, wt, extra = {}) => {
    const r = staleRec(id, wt, { cwd: MAIN, originCwd: MAIN, ...extra });
    records.push(r);
    fs.writeFileSync(path.join(store, r.sessionId + '.json'), JSON.stringify(r));
  };
  const plant = (wt, name, contents = name) => {
    const file = path.join(wt, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  const locals = [];
  for (const state of ['STALE', 'DONE', 'MERGED']) {
    const wt = makeWorktree('preserve-' + state, 'preserve-' + state);
    sh(`git push -q -u origin preserve-${state}`, wt);
    plant(wt, '.env.local', 'private fixture\n');
    plant(wt, '.claude/reports/audit with spaces.md', 'report fixture\n');
    const extra = state === 'DONE' ? { lastActivityAt: Date.now() - 8 * 3600000 }
      : state === 'MERGED' ? { prs: [{ repo: 'fixture/project', prNumber: 1, state: 'MERGED' }] } : {};
    put('preserve-' + state, wt, extra);
    locals.push(wt);
  }
  const regen = ['node_modules', '.next', 'dist', 'build', 'out', 'coverage', '.turbo', '.cache',
    'test-results', 'playwright-report', '.vercel/output', '__pycache__', '.venv', 'target'];
  for (const name of regen) plant(locals[0], name + '/generated.txt');
  execFileSync('git', ['config', 'core.excludesFile', path.join(ROOT, 'preserve-excludes')], { cwd: MAIN });
  fs.writeFileSync(path.join(ROOT, 'preserve-excludes'), regen.map((n) => '/' + n + '/').join('\n') + '\n');

  const dirty = makeWorktree('preserve-dirty', 'preserve-dirty');
  plant(dirty, '.env.local');
  plant(dirty, 'untracked.txt');
  put('preserve-dirty', dirty);
  const unpushed = makeWorktree('preserve-unpushed', 'preserve-unpushed');
  commitIn(unpushed, 'unique.txt', 'unique preservation commit');
  plant(unpushed, '.env.local');
  put('preserve-unpushed', unpushed);
  plant(MAIN, '.env.local', 'main must remain untouched');
  put('preserve-main', MAIN);
  put('preserve-no-worktree', null, { worktreePath: undefined });

  // A real removed worktree beneath a dirty parent reproduces git walking up.
  const leftover = path.join(MAIN, 'leftover');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'leftover-own-branch', leftover, 'main'], { cwd: MAIN });
  execFileSync('git', ['worktree', 'remove', leftover], { cwd: MAIN });
  plant(leftover, 'notes.txt', 'leftover evidence');
  plant(leftover, '-leading-dash.txt', 'literal filename');
  for (const name of ['node_modules', '.venv', '__pycache__']) plant(leftover, 'nested/' + name + '/generated.txt');
  put('preserve-leftover', leftover, { branch: 'leftover-own-branch' });
  const empty = path.join(MAIN, 'leftover-empty');
  plant(empty, 'node_modules/generated.txt');
  put('preserve-leftover-empty', empty);
  // The parent has an open PR on its branch, but this removed worktree does not.
  fs.writeFileSync(fixture, JSON.stringify({ 'github.com/origin': [{ number: 9, state: 'OPEN', headRefName: 'main' }] }));
  const env = { ...process.env, SESSION_SWEEP_STORE: path.dirname(path.dirname(store)),
    SESSION_SWEEP_OWNER: '', SESSION_SWEEP_PR_FIXTURE: fixture, SESSION_SWEEP_ARCHIVE_DIR: archives,
    CLAUDE_CONFIG_DIR: path.join(ROOT, 'preserve-profile') };
  const sweep = (flags = [], overrides = {}) => {
    const r = spawnSync(process.execPath, [SCRIPT, '--json', ...flags], { encoding: 'utf8', env: { ...env, ...overrides } });
    check('preserve CLI exits 0', r.status, 0);
    try { return JSON.parse(r.stdout); }
    catch { failures.push('preserve CLI returned invalid JSON: ' + (r.stderr || r.stdout)); return []; }
  };
  const row = (rows, id) => rows.find((r) => r.sessionId === 'local_' + id) || {};
  const before = sweep();
  check('gap 1: JSON keeps cwd at the recorded repo root', row(before, 'preserve-STALE').cwd, MAIN);
  check('gap 1: JSON carries the record worktreePath', row(before, 'preserve-STALE').worktreePath, locals[0]);
  check('gap 1: missing worktreePath is explicitly null', row(before, 'preserve-no-worktree').worktreePath, null);
  check('gap 2: read-only scan retains local-only blocker', row(before, 'preserve-STALE').risk, (v) => /^local-only\(/.test(v || ''));
  check('gap 2: read-only scan writes no archive directory', fs.existsSync(archives), false);
  check('gap 3: leftover has its own two-file state', row(before, 'preserve-leftover').risk, 'leftover-dir(2 files)');
  check('gap 3: empty leftover has its own zero-file state', row(before, 'preserve-leftover-empty').risk, 'leftover-dir(0 files)');
  check('gap 3: leftover does not adopt parent branch PR', row(before, 'preserve-leftover').state, 'STALE');

  const after = sweep(['--preserve-local']);
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  for (const state of ['STALE', 'DONE', 'MERGED']) {
    const r = row(after, 'preserve-' + state);
    check('gap 2: preserves finished ' + state + ' as SAFE', r.safe, true);
    check('gap 2: preserves ' + state + ' without changing verdict', r.state, state);
    check('gap 2: ' + state + ' archive is in the override directory',
      typeof r.archive === 'string' && path.dirname(r.archive) === archives, true);
    if (r.archive && fs.existsSync(r.archive)) {
      const members = execFileSync(tar, ['-tzf', r.archive], { encoding: 'utf8' }).trim().split('\n').map((s) => s.replace(/^\.\//, '').replace(/\r$/, '')).sort();
      check('gap 2: read-back contains only the two local files for ' + state,
        JSON.stringify(members), JSON.stringify(['.claude/reports/audit with spaces.md', '.env.local']));
      const extracted = path.join(ROOT, 'extracted-' + state);
      fs.mkdirSync(extracted);
      execFileSync(tar, ['-xzf', r.archive, '-C', extracted]);
      check('gap 2: restored content for ' + state, fs.readFileSync(path.join(extracted, '.env.local'), 'utf8'), 'private fixture\n');
    }
  }
  const left = row(after, 'preserve-leftover');
  check('gap 3: preserved leftover is SAFE', left.safe, true);
  check('gap 3: preserved leftover reports an archive', typeof left.archive, 'string');
  if (left.archive && fs.existsSync(left.archive)) {
    const members = execFileSync(tar, ['-tzf', left.archive], { encoding: 'utf8' }).trim().split('\n');
    check('gap 3: leftover archive has exactly two files', members.length, 2);
  }
  check('gap 3: regenerable-only leftover clears without a tar', row(after, 'preserve-leftover-empty').safe, true);
  check('preserve refuses tracked or unignored changes', row(after, 'preserve-dirty').risk, (v) => /^dirty\(/.test(v || ''));
  check('preserve refuses commits on no remote', row(after, 'preserve-unpushed').risk, (v) => /preserve-refused.*commit/.test(v || ''));
  check('preserve never clears a main checkout', row(after, 'preserve-main').safe, false);
  check('preserve refusal names the main checkout', row(after, 'preserve-main').risk, (v) => /main-checkout|preserve-refused.*main checkout/.test(v || ''));
  check('preserve retains source content', fs.readFileSync(path.join(locals[0], '.env.local'), 'utf8'), 'private fixture\n');
  check('preserve retains leftover content', fs.readFileSync(path.join(leftover, 'notes.txt'), 'utf8'), 'leftover evidence');
  check('preserve does not archive the session record', JSON.parse(fs.readFileSync(path.join(store, records[0].sessionId + '.json'))).isArchived, false);

  // A preload corrupts only tar listing after a real archive creation.
  const preload = path.join(ROOT, 'mismatch-preload.cjs');
  fs.writeFileSync(preload, "const cp = require('child_process')\nconst real = cp.execFileSync\ncp.execFileSync = function (file, args, opts) {\n  if (args && args[0] === '-tzf') return ''\n  return real(file, args, opts)\n}\n");
  const mismatchDir = path.join(ROOT, 'mismatch-archives');
  const mismatch = sweep(['--preserve-local'], { SESSION_SWEEP_ARCHIVE_DIR: mismatchDir,
    NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --require "' + preload.replace(/\\/g, '/') + '"' });
  check('preserve mismatch keeps the linked worktree blocked', row(mismatch, 'preserve-STALE').risk,
    (v) => /preserve-refused.*read-back/.test(v || ''));
  check('preserve mismatch keeps the leftover blocked', row(mismatch, 'preserve-leftover').safe, false);
  check('preserve mismatch publishes no archive', fs.existsSync(mismatchDir) ? fs.readdirSync(mismatchDir).filter((n) => n.endsWith('.tgz')).length : 0, 0);
  const blockedDir = path.join(ROOT, 'not-an-archive-directory');
  fs.writeFileSync(blockedDir, 'not a directory');
  const refused = sweep(['--preserve-local'], { SESSION_SWEEP_ARCHIVE_DIR: blockedDir });
  check('preserve write failure retains its reason', row(refused, 'preserve-STALE').risk,
    (v) => /preserve-refused\(/.test(v || ''));
  check('preserve write failure remains unsafe', row(refused, 'preserve-STALE').safe, false);

  const archive = row(after, 'preserve-STALE').archive;
  const saved = archive && fs.existsSync(archive) ? fs.readFileSync(archive) : null;
  const repeated = sweep(['--preserve-local']);
  check('S1: repeated preservation stays SAFE', row(repeated, 'preserve-STALE').safe, true);
  check('S1: repeated preservation has a distinct archive',
    typeof row(repeated, 'preserve-STALE').archive === 'string' && row(repeated, 'preserve-STALE').archive !== archive, true);
  if (saved) check('existing archive bytes remain intact', fs.readFileSync(archive).equals(saved), true);

  const changePreload = path.join(ROOT, 'change-preload.cjs');
  fs.writeFileSync(changePreload, "const cp = require('child_process')\nconst fs = require('fs')\nconst path = require('path')\nconst real = cp.execFileSync\ncp.execFileSync = function (file, args, opts) {\n  const result = real(file, args, opts)\n  if (args && args[0] === '-czf') fs.appendFileSync(path.join(args[3], '.env.local'), 'changed during tar')\n  return result\n}\n");
  const changed = sweep(['--preserve-local'], { SESSION_SWEEP_ARCHIVE_DIR: path.join(ROOT, 'changed-archives'),
    NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --require "' + changePreload.replace(/\\/g, '/') + '"' });
  check('preserve refuses a local file changed during tar', row(changed, 'preserve-STALE').risk,
    (v) => /preserve-refused.*local files changed/.test(v || ''));

  // Observe all three metadata inspections against an unrelated parent repo.
  const metadata = path.join(MAIN, 'metadata-leftover');
  plant(metadata, 'evidence.txt');
  const familyStore = path.join(ROOT, 'family-store');
  fs.mkdirSync(familyStore);
  const absent = path.join(ROOT, 'no-recorded-repository');
  const familyRecords = [staleRec('metadata-leftover', metadata, { cwd: absent, originCwd: absent, branch: 'own-removed-branch' }),
    staleRec('metadata-parent-control', MAIN), staleRec('metadata-remote-control', locals[1])];
  for (const r of familyRecords) fs.writeFileSync(path.join(familyStore, r.sessionId + '.json'), JSON.stringify(r));
  execFileSync('git', ['checkout', '-q', '-b', 'parent-sweep'], { cwd: MAIN });
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://unrelated.invalid/foreign/project.git'], { cwd: MAIN });
  const familyFixture = path.join(ROOT, 'family-prs.json');
  fs.writeFileSync(familyFixture, JSON.stringify({ 'foreign/project': [{ number: 19, state: 'OPEN', headRefName: 'parent-sweep' }] }));
  const family = sweep([], { SESSION_SWEEP_STORE: familyStore, SESSION_SWEEP_PR_FIXTURE: familyFixture });
  check('gap 3 family: leftover does not adopt parent repo PRs', row(family, 'metadata-leftover').unboundPrs.length, 0);
  check('gap 3 family: leftover does not adopt parent branch', row(family, 'metadata-leftover').state, 'STALE');
  check('gap 3 family: leftover retains its own file count', row(family, 'metadata-leftover').risk, 'leftover-dir(1 files)');
  check('gap 3 family: known parent PR still resolves', row(family, 'metadata-parent-control').state, 'PR-OPEN');
  check('gap 3 family: known third-party remote is still excluded', row(family, 'metadata-remote-control').thirdParty, true);
  const remoteOnly = sweep([], { SESSION_SWEEP_STORE: familyStore, SESSION_SWEEP_PR_FIXTURE: fixture });
  check('gap 3 family: remote test reaches finished classification', row(remoteOnly, 'metadata-leftover').state, 'STALE');
  check('gap 3 family: leftover does not adopt parent remote exclusion', row(remoteOnly, 'metadata-leftover').thirdParty, false);
  execFileSync('git', ['remote', 'set-url', 'origin', BARE], { cwd: MAIN });
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: MAIN });
  execFileSync('git', ['config', 'core.excludesFile', path.join(ROOT, 'empty-excludes')], { cwd: MAIN });
  preserveStates = records.length + familyRecords.length;
}

function checkRound2Regressions() {
  const store = path.join(ROOT, 'round2-store', 'live', 'sub');
  const archives = path.join(ROOT, 'round2-archives');
  const fixture = path.join(ROOT, 'round2-prs.json');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(fixture, '{}');
  const put = (id, wt, extra = {}) => {
    const rec = staleRec(id, wt, { cwd: MAIN, originCwd: MAIN, ...extra });
    fs.writeFileSync(path.join(store, rec.sessionId + '.json'), JSON.stringify(rec));
  };
  const plant = (wt, name, content = 'handwritten evidence\n') => {
    fs.mkdirSync(path.dirname(path.join(wt, name)), { recursive: true });
    fs.writeFileSync(path.join(wt, name), content);
  };
  const linked = (name) => {
    const wt = makeWorktree('round2-' + name, 'round2-' + name);
    sh('git push -q -u origin round2-' + name, wt);
    return wt;
  };
  const env = { ...process.env, SESSION_SWEEP_STORE: path.dirname(path.dirname(store)),
    SESSION_SWEEP_OWNER: '', SESSION_SWEEP_PR_FIXTURE: fixture, SESSION_SWEEP_ARCHIVE_DIR: archives,
    CLAUDE_CONFIG_DIR: path.join(ROOT, 'round2-profile') };
  const sweep = (flags = [], overrides = {}) => {
    const r = spawnSync(process.execPath, [SCRIPT, '--json', ...flags], {
      encoding: 'utf8', env: { ...env, ...overrides }, maxBuffer: 64 << 20 });
    check('round2 CLI exits 0', r.status, 0);
    try { return JSON.parse(r.stdout); }
    catch { failures.push('round2 invalid JSON: ' + (r.stderr || r.stdout)); return []; }
  };
  const row = (rows, id) => rows.find((r) => r.sessionId === 'local_' + id) || {};
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const members = (r) => r.archive && fs.existsSync(r.archive)
    ? execFileSync(tar, ['-tzf', r.archive], { encoding: 'utf8' }).split('\n')
      .map((n) => n.replace(/\r$/, '').replace(/^\.\//, '')).filter(Boolean).sort() : [];

  const nested = linked('nested-out');
  const nestedName = '.claude/reports/out/audit.md';
  plant(nested, nestedName);
  plant(nested, '.env.local');
  put('nested-out', nested);
  const leftover = path.join(MAIN, 'round2-leftover');
  const outputNames = ['build/notes.md', 'docs/out/report.md', 'dist/draft.md',
    'coverage/analysis.md', 'target/plan.md', '.cache/research.md'];
  for (const name of outputNames) plant(leftover, name);
  for (const name of ['node_modules', '.venv', '__pycache__']) plant(leftover, 'nested/' + name + '/dependency.txt');
  put('output-leftover', leftover);

  plant(MAIN, 'apps/web/owned.md');
  execFileSync('git', ['add', '--', 'apps/web/owned.md'], { cwd: MAIN });
  execFileSync('git', ['commit', '-qm', 'tracked subdirectory fixture'], { cwd: MAIN });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: MAIN });
  const subdir = path.join(MAIN, 'apps', 'web');
  put('tracked-subdir', subdir);
  const metadataStore = path.join(ROOT, 'round2-metadata', 'live', 'sub');
  fs.mkdirSync(metadataStore, { recursive: true });
  for (const field of ['originCwd', 'cwd']) {
    const rec = staleRec('subdir-' + field, null, { cwd: subdir, originCwd: null, branch: 'round2-open', [field]: subdir });
    fs.writeFileSync(path.join(metadataStore, rec.sessionId + '.json'), JSON.stringify(rec));
  }
  const metadataFixture = path.join(ROOT, 'round2-metadata-prs.json');
  fs.writeFileSync(metadataFixture, JSON.stringify({ 'github.com/origin': [{ number: 71, state: 'OPEN', headRefName: 'round2-open' }] }));
  const metadataEnv = { SESSION_SWEEP_STORE: path.dirname(path.dirname(metadataStore)), SESSION_SWEEP_PR_FIXTURE: metadataFixture };
  const metadata = sweep([], metadataEnv);
  for (const field of ['originCwd', 'cwd']) check('F3: subdirectory ' + field + ' retains OPEN PR binding', row(metadata, 'subdir-' + field).state, 'PR-OPEN');
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://bitbucket.org/fixture/project.git'], { cwd: MAIN });
  const thirdParty = sweep([], { ...metadataEnv, SESSION_SWEEP_PR_FIXTURE: fixture });
  for (const field of ['originCwd', 'cwd']) check('F3: subdirectory ' + field + ' retains third-party exclusion', row(thirdParty, 'subdir-' + field).thirdParty, true);
  execFileSync('git', ['remote', 'set-url', 'origin', BARE], { cwd: MAIN });

  const detached = path.join(ROOT, 'wt', 'round2-detached');
  execFileSync('git', ['worktree', 'add', '-q', '--detach', detached, 'main'], { cwd: MAIN });
  commitIn(detached, 'only-copy.md', 'detached unique commit');
  put('detached', detached);
  check('F5 control: one commit on no named ref',
    execFileSync('git', ['rev-list', '--count', 'HEAD', '--not', '--remotes', '--branches', '--tags'], { cwd: detached, encoding: 'utf8' }).trim(), '1');

  const dependencies = linked('dependencies');
  plant(dependencies, '.env.local');
  const depRoot = path.join(dependencies, 'node_modules', 'fixture-package', 'lib');
  fs.mkdirSync(depRoot, { recursive: true });
  for (let i = 0; i < 12000; i++) fs.writeFileSync(path.join(depRoot, 'installed-module-' + String(i).padStart(5, '0') + '-' + 'x'.repeat(65) + '.js'), '');
  const depListing = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
    { cwd: dependencies, encoding: 'utf8', maxBuffer: 64 << 20 });
  check('F4 control: installed dependencies exceed the default git buffer', Buffer.byteLength(depListing) > 1048576, true);
  put('dependencies', dependencies);

  // Same worktree basename in a second repository exercises archive namespace.
  const otherMain = path.join(ROOT, 'other-checkout');
  execFileSync('git', ['clone', '-q', BARE, otherMain], { cwd: ROOT });
  const excludes = path.join(ROOT, 'empty-excludes');
  execFileSync('git', ['config', 'core.excludesFile', excludes], { cwd: otherMain });
  const otherNested = path.join(ROOT, 'other-wt', path.basename(nested));
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'other-nested', otherNested, 'main'], { cwd: otherMain });
  execFileSync('git', ['push', '-q', '-u', 'origin', 'other-nested'], { cwd: otherNested });
  plant(otherNested, nestedName);
  plant(otherNested, '.env.local');
  put('other-nested', otherNested, { cwd: otherMain, originCwd: otherMain });

  const before = sweep();
  check('F1 control: nested report is named by the blocker', row(before, 'nested-out').risk, (v) => (v || '').includes(nestedName));
  check('F2: leftover inventory includes all six build-output documents', row(before, 'output-leftover').risk, 'leftover-dir(6 files)');
  check('F2: tracked subdirectory stays blocked', row(before, 'tracked-subdir').risk, 'tracked-subdirectory');
  check('F5: detached commit blocks read-only sweep', row(before, 'detached').risk, 'orphan-commits(1)');
  const after = sweep(['--preserve-local']);
  check('F1: archive contains the exact nested report named by the blocker', JSON.stringify(members(row(after, 'nested-out'))), JSON.stringify([nestedName, '.env.local']));
  check('F1: nested report becomes SAFE after preservation', row(after, 'nested-out').safe, true);
  check('F2: leftover archive contains all six build-output documents', JSON.stringify(members(row(after, 'output-leftover'))), JSON.stringify([...outputNames].sort()));
  check('F2: tracked subdirectory remains blocked with preserve-local', row(after, 'tracked-subdir').safe, false);
  check('F2: tracked subdirectory publishes no archive', row(after, 'tracked-subdir').archive, null);
  check('F4: preservation works with installed dependencies', row(after, 'dependencies').safe, true);
  check('F4: dependency archive contains only local configuration', JSON.stringify(members(row(after, 'dependencies'))), JSON.stringify(['.env.local']));
  check('F5: detached commit blocks preserve-local without local files', row(after, 'detached').risk, 'orphan-commits(1)');
  check('F5: detached blocked row publishes no archive', row(after, 'detached').archive, null);
  check('S1: same basename in another repo is SAFE', row(after, 'other-nested').safe, true);
  check('S1: repository archives have distinct names', typeof row(after, 'other-nested').archive === 'string' && row(after, 'other-nested').archive !== row(after, 'nested-out').archive, true);

  // Change tracked state after tar has finished. Only finalRisk sees this.
  const guardStore = path.join(ROOT, 'round2-guards', 'live', 'sub');
  fs.mkdirSync(guardStore, { recursive: true });
  const finalTree = linked('final-risk');
  plant(finalTree, '.env.local');
  const finalRec = staleRec('final-risk', finalTree, { cwd: MAIN, originCwd: MAIN });
  fs.writeFileSync(path.join(guardStore, finalRec.sessionId + '.json'), JSON.stringify(finalRec));
  const finalPreload = path.join(ROOT, 'final-risk-preload.cjs');
  fs.writeFileSync(finalPreload, `const cp = require('child_process')
const fs = require('fs')
const path = require('path')
const real = cp.execFileSync
cp.execFileSync = function (file, args, opts) {
  const result = real(file, args, opts)
  if (args && args[0] === '-tzf') fs.appendFileSync(path.join(process.env.SWEEP_GUARD_TREE, 'README.md'), 'tracked change after tar')
  return result
}
`);
  const guardEnv = { SESSION_SWEEP_STORE: path.dirname(path.dirname(guardStore)),
    SESSION_SWEEP_ARCHIVE_DIR: path.join(ROOT, 'final-risk-archives'), SWEEP_GUARD_TREE: finalTree,
    NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --require "' + finalPreload.replace(/\\/g, '/') + '"' };
  const changed = sweep(['--preserve-local'], guardEnv);
  check('guard finalRisk: tracked change during tar is refused', row(changed, 'final-risk').risk, (v) => /preserve-refused.*dirty\(/.test(v || ''));
  check('guard finalRisk: no archive is published', row(changed, 'final-risk').archive, null);
  execFileSync('git', ['restore', '--', 'README.md'], { cwd: finalTree });

  // A detached commit created just after the preserve eligibility recheck is
  // invisible to the earlier risk check. The preserve commit guard must fire.
  const commitTree = path.join(ROOT, 'wt', 'round2-commit-guard');
  execFileSync('git', ['worktree', 'add', '-q', '--detach', commitTree, 'main'], { cwd: MAIN });
  plant(commitTree, '.env.local');
  const commitRec = staleRec('commit-guard', commitTree, { cwd: MAIN, originCwd: MAIN });
  fs.unlinkSync(path.join(guardStore, finalRec.sessionId + '.json'));
  fs.writeFileSync(path.join(guardStore, commitRec.sessionId + '.json'), JSON.stringify(commitRec));
  const commitPreload = path.join(ROOT, 'commit-guard-preload.cjs');
  fs.writeFileSync(commitPreload, `const cp = require('child_process')
const fs = require('fs')
const path = require('path')
const real = cp.spawnSync
let checks = 0
const hasRefCheck = fs.readFileSync(process.argv[1], 'utf8').includes("'--branches', '--tags'")
cp.spawnSync = function (file, args, opts) {
  const result = real(file, args, opts)
  const eligibilityCheck = hasRefCheck ? args[0] === 'rev-list' && args.includes('--branches')
    : args[0] === 'status' && args.length === 2
  if (file === 'git' && eligibilityCheck && ++checks === 2) {
    const cwd = process.env.SWEEP_GUARD_TREE
    fs.writeFileSync(path.join(cwd, 'late-commit.md'), 'unique detached commit')
    cp.execFileSync('git', ['add', '--', 'late-commit.md'], { cwd })
    cp.execFileSync('git', ['commit', '-qm', 'late detached commit'], { cwd })
  }
  return result
}
`);
  const committed = sweep(['--preserve-local'], { ...guardEnv, SWEEP_GUARD_TREE: commitTree,
    SESSION_SWEEP_ARCHIVE_DIR: path.join(ROOT, 'commit-guard-archives'),
    NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --require "' + commitPreload.replace(/\\/g, '/') + '"' });
  check('guard detached preserve: late detached commit is refused', row(committed, 'commit-guard').risk,
    (v) => /preserve-refused\(1 commit\(s\) on no remote\)/.test(v || ''));
  check('guard detached preserve: no archive is published', row(committed, 'commit-guard').archive, null);

  // Compile a temporary mutation only inside the child, leaving the candidate
  // untouched. The predicted safety assertion must detect each removed guard.
  const mutationPreload = path.join(ROOT, 'round2-mutation-preload.cjs');
  fs.writeFileSync(mutationPreload, `const Module = require('module')
const real = Module.prototype._compile
Module.prototype._compile = function (source, file) {
  if (file === process.argv[1]) {
    const before = source
    if (process.env.SWEEP_MUTATION === 'finalRisk') {
      source = source.replace(/const finalRisk = worktreeRisk\\(s, all, \\{ localPreserved: true \\}\\);/, "const finalRisk = { reason: null, localOnly: files };")
      source = source.replace(/if \\(finalRisk \\|\\| worktreeIdentity[^\\n]+/, '')
    } else {
      source = source.replace(/if \\(identity === 'linked'\\) \\{\\s+const count = git\\(wt, \\['rev-list', '--count', 'HEAD', '--not', '--remotes'\\]\\);[\\s\\S]*?\\n    \\}/, '')
    }
    if (source === before) throw new Error('guard mutation did not apply')
  }
  return real.call(this, source, file)
}
`);
  const withMutation = (base, kind) => ({ ...base, SWEEP_MUTATION: kind,
    NODE_OPTIONS: base.NODE_OPTIONS + ' --require "' + mutationPreload.replace(/\\/g, '/') + '"' });
  fs.unlinkSync(path.join(guardStore, commitRec.sessionId + '.json'));
  fs.writeFileSync(path.join(guardStore, finalRec.sessionId + '.json'), JSON.stringify(finalRec));
  const mutatedFinal = sweep(['--preserve-local'], withMutation({ ...guardEnv,
    SESSION_SWEEP_ARCHIVE_DIR: path.join(ROOT, 'mutated-final-archives') }, 'finalRisk'));
  check('guard finalRisk mutation: safety assertion detects removal', row(mutatedFinal, 'final-risk').safe, true);
  check('guard finalRisk mutation: archive control proves the removed guard mattered', typeof row(mutatedFinal, 'final-risk').archive, 'string');
  execFileSync('git', ['restore', '--', 'README.md'], { cwd: finalTree });
  execFileSync('git', ['reset', '--hard', 'main'], { cwd: commitTree });
  fs.unlinkSync(path.join(guardStore, finalRec.sessionId + '.json'));
  fs.writeFileSync(path.join(guardStore, commitRec.sessionId + '.json'), JSON.stringify(commitRec));
  const mutatedCommit = sweep(['--preserve-local'], withMutation({ ...guardEnv, SWEEP_GUARD_TREE: commitTree,
    SESSION_SWEEP_ARCHIVE_DIR: path.join(ROOT, 'mutated-commit-archives'),
    NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --require "' + commitPreload.replace(/\\/g, '/') + '"' }, 'commit'));
  check('guard detached preserve mutation: exact commit refusal assertion detects removal',
    /preserve-refused\(1 commit\(s\) on no remote\)/.test(row(mutatedCommit, 'commit-guard').risk || ''), false);
  check('guard detached preserve mutation: final recheck independently blocks the late commit', row(mutatedCommit, 'commit-guard').safe, false);
  preserveStates += 11;
}

function checkRound3Regressions() {
  const store = path.join(ROOT, 'round3-store', 'live', 'sub');
  const archives = path.join(ROOT, 'round3-archives');
  const fixture = path.join(ROOT, 'round3-prs.json');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(fixture, '{}');
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const plant = (wt, name, content = 'handwritten evidence\n') => {
    fs.mkdirSync(path.dirname(path.join(wt, name)), { recursive: true });
    fs.writeFileSync(path.join(wt, name), content);
  };
  const put = (id, wt, extra = {}, dir = store) => {
    fs.mkdirSync(dir, { recursive: true });
    const rec = staleRec(id, wt, { cwd: MAIN, originCwd: MAIN, ...extra });
    fs.writeFileSync(path.join(dir, rec.sessionId + '.json'), JSON.stringify(rec));
  };
  const linked = (id) => {
    const wt = makeWorktree('round3-' + id, 'round3-' + id);
    g(wt, 'push', '-q', '-u', 'origin', 'round3-' + id);
    return wt;
  };
  const env = { ...process.env, SESSION_SWEEP_STORE: path.dirname(path.dirname(store)),
    SESSION_SWEEP_OWNER: '', SESSION_SWEEP_PR_FIXTURE: fixture, SESSION_SWEEP_ARCHIVE_DIR: archives,
    CLAUDE_CONFIG_DIR: path.join(ROOT, 'round3-profile') };
  const row = (rows, id) => rows.find((r) => r.sessionId === 'local_' + id) || {};
  const sweep = (flags = [], overrides = {}) => {
    const r = spawnSync(process.execPath, [SCRIPT, '--json', ...flags], {
      encoding: 'utf8', env: { ...env, ...overrides }, maxBuffer: 64 << 20 });
    check('round3 CLI exits 0', r.status, 0);
    try { return JSON.parse(r.stdout); }
    catch { failures.push('round3 invalid JSON: ' + (r.stderr || r.stdout)); return []; }
  };
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const members = (r) => r.archive && fs.existsSync(r.archive)
    ? execFileSync(tar, ['-tzf', r.archive], { encoding: 'utf8' }).split(/\r?\n/)
      .map((n) => n.replace(/^\.\//, '')).filter(Boolean).sort() : [];
  const archiveFiles = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.tgz')) : [];

  // Submodule data is invisible to the parent's ignored-file and commit lists.
  const subSource = path.join(ROOT, 'submodule-source');
  fs.mkdirSync(subSource);
  g(subSource, 'init', '-q', '-b', 'main');
  g(subSource, 'config', 'user.name', 'Suite');
  g(subSource, 'config', 'user.email', 'suite@example.com');
  plant(subSource, '.gitignore', '.env.local\n');
  plant(subSource, 'sub.md');
  g(subSource, 'add', '.');
  g(subSource, 'commit', '-qm', 'submodule fixture');
  g(MAIN, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSource, 'vendor/sub');
  g(MAIN, 'commit', '-qm', 'parent submodule fixture');
  g(MAIN, 'push', '-q', 'origin', 'main');
  const subOnly = linked('sub-only');
  g(subOnly, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init');
  plant(subOnly, 'vendor/sub/.env.local', 'only submodule copy\n');
  put('sub-only', subOnly);
  const subCommit = linked('sub-commit');
  g(subCommit, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init');
  g(path.join(subCommit, 'vendor/sub'), 'checkout', '-q', '-b', 'local-sub');
  plant(subCommit, 'vendor/sub/unique.md');
  g(path.join(subCommit, 'vendor/sub'), 'add', '.');
  g(path.join(subCommit, 'vendor/sub'), '-c', 'user.name=Suite', '-c', 'user.email=suite@example.com', 'commit', '-qm', 'local submodule commit');
  g(subCommit, 'add', 'vendor/sub');
  g(subCommit, 'commit', '-qm', 'parent gitlink');
  g(subCommit, 'push', '-q');
  plant(subCommit, '.env.local');
  put('sub-commit', subCommit);
  const modulesOnly = linked('modules-only');
  fs.mkdirSync(path.join(g(modulesOnly, 'rev-parse', '--absolute-git-dir'), 'modules'));
  put('modules-only', modulesOnly);
  const clean = linked('clean-uninitialized');
  check('B1 control: uninitialized submodule directory is empty', fs.readdirSync(path.join(clean, 'vendor/sub')).length, 0);
  put('clean-uninitialized', clean);

  // Keep later guard fixtures free of gitlinks so their subprocess controls
  // exercise only the intended refusal, without repeated submodule helpers.
  g(MAIN, 'rm', '-q', '-f', 'vendor/sub', '.gitmodules');
  g(MAIN, 'commit', '-qm', 'remove fixture gitlink for guard controls');
  g(MAIN, 'push', '-q', 'origin', 'main');

  const nested = linked('nested-build');
  const nestedNames = ['build', 'out', 'dist', 'coverage', 'target', '.cache', '.turbo', 'test-results', 'playwright-report', '.vercel', '.pytest_cache', '.parcel-cache']
    .map((n) => '.claude/reports/' + n + '/notes.md');
  for (const name of nestedNames) plant(nested, name);
  const residue = require(path.join(path.dirname(SCRIPT), 'worktree-residue.js'));
  for (const name of ['build', 'out', 'dist', 'coverage', 'target', '.cache', '.turbo', 'test-results', 'playwright-report', '.vercel', '.pytest_cache', '.parcel-cache']) {
    check('W3-R3 paired: ' + name + ' is regenerable at root only', residue.isRegenerable(name + '/generated.txt')
      && !residue.isRegenerable('.claude/reports/' + name + '/notes.md'), true);
  }
  put('nested-build', nested);
  const unicode = linked('unicode');
  plant(unicode, '.claude/not\u0103 \u0219.md');
  put('unicode', unicode);
  const before = sweep();
  const after = sweep(['--preserve-local']);
  for (const id of ['sub-only', 'sub-commit', 'modules-only']) {
    for (const [mode, rows] of [['default', before], ['preserve', after]]) {
      check('B1: ' + id + ' blocked by its own label in ' + mode, row(rows, id).risk, (v) => /^submodules\(\d+\)$/.test(v || ''));
      check('B1: ' + id + ' stays unsafe in ' + mode, row(rows, id).safe, false);
      check('B1: ' + id + ' publishes no archive in ' + mode, row(rows, id).archive, null);
    }
  }
  check('B1 control: uninitialized submodule without modules remains SAFE', row(after, 'clean-uninitialized').safe, true);
  check('B1 control: submodule has one commit on no remote', g(path.join(subCommit, 'vendor/sub'), 'rev-list', '--count', 'HEAD', '--not', '--remotes'), '1');
  check('B1: submodule local file remains intact', fs.readFileSync(path.join(subOnly, 'vendor/sub/.env.local'), 'utf8'), 'only submodule copy\n');
  check('W2: nested build document is named by the blocker', row(before, 'nested-build').risk,
    (v) => /^local-only\(12 files: /.test(v || '') && v.includes('.claude/reports/.parcel-cache/notes.md'));
  check('W2: all nested output documents are archived', JSON.stringify(members(row(after, 'nested-build'))), JSON.stringify(nestedNames.sort()));
  check('W2: nested output row becomes SAFE after verification', row(after, 'nested-build').safe, true);

  // Preloads model failures at real subprocess/filesystem boundaries. No host
  // tar executable, real source, or external archive directory is changed.
  const preload = path.join(ROOT, 'round3-preload.cjs');
  fs.writeFileSync(preload, `const cp = require('child_process')
const fs = require('fs')
const path = require('path')
const originalSpawn = cp.spawnSync
const originalExec = cp.execFileSync
const chmod = fs.chmodSync
const lstat = fs.lstatSync
const mode = process.env.SWEEP_PRESERVE_GUARD_MODE
if (mode === 'preexisting' || mode === 'publish-race') {
  const RealDate = Date
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2020-01-01T00:00:00.000Z'])) }
  }
  require('crypto').randomBytes = (size) => Buffer.alloc(size)
}
cp.spawnSync = function (file, args, opts) {
  const result = originalSpawn(file, args, opts)
  if (mode === 'listing-stderr' && file === 'git' && args[0] === 'ls-files' && args.includes('--ignored')) {
    result.stderr = 'fixture listing warning'
  }
  return result
}
cp.execFileSync = function (file, args, opts) {
  if (args && (args[0] === '-czf' || args[0] === '-tzf')) {
    fs.appendFileSync(process.env.SWEEP_PRESERVE_TAR_LOG, args[0] + '\\n')
    if (mode === 'tar-failure') {
      const e = new Error('raw message ENV_CANARY_42')
      e.stderr = 'raw tar stderr ENV_CANARY_42'
      e.status = 7
      throw e
    }
  }
  return originalExec(file, args, opts)
}
fs.chmodSync = function (file, bits) {
  const result = chmod(file, bits)
  if (mode === 'publish-race' && String(file).endsWith('archive.tgz')) fs.writeFileSync(process.env.SWEEP_PRESERVE_ARCHIVE, 'concurrent archive')
  return result
}
fs.lstatSync = function (file, ...args) {
  const stat = lstat(file, ...args)
  // Model a file symlink on Windows without requiring symlink privileges.
  // tar still reads the real fixture, isolating this specific refusal guard.
  if (mode === 'symlink' && String(file) === path.join(process.env.SWEEP_PRESERVE_TREE, '.env.local')) {
    stat.isFile = () => false
    stat.isSymbolicLink = () => true
  }
  return stat
}
`);
  const guardTree = linked('guard');
  plant(guardTree, '.env.local');
  const guardStore = path.join(ROOT, 'round3-guard-store', 'live', 'sub');
  put('guard', guardTree, {}, guardStore);
  let runs = 0;
  const guard = (mode, overrides = {}) => {
    const dest = overrides.SESSION_SWEEP_ARCHIVE_DIR || path.join(ROOT, 'round3-guard-archives-' + ++runs);
    const tarLog = path.join(ROOT, 'round3-tar-' + runs + '.log');
    fs.writeFileSync(tarLog, '');
    const common = fs.realpathSync(path.resolve(guardTree, g(guardTree, 'rev-parse', '--git-common-dir')));
    const hash = require('crypto').createHash('sha256').update(process.platform === 'win32' ? common.toLowerCase() : common).digest('hex').slice(0, 10);
    const collision = path.join(dest, path.basename(guardTree) + '-' + hash + '-20200101T000000000Z-00000000.tgz');
    if (mode === 'preexisting') {
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(collision, 'earlier archive');
    }
    const rows = sweep(['--preserve-local'], {
      SESSION_SWEEP_STORE: path.dirname(path.dirname(guardStore)), SESSION_SWEEP_ARCHIVE_DIR: dest,
      SWEEP_PRESERVE_GUARD_MODE: mode, SWEEP_PRESERVE_TREE: guardTree, SWEEP_PRESERVE_TAR_LOG: tarLog,
      SWEEP_PRESERVE_ARCHIVE: collision,
      NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --require "' + preload.replace(/\\/g, '/') + '"', ...overrides });
    return { r: row(rows, 'guard'), rows, dest, calls: fs.readFileSync(tarLog, 'utf8').trim() };
  };
  const valid = guard('control');
  check('W3 control: eligible local-only row writes a real archive', typeof valid.r.archive, 'string');
  check('W3 control: archive reads back the expected local file', JSON.stringify(members(valid.r)), JSON.stringify(['.env.local']));
  const sym = guard('symlink');
  check('W3 symlink: specific refusal fires', sym.r.risk, (v) => /preserve-refused\(unsupported local file:/.test(v || ''));
  check('W3 symlink: tar never runs', sym.calls, '');
  check('W3 symlink: no archive file is written', archiveFiles(sym.dest).length, 0);
  const inside = guard('control', { SESSION_SWEEP_ARCHIVE_DIR: path.join(guardTree, '.claude', 'backups') });
  check('W3 inside: lexical archive-dir guard fires', inside.r.risk, (v) => /preserve-refused\(archive directory is inside the worktree\)/.test(v || ''));
  check('W3 inside: tar never runs', inside.calls, '');
  check('W3 inside: no archive file is written', archiveFiles(inside.dest).length, 0);
  // A junction is available without Windows file-symlink privileges.
  const alias = path.join(ROOT, 'round3-archive-alias');
  fs.mkdirSync(path.join(guardTree, '.claude', 'real-backups'), { recursive: true });
  fs.symlinkSync(path.join(guardTree, '.claude', 'real-backups'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const resolved = guard('control', { SESSION_SWEEP_ARCHIVE_DIR: alias });
  check('W3 inside: resolved archive-dir guard fires', resolved.r.risk, (v) => /preserve-refused\(archive directory resolves inside the worktree\)/.test(v || ''));
  check('W3 inside: resolved directory writes no archive', archiveFiles(alias).length, 0);
  fs.unlinkSync(alias);
  fs.rmSync(path.join(guardTree, '.claude'), { recursive: true, force: true });
  const warned = guard('listing-stderr');
  check('W3 answered: exit-zero ls-files stderr remains blocked', warned.r.risk, 'git-unreadable');
  check('W3 answered: no archive file is written', archiveFiles(warned.dest).length, 0);
  const preexisting = guard('preexisting');
  check('W3 exists: preexisting destination has its specific refusal', preexisting.r.risk,
    (v) => /preserve-refused\(archive already exists, refusing to overwrite\)/.test(v || ''));
  check('W3 exists: tar never runs', preexisting.calls, '');
  check('W3 exists: earlier archive bytes survive', archiveFiles(preexisting.dest).map((n) => fs.readFileSync(path.join(preexisting.dest, n), 'utf8')).join(''), 'earlier archive');
  const raced = guard('publish-race');
  check('W3 publish: concurrent destination keeps row blocked', raced.r.safe, false);
  check('W3 publish: no archive is reported', raced.r.archive, null);
  check('W3 publish: concurrent archive bytes survive', archiveFiles(raced.dest).map((n) => fs.readFileSync(path.join(raced.dest, n), 'utf8')).join(''), 'concurrent archive');
  check('W3 publish control: tar created and verified before race', raced.calls, '-czf\n-tzf');
  const tarFailed = guard('tar-failure');
  check('W1: tar stderr never reaches risk text', tarFailed.r.risk,
    (v) => /preserve-refused\(tar failed \(exit 7\)\)/.test(v || '') && !v.includes('ENV_CANARY_42'));
  check('W1: failed tar leaves row blocked', tarFailed.r.safe, false);
  check('W1: failed tar publishes no archive', archiveFiles(tarFailed.dest).length, 0);
  if (process.platform === 'win32') {
    const unicodeStore = path.join(ROOT, 'round3-unicode-store', 'live', 'sub');
    put('unicode', unicode, {}, unicodeStore);
    const refused = guard('control', { SESSION_SWEEP_STORE: path.dirname(path.dirname(unicodeStore)) });
    check('W1: non-ASCII has a fixed Windows refusal', row(refused.rows, 'unicode').risk,
      (v) => /preserve-refused\(non-ASCII local paths are unsupported on win32\)/.test(v || ''));
    check('W1: non-ASCII is refused before tar runs', refused.calls, '');
    check('W1: non-ASCII row stays blocked', row(refused.rows, 'unicode').safe, false);
  } else {
    const locale = spawnSync('locale', ['charmap'], { encoding: 'utf8' });
    const charmap = (locale.stdout || '').trim();
    if (locale.status !== 0 || locale.error || !/^UTF-?8$/i.test(charmap)) {
      console.log('SKIP W1 POSIX control: non-ASCII names are preserved, locale cannot be verified as UTF-8 (' +
        (locale.error ? locale.error.code : charmap || 'locale exited ' + locale.status) + ')');
    } else {
      check('W1 POSIX control: non-ASCII names are preserved', JSON.stringify(members(row(after, 'unicode'))), JSON.stringify(['.claude/not\u0103 \u0219.md']));
    }
  }

  // Exclusion must prevent the write itself, even when SAFE remains false.
  for (const policy of ['third-party', 'exempt', 'unreachable']) {
    const policyStore = path.join(ROOT, 'round3-policy-' + policy, 'live', 'sub');
    put('guard', guardTree, policy === 'exempt' ? { autoArchiveExempt: true } : {}, policyStore);
    if (policy === 'third-party') g(MAIN, 'remote', 'set-url', 'origin', 'https://bitbucket.org/fixture/project.git');
    if (policy === 'unreachable') {
      const recent = staleRec('active-anchor', null, { cwd: MAIN, originCwd: MAIN, lastActivityAt: Date.now() });
      const other = path.join(path.dirname(path.dirname(policyStore)), 'other', 'sub');
      fs.mkdirSync(other, { recursive: true });
      fs.writeFileSync(path.join(other, recent.sessionId + '.json'), JSON.stringify(recent));
    }
    const dest = path.join(ROOT, 'round3-policy-archives-' + policy);
    const rows = sweep(['--preserve-local'], { SESSION_SWEEP_STORE: path.dirname(path.dirname(policyStore)), SESSION_SWEEP_ARCHIVE_DIR: dest });
    check('W3 gate: ' + policy + ' row retains policy', row(rows, 'guard')[policy === 'third-party' ? 'thirdParty' : policy === 'exempt' ? 'exempt' : 'reachable'], policy !== 'unreachable');
    check('W3 gate: ' + policy + ' writes no archive file', archiveFiles(dest).length, 0);
    check('W3 gate: ' + policy + ' reports no archive', row(rows, 'guard').archive, null);
    if (policy === 'third-party') g(MAIN, 'remote', 'set-url', 'origin', BARE);
  }
  const skill = fs.readFileSync(process.env.SESSION_SWEEP_TEST_SKILL || path.resolve(__dirname, '..', 'plugins/autodev-core/skills/sessions/SKILL.md'), 'utf8');
  const dispositions = skill.split('Disposition is separate from verdict')[1].split('## Step 2')[0];
  for (const label of ['leftover-dir(N files)', 'leftover-dir-unreadable', 'tracked-subdirectory', 'main-checkout', 'orphan-commits(N)', 'commit-uncheckable', 'submodules(N)', 'submodules-uncheckable', 'preserve-refused(reason)', 'local-only(N files: paths)']) {
    check('W4: disposition names ' + label + ' on its own line', dispositions.split('\n').some((line) => line.startsWith('- `' + label + '`')), true);
  }
  preserveStates += 9;
}

function checkPosixLocaleControls() {
  // Execute the actual POSIX assertion block with tar/locale boundary results.
  // This keeps both locale branches covered even on a Windows suite host.
  const source = fs.readFileSync(process.env.SESSION_SWEEP_TEST_SUITE || __filename, 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf("    const unicodeStore = path.join(ROOT, 'round3-unicode-store'");
  const from = source.indexOf('  } else {\n', start) + '  } else {\n'.length;
  const to = source.indexOf('\n  }\n\n  // Exclusion', from);
  check('W4-R3 control: POSIX block extraction is bounded', start >= 0 && from > start && to > from, true);
  if (start < 0 || to < from) return;
  for (const [locale, charmap, members] of [['C', 'ANSI_X3.4-1968', []], ['C.UTF-8', 'UTF-8', ['.claude/not\u0103 \u0219.md']]]) {
    const assertions = [];
    const messages = [];
    require('vm').runInNewContext(source.slice(from, to), {
      spawnSync: () => ({ status: 0, stdout: charmap + '\n' }),
      members: () => members, row: () => ({}), after: [],
      check: (name, actual, expected) => assertions.push(actual === expected),
      console: { log: (message) => messages.push(message) },
    });
    check('W4-R3: POSIX assertion handles ' + locale,
      locale === 'C' ? assertions.length === 0 && messages.some((m) => /^SKIP .*locale.*UTF-8/.test(m))
        : assertions.length === 1 && assertions[0] && messages.length === 0, true);
  }
}

function checkRound4Regressions() {
  checkPosixLocaleControls();
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const plant = (wt, name, content = 'only local copy\n') => {
    fs.mkdirSync(path.dirname(path.join(wt, name)), { recursive: true });
    fs.writeFileSync(path.join(wt, name), content);
  };
  const config = (repo) => {
    g(repo, 'config', 'user.name', 'Suite');
    g(repo, 'config', 'user.email', 'suite@example.com');
    g(repo, 'config', 'core.excludesFile', path.join(ROOT, 'empty-excludes'));
  };
  const sub = path.join(ROOT, 'round4-sub-source');
  g(ROOT, 'init', '-q', '-b', 'main', sub);
  config(sub);
  plant(sub, '.gitignore', '.env.local\n');
  plant(sub, 'sub.md');
  g(sub, 'add', '.');
  g(sub, 'commit', '-qm', 'submodule base');
  const bare = path.join(ROOT, 'github.com', 'round4.git');
  const seed = path.join(ROOT, 'round4-seed');
  g(ROOT, 'init', '-q', '--bare', '--initial-branch=main', bare);
  g(ROOT, 'clone', '-q', bare, seed);
  config(seed);
  plant(seed, '.gitignore', '*.local\n.claude/\n');
  plant(seed, 'cfg.json', '{}\n');
  g(seed, 'add', '.');
  g(seed, 'commit', '-qm', 'parent base');
  g(seed, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub');
  g(seed, 'commit', '-qm', 'parent gitlink');
  g(seed, 'push', '-q', 'origin', 'main');
  // This clone has never activated a submodule, matching the review scenario.
  const main = path.join(ROOT, 'round4-main');
  g(ROOT, 'clone', '-q', bare, main);
  config(main);
  const store = path.join(ROOT, 'round4-store', 'live', 'sub');
  const archives = path.join(ROOT, 'round4-archives');
  const fixture = path.join(ROOT, 'round4-prs.json');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(fixture, '{}');
  const put = (id, wt) => {
    const rec = staleRec(id, wt, { cwd: main, originCwd: main });
    fs.writeFileSync(path.join(store, rec.sessionId + '.json'), JSON.stringify(rec));
  };
  const linked = (id) => {
    const wt = path.join(ROOT, 'round4-wt', id);
    g(main, 'worktree', 'add', '-q', '-b', id, wt, 'main');
    g(wt, 'push', '-q', '-u', 'origin', id);
    put(id, wt);
    return wt;
  };
  const clean = linked('r4-clean-uninitialized');
  check('B1-R control: clean gitlink directory is empty', fs.readdirSync(path.join(clean, 'vendor/sub')).length, 0);
  const absent = linked('r4-absent-uninitialized');
  fs.rmdirSync(path.join(absent, 'vendor/sub'));
  check('B1-R control: absent gitlink directory has no content', fs.existsSync(path.join(absent, 'vendor/sub')), false);
  const uninit = linked('r4-uninit-files');
  plant(uninit, 'vendor/sub/notes.md');
  const emptyChild = linked('r4-uninit-directory');
  fs.mkdirSync(path.join(emptyChild, 'vendor/sub/empty-child'));
  const manual = linked('r4-manual-clone');
  fs.rmdirSync(path.join(manual, 'vendor/sub'));
  const manualSub = path.join(manual, 'vendor/sub');
  g(ROOT, 'clone', '-q', sub, manualSub);
  config(manualSub);
  g(manualSub, 'checkout', '-q', '-b', 'local-feature');
  plant(manualSub, 'feature.md');
  g(manualSub, 'add', '.');
  g(manualSub, 'commit', '-qm', 'only submodule branch');
  g(manualSub, 'checkout', '-q', 'main');
  plant(manualSub, '.env.local');
  for (const wt of [uninit, emptyChild, manual]) {
    check('B1-R control: ' + path.basename(wt) + ' reads uninitialized', g(wt, 'submodule', 'status').startsWith('-'), true);
    check('B1-R control: ' + path.basename(wt) + ' parent status is clean', g(wt, 'status', '--porcelain'), '');
  }
  // Later rows have no gitlinks, so status and index controls decide alone.
  g(main, 'rm', '-q', '-f', 'vendor/sub', '.gitmodules');
  g(main, 'commit', '-qm', 'remove parent gitlink');
  g(main, 'push', '-q', 'origin', 'main');
  const embedded = linked('r4-embedded');
  const embeddedSub = path.join(embedded, 'vendor/new');
  g(ROOT, 'clone', '-q', sub, embeddedSub);
  config(embeddedSub);
  g(embeddedSub, 'checkout', '-q', '-b', 'local-feature');
  plant(embeddedSub, 'feature.md');
  g(embeddedSub, 'add', '.');
  g(embeddedSub, 'commit', '-qm', 'embedded local branch');
  g(embeddedSub, 'checkout', '-q', 'main');
  g(embedded, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/new');
  g(embedded, 'commit', '-qm', 'embedded gitlink');
  g(embedded, 'push', '-q');
  check('W2-R3 control: embedded git directory is a folder', fs.statSync(path.join(embeddedSub, '.git')).isDirectory(), true);
  check('W2-R3 control: private modules directory is absent', fs.existsSync(path.join(g(embedded, 'rev-parse', '--absolute-git-dir'), 'modules')), false);
  check('W2-R3 control: embedded branch holds one local commit', g(embeddedSub, 'rev-list', '--count', 'local-feature', '--not', '--remotes'), '1');
  const dup = linked('r4-duplicate');
  const population = ['notes/a/b/deep.local', 'notes/top.local'];
  for (const name of population) plant(dup, name);
  const listing = g(dup, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z').split('\0');
  check('W1-R3 control: git lists both ancestor and descendant', listing.includes('notes/') && listing.includes('notes/a/b/'), true);
  const hidden = linked('r4-untracked-hidden');
  plant(hidden, 'notes.md');
  const flagged = [];
  for (const flag of ['skip-worktree', 'assume-unchanged']) {
    const wt = linked('r4-' + flag);
    g(wt, 'update-index', '--' + flag, 'cfg.json');
    plant(wt, 'cfg.json', '{"local":"edit"}\n');
    flagged.push(path.basename(wt));
    check('W5-R3 control: ' + flag + ' edit is invisible to status', g(wt, 'status', '--porcelain'), '');
    const same = linked('r4-clean-' + flag);
    g(same, 'update-index', '--' + flag, 'cfg.json');
  }
  const wtref = linked('r4-worktree-ref');
  plant(wtref, 'only-ref.md');
  g(wtref, 'add', '.');
  g(wtref, 'commit', '-qm', 'only worktree ref');
  const orphan = g(wtref, 'rev-parse', 'HEAD');
  g(wtref, 'update-ref', 'refs/worktree/keep', orphan);
  g(wtref, 'reset', '-q', '--hard', 'origin/r4-worktree-ref');
  check('W5-R3 control: HEAD alone has no orphan commits', g(wtref, 'rev-list', '--count', 'HEAD', '--not', '--remotes', '--branches', '--tags'), '0');
  check('W5-R3 control: private ref has one orphan commit', g(wtref, 'rev-list', '--count', 'refs/worktree/keep', '--not', '--remotes', '--branches', '--tags'), '1');
  g(main, 'config', 'status.showUntrackedFiles', 'no');
  check('W5-R3 control: shared config hides untracked file', g(hidden, 'status', '--porcelain'), '');
  const env = { ...process.env, SESSION_SWEEP_STORE: path.dirname(path.dirname(store)), SESSION_SWEEP_OWNER: '',
    SESSION_SWEEP_PR_FIXTURE: fixture, SESSION_SWEEP_ARCHIVE_DIR: archives, CLAUDE_CONFIG_DIR: path.join(ROOT, 'round4-profile') };
  const sweep = (flags) => {
    const r = spawnSync(process.execPath, [SCRIPT, '--json', ...flags], { env, encoding: 'utf8', maxBuffer: 64 << 20 });
    check('round4 CLI exits 0', r.status, 0);
    try { return JSON.parse(r.stdout); }
    catch { failures.push('round4 invalid JSON: ' + (r.stderr || r.stdout)); return []; }
  };
  const row = (rows, id) => rows.find((r) => r.sessionId === 'local_' + id) || {};
  const before = sweep([]);
  const after = sweep(['--preserve-local']);
  for (const [mode, rows] of [['default', before], ['preserve', after]]) {
    for (const id of ['r4-uninit-files', 'r4-uninit-directory', 'r4-manual-clone']) {
      check('B1-R: ' + id + ' has its own label in ' + mode, row(rows, id).risk, 'submodule-dir-not-empty(1)');
      check('B1-R: ' + id + ' stays unsafe in ' + mode, row(rows, id).safe, false);
      check('B1-R: ' + id + ' has no archive in ' + mode, row(rows, id).archive, null);
    }
    check('W2-R3: embedded gitlink branch blocks in ' + mode, row(rows, 'r4-embedded').risk, 'submodules(1)');
    check('W2-R3: embedded row stays unsafe in ' + mode, row(rows, 'r4-embedded').safe, false);
    check('W2-R3: embedded row has no archive in ' + mode, row(rows, 'r4-embedded').archive, null);
    check('W5-R3: untracked files cannot be hidden in ' + mode, row(rows, 'r4-untracked-hidden').risk, 'dirty(1 file)');
    for (const id of flagged) check('W5-R3: ' + id + ' edit blocks in ' + mode, row(rows, id).risk, 'hidden-index-changes(1)');
    check('W5-R3: worktree-only ref blocks in ' + mode, row(rows, 'r4-worktree-ref').risk, 'orphan-commits(1)');
    check('B1-R control: absent gitlink has no occupied-directory label in ' + mode,
      (row(rows, 'r4-absent-uninitialized').risk || '').startsWith('submodule-dir-not-empty('), false);
    for (const id of ['r4-clean-uninitialized', 'r4-clean-skip-worktree', 'r4-clean-assume-unchanged']) {
      check('B1-R W5-R3 control: ' + id + ' stays SAFE in ' + mode, row(rows, id).safe, true);
    }
  }
  const risk = row(before, 'r4-duplicate').risk || '';
  check('W1-R3: exact unique file count', risk.match(/^local-only\((\d+) files:/)?.[1], String(population.length));
  check('W1-R3: exact named planted population', risk, 'local-only(2 files: ' + population.join(', ') + ')');
  const archived = row(after, 'r4-duplicate');
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const members = archived.archive ? execFileSync(tar, ['-tzf', archived.archive], { encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean).map((n) => n.replace(/^\.\//, '')).sort() : [];
  check('W1-R3: exact tar member count', members.length, population.length);
  check('W1-R3: exact tar members appear once', JSON.stringify(members), JSON.stringify(population));
  check('W1-R3: deduplicated preservation becomes SAFE', archived.safe, true);
  const skill = fs.readFileSync(process.env.SESSION_SWEEP_TEST_SKILL || path.resolve(__dirname, '..', 'plugins/autodev-core/skills/sessions/SKILL.md'), 'utf8');
  const dispositions = skill.split('Disposition is separate from verdict')[1].split('## Step 2')[0];
  for (const label of ['submodule-dir-not-empty(N)', 'hidden-index-changes(N)', 'hidden-index-uncheckable']) {
    check('W4: disposition names ' + label + ' on its own line', dispositions.split('\n').some((line) => line.startsWith('- `' + label + '`')), true);
  }
  preserveStates += 12;
}

function checkRound5Regressions() {
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const plant = (wt, name, content = 'retained in Git\n') => {
    fs.mkdirSync(path.dirname(path.join(wt, name)), { recursive: true });
    fs.writeFileSync(path.join(wt, name), content);
  };
  const bare = path.join(ROOT, 'github.com', 'round5.git');
  const main = path.join(ROOT, 'round5-main');
  g(ROOT, 'init', '-q', '--bare', '--initial-branch=main', bare);
  g(ROOT, 'clone', '-q', bare, main);
  g(main, 'config', 'user.name', 'Suite');
  g(main, 'config', 'user.email', 'suite@example.com');
  g(main, 'config', 'core.excludesFile', path.join(ROOT, 'empty-excludes'));
  g(main, 'config', 'extensions.worktreeConfig', 'true');
  plant(main, 'apps/a/keep.txt');
  plant(main, 'apps/b/omit.txt');
  plant(main, 'cfg.json', '{}\n');
  plant(main, '.gitattributes', '*.txt text eol=crlf\n');
  g(main, 'add', '.');
  g(main, 'commit', '-qm', 'sparse base');
  g(main, 'push', '-q', 'origin', 'main');
  const store = path.join(ROOT, 'round5-store', 'live', 'sub');
  const archives = path.join(ROOT, 'round5-archives');
  const fixture = path.join(ROOT, 'round5-prs.json');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(fixture, '{}');
  const put = (dir, id, wt) => {
    fs.mkdirSync(dir, { recursive: true });
    const rec = staleRec(id, wt, { cwd: main, originCwd: main });
    fs.writeFileSync(path.join(dir, rec.sessionId + '.json'), JSON.stringify(rec));
  };
  const linked = (id, dir = store) => {
    const wt = path.join(ROOT, 'round5-wt', id);
    g(main, 'worktree', 'add', '-q', '-b', id, wt, 'main');
    g(wt, 'push', '-q', '-u', 'origin', id);
    put(dir, id, wt);
    return wt;
  };
  const sparse = linked('r5-sparse-cone');
  g(sparse, 'sparse-checkout', 'set', '--cone', 'apps/a');
  check('W1-R4 control: cone excludes a skip-worktree file',
    g(sparse, 'ls-files', '-v', 'apps/b/omit.txt'), 'S apps/b/omit.txt');
  check('W1-R4 control: outside-cone file is absent', fs.existsSync(path.join(sparse, 'apps/b/omit.txt')), false);
  for (const flag of ['skip-worktree', 'assume-unchanged']) {
    const wt = linked('r5-edited-' + flag);
    g(wt, 'update-index', '--' + flag, 'cfg.json');
    plant(wt, 'cfg.json', '{"edit":true}\n');
    check('W1-R4 control: edited ' + flag + ' is invisible to status', g(wt, 'status', '--porcelain'), '');
  }
  const missing = linked('r5-absent-assume');
  g(missing, 'update-index', '--assume-unchanged', 'cfg.json');
  fs.unlinkSync(path.join(missing, 'cfg.json'));
  check('W1-R4 control: deleted assume-unchanged is invisible to status', g(missing, 'status', '--porcelain'), '');
  for (const [id, ref] of [['r5-bisect-ref', 'refs/bisect/bad'], ['r5-rewritten-ref', 'refs/rewritten/x']]) {
    const wt = linked(id);
    plant(wt, 'only-ref.md');
    g(wt, 'add', '.');
    g(wt, 'commit', '-qm', 'only private ref');
    g(wt, 'update-ref', ref, 'HEAD');
    g(wt, 'reset', '-q', '--hard', 'origin/' + id);
    check('F1 control: ' + ref + ' holds one unique commit', g(wt, 'rev-list', '--count', ref, '--not', '--remotes', '--branches', '--tags'), '1');
    check('F1 control: HEAD has no unique commit for ' + ref, g(wt, 'rev-list', '--count', 'HEAD', '--not', '--remotes', '--branches', '--tags'), '0');
    check('F1 control: common checkout cannot see ' + ref,
      spawnSync('git', ['rev-parse', '--verify', '-q', ref], { cwd: main }).status, 1);
  }
  // Index-only entries avoid host symlink privileges and submodule activation.
  const head = g(main, 'rev-parse', 'HEAD');
  const symlinkBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: main, input: '../apps/a/keep.txt', encoding: 'utf8' }).trim();
  g(main, 'update-index', '--add', '--cacheinfo', '160000,' + head + ',vendor/sub');
  g(main, 'update-index', '--add', '--cacheinfo', '120000,' + symlinkBlob + ',vendor/link');
  g(main, 'commit', '-qm', 'outside cone special entries');
  g(main, 'push', '-q', 'origin', 'main');
  const special = linked('r5-sparse-gitlink');
  g(special, 'sparse-checkout', 'set', '--cone', 'apps/a');
  for (const [name, mode] of [['vendor/sub', '160000'], ['vendor/link', '120000']]) {
    check('W1-R4 control: sparse ' + mode + ' is skip-worktree', g(special, 'ls-files', '-v', name), 'S ' + name);
    check('W1-R4 control: sparse ' + mode + ' is absent', fs.existsSync(path.join(special, name)), false);
  }
  const env = { ...process.env, SESSION_SWEEP_STORE: path.dirname(path.dirname(store)), SESSION_SWEEP_OWNER: '',
    SESSION_SWEEP_PR_FIXTURE: fixture, SESSION_SWEEP_ARCHIVE_DIR: archives, CLAUDE_CONFIG_DIR: path.join(ROOT, 'round5-profile') };
  const sweep = (flags, extra = {}) => {
    const start = performance.now();
    const r = spawnSync(process.execPath, [SCRIPT, '--json', ...flags], { env: { ...env, ...extra }, encoding: 'utf8', maxBuffer: 64 << 20 });
    const elapsed = performance.now() - start;
    check('round5 CLI exits 0', r.status, 0);
    try { return { rows: JSON.parse(r.stdout), elapsed }; }
    catch { failures.push('round5 invalid JSON: ' + (r.stderr || r.stdout)); return { rows: [], elapsed }; }
  };
  const row = (rows, id) => rows.find((r) => r.sessionId === 'local_' + id) || {};
  for (const flags of [[], ['--preserve-local']]) {
    const mode = flags.length ? 'preserve' : 'default';
    const { rows } = sweep(flags);
    for (const id of ['r5-sparse-cone', 'r5-sparse-gitlink']) {
      check('W1-R4: ' + id + ' reads SAFE in ' + mode, row(rows, id).safe, true);
      check('W1-R4: ' + id + ' has no blocker in ' + mode, row(rows, id).risk, null);
      check('W1-R4: ' + id + ' needs no archive in ' + mode, row(rows, id).archive, null);
    }
    for (const id of ['r5-edited-skip-worktree', 'r5-edited-assume-unchanged', 'r5-absent-assume']) {
      check('W1-R4: ' + id + ' stays blocked in ' + mode, row(rows, id).risk, 'hidden-index-changes(1)');
      check('W1-R4: ' + id + ' stays unsafe in ' + mode, row(rows, id).safe, false);
    }
    for (const id of ['r5-bisect-ref', 'r5-rewritten-ref']) {
      check('F1: ' + id + ' blocks in ' + mode, row(rows, id).risk, 'orphan-commits(1)');
      check('F1: ' + id + ' stays unsafe in ' + mode, row(rows, id).safe, false);
      check('F1: ' + id + ' writes no archive in ' + mode, row(rows, id).archive, null);
    }
  }
  const skill = fs.readFileSync(process.env.SESSION_SWEEP_TEST_SKILL || path.resolve(__dirname, '..', 'plugins/autodev-core/skills/sessions/SKILL.md'), 'utf8');
  const orphanLine = skill.split('\n').find((line) => line.startsWith('- `orphan-commits(N)`')) || '';
  check('F1: disposition names exactly the checked private namespaces',
    JSON.stringify(orphanLine.match(/refs\/[a-z]+\/\*/g) || []), JSON.stringify(['refs/worktree/*', 'refs/bisect/*', 'refs/rewritten/*']));

  // Time one row, including CLI startup. Setup and flag writes are not timed.
  const perfStore = path.join(ROOT, 'round5-perf-store', 'live', 'sub');
  const many = linked('r5-mass-flag', perfStore);
  const names = Array.from({ length: 298 }, (_, i) => 'src/f' + i + '.js');
  names.push('src/space name.txt', 'src/nonascii-\u0103.txt');
  for (const name of names) plant(many, name, name.endsWith('.txt') ? 'filtered\r\n' : 'unchanged\n');
  g(many, 'add', 'src');
  g(many, 'commit', '-qm', '300 flagged files');
  g(many, 'push', '-q');
  g(many, 'update-index', '--assume-unchanged', ...names);
  check('F2 control: exactly 300 assume-unchanged entries', g(many, 'ls-files', '-v').split('\n').filter((line) => line.startsWith('h ')).length, 300);
  const calls = path.join(ROOT, 'round5-hash-calls.jsonl');
  const preload = path.join(ROOT, 'round5-hash-preload.cjs');
  fs.writeFileSync(preload, `const cp = require('child_process');
const fs = require('fs');
const original = cp.spawnSync;
cp.spawnSync = function(command, args, options) {
  const r = original.apply(this, arguments);
  if (command === 'git' && args[0] === 'hash-object') {
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
  }
  return r;
};\n`);
  const perfEnv = { SESSION_SWEEP_STORE: path.dirname(path.dirname(perfStore)), NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --require "' + preload.replace(/\\/g, '/') + '"' };
  const measured = sweep([], perfEnv);
  check('F2: 300 unchanged filtered paths read SAFE', row(measured.rows, 'r5-mass-flag').safe, true);
  const hashCalls = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  console.log('F2 timing: 300 files, ' + measured.elapsed.toFixed(1) + ' ms, ' + hashCalls.length + ' hash-object calls, SAFE=' + row(measured.rows, 'r5-mass-flag').safe);
  check('F2: one stdin-paths call per row', JSON.stringify(hashCalls), JSON.stringify([['hash-object', '--stdin-paths']]));
  // Multiple changed files prove hash order and counting survive batching.
  plant(many, names[0], 'edited\n');
  plant(many, names[299], 'edited filtered\r\n');
  check('F2: batched hashes count both edited paths', row(sweep([], perfEnv).rows, 'r5-mass-flag').risk, 'hidden-index-changes(2)');
  preserveStates += 8;
}

function checkHiddenIndexPaths() {
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const store = path.join(ROOT, 'hidden-path-store', 'live', 'sub');
  const archives = path.join(ROOT, 'hidden-path-archives');
  const fixture = path.join(ROOT, 'hidden-path-prs.json');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(fixture, '{}');
  const put = (id, wt) => {
    const rec = staleRec(id, wt, { cwd: MAIN, originCwd: MAIN });
    fs.writeFileSync(path.join(store, rec.sessionId + '.json'), JSON.stringify(rec));
  };
  const env = { ...process.env, SESSION_SWEEP_STORE: path.dirname(path.dirname(store)), SESSION_SWEEP_OWNER: '',
    SESSION_SWEEP_PR_FIXTURE: fixture, SESSION_SWEEP_ARCHIVE_DIR: archives, CLAUDE_CONFIG_DIR: path.join(ROOT, 'hidden-path-profile') };
  const sweep = (flags, extra = {}) => {
    const r = spawnSync(process.execPath, [SCRIPT, '--json', ...flags], { env: { ...env, ...extra }, encoding: 'utf8', maxBuffer: 64 << 20 });
    check('B1-R5 CLI exits 0', r.status, 0);
    try { return JSON.parse(r.stdout); }
    catch { failures.push('hidden-path invalid JSON: ' + (r.stderr || r.stdout)); return []; }
  };
  const row = (rows, id) => rows.find((r) => r.sessionId === 'local_' + id) || {};
  const blocked = (rows, id, mode) => {
    check('B1-R5: ' + id + ' is uncheckable in ' + mode, row(rows, id).risk, 'hidden-index-uncheckable');
    check('B1-R5: ' + id + ' stays unsafe in ' + mode, row(rows, id).safe, false);
    check('B1-R5: ' + id + ' publishes no archive in ' + mode, row(rows, id).archive, null);
  };

  // Model only the Git decoding boundary on all hosts. The real byte-name
  // fixture below is separate because Windows cannot create that filename.
  const decoded = makeWorktree('decoded-index-path', 'decoded-index-path');
  g(decoded, 'push', '-q', '-u', 'origin', 'decoded-index-path');
  g(decoded, 'update-index', '--skip-worktree', 'README.md');
  fs.writeFileSync(path.join(decoded, 'README.md'), 'hidden local edit\n');
  check('B1-R5 boundary control: real edit is invisible to status', g(decoded, 'status', '--porcelain'), '');
  put('decoded-index-path', decoded);
  const calls = path.join(ROOT, 'decoded-index-calls.jsonl');
  const preload = path.join(ROOT, 'decoded-index-preload.cjs');
  fs.writeFileSync(preload, `const cp = require('child_process');
const fs = require('fs');
const originalSpawn = cp.spawnSync;
const originalLstat = fs.lstatSync;
const record = (call) => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(call) + '\\n');
cp.spawnSync = function(command, args, options) {
  const r = originalSpawn.apply(this, arguments);
  if (command === 'git' && options.cwd === ${JSON.stringify(decoded)} && args[0] === 'ls-files' && args.includes('-v')) {
    const raw = Buffer.concat([Buffer.from('S hidden-'), Buffer.from([0xff, 0])]);
    r.stdout = raw.toString('utf8');
    record('decoded-output');
  }
  return r;
};
fs.lstatSync = function(file, ...args) {
  if (String(file).includes('\\uFFFD')) record('lstat-lossy-path');
  return originalLstat.call(this, file, ...args);
};\n`);
  for (const flags of [[], ['--preserve-local']]) {
    const mode = flags.length ? 'preserve' : 'default';
    fs.writeFileSync(calls, '');
    const rows = sweep(flags, { NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --require "' + preload.replace(/\\/g, '/') + '"' });
    blocked(rows, 'decoded-index-path', mode);
    check('B1-R5 boundary: decoding refusal precedes lstat in ' + mode,
      fs.readFileSync(calls, 'utf8').trim(), JSON.stringify('decoded-output'));
    check('B1-R5 boundary: edited bytes survive in ' + mode, fs.readFileSync(path.join(decoded, 'README.md'), 'utf8'), 'hidden local edit\n');
  }
  fs.unlinkSync(path.join(store, 'local_decoded-index-path.json'));
  preserveStates++;

  if (process.platform === 'win32') {
    console.log('SKIP B1-R5 POSIX byte-name fixture: Windows cannot create a filename containing byte 0xFF');
    return;
  }
  const ids = ['nonutf8-skip-edit', 'nonutf8-skip-same', 'nonutf8-assume-same'];
  const rawName = Buffer.concat([Buffer.from('nonutf8-'), Buffer.from([0xff])]);
  const planted = new Map();
  for (const id of ids) {
    const wt = makeWorktree(id, id);
    const file = Buffer.concat([Buffer.from(wt + '/'), rawName]);
    fs.writeFileSync(file, 'committed bytes\n');
    g(wt, 'add', '.');
    g(wt, 'commit', '-qm', 'byte name fixture');
    g(wt, 'push', '-q', '-u', 'origin', id);
    execFileSync('git', ['update-index', id.includes('assume') ? '--assume-unchanged' : '--skip-worktree', '-z', '--stdin'],
      { cwd: wt, input: Buffer.concat([rawName, Buffer.from([0])]), stdio: ['pipe', 'pipe', 'pipe'] });
    const content = id.endsWith('edit') ? 'local edit only here\n' : 'committed bytes\n';
    fs.writeFileSync(file, content);
    const rawFlags = execFileSync('git', ['ls-files', '-v', '-z'], { cwd: wt, stdio: ['ignore', 'pipe', 'pipe'] });
    check('B1-R5 POSIX control: ' + id + ' retains byte 0xFF in Git output', rawFlags.includes(Buffer.from([0xff])), true);
    check('B1-R5 POSIX control: ' + id + ' decodes with U+FFFD', rawFlags.toString('utf8').includes('\uFFFD'), true);
    check('B1-R5 POSIX control: ' + id + ' is invisible to status', g(wt, 'status', '--porcelain'), '');
    planted.set(id, { file, content });
    put(id, wt);
  }
  const clean = makeWorktree('byte-name-clean-control', 'byte-name-clean-control');
  g(clean, 'push', '-q', '-u', 'origin', 'byte-name-clean-control');
  put('byte-name-clean-control', clean);
  for (const flags of [[], ['--preserve-local']]) {
    const mode = flags.length ? 'preserve' : 'default';
    const rows = sweep(flags);
    check('B1-R5 POSIX control: ordinary clean row stays SAFE in ' + mode, row(rows, 'byte-name-clean-control').safe, true);
    for (const id of ids) {
      blocked(rows, id, mode);
      const { file, content } = planted.get(id);
      check('B1-R5 POSIX: ' + id + ' bytes survive in ' + mode, fs.readFileSync(file, 'utf8'), content);
    }
  }
  preserveStates += ids.length + 1;
}

function run() {
  setup();
  if (process.env.SESSION_SWEEP_HIDDEN_PATHS_ONLY === '1') { checkHiddenIndexPaths(); return; }
  if (process.env.SESSION_SWEEP_HIDDEN_INDEX_ONLY === '1') { checkRound5Regressions(); return; }
  if (process.env.SESSION_SWEEP_SUBMODULE_INDEX_ONLY === '1') { checkRound4Regressions(); return; }
  if (process.env.SESSION_SWEEP_PRESERVATION_GUARDS_ONLY === '1') { checkRound3Regressions(); return; }
  if (process.argv.includes('--preserve-regressions')) { checkPreserveRegressions(); return; }
  buildCases();

  checkUnreadableStoreRefuses();
  checkReadableStoreStillScans();
  checkPlatformDefaultPath();
  checkSharedWorktreeBlocks();
  checkLiveTranscriptBlocks();
  checkDoneUnboundAndSelf();
  checkPipeDeliversEveryByte();
  checkUnpushedLogDies();
  checkWorkspaceReachability();
  checkPreserveRegressions();
  checkRound2Regressions();
  checkRound3Regressions();
  checkRound4Regressions();
  checkRound5Regressions();
  checkHiddenIndexPaths();

  // Two extra records for the ephemeral clock: same 5-day idle, differing only
  // by whether a schedule launched them. Derived from the same age so the pair
  // cannot drift apart and quietly stop testing the distinction.
  const EPH_AGE = 5;
  cases.push({ id: 'sched-stale', wt: null, scheduledTaskId: 'suite-task', ageDays: EPH_AGE, expectState: 'STALE' });
  // Hand-started and PR-less at 5d is DONE since the DONE verdict landed: it was
  // ACTIVE only because the one clock for PR-less work was 14 days.
  cases.push({ id: 'hand-active', wt: null, ageDays: EPH_AGE, expectState: 'DONE' });

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

  const res = settle(runBudgeted(process.execPath, [SCRIPT, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, SESSION_SWEEP_STORE: STORE, SESSION_SWEEP_OWNER: '' },
    timeout: 180000,
    maxTimeout: 600000,   // contention is clamped at 20; cap the widened retry
  }), 'the --json classification run');

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
  const bad = settle(runBudgeted(process.execPath, [SCRIPT, '--json', '--merged-min-minutes', 'garbage'], {
    encoding: 'utf8',
    env: { ...process.env, SESSION_SWEEP_STORE: STORE, SESSION_SWEEP_OWNER: '' },
    timeout: 180000,
    maxTimeout: 600000,
  }), 'the unparseable-floor run');
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
    const w = settle(runBudgeted(process.execPath, [SCRIPT, '--write-resume'], {
      encoding: 'utf8',
      cwd: RESUME_CWD,               // stubs land under the CALLER's cwd
      env: { ...process.env, SESSION_SWEEP_STORE: STORE, SESSION_SWEEP_OWNER: '' },
      timeout: 180000,
      maxTimeout: 600000,
    }), 'the --write-resume run');
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

  const w = settle(runBudgeted(process.execPath, [SCRIPT, '--archive-orphaned'], {
    encoding: 'utf8',
    env: { ...process.env, SESSION_SWEEP_STORE: STORE, SESSION_SWEEP_OWNER: '' },
    timeout: 180000,
    maxTimeout: 600000,
  }), 'the --archive-orphaned run');
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
if (failures.length || infra) {
  console.error(`session-sweep: ${tally(passed, failures.length, infra)}\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  for (const i of indeterminate) console.error('  ? ' + i);
  process.exit(exitCode(failures.length, infra));
}
console.log(`session-sweep: ${passed}/${total} passed — ${cases.length + preserveStates} planted worktree states, every safety label asserted by name`);
