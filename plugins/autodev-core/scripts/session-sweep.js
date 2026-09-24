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
 *   node session-sweep.js                     # classify, print table
 *   node session-sweep.js --stale-days 14     # idle days before a session is stale
 *   node session-sweep.js --live-minutes 240  # recent transcript window treated as in use
 *   node session-sweep.js --ephemeral-days 2  # age below which a session counts as ephemeral
 *   node session-sweep.js --done-minutes N    # cold floor for PR-less DONE (default 240)
 *   node session-sweep.js --write-resume      # also write resume stubs for SAFE rows
 *   node session-sweep.js --archive-orphaned  # clear records the app no longer tracks
 *   node session-sweep.js --self              # may the session in THIS cwd settle? (JSON)
 *   node session-sweep.js --json              # machine-readable output
 */

function helpHeader() {
    // Print this file's own header block. A probe asking what this script is
    // must never cause it to DO what this script does: several entry points
    // here reach the network, and one made 21 registry calls from a --help
    // probe before this branch existed. main() calls this FIRST, before any
    // part of the sweep.
    //
    // THIS COMMENT LIVES INSIDE THE FUNCTION ON PURPOSE. The loop below takes
    // every comment line from the top of the file until the first line that is
    // not one, so a comment written ABOVE this function becomes part of what
    // --help prints. That happened once, during the 2026-09-08 exit refactor,
    // and the tail of --help grew four lines of implementation note.
    const lines = require('fs').readFileSync(__filename, 'utf8').split('\n');
    const head = [];
    for (const line of lines.slice(1)) {
        if (line.trim() === "'use strict';") continue;
        if (/^\s*(\/\/|\/\*|\*|$)/.test(line)) head.push(line);
        else break;
    }
    console.log(head.join('\n').trim());
}

const fs = require('fs');
const path = require('path');
const claudePaths = require('./claude-paths.js');
const { execFileSync } = require('child_process');

// SESSION_SWEEP_STORE exists so the suite can drive a synthetic population
// through the REAL code path. The safety check is the whole point of this
// script, and a check nothing has ever seen fail is not a check.
// The app keeps sessions in the per-user application-data directory, and that is
// a DIFFERENT path on each platform. `~/.config` is right on Linux only. On macOS
// it does not exist, so the store read as empty and every downstream count printed
// a zero — including "BLOCKED: 0 (none — every finished own-repo session is
// committed and pushed)", an affirmative all-clear about a directory the process
// never opened. [measured 2026-08-28] 22 records were present at the real path.
function defaultStoreBase() {
  if (process.platform === 'win32' && process.env.APPDATA) return process.env.APPDATA;
  const home = process.env.HOME || '';
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(home, '.config');
}
const STORE = process.env.SESSION_SWEEP_STORE || path.join(
  defaultStoreBase(),
  'Claude',
  'claude-code-sessions'
);

// Repos whose work must never be swept automatically are named in a LOCAL file,
// never in this repo — this one is public. One substring per line, '#' comments.
const DENYLIST_FILE = path.join(claudePaths.configDir(), 'session-sweep-denylist.txt');

// Gitignored paths a build, an install or this harness writes back. Anything
// ignored and NOT on this list exists only in that worktree, and
// archive_session deletes it with the worktree. Matched against the path
// `git status --ignored` prints, which ends in '/' for a directory and may sit
// under a package directory (`site/.next/`). Keep this list narrow: a miss here
// is clutter (a worktree kept a little longer), a false entry is loss.
//
// The harness entries are its own throttle, flag and scratch files, rewritten
// on the next run. `.claude/reports/`, `.claude/archives/`, `.claude/handoffs/`
// and the rest of `.claude/` are deliberately NOT here: a report or a prd
// archive in a worktree is the only copy, and naming it is the point.
// [measured 2026-09-16] over 30 live session records, the unfiltered list
// flagged five, three of them for hundreds of `.claude/COMMIT_MSG_v*.txt`
// scratch files beside the one `.claude/archives/` that was the real finding.
const REGENERABLE = [
  /(^|\/)node_modules\//, /(^|\/)\.next\//, /(^|\/)dist\//, /(^|\/)build\//, /^out\//,
  /(^|\/)coverage\//, /(^|\/)\.turbo\//, /(^|\/)\.vercel\//, /(^|\/)\.cache\//,
  /(^|\/)__pycache__\//, /\.pyc$/, /(^|\/)\.pytest_cache\//, /(^|\/)\.venv\//,
  /(^|\/)target\//, /(^|\/)\.parcel-cache\//, /(^|\/)playwright-report\//,
  /(^|\/)test-results\//, /(^|\/)tsconfig\.tsbuildinfo$/, /(^|\/)next-env\.d\.ts$/,
  /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/,
  /^\.claude\/memory-sessions\//, /^\.claude\/\.claude\//, /^\.claude\/types\//,
  /^\.claude\/knowledge-surfaced$/, /^\.claude\/panel-deny\.json$/,
  /^\.claude\/settings\.local\.json$/, /^\.claude\/pre-compact-state\.json$/,
  /^\.claude\/auto-(active|exit|idle-triggered)$/, /^\.claude\/\.typecheck-pending(\.\d+\.claim)?$/,
  /^\.claude\/memory-session-id$/, /^\.claude\/commit-msg\.txt$/, /^\.claude\/COMMIT_MSG_[^/]*\.txt$/,
];

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);

