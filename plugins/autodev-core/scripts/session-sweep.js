#!/usr/bin/env node
/**
 * session-sweep.js — classify Claude Code Desktop sessions for archiving.
 *
 * READ-ONLY. Prints a verdict table and optionally writes resume stubs. It never
 * archives anything itself: archiving is an MCP call the model makes after
 * reading this output, so a bug here cannot destroy a worktree.
 *
 * Why the safety checks exist: archive_session stops the session process AND
 * cleans up its git worktree. A session whose worktree holds uncommitted or
 * unpushed work is NOT safe to archive, however finished it looks. That check is
 * the point of this script; the classification around it is the easy part.
 *
 * Usage:
 *   node session-sweep.js                  # classify, print table
 *   node session-sweep.js --stale-days 14  # override staleness threshold
 *   node session-sweep.js --write-resume   # also write resume stubs for SAFE rows
 *   node session-sweep.js --json           # machine-readable output
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// SESSION_SWEEP_STORE exists so the suite can drive a synthetic population
// through the REAL code path. The safety check is the whole point of this
// script, and a check nothing has ever seen fail is not a check.
const STORE = process.env.SESSION_SWEEP_STORE || path.join(
  process.env.APPDATA || path.join(process.env.HOME || '', '.config'),
  'Claude',
  'claude-code-sessions'
);

// Repos whose work must never be swept automatically are named in a LOCAL file,
// never in this repo — this one is public. One substring per line, '#' comments.
const DENYLIST_FILE = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'session-sweep-denylist.txt');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const STALE_DAYS = parseInt(opt('--stale-days', '14'), 10);
// Scheduled sessions are disposable by construction — the task regenerates them
// tomorrow — so they get a much shorter clock than hand-started work.
const EPHEMERAL_DAYS = parseInt(opt('--ephemeral-days', '2'), 10);
// A settled PR makes a session finished, and that bypasses the idle clock
// entirely — so a session whose PR merged three minutes ago reads as MERGED
// while its author is plainly still working in it. Measured: two sessions
// qualified as MERGED with last activity 3 minutes earlier. Finished is not
// the same as cold; require both.
const MERGED_MIN_HOURS = parseInt(opt('--merged-min-hours', '12'), 10);
const AS_JSON = flag('--json');
const WRITE_RESUME = flag('--write-resume');
// The ONLY mode in which this script mutates anything. Off by default and never
// implied: it marks SAFE records archived by editing the store, for workspaces
// the app no longer tracks. It still never touches a git worktree.
const ARCHIVE_ORPHANED = flag('--archive-orphaned');

function loadDenylist() {
  try {
    return fs.readFileSync(DENYLIST_FILE, 'utf8')
      .split('\n')
      .map((l) => l.split('#')[0].trim().toLowerCase())
      .filter(Boolean);
  } catch { return []; }
}
const DENY = loadDenylist();

// ---------------------------------------------------------------- collection

function collectSessions() {
  const out = [];
  if (!fs.existsSync(STORE)) return out;
  const walk = (dir, depth, workspace) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      // The workspace is the FIRST path segment under the store root. It is the
      // unit the app tracks, and which one a record sits in decides whether the
      // app holds it in memory.
      if (e.isDirectory()) walk(full, depth + 1, depth === 0 ? e.name : workspace);
      else if (e.isFile() && /^local_.*\.json$/.test(e.name)) {
        try {
          const rec = JSON.parse(fs.readFileSync(full, 'utf8'));
          rec.__file = full;
          rec.__workspace = workspace;
          out.push(rec);
        } catch { /* skip unreadable */ }
      }
    }
  };
  walk(STORE, 0, null);
  return out;
}

/**
 * Which workspace directory is the app actually using?
 *
 * Measured: the MCP tools see exactly ONE workspace dir — 5/5 known-reachable
 * sessions in it, 5/5 known-unreachable across the others. Age does not predict
 * reachability; the directory does. Records outside the live workspace were
 * never loaded by the app, which is what makes writing them safe.
 *
 * Current = the workspace owning the most recently active record. Any OTHER
 * workspace with recent activity is treated as live too, not orphaned — if two
 * dirs are both warm, something is going on that this heuristic does not model,
 * and the safe reading is "do not touch either".
 */
