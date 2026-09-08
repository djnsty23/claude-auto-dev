#!/usr/bin/env node
/**
 * overlap.js — find sessions working the same ground.
 *
 * Four signals, deliberately separate because they mean different things:
 *   BRANCH  two sessions on the same git branch — the hardest evidence, they
 *           will physically collide.
 *   FILES   the two worktrees have actually edited the same path. Evidence, not
 *           a prior: it is the only signal that names WHAT the collision is.
 *   REPO    same repo, different branches — may be fine, may be duplicated work.
 *   TOPIC   shared distinctive title tokens — the softest, catches the two
 *           sessions that share no repo at all.
 *
 * WHY FILES EXIST, measured 2026-09-07/08 over 32 live sessions in 64
 * worktrees, 36 of them in one repo.
 *
 * The first three signals score INTENT — what a session is called and where it
 * sits. Scoring intent missed six real collisions in one night, every one of
 * them found later at PR-or-report time, hours after the duplicated work was
 * already done:
 *
 *   two sessions rewriting the same seo snapshot script
 *   two rewriting the same rendered-layout gate
 *   two rewriting the same validate script
 *   two fixing the same flaky test
 *   two editing the same CI workflow comment
 *   two doing the same three-suite fix end to end — a full duplicate
 *
 * Not one of those pairs shares enough title vocabulary to score, and each sat
 * on its own branch. Under the old weights they scored 5, for the shared repo,
 * against a threshold of 20. Six invisible collisions.
 *
 * The file signal fires after the first edit and before the PR, which is the
 * only window where the answer is still cheap. All six pairs above score on it;
 * they are the suite's fixture, not an illustration.
 *
 * A shared PATH is evidence. A shared REPO is a prior, and a weak one now: with
 * 36 worktrees in a single repo, "same repo" is close to meaningless, which is
 * why one shared file (40) clears the threshold alone while a shared repo (5)
 * still cannot.
 *
 * The title signal is KEPT, not replaced. It catches a class the file signal
 * physically cannot see: two sessions about to work the same thing that have
 * not edited anything yet. Deleting it would trade one blind spot for another.
 *
 * Stopwords matter here: without them every pair "overlaps" on words like
 * session, fix, and the repo name, which is a detector that fires on everything
 * and therefore says nothing.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// fleet-status.js is a SIBLING in this plugin, so resolve it as one.
//
// This used to be path.join(process.env.USERPROFILE, 'claude-auto-dev', ...) -
// a hardcoded absolute path to one clone on one machine. Three things followed,
// none of them announced: the INSTALLED plugin invoked the fleet-status in
// ~/claude-auto-dev rather than the one shipped beside it, so a released
// version did not run its own code; any clone silently read a different
// checkout's parser; and on a machine where USERPROFILE is unset, path.join
// throws a TypeError on load rather than reporting anything.
//
// __dirname is right because this is a same-plugin sibling. CLAUDE.md's warning
// about ${CLAUDE_PLUGIN_ROOT} is about CROSS-plugin paths and does not apply.
const FLEET = path.join(__dirname, 'fleet-status.js');

// Generic filler only. Project names used to be listed here too, which put
// private repo names — including a client's — into a PUBLIC repo, and hardcoded
// this machine's project list into a script meant to run anywhere. They are
// derived from the sessions themselves below instead.
const STOP = new Set(
  ('the a an and or for to of in on with from into session sessions claude code fix fixes ' +
    'update updates check checks run runs new all set setup and2 status work works item items ' +
    'untitled')
    .split(/\s+/),
);

// A crash here used to print a stack trace and NOTHING on stdout - no
// population line, no pair count. A session reading stdout saw an empty result,
// which reads as "no overlaps". That is the false zero this repo's own rules
// warn about, in the script the brain skill tells every session to run at boot.
//
// Fail LOUD and SPECIFIC instead: say the check could not run, and exit
// non-zero. An unrecognised state must never fall through to the reassuring
// reading.
let raw;
try {
  raw = execFileSync(process.execPath, [FLEET, '--days', '2', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  console.log('COULD NOT CHECK overlap - fleet-status did not run');
  console.log('  subject: ' + FLEET);
  console.log('  reason:  ' + (e && e.message ? e.message.split('\n')[0] : e));
  console.log('  This is NOT "no overlapping pairs". Nothing was scanned.');
  process.exit(2);
}

let d;
try {
  d = JSON.parse(raw);
} catch (e) {
  console.log('COULD NOT CHECK overlap - fleet-status emitted no parseable JSON');
  console.log('  subject: ' + FLEET);
  console.log('  got ' + raw.length + ' byte(s): ' + JSON.stringify(raw.slice(0, 120)));
  console.log('  This is NOT "no overlapping pairs". Nothing was scanned.');
  process.exit(2);
}
const all = Array.isArray(d) ? d : d.sessions || d.rows || [];

// Only sessions that are actually alive: not archived, and touched in the last day.
const live = all.filter((r) => !r.isArchived && r.idleMinutes < 60 * 24);

function repoOf(r) {
  const m = String(r.originCwd || r.cwd || '').match(/code[\\/]([^\\/]+)/i);
  return m ? m[1] : '(none)';
}
// A repo's own name is not evidence that two sessions overlap — every session in
// that repo carries it. Derived from the live set rather than listed, so it needs
// no maintenance and names no repo in this file.
const PROJECT_WORDS = new Set(
  live.flatMap((r) => repoOf(r).toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean),
);

function tokens(r) {
  return new Set(
    String(r.title || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !STOP.has(w) && !PROJECT_WORDS.has(w)),
  );
}

// ---------------------------------------------------------------------------
// SIGNAL 4: the files each live worktree has actually touched.
// ---------------------------------------------------------------------------

/**
 * Paths that collide BY CONSTRUCTION — shared coordination ledgers, not work.
 *
 * This list is MEASURED, not guessed. Over the 39 live sessions of 2026-09-08,
 * every path was counted by how many same-repo pairs shared it (309 such pairs).
 * The distribution has a clean cliff:
 *
 *     28 pairs  docs/decisions.md          <- ledger
 *     12 pairs  RESUME.md                  <- ledger
 *     10 pairs  DECISIONS.md               <- ledger
 *      6 pairs  PUBLISH-QUEUE.md           <- ledger
 *      6 pairs  CLAUDE.md                  <- REAL, kept
 *      4 pairs  DECISIONS-<date>.md        <- ledger
 *   <= 3 pairs  everything else            <- REAL, kept
 *
 * Above the cliff sit files whose whole purpose is that every session appends
 * to them; two sessions writing different sections of a journal are not
 * colliding. Below it, at three pairs and fewer, sit the genuine collisions
 * this detector exists for — the shared test file, the shared CI workflow, the
 * shared gate script. The cut is between four and three, and it is a cut
 * between KINDS, which is why the rules are patterns rather than the literal
 * filenames measured: DECISIONS-<date>.md is created fresh most days, so a
 * literal list would rot within a week of being written.
 *
 * CLAUDE.md is deliberately NOT excluded even though it is sixth by volume. It
 * is prose people edit and conflict over rather than a journal they append to,
 * and it costs 4 single-file pairs out of 309. Volume alone does not make a
 * ledger; being append-only does.
 *
 * Every exclusion this run actually suppressed is PRINTED below. A silent
 * exclusion is how a detector goes quietly blind, and this list is exactly the
 * kind of thing that rots: the day a new shared journal appears, it will show
 * up in the report as a path inflating scores, rather than as nothing at all.
 */