// --help returns BEFORE any sweep. Without this the flag fell through and the
// script ran its whole scan, which reads every transcript and shells out to git
// per worktree: 6.8s, 10.0s and 6.8s measured over three quiet runs 2026-09-02.
// check-entrypoints.js allows 10s, so this script sat astride the budget and
// went red or green on machine load.
//
// The deeper point, worth keeping: that gate's verdict was never about --help
// for a script like this. It measured whether the DEFAULT action finished in
// time, and scored that identically to handling the flag.
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const STALE_DAYS = parseInt(opt('--stale-days', '14'), 10);
// A worktree whose transcript was written this recently is treated as in use,
// whatever the idle clock says. Generous on purpose: against a 14-day staleness
// threshold, waiting a few hours costs nothing, and the thing on the other side
// of the trade is deleting a worktree with a session running in it.
const LIVE_MINUTES = parseInt(opt('--live-minutes', '240'), 10);
// Scheduled sessions are disposable by construction — the task regenerates them
// tomorrow — so they get a much shorter clock than hand-started work.
const EPHEMERAL_DAYS = parseInt(opt('--ephemeral-days', '2'), 10);
// A settled PR makes a session finished, and that bypasses the idle clock
// entirely — so a session whose PR merged three minutes ago reads as MERGED
// while its author is plainly still working in it. Measured: two sessions
// qualified as MERGED with last activity 3 minutes earlier. Finished is not
// the same as cold; require both.
//
// The floor compensates for a PING, not for a workday, and that is what sets
// the unit. `lastActivityAt` is a liveness ping the app refreshes only while a
// session is actually running, and it FREEZES the moment one stops. Measured
// over 490 records with 9 running: running max 324s, not-running min 865s —
// cleanly separable (the same measurement the `stalled` gate is built on). So a
// record hours stale is not someone typing slowly; it is a session the app is
// no longer running, and the floor only has to outlast a ping interval.
//
// It was 12 HOURS, which conflated "still being typed in" with "finished this
// morning". Measured over 42 live records: four sessions with every PR settled
// and clean pushed worktrees sat unarchivable at 1-9h idle, and NOT ONE record
// in the whole population fell between 4h and 24h — so the extra eleven hours
// bought no discrimination at all, only false ACTIVEs.
//
// 30 minutes is 5.5x the observed running maximum and 2x the not-running
// minimum, so it clears both sides of that split. It is deliberately NOT tuned
// to the gap in today's snapshot: derive it from the ping cadence, or the next
// population shift silently re-opens this bug.
const DEFAULT_MERGED_MIN_MINUTES = 30;
function mergedMinMinutes() {
  // `--merged-min-hours` is the retired spelling. Honour it rather than
  // dropping it: a flag silently ignored would restore the old default's bug
  // with nothing on screen to say so.
  const raw = flag('--merged-min-hours')
    ? parseFloat(opt('--merged-min-hours', '')) * 60
    : parseFloat(opt('--merged-min-minutes', String(DEFAULT_MERGED_MIN_MINUTES)));
  // An unparseable value must not reach the comparison. NaN makes every `<`
  // false, which would disable the floor entirely — failing OPEN, silently.
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MERGED_MIN_MINUTES;
}
const MERGED_MIN_MINUTES = mergedMinMinutes();
const AS_JSON = flag('--json');
const WRITE_RESUME = flag('--write-resume');
// The ONLY mode in which this script mutates anything. Off by default and never
// implied: it marks SAFE records archived by editing the store, for workspaces
// the app no longer tracks. It still never touches a git worktree.
const ARCHIVE_ORPHANED = flag('--archive-orphaned');