function detectWorkspaces(sessions) {
  const newest = new Map();
  for (const s of sessions) {
    const ws = s.__workspace;
    if (!ws) continue;
    const t = s.lastActivityAt || s.createdAt || 0;
    if (t > (newest.get(ws) || 0)) newest.set(ws, t);
  }
  if (!newest.size) return { current: null, orphaned: new Set(), newest };

  let current = null, best = -1;
  for (const [ws, t] of newest) if (t > best) { best = t; current = ws; }

  const RECENT = 2 * DAY;
  const orphaned = new Set();
  for (const [ws, t] of newest) {
    if (ws === current) continue;
    if (best - t < RECENT) continue;   // also warm: fail closed, leave it alone
    orphaned.add(ws);
  }
  return { current, orphaned, newest };
}

// ------------------------------------------------------------- git inspection

function git(cwd, cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

/**
 * The `prs[].state` stored on disk is a SNAPSHOT from whenever that session last
 * looked, not live state — measured: PR #504 was cached MERGED in one session
 * and OPEN in another on the same day, and `gh` said MERGED. Trusting the cache
 * both strands finished sessions and, worse, can call a reopened PR merged.
 *
 * So refresh it. One `gh pr list` per repo, not one call per PR.
 * Returns Map<"repo#number", STATE>. On any failure the map stays empty and
 * callers fall back to the cached value, which is degraded but not wrong-by-
 * default — an unknown state is never promoted to MERGED.
 */
function refreshPrStates(sessions) {
  const map = new Map();
  const repos = new Set();
  for (const s of sessions) {
    for (const pr of s.prs || []) if (pr.repo) repos.add(pr.repo);
  }
  for (const repo of repos) {
    try {
      const raw = execSync(
        `gh pr list --repo ${repo} --state all --limit 300 --json number,state`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 }
      );
      for (const pr of JSON.parse(raw)) {
        map.set(`${repo}#${pr.number}`, String(pr.state).toUpperCase());
      }
    } catch {
      // Network/auth failure: leave this repo unrefreshed rather than guessing.
    }
  }
  return map;
}

/**
 * Third-party work is identified by its REMOTE, not by a hardcoded project name.
 * The remote is the durable tell and it keeps client identifiers out of this
 * public file. Anything not on the operator's own account is treated as
 * third-party and excluded from the sweep.
 */
function isThirdParty(s) {
  const dir = fs.existsSync(s.worktreePath || '') ? s.worktreePath : s.originCwd || s.cwd;
  if (!dir || !fs.existsSync(dir)) return false;
  const remote = (git(dir, 'remote get-url origin') || '').toLowerCase();
  if (!remote) return false;
  if (DENY.some((d) => remote.includes(d) || (s.originCwd || '').toLowerCase().includes(d))) return true;
  const own = (process.env.SESSION_SWEEP_OWNER || '').toLowerCase();
  if (own && remote.includes('github.com') && !remote.includes(own)) return true;
  return !remote.includes('github.com');
}

/**
 * The load-bearing check. Returns the reason a worktree is unsafe to discard,
 * or null when it is genuinely disposable.
 *
 * Fails CLOSED by design: if the worktree exists but git cannot be read, that is
 * "unknown", and unknown is treated as unsafe. An unrecognised state must never
 * fall through to "safe to delete".
 */