const LEDGER_RULES = [
  ['RESUME.md', /(^|\/)RESUME\.md$/i],
  ['DECISIONS.md and DECISIONS-*.md', /(^|\/)DECISIONS(-[^/]*)?\.md$/i],
  ['PUBLISH-QUEUE.md', /(^|\/)PUBLISH-QUEUE\.md$/i],
  ['prd.json', /(^|\/)prd\.json$/i],
  ['lockfiles', /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|uv\.lock)$/i],
  ['.claude/reports/*', /(^|\/)\.claude\/reports\//i],
];
const isLedger = (f) => LEDGER_RULES.some(([, re]) => re.test(f));

/**
 * Read one worktree with git, without ever taking a lock in it.
 *
 * --no-optional-locks matters and is not decoration: `git diff` refreshes the
 * index stat cache and takes index.lock to do it. Running that across 39 live
 * worktrees means 39 chances to collide with the session actually working in
 * one. The flag exists for exactly this caller — a reader that must not
 * perturb the tree it is reading.
 *
 * Returns a status, never a bare empty set:
 *   ok        every question answered
 *   partial   some answered. Files found are still USED — a partial read can
 *             only add detections, never remove them — but it is reported
 *             separately so nobody reads it as a clean zero.
 *   failed    nothing readable. NOT a zero. With 64 worktrees some are always
 *             mid-rebase, detached, or pruned out from under the session record.
 */