// DONE: no PR at all, not scheduled, and cold for this long. The pile it exists
// for is same-day: [measured 2026-09-13] 24 of 35 live records read ACTIVE at 0d,
// because the only clock for PR-less work was STALE_DAYS. The default equals
// LIVE_MINUTES on purpose: a DONE row still has to clear the live-transcript
// guard, so a shorter floor would only produce rows that can never be SAFE.
const DONE_MINUTES = (() => {
  const raw = parseFloat(opt('--done-minutes', String(LIVE_MINUTES)));
  // NaN would make `>=` false for every row and hide DONE silently. Fall back.
  return Number.isFinite(raw) && raw >= 0 ? raw : LIVE_MINUTES;
})();
const SELF = flag('--self');
// Test seam, like SESSION_SWEEP_STORE: a JSON map of "owner/repo" -> PR list in
// `gh pr list --json number,state,headRefName,url` shape. When set, gh is never
// called, so a suite cannot reach the network or read the operator's real PRs.
const PR_FIXTURE = process.env.SESSION_SWEEP_PR_FIXTURE || null;

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

// A store that cannot be read is NOT a store with no sessions in it, and the
// difference decides whether "SAFE TO ARCHIVE: 0" means "nothing to do" or
// "this probe is blind". Returning [] here made every caller print the first
// while meaning the second. Signal it instead and let main refuse.
function storeIsReadable() {
  try { fs.readdirSync(STORE); return true; } catch { return false; }
}