function worktreeRisk(s) {
  const wt = s.worktreePath;
  if (!wt) return null;                  // no worktree, nothing to lose
  if (!fs.existsSync(wt)) return null;   // already cleaned up

  const status = git(wt, 'status --porcelain');
  if (status === null) return 'git-unreadable';
  if (status.length > 0) {
    const n = status.split('\n').filter(Boolean).length;
    return `dirty(${n} file${n === 1 ? '' : 's'})`;
  }

  // Use the LIVE checked-out branch, never the one recorded in session metadata.
  // Measured on two worktrees out of six: the record named one branch while the
  // worktree sat on another entirely (the session had switched branches after
  // the record was written). Checking the recorded name inspects a branch the
  // worktree is not on — which produced false blocks here, and would just as
  // easily clear a branch nobody ever checked.
  const branch = git(wt, 'rev-parse --abbrev-ref HEAD') || s.branch;
  if (branch && branch !== 'HEAD') {
    const onRemote = git(wt, `ls-remote --heads origin ${branch}`);
    if (onRemote) {
      const unpushed = git(wt, `log --oneline origin/${branch}..HEAD`);
      if (unpushed && unpushed.length > 0) {
        return `unpushed(${unpushed.split('\n').length})`;
      }
    } else {
      // No remote branch, so `origin/<branch>..HEAD` resolves to nothing and
      // reports 0 — an empty result meaning "the probe could not run", not
      // "nothing would be lost". Measure against the default branch instead,
      // and report the count, because "local branch carrying 8 commits" and
      // "local branch carrying nothing" are the same label but opposite risks.
      // Never assume the default branch is `main`. Measured: one repo's real
      // default is a long-lived feature branch, and its stale `main` sits 7694
      // commits behind — basing the count on `main` there would invent 7694
      // orphans. Ask git, then ask the forge, then give up rather than guess.
      let base = (git(wt, 'symbolic-ref refs/remotes/origin/HEAD') || '').replace('refs/remotes/', '');
      if (!base) {
        const slug = (git(wt, 'remote get-url origin') || '').replace(/^.*[:/]([^/]+\/[^/]+?)(\.git)?$/, '$1');
        try {
          const d = execSync(`gh repo view ${slug} --json defaultBranchRef -q .defaultBranchRef.name`,
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }).trim();
          if (d) base = `origin/${d}`;
        } catch { /* fall through to fail-closed below */ }
      }
      if (!base) return 'branch-not-on-remote';             // unknown base: fail closed
      const orphan = git(wt, `log --oneline ${base}..HEAD`);
      if (orphan === null) return 'branch-not-on-remote';   // unreadable: fail closed
      const n = orphan ? orphan.split('\n').filter(Boolean).length : 0;
      if (n > 0) return `orphan-commits(${n})`;
      // Local-only branch carrying nothing the default branch lacks: not a blocker.
    }
  }

  // Stashes are deliberately NOT a blocker, and this is not an oversight.
  // `refs/stash` lives in the COMMON git dir, so every worktree of a repo sees
  // the same stash list and removing one worktree loses none of it. Measured:
  // the main checkout and two sibling worktrees all reported the identical 4
  // entries. Blocking on it would strand every worktree in any repo that has
  // ever stashed anything, while protecting nothing. Do not re-add it.

  return null;
}

// ------------------------------------------------------------- classification

const now = Date.now();
const DAY = 86400000;

function classify(s, prStates) {
  const ageDays = (now - (s.lastActivityAt || s.createdAt || now)) / DAY;
  const prs = Array.isArray(s.prs) ? s.prs : [];
  // A session the app itself launched from a schedule. Structural, not a title
  // regex: 261 records carry `scheduledTaskId` (e.g. "coordinator-pulse"), and a
  // regex over titles would both miss renamed tasks and catch hand-started work
  // that happens to be called "daily digest".
  const ephemeral = !!s.scheduledTaskId;
  // Live state wins over the on-disk snapshot; the snapshot is the fallback.
  const stateOf = (p) =>
    prStates.get(`${p.repo}#${p.prNumber}`) || (p.state || p.prState || '').toUpperCase();

  // A CLOSED-unmerged PR is finished work too — the branch was abandoned, so the
  // session has nothing left to do. Treat CLOSED like MERGED for disposal, and
  // note it separately so the reason stays honest.
  const settled = (p) => ['MERGED', 'CLOSED'].includes(stateOf(p));

  let state, why;
  if (prs.length && prs.every(settled) && ageDays * 24 < MERGED_MIN_HOURS) {
    // Settled but still warm: treat as ACTIVE, not finished.
    state = 'ACTIVE';
    why = `PRs settled but active ${Math.round(ageDays * 24)}h ago (< ${MERGED_MIN_HOURS}h floor)`;
  } else if (prs.length && prs.every(settled)) {
    state = 'MERGED';
    why = `PR ${prs.map((p) => '#' + p.prNumber + (stateOf(p) === 'CLOSED' ? '(closed)' : '')).join(', ')} settled`;
  } else if (prs.some((p) => stateOf(p) === 'OPEN')) {
    state = 'PR-OPEN';
    why = `PR ${prs.filter((p) => stateOf(p) === 'OPEN').map((p) => '#' + p.prNumber).join(', ')} still open`;
  } else if (ageDays >= (ephemeral ? EPHEMERAL_DAYS : STALE_DAYS)) {
    state = 'STALE';
    why = ephemeral
      ? `scheduled task "${s.scheduledTaskId}", idle ${Math.floor(ageDays)}d`
      : `no activity ${Math.floor(ageDays)}d`;
  } else {
    state = 'ACTIVE';
    why = `active ${Math.floor(ageDays)}d ago`;
  }

  return { state, why, ageDays, prs, ephemeral };
}