function readWorktree(cwd) {
  const rec = {
    status: 'ok', reason: null, repoKey: null, trunk: null,
    commits: new Map(),   // sha -> files that commit touched
    dirty: new Set(),     // uncommitted + untracked: always this session's own
  };
  const git = (args) => {
    try {
      return execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], {
        encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch (e) {
      return null;
    }
  };
  const fail = (why) => { rec.status = 'failed'; rec.reason = why; return rec; };
  const degrade = (why) => { rec.status = 'partial'; rec.reason = rec.reason ? rec.reason + '; ' + why : why; };

  if (!cwd) return fail('no cwd recorded for this session');
  if (!fs.existsSync(cwd)) return fail('worktree path no longer exists');
  const top = git(['rev-parse', '--show-toplevel']);
  if (!top) return fail('not a readable git worktree');

  // Repo identity is the ORIGIN URL, not the directory name. Two worktrees of
  // one clone must agree, and — more importantly — scripts/build.mjs in two
  // DIFFERENT repos is not a shared file. Falling back to the shared git dir
  // keeps a remote-less repo comparable with its own worktrees only.
  const origin = git(['remote', 'get-url', 'origin']);
  rec.repoKey = origin
    ? origin.replace(/\.git$/, '').replace(/^.*[:/]([^:/]+\/[^:/]+)$/, '$1').toLowerCase()
    : (git(['rev-parse', '--path-format=absolute', '--git-common-dir']) || top);

  // Committed work, kept PER COMMIT rather than as a flat file list.
  //
  // The flat list was wrong, and wrong in the most expensive direction: it made
  // a REVIEWER look like a colliding author. Measured 2026-09-08 — a session
  // assigned to review a PR had that PR's branch checked out, so both worktrees
  // sat at the same tip with the same 19 files and no local edits. The pair
  // scored top of the report. It was one session READING another's work, which
  // is the behaviour the fleet wants, and a detector whose loudest rows are all
  // correct behaviour is one that gets ignored. That is not hypothetical here:
  // nine review assignments went out the same night, each of which would have
  // produced one of these.
  //
  // So a file counts as this session's OWN work only if a commit that is NOT in
  // the other session's history touched it. Shared commits are shared history,
  // not convergence. Keeping the sha->files map makes that a set difference at
  // pair time and costs the same one git call the flat diff cost.
  //
  // Chosen over the two cheaper discriminators because both are wrong at an
  // edge that matters:
  //   equal tips     suppresses a REAL collision where two sessions sit at one
  //                  tip and both have the same file dirty. Uncommitted work is
  //                  exactly what this signal exists to catch early.
  //   detached HEAD  reads detachment as "reviewing". A session can and does
  //                  author on a detached HEAD, and this would go blind to it.
  // Commit attribution subsumes the useful half of both and assumes neither. It
  // also handles the ANCESTOR case the tip check misses: a reviewer sitting on
  // an older commit of the same branch has no commit of their own either.
  let base = null;
  for (const ref of ['origin/main', 'origin/master', 'origin/HEAD', 'main', 'master']) {
    base = git(['merge-base', 'HEAD', ref]);
    if (base) { rec.trunk = ref + ' @ ' + base.slice(0, 7); break; }
  }
  if (base) {
    // %x00 prefixes each commit block with a NUL, so a sha line can never be
    // confused with a path. A bare %H would need the reader to guess whether a
    // 40-hex line is a commit or a file named like one.
    const log = git(['log', '--name-only', '--pretty=format:%x00%H', base + '..HEAD']);
    if (log === null) degrade('commit log failed');
    else {
      for (const chunk of log.split('\u0000')) {
        const lines = chunk.split('\n').filter(Boolean);
        if (!lines.length) continue;
        rec.commits.set(lines[0], lines.slice(1));
      }
    }
  } else {
    degrade('no merge base against any known trunk');
  }

  // Uncommitted work is ALWAYS this session's own: nobody else's history can
  // account for an edit that is not in any commit. `diff HEAD` rather than a
  // bare `diff` so STAGED work counts — a session that has staged its edit is
  // exactly as much of a collision as one that has not.
  const dirty = git(['diff', '--name-only', 'HEAD']);
  if (dirty === null) degrade('working-tree diff failed');
  else dirty.split('\n').filter(Boolean).forEach((f) => rec.dirty.add(f));

  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  if (untracked === null) degrade('untracked listing failed');
  else untracked.split('\n').filter(Boolean).forEach((f) => rec.dirty.add(f));

  return rec;
}

/**
 * The files `mine` can be held responsible for, given what `theirs` also holds.
 *
 * Uncommitted work always counts. Committed work counts only when the commit
 * that touched it is absent from the other session's history — otherwise the
 * two are looking at one piece of work, not doing it twice.
 */
function ownFiles(mine, theirs) {
  const out = new Set(mine.dirty);
  for (const [sha, files] of mine.commits) {
    if (theirs.commits.has(sha)) continue;
    for (const f of files) out.add(f);
  }
  return out;
}

const touched = new Map();
const suppressed = new Map();
for (const r of live) {
  const rec = readWorktree(r.cwd);
  const seen = new Set();
  const drop = (f) => {
    if (!isLedger(f)) return false;
    if (!seen.has(f)) { seen.add(f); suppressed.set(f, (suppressed.get(f) || 0) + 1); }
    return true;
  };
  for (const f of [...rec.dirty]) if (drop(f)) rec.dirty.delete(f);
  for (const [sha, files] of rec.commits) rec.commits.set(sha, files.filter((f) => !drop(f)));
  touched.set(r, rec);
}
// Pairs dropped because one worktree simply HOLDS the other's commits — a review
// checkout, or a branch taken from another. Counted so the suppression is
// visible: this class is common by design and going silently blind to how often
// it fires is how the threshold underneath it stops being understood.
let sharedHistoryPairs = 0;

const readOk = [...touched.values()].filter((t) => t.status === 'ok').length;
const readPartial = [...touched.values()].filter((t) => t.status === 'partial').length;
const readFailed = [...touched.values()].filter((t) => t.status === 'failed').length;

const pairs = [];
for (let i = 0; i < live.length; i++) {
  for (let j = i + 1; j < live.length; j++) {
    const a = live[i];
    const b = live[j];
    const reasons = [];
    let score = 0;

    if (a.gitBranch && b.gitBranch && a.gitBranch === b.gitBranch && a.gitBranch !== 'HEAD') {
      reasons.push(`SAME BRANCH ${a.gitBranch}`);
      score += 100;
    }
    // FILES, scored above everything but a shared branch. A shared path is
    // evidence of the collision; the reasons NAME the paths, because which file
    // it is is the actionable half — a reader who knows only "these two overlap"
    // still has to go and find out what to do about it.
    //
    // Only within one repo: the same relative path in two different repos is two
    // different files, and pairing them would fire on every project that has a
    // README.
    //
    // 40 for the first shared path, +20 for each after, capped at 100 so the
    // file signal can equal but never outrank a proven same-branch collision.
    // One shared file scores 40 against a threshold of 20, so it fires ALONE —
    // deliberately, because with 36 worktrees in a single repo the shared-repo
    // prior underneath it has stopped carrying information.
    const fa = touched.get(a);
    const fb = touched.get(b);
    if (fa && fb && fa.repoKey && fa.repoKey === fb.repoKey) {
      const mine = ownFiles(fa, fb);
      const yours = ownFiles(fb, fa);
      const sharedFiles = [...mine].filter((f) => yours.has(f)).sort();
      // Did they share paths that ONLY common history accounts for? That is the
      // reviewer case, and it is reported as a count rather than as a pair.
      if (!sharedFiles.length) {
        const everyA = new Set([...fa.dirty, ...[].concat(...[...fa.commits.values()])]);
        const everyB = new Set([...fb.dirty, ...[].concat(...[...fb.commits.values()])]);
        if ([...everyA].some((f) => everyB.has(f))) sharedHistoryPairs++;
      }
      if (sharedFiles.length) {
        const shown = sharedFiles.slice(0, 6).join(', ');
        const more = sharedFiles.length > 6 ? ` (+${sharedFiles.length - 6} more)` : '';
        reasons.push(`SAME FILES (${sharedFiles.length}): ${shown}${more}`);
        score += Math.min(100, 40 + 20 * (sharedFiles.length - 1));
      }
    }

    const ra = repoOf(a);
    const rb = repoOf(b);
    if (ra === rb && ra !== '(none)') {
      reasons.push(`same repo ${ra}`);
      score += 5;
    }
    const ta = tokens(a);
    const tb = tokens(b);
    const shared = [...ta].filter((w) => tb.has(w));
    if (shared.length) {
      reasons.push(`topic: ${shared.join(', ')}`);
      score += 20 * shared.length;
    }
    if (score >= 20) pairs.push({ score, a, b, reasons });
  }
}

pairs.sort((x, y) => y.score - x.score);

console.log(`population: ${all.length} scanned, ${live.length} live (unarchived, active <24h)`);
// The worktree ledger is a SEPARATE count from the session one, because a
// worktree that could not be read is not a worktree with no overlaps. Reporting
// them together is how "nothing found" comes to mean two different things.
console.log(
  `worktrees: ${readOk} read, ${readPartial} partially read, ${readFailed} COULD NOT CHECK`,
);
for (const [r, t] of touched) {
  if (t.status === 'ok') continue;
  const label = t.status === 'failed' ? 'COULD NOT CHECK' : 'partial';
  console.log(`  ${label}: ${r.title || r.sessionId} - ${t.reason}`);
}
if (readFailed) {
  console.log(
    `  ${readFailed} worktree(s) contributed NO file evidence. That is not a finding of "no overlap".`,
  );
}
// Printed every run, whether or not anything was suppressed: a reader has to be
// able to tell "nothing was excluded" from "the exclusion list was skipped".
console.log(
  `shared-history pairs not reported: ${sharedHistoryPairs} `
  + '(one worktree holds the other\'s commits — a review checkout, not two authors)',
);
console.log(`file-signal exclusions (paths that collide by construction): ${LEDGER_RULES.map(([n]) => n).join(', ')}`);
if (suppressed.size) {
  const rows = [...suppressed].sort((x, y) => y[1] - x[1]);
  console.log(`  suppressed this run: ${rows.map(([f, n]) => `${f} (${n} worktree(s))`).join(', ')}`);
} else {
  console.log('  suppressed this run: none');
}
console.log(`${pairs.length} overlapping pair(s) at score >= 20\n`);
for (const p of pairs) {
  console.log(`[${String(p.score).padStart(3)}] ${p.a.title}`);
  console.log(`      ${p.b.title}`);
  console.log(`      ${p.reasons.join(' | ')}`);
  console.log(`      ${p.a.addressableId || p.a.sessionId}  /  ${p.b.addressableId || p.b.sessionId}`);
  console.log(`      states: ${p.a.state}/${p.b.state}\n`);
}

const blocked = live.filter((r) => r.state === 'blocked');
console.log(`awaiting input right now: ${blocked.length}`);
for (const r of blocked) console.log(`  - ${r.title}  [${r.state}, ${r.idleMinutes}m idle]`);