function collectSessions() {
  const out = [];
  if (!storeIsReadable()) return out;
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

// argv form, never a shell. `args` is an ARRAY. The live checked-out branch name
// flows into `ls-remote --heads origin <branch>` below, and a branch name may
// legally contain `;`, `|`, a backtick or `$(…)` — which the old
// `execSync(\`git ${cmd}\`)` handed straight to /bin/sh -c. Each array element
// reaches git as one literal argument, so a metacharacter is data, not syntax.
function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

/**
 * The `prs[].state` stored on disk is a SNAPSHOT from whenever that session last
 * looked, not live state — measured: PR #504 was cached MERGED in one session
 * and OPEN in another on the same day, and `gh` said MERGED. Trusting the cache
 * both strands finished sessions and, worse, can call a reopened PR merged.
 *
 * So refresh it. One `gh pr list` per repo, not one call per PR.
 * Returns { states: Map<"repo#number", STATE>, byHead: Map<repo, Map<head, pr[]>> }.
 * On any failure a repo stays absent and callers fall back to the cached value,
 * which is degraded but not wrong-by-default — an unknown state is never
 * promoted to MERGED.
 *
 * Repos come from each session's worktree remote as well as from its bound PRs.
 * [measured 2026-09-13] 19 of 28 live sessions had NO bound PR, and three of them
 * owned an open PR on their own branch (#254, #10, #253). The app's
 * auto-archive-on-close cannot fire for a PR it never bound, and a sweep that
 * reads only bound PRs could call such a session DONE while its PR is open.
 */
const slugCache = new Map();
function repoSlugOf(s) {
  const dir = [s.worktreePath, s.originCwd, s.cwd].find((d) => d && fs.existsSync(d));
  if (!dir) return null;
  if (slugCache.has(dir)) return slugCache.get(dir);
  // Backslashes first: a remote cloned from a Windows path spells its segments
  // with `\`, and the owner/repo match below reads only `/`.
  const url = (git(dir, ['remote', 'get-url', 'origin']) || '').replace(/\\/g, '/');
  // Each half must start alphanumeric: the slug becomes a gh argument, and a
  // leading dash there is read as a flag (same reasoning as worktreeRisk).
  const m = url.match(/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/);
  const slug = m ? `${m[1]}/${m[2]}` : null;
  slugCache.set(dir, slug);
  return slug;
}

function liveBranch(s) {
  const wt = s.worktreePath && fs.existsSync(s.worktreePath) ? s.worktreePath : null;
  return (wt && git(wt, ['rev-parse', '--abbrev-ref', 'HEAD'])) || s.branch || null;
}

function refreshPrStates(sessions) {
  const states = new Map();
  const byHead = new Map();
  const repos = new Set();
  for (const s of sessions) {
    for (const pr of s.prs || []) if (pr.repo) repos.add(pr.repo);
    const slug = repoSlugOf(s);
    if (slug) repos.add(slug);
  }
  let fixture = null;
  if (PR_FIXTURE) {
    try { fixture = JSON.parse(fs.readFileSync(PR_FIXTURE, 'utf8')); } catch { fixture = {}; }
  }
  for (const repo of repos) {
    let list = null;
    if (fixture) {
      list = Array.isArray(fixture[repo]) ? fixture[repo] : null;
    } else {
      try {
        list = JSON.parse(execFileSync(
          'gh',
          ['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '300', '--json', 'number,state,headRefName,url'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 }
        ));
      } catch {
        // Network/auth failure: leave this repo unrefreshed rather than guessing.
      }
    }
    if (!Array.isArray(list)) continue;
    const heads = new Map();
    for (const pr of list) {
      states.set(`${repo}#${pr.number}`, String(pr.state).toUpperCase());
      if (!pr.headRefName) continue;
      if (!heads.has(pr.headRefName)) heads.set(pr.headRefName, []);
      heads.get(pr.headRefName).push(pr);
    }
    byHead.set(repo, heads);
  }
  return { states, byHead };
}

/**
 * PRs whose head is this session's branch but which the session record does not
 * carry. Trunk names are skipped: a session sitting on `main` did not author
 * every PR that happens to be headed there, and claiming them would hand one
 * session another's open PR. A session with neither a worktree nor a recorded
 * branch is skipped too, because the repo root's branch is not the session's.
 */
const TRUNKS = new Set(['main', 'master', 'trunk', 'develop', 'HEAD']);
//
// `boundElsewhere` maps "repo#number" to the title of another live session that
// binds that PR. [measured 2026-09-13] nvision#10 was reported unbound for the
// session on its branch while "Take the CV editor live" already bound it, and a
// bind request sent on that report would have doubled the binding. The PR still
// counts toward this session's verdict; only the advice changes.
function unboundPrsFor(s, byHead, boundElsewhere = new Map()) {
  if (!s.worktreePath && !s.branch) return [];
  const slug = repoSlugOf(s);
  const branch = liveBranch(s);
  if (!slug || !branch || TRUNKS.has(branch)) return [];
  const found = (byHead.get(slug) && byHead.get(slug).get(branch)) || [];
  const keyOf = (repo, n) => `${String(repo || '').toLowerCase()}#${n}`;
  const bound = new Set((s.prs || []).map((p) => keyOf(p.repo, p.prNumber)));
  return found
    .filter((pr) => !bound.has(keyOf(slug, pr.number)))
    .map((pr) => ({
      prNumber: pr.number, repo: slug, url: pr.url || null, state: String(pr.state).toUpperCase(),
      boundTo: boundElsewhere.get(keyOf(slug, pr.number)) || null,
    }));
}

// Every live binding, keyed "repo#number" -> the binding session's title.
function bindingsOf(sessions) {
  const map = new Map();
  for (const s of sessions) {
    for (const p of s.prs || []) {
      const k = `${String(p.repo || '').toLowerCase()}#${p.prNumber}`;
      if (!map.has(k)) map.set(k, s.title || s.sessionId);
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
  const remote = (git(dir, ['remote', 'get-url', 'origin']) || '').toLowerCase();
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
/**
 * Is another session record pointing at this same worktree?
 *
 * archive_session removes the worktree, so a worktree named by two records is
 * one archive away from being pulled out from under whatever still uses it.
 * This is a CROSS-RECORD property: worktreeRisk() sees one session and cannot
 * see it, which is why `all` has to be threaded in.
 *
 * [measured 2026-08-28] two records, "Census lcd.js" and "Fix dead regex in
 * ask.js", both named .../worktrees/mito-keys, and a third session was working
 * there. Both read as 8.7d idle and would have swept.
 */
// Only a real worktreePath counts. Falling back to cwd here looked harmless and
// was not: every record without a worktree carries the REPO ROOT as its cwd, so
// they all collided and ten unrelated sessions reported shared-worktree(10).
// Sharing a repo root is normal and is not the hazard — archive_session removes
// WORKTREES, and a repo root is not one.
function sessionDir(s) {
  return s.worktreePath || null;
}

function sharedWorktree(s, all) {
  const wt = sessionDir(s);
  if (!wt) return null;
  const others = all.filter((o) =>
    o.sessionId !== s.sessionId && !o.isArchived && sessionDir(o) === wt);
  if (!others.length) return null;
  return `shared-worktree(${others.length + 1} sessions)`;
}

/**
 * Has anything written a transcript for this worktree recently?
 *
 * The independent check on `lastActivityAt`, which is a liveness ping the app
 * refreshes only while IT holds the session and which FREEZES rather than
 * failing otherwise. [measured 2026-08-28] two records read as nine days idle
 * while that worktree's transcript had been written three minutes earlier.
 * Idle-clock staleness therefore cannot be the only thing standing between a
 * live session and `rm -rf` of its worktree.
 *
 * Transcripts live in ~/.claude/projects/<slug>/, where the slug is the cwd with
 * every '/' and '.' replaced by '-'.
 */
function transcriptFreshMinutes(wt) {
  if (!wt) return null;
  const home = claudePaths.configDir();
  // The slug replaces the path separator, the dot, AND on Windows the
  // backslash and the drive colon. [measured 2026-08-29] a Windows path such
  // as `D:\\proj\\repo` was returned UNCHANGED under the old /[/.]/, because
  // such a path contains neither a forward slash nor a dot, so the lookup
  // could never match the real directory `D--proj-repo` that is on disk.
  // This made session-sweep blind to every transcript on a Windows machine.
  // validate's 'Slug reversal' check passes and does not cover this: it
  // tests turning a slug back INTO a path, which is the other direction.
  const dir = path.join(home, 'projects', wt.replace(/[/.:\\\\]/g, '-'));
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { return null; }
  let newest = 0;
  for (const n of names) {
    try { newest = Math.max(newest, fs.statSync(path.join(dir, n)).mtimeMs); } catch { /* skip */ }
  }
  if (!newest) return null;
  return (Date.now() - newest) / 60000;
}

function worktreeRisk(s, all, opts = {}) {
  // Both of these are about OTHER sessions and hold whether or not the worktree
  // still exists on disk, so they come before the existence check below.
  const shared = all ? sharedWorktree(s, all) : null;
  if (shared) return shared;

  // --self skips the transcript guard and nothing else: the fresh transcript it
  // would find is the caller's own, written by the turn asking the question.
  const fresh = opts.self ? null : transcriptFreshMinutes(sessionDir(s));
  if (fresh !== null && fresh < LIVE_MINUTES) {
    return `live-transcript(${Math.round(fresh)}m ago)`;
  }

  const wt = s.worktreePath;
  if (!wt) return null;                  // no worktree, nothing to lose
  if (!fs.existsSync(wt)) return null;   // already cleaned up

  const status = git(wt, ['status', '--porcelain']);
  if (status === null) return 'git-unreadable';
  if (status.length > 0) {
    const n = status.split('\n').filter(Boolean).length;
    return `dirty(${n} file${n === 1 ? '' : 's'})`;
  }

  // Gitignored files go with the worktree too, and `status --porcelain` is
  // silent about them by design. [measured 2026-09-16] a session's `.env.local`
  // held a service key no other checkout had; its PR merged, the app
  // auto-archived the session, and the worktree removal took the only copy.
  // The sweep had nothing to say, because every check above was green.
  //
  // Traditional mode lists a fully ignored directory once (`node_modules/`)
  // rather than every file in it, so this stays cheap on a real worktree. The
  // regenerable list is the one `safe-cleanup` uses for the same question:
  // anything a build or install writes back is clutter, not loss.
  const ignored = git(wt, ['status', '--porcelain', '--ignored=traditional']);
  if (ignored === null) return 'git-unreadable';
  const entries = ignored.split('\n').filter((l) => l.startsWith('!! ')).map((l) => l.slice(3).replace(/^"|"$/g, ''));
  const regenerable = (p) => REGENERABLE.some((re) => re.test(p));
  const localOnly = [];
  for (const entry of entries) {
    if (regenerable(entry)) continue;
    if (!entry.endsWith('/')) { localOnly.push(entry); continue; }
    // A fully ignored directory prints once, so a repo that ignores `.claude/`
    // wholesale shows nothing of what is inside. Open it: one holding only
    // harness state must not block, and one holding a report must name it.
    // Only directories that are not regenerable get opened, so `node_modules/`
    // is never enumerated.
    const inside = git(wt, ['ls-files', '--others', '--ignored', '--exclude-standard', '--', entry]);
    if (inside === null) return 'git-unreadable';
    const files = inside.split('\n').filter(Boolean).map((f) => f.replace(/^"|"$/g, ''));
    if (!files.length) localOnly.push(entry);
    for (const f of files) if (!regenerable(f)) localOnly.push(f);
  }
  if (localOnly.length > 0) {
    const n = localOnly.length;
    const named = localOnly.slice(0, 3).join(', ') + (n > 3 ? ', ...' : '');
    return `local-only(${n} file${n === 1 ? '' : 's'}: ${named})`;
  }

  // Use the LIVE checked-out branch, never the one recorded in session metadata.
  // Measured on two worktrees out of six: the record named one branch while the
  // worktree sat on another entirely (the session had switched branches after
  // the record was written). Checking the recorded name inspects a branch the
  // worktree is not on — which produced false blocks here, and would just as
  // easily clear a branch nobody ever checked.
  const branch = git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']) || s.branch;

  // A ref may legally begin with '-', and that is ARGUMENT injection, not shell
  // injection — execFileSync does not help, because the shell was never the
  // vector. `git branch -- '--upload-pack=x'` is refused, but
  // `git update-ref refs/heads/--upload-pack=x HEAD` succeeds and rev-parse then
  // hands the name straight back. Passed as a bare positional, git's option
  // parser can read it as a FLAG rather than a ref.
  //
  // Measured on git 2.54.0.windows.1, with a bogus flag as the value: `ls-remote
  // --heads origin <flag>` treats it as positional (ls-remote stops parsing
  // options at the repository argument — the same flag placed BEFORE `origin`
  // exits 129 "unknown option"), while `log -1 --format=%ad <flag>` exits 128 on
  // it. So whether a leading dash is dangerous depends on the subcommand and the
  // git version, which is not a property to depend on. Refuse the value instead,
  // and fail CLOSED: a branch name we will not hand to git is a branch we cannot
  // clear for deletion.
  if (branch && branch.startsWith('-')) return 'branch-name-unsafe';

  if (branch && branch !== 'HEAD') {
    // `--` after the repository closes the positional list explicitly. Measured:
    // a normal branch still matches through it.
    const onRemote = git(wt, ['ls-remote', '--heads', 'origin', '--', branch]);
    if (onRemote) {
      const unpushed = git(wt, ['log', '--oneline', `origin/${branch}..HEAD`]);
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
      let base = (git(wt, ['symbolic-ref', 'refs/remotes/origin/HEAD']) || '').replace('refs/remotes/', '');
      if (!base) {
        const slug = (git(wt, ['remote', 'get-url', 'origin']) || '').replace(/^.*[:/]([^/]+\/[^/]+?)(\.git)?$/, '$1');
        // VALIDATE, do not merely extract. `String.replace` returns its input
        // UNCHANGED when the pattern does not match, so a remote URL that is not
        // owner/repo shaped falls through as the whole URL rather than as an
        // empty string. Require the owner/repo shape and skip `gh` otherwise —
        // an unrecognised remote must not become an argument.
        //
        // Each half must START with an alphanumeric. The previous shape allowed
        // a leading dash, so `-a/-b` and `--json/x` passed — and `slug` is a
        // POSITIONAL argument to `gh repo view`, where a leading dash is read as
        // a flag. Owner and repo names cannot begin with a dash on GitHub, so
        // nothing legitimate is lost.
        if (/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
          try {
            const d = execFileSync('gh',
              ['repo', 'view', slug, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'],
              { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }).trim();
            if (d) base = `origin/${d}`;
          } catch { /* fall through to fail-closed below */ }
        }
      }
      if (!base) return 'branch-not-on-remote';             // unknown base: fail closed
      const orphan = git(wt, ['log', '--oneline', `${base}..HEAD`]);
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

function classify(s, prStates, unbound = []) {
  const ageDays = (now - (s.lastActivityAt || s.createdAt || now)) / DAY;
  // Unbound PRs count exactly like bound ones. An open PR the app never bound is
  // still open work, and must keep its session out of DONE.
  const prs = [...(Array.isArray(s.prs) ? s.prs : []), ...unbound];
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

  // Idle time, in the unit the floor is actually expressed in. Reporting this
  // in hours rounded the real case — a PR merged 3 minutes ago — to "0h ago",
  // which reads as a bug in the sweep rather than as the floor doing its job.
  const idleMinutes = ageDays * 24 * 60;

  let state, why;
  if (prs.length && prs.every(settled) && idleMinutes < MERGED_MIN_MINUTES) {
    // Settled but still warm: treat as ACTIVE, not finished.
    state = 'ACTIVE';
    why = `PRs settled but active ${Math.round(idleMinutes)}m ago (< ${MERGED_MIN_MINUTES}m floor)`;
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
  } else if (!prs.length && !ephemeral && idleMinutes >= DONE_MINUTES) {
    // No PR of any state, so a PR with an unknown state can never land here.
    // Cold is the whole claim: a DONE row still needs a clean, pushed worktree
    // and no live transcript before it is SAFE, like every other verdict.
    state = 'DONE';
    why = `no PR, idle ${idleMinutes >= 120 ? Math.round(idleMinutes / 60) + 'h' : Math.round(idleMinutes) + 'm'}`;
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

function main() {
    // --help returns BEFORE any sweep. The scan reads every transcript and
    // shells out to git per worktree — 6.8s, 10.0s and 6.8s measured over three
    // quiet runs 2026-09-02, against check-entrypoints.js's 10s budget — so this
    // has to be the first thing main() does. It was a top-level guard that
    // exited; it is a function now, called here, and nothing between module
    // scope and this line does more than parse flags and read one denylist file.
    //
    // There were TWO --help blocks, with identical predicates 55 lines apart, so
    // the second never ran. It is gone, and the four option lines only it
    // documented are in the header block above — which is what --help prints.
    if (flag('--help') || flag('-h')) { helpHeader(); return 0; }
    // Refuse before any count is printed. Everything downstream reads as a real
    // zero, so an unreadable store must never reach it.
    if (!storeIsReadable()) {
      console.error(`COULD NOT READ the session store — this is NOT a zero.`);
      console.error(`  path: ${STORE}`);
      console.error(`  platform: ${process.platform}`);
      console.error(`  Nothing was scanned, so no verdict below would have meant anything.`);
      console.error(`  Set SESSION_SWEEP_STORE to the correct directory if the app keeps it elsewhere.`);
      return 2;
    }

    const all = collectSessions();
    const live = all.filter((s) => !s.isArchived);
    const { current: currentWorkspace, orphaned: orphanedWorkspaces } = detectWorkspaces(all);

    const { states: prStates, byHead } = refreshPrStates(live);

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

    const FINISHED = new Set(['MERGED', 'STALE', 'DONE']);
    const bindings = bindingsOf(live);
    const rows = live.map((s) => {
      const unbound = unboundPrsFor(s, byHead, bindings);
      const c = classify(s, prStates, unbound);
      const finished = FINISHED.has(c.state);
      const thirdParty = finished ? isThirdParty(s) : false;
      const risk = finished ? worktreeRisk(s, all) : null;
      // The app has its own opt-out. Honour it rather than inventing a second one.
      const exempt = s.autoArchiveExempt === true;
      return {
        s, c, risk, thirdParty, exempt, unbound,
        safe: finished && !thirdParty && !exempt && risk === null,
      };
    });

    /**
     * --self: may the session working in this cwd archive itself right now?
     *
     * The idle clocks do not apply, because the caller is by definition active; the
     * question is only whether archiving would lose anything. Fails CLOSED: no
     * matching record, or more than one, is a blocker rather than a guess, and a PR
     * in any state other than MERGED or CLOSED blocks, including an unknown one.
     * Always exits 0 with JSON; `settle` is the verdict.
     */
    if (SELF) {
      const norm = (p) => {
        let r;
        try { r = fs.realpathSync.native(p); } catch { r = path.resolve(p); }
        return process.platform === 'win32' ? r.toLowerCase() : r;
      };
      const here = norm(process.cwd());
      const mine = rows.filter((r) => [r.s.worktreePath, r.s.cwd].some((d) => d && norm(d) === here));
      const blockers = [];
      let row = null;
      if (mine.length === 0) blockers.push('no-session-for-cwd');
      else if (mine.length > 1) blockers.push(`ambiguous(${mine.length} sessions share this cwd)`);
      else {
        row = mine[0];
        const stateOf = (p) => prStates.get(`${p.repo}#${p.prNumber}`) || String(p.state || p.prState || '').toUpperCase();
        const unsettled = row.c.prs.filter((p) => !['MERGED', 'CLOSED'].includes(stateOf(p)));
        if (unsettled.length) blockers.push(`pr-unsettled(${unsettled.map((p) => '#' + p.prNumber).join(', ')})`);
        if (row.exempt) blockers.push('autoArchiveExempt');
        const risk = worktreeRisk(row.s, all, { self: true });
        if (risk) blockers.push(risk);
      }
      console.log(JSON.stringify({
        sessionId: row ? row.s.sessionId : null,
        title: row ? row.s.title : null,
        settle: blockers.length === 0,
        blockers,
        unboundPrs: row ? row.unbound : [],
      }, null, 2));
      return 0;
    }

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
        unboundPrs: r.unbound,
      })), null, 2));
      return 0;
    }

    // Population first — a bare verdict is indistinguishable from a probe that found
    // nothing, so always print what was scanned.
    console.log(`POPULATION: ${all.length} session records on disk, ${live.length} not yet archived.`);
    console.log(`Store: ${STORE}`);
    console.log(`Denylist: ${DENY.length} entr${DENY.length === 1 ? 'y' : 'ies'} from ${DENYLIST_FILE}`);
    console.log(`PR states refreshed live: ${prStates.size} (0 means gh was unavailable — verdicts fell back to the stale on-disk snapshot)`);
    console.log(`Staleness threshold: ${STALE_DAYS}d for hand-started work, ${EPHEMERAL_DAYS}d for scheduled tasks`);
    console.log(`Live workspace: ${currentWorkspace || '(undetermined)'} — ${orphanedWorkspaces.size} orphaned workspace(s) alongside it\n`);

    const order = { MERGED: 0, DONE: 1, STALE: 2, 'PR-OPEN': 3, ACTIVE: 4 };
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
    const finished = rows.filter((r) => !r.safe && FINISHED.has(r.c.state));

    // Two very different things were sharing one list, and the permanent one drowns
    // the urgent one. `blocked` means WORK EXISTS IN EXACTLY ONE PLACE — act on it.
    // `excluded` means third-party or opted-out: correct, permanent, and identical
    // every run. Five such rows appeared under BLOCKED every time, so a reader
    // learns to skip the section that is the only place a real warning can appear.
    const blocked = finished.filter((r) => !r.thirdParty && !r.exempt);
    const excluded = finished.filter((r) => r.thirdParty || r.exempt);

    console.log('\n--- SUMMARY ---');
    for (const st of ['MERGED', 'DONE', 'STALE', 'PR-OPEN', 'ACTIVE']) {
      console.log(`${st.padEnd(9)} ${rows.filter((r) => r.c.state === st).length}`);
    }

    // A PR the app never bound cannot trigger its auto-archive-on-close. bind_pr
    // binds only the CALLING session, so the fix happens in the owning session;
    // for a PR already settled there is nothing to bind and its row reads MERGED.
    const unboundRows = rows.filter((r) => r.unbound.length);
    console.log(`\nPRs NOT BOUND to the session whose branch they came from: ${unboundRows.length}`);
    for (const r of unboundRows) {
      for (const p of r.unbound) {
        const where = p.boundTo ? `  [already bound to "${p.boundTo}", do not re-bind]` : '';
        console.log(`  - ${r.s.title} — #${p.prNumber} ${p.state}${p.url ? ' ' + p.url : ''}  (${r.s.sessionId})${where}`);
      }
    }
    console.log(`\nSAFE TO ARCHIVE: ${safe.length}`);
    console.log(`BLOCKED — work exists in exactly one place, act on these: ${blocked.length}`);
    for (const b of blocked) {
      console.log(`  - ${b.s.title} — ${b.risk}`);
      if (b.s.worktreePath) console.log(`      ${b.s.worktreePath}`);
    }
    if (!blocked.length) console.log('  (none — every finished own-repo session is committed and pushed)');

    // Counted, never listed. It is the same rows every run; naming them each time is
    // what taught the reader to skip the section above.
    console.log(`\nExcluded by policy (third-party remote or autoArchiveExempt): ${excluded.length}`);
    if (excluded.length) {
      console.log('  Permanent and expected. Re-run with --list-excluded to see them.');
      if (flag('--list-excluded')) {
        for (const e of excluded) {
          console.log(`  - ${e.s.title} — ${e.exempt ? 'autoArchiveExempt' : 'third-party remote'}`);
        }
      }
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
    return 0;
}

// process.exit() TRUNCATES output, and only on some platforms.
//
// node's process.stdout is ASYNCHRONOUS when it is a PIPE on POSIX (Linux and
// macOS alike) and synchronous when it is a pipe on win32; it is synchronous
// for a FILE everywhere. process.exit() terminates without draining a
// pending async write, so a run that prints more than the 64KiB OS pipe buffer
// and then exits delivers exactly 65536 bytes — under exit status 0, because
// the write never failed. A silent wrong answer, not a visible failure. The
// three things that hide it: a file redirect is synchronous so the output looks
// whole, the status is 0 so CI stays green (a Linux pipe is asynchronous too,
// so CI is exposed and cannot see it), and nothing compares byte counts.
//
// Setting process.exitCode instead lets the event loop drain the stream and
// exit on its own with the same status. Nothing here holds the loop open.
// See rendered-layout-gate.js for the case that cost this, and CLAUDE.md under
// conventions that have actually cost something.
process.exitCode = main();
