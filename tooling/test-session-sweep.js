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

function run() {
  setup();
  buildCases();

  // Two extra records for the ephemeral clock: same 5-day idle, differing only
  // by whether a schedule launched them. Derived from the same age so the pair
  // cannot drift apart and quietly stop testing the distinction.
  const EPH_AGE = 5;
  cases.push({ id: 'sched-stale', wt: null, scheduledTaskId: 'suite-task', ageDays: EPH_AGE, expectState: 'STALE' });
  cases.push({ id: 'hand-active', wt: null, ageDays: EPH_AGE, expectState: 'ACTIVE' });

  // A settled PR bypasses the idle clock, so "merged" alone would call a session
  // finished while its author is still in it — measured on two real sessions
  // whose PRs had merged three minutes earlier. The floor requires finished AND
  // cold. Both records carry identical PRs and differ only in age, so a bug that
  // ignores the floor cannot satisfy the pair.
  const MERGED_PRS = [{ prNumber: 1, repo: 'suite-nonexistent/repo', state: 'MERGED' }];
  cases.push({ id: 'merged-warm', wt: null, prs: MERGED_PRS, ageDays: 0.1, expectState: 'ACTIVE' });
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

  const warm = rows.find((r) => r.sessionId === ids[cases.findIndex((c) => c.id === 'merged-warm')]);
  const cold = rows.find((r) => r.sessionId === ids[cases.findIndex((c) => c.id === 'merged-cold')]);
  check('merged floor separates the pair', warm && cold && warm.state !== cold.state, true);

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