// -------------------------------------------------------------------- resume

function resumeStub(s, c, risk) {
  const when = new Date(s.lastActivityAt || s.createdAt).toISOString().slice(0, 10);
  return `# RESUME — ${s.title || 'untitled session'}

_Archived ${new Date().toISOString().slice(0, 10)} by the \`sessions\` command. Last active ${when}._

| field | value |
|---|---|
| session | \`${s.sessionId}\` |
| branch | \`${s.branch || '—'}\` |
| worktree | \`${s.worktreePath || '—'}\` |
| PRs | ${c.prs.length ? c.prs.map((p) => `[#${p.prNumber}](${p.url}) ${p.state || ''}`).join(', ') : '—'} |
| verdict | ${c.state} — ${c.why} |
| worktree risk | ${risk || 'none'} |

## To pick this back up

1. Reopen \`${s.sessionId}\` from the Archived list — the transcript is intact — **or**
2. Start fresh in \`${s.originCwd || s.cwd}\` and read this file plus the repo's own
   \`RESUME.md\` / \`DECISIONS.md\`.

Prefer (2) when the old thread was long. A deep transcript re-bills its full
context on every turn and carries its own accumulated wrong turns; the repo
carries the conclusions without the cost.
`;
}

// ---------------------------------------------------------------------- main

const all = collectSessions();
const live = all.filter((s) => !s.isArchived);
const { current: currentWorkspace, orphaned: orphanedWorkspaces } = detectWorkspaces(all);

const prStates = refreshPrStates(live);

/**
 * Mark SAFE records archived by editing the store, for orphaned workspaces only.
 *
 * A string replace, deliberately, not parse-then-stringify: reserializing would
 * rewrite field order and escaping across a file the app owns, so any breakage
 * would be indistinguishable from the one change being made. Anything whose
 * shape does not match exactly one needle is skipped rather than guessed at.
 */
function archiveOrphaned(rows) {
  const NEEDLE = '"isArchived":false';
  const done = [];
  const skipped = [];

  for (const r of rows) {
    if (!r.safe) continue;
    const ws = r.s.__workspace;
    if (!ws || ws === currentWorkspace || !orphanedWorkspaces.has(ws)) {
      skipped.push([r.s.title, 'app tracks this workspace — use archive_session']);
      continue;
    }
    let raw;
    try { raw = fs.readFileSync(r.s.__file, 'utf8'); } catch { skipped.push([r.s.title, 'unreadable']); continue; }
    if ((raw.split(NEEDLE).length - 1) !== 1) { skipped.push([r.s.title, 'unexpected shape']); continue; }
    try {
      fs.writeFileSync(r.s.__file, raw.replace(NEEDLE, '"isArchived":true'), 'utf8');
      JSON.parse(fs.readFileSync(r.s.__file, 'utf8'));   // prove it still parses
      done.push(r.s.title);
    } catch (e) {
      try { fs.writeFileSync(r.s.__file, raw, 'utf8'); } catch { /* caller holds a backup */ }
      skipped.push([r.s.title, 'write failed: ' + e.message]);
    }
  }
  return { done, skipped };
}

const rows = live.map((s) => {
  const c = classify(s, prStates);
  const finished = c.state === 'MERGED' || c.state === 'STALE';
  const thirdParty = finished ? isThirdParty(s) : false;
  const risk = finished ? worktreeRisk(s) : null;
  // The app has its own opt-out. Honour it rather than inventing a second one.
  const exempt = s.autoArchiveExempt === true;
  return {
    s, c, risk, thirdParty, exempt,
    safe: finished && !thirdParty && !exempt && risk === null,
  };
});

if (AS_JSON) {
  console.log(JSON.stringify(rows.map((r) => ({
    sessionId: r.s.sessionId,
    title: r.s.title,
    cwd: r.s.originCwd || r.s.cwd,
    branch: r.s.branch,
    state: r.c.state,
    why: r.c.why,
    ageDays: Math.floor(r.c.ageDays),
    thirdParty: r.thirdParty,
    ephemeral: r.c.ephemeral,
    exempt: r.exempt,
    risk: r.risk,
    safe: r.safe,
  })), null, 2));
  process.exit(0);
}

// Population first — a bare verdict is indistinguishable from a probe that found
// nothing, so always print what was scanned.
console.log(`POPULATION: ${all.length} session records on disk, ${live.length} not yet archived.`);
console.log(`Store: ${STORE}`);
console.log(`Denylist: ${DENY.length} entr${DENY.length === 1 ? 'y' : 'ies'} from ${DENYLIST_FILE}`);
console.log(`PR states refreshed live: ${prStates.size} (0 means gh was unavailable — verdicts fell back to the stale on-disk snapshot)`);
console.log(`Staleness threshold: ${STALE_DAYS}d for hand-started work, ${EPHEMERAL_DAYS}d for scheduled tasks`);
console.log(`Live workspace: ${currentWorkspace || '(undetermined)'} — ${orphanedWorkspaces.size} orphaned workspace(s) alongside it\n`);

const order = { MERGED: 0, STALE: 1, 'PR-OPEN': 2, ACTIVE: 3 };
rows.sort((a, b) => (order[a.c.state] - order[b.c.state]) || (b.c.ageDays - a.c.ageDays));

const pad = (v, n) => String(v == null ? '' : v).slice(0, n).padEnd(n);
console.log(pad('VERDICT', 9) + pad('AGE', 6) + pad('TITLE', 40) + pad('DISPOSITION', 22) + 'PROJECT');
console.log('-'.repeat(112));
for (const r of rows) {
  const disp = r.safe ? 'SAFE' : r.exempt ? 'exempt' : r.thirdParty ? 'third-party' : (r.risk || 'keep');
  console.log(
    pad(r.c.state, 9) +
    pad(Math.floor(r.c.ageDays) + 'd', 6) +
    pad(r.s.title || '(untitled)', 40) +
    pad(disp, 22) +
    path.basename(r.s.originCwd || r.s.cwd || '')
  );
}

const safe = rows.filter((r) => r.safe);
const blocked = rows.filter((r) => !r.safe && (r.c.state === 'MERGED' || r.c.state === 'STALE'));

console.log('\n--- SUMMARY ---');
for (const st of ['MERGED', 'STALE', 'PR-OPEN', 'ACTIVE']) {
  console.log(`${st.padEnd(9)} ${rows.filter((r) => r.c.state === st).length}`);
}
console.log(`\nSAFE TO ARCHIVE: ${safe.length}`);
console.log(`BLOCKED (finished, but worktree is not disposable): ${blocked.length}`);
for (const b of blocked) {
  console.log(`  - ${b.s.title} — ${b.thirdParty ? 'third-party remote' : b.risk}`);
}

if (WRITE_RESUME) {
  const outDir = path.join(process.cwd(), '.claude', 'handoffs');
  fs.mkdirSync(outDir, { recursive: true });
  let n = 0;
  for (const r of safe) {
    const slug = (r.s.title || r.s.sessionId).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    fs.writeFileSync(path.join(outDir, `resume-${slug}.md`), resumeStub(r.s, r.c, r.risk), 'utf8');
    n++;
  }
  console.log(`\nWrote ${n} resume stub${n === 1 ? '' : 's'} to ${outDir}`);
}

if (ARCHIVE_ORPHANED) {
  const { done, skipped } = archiveOrphaned(rows);
  console.log(`\n--- --archive-orphaned ---`);
  console.log(`marked archived in the store: ${done.length}`);
  console.log(`left for archive_session    : ${skipped.filter((x) => /app tracks/.test(x[1])).length}`);
  const other = skipped.filter((x) => !/app tracks/.test(x[1]));
  if (other.length) {
    console.log(`skipped for other reasons  : ${other.length}`);
    for (const [t, why] of other.slice(0, 10)) console.log(`  - ${t}: ${why}`);
  }
  console.log('\nNo git worktree was touched. Records in the live workspace are untouched');
  console.log('and still require archive_session.');
} else {
  console.log('\nNothing was archived. Pass the SAFE list to archive_session to act on it,');
  console.log('or re-run with --archive-orphaned to clear the ones the app no longer tracks.');
}
