// Mutation-test the session-sweep suite.
//
// A suite passing proves nothing about whether it CAN fail. This breaks the
// gate in specific ways and asserts (a) the suite goes red, and (b) the
// assertion that fails is the one belonging to that defect — a mutation caught
// by a different assertion proves nothing about the one under test.
//
// Refuses to start on a dirty subject, and restores in a finally.
//
// NOT named test-*.js on purpose: tooling/test-all.js auto-discovers that
// pattern, and this REWRITES its subject in place. It needs the repo to
// itself — never run it alongside the suite, a build, or a git diff you
// intend to read, or you will be reading a mutant.
//
// Run: node tooling/mutate-sessions-gate.js
//      node tooling/mutate-sessions-gate.js --help   print this line and exit 0
//
// --help returns before the dirty check. It used to be ignored, so asking for
// help in a checkout started the sweep, which rewrites session-sweep.js in
// place. check-entrypoints.js found it once its scratch copy became a git
// repository: the probe ran past its 10 s budget there, where before it died on
// the first git call and read as an answer. `[measured 2026-09-25]`

const fs = require('fs');
const { execSync, spawnSync } = require('child_process');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node tooling/mutate-sessions-gate.js   (mutation-tests tooling/test-session-sweep.js; rewrites its subject in place)');
  process.exit(0);
}

const REPO = require('path').resolve(__dirname, '..');
const SUBJECT = `${REPO}/plugins/autodev-core/scripts/session-sweep.js`;
const SUITE = `${REPO}/tooling/test-session-sweep.js`;

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

const dirty = git('status --porcelain -- plugins/autodev-core/scripts/session-sweep.js');
if (dirty) {
  console.error('REFUSING: subject is dirty. Commit it first, or a restore will lose work.\n  ' + dirty);
  process.exit(1);
}

// Exit codes: 0 every mutant was caught by its own assertion. 1 a mutant
// survived or was caught by the wrong assertion, the subject was dirty, or it
// was not restored byte for byte.
// 2 nothing was measured: an anchor matched other than once, or the suite
// gave no verdict under a mutant.
//
// Each mutant replaces one exact fragment, `from`, with `to`. Every `from` is
// counted in the subject BEFORE the subject is touched, and must occur exactly
// once. Zero means the code moved and the mutant would test nothing. Two means
// the suite may exercise the copy that was not broken.
//
// [measured 2026-09-25] the first mutant had matched nothing since 9f3da64
// (2026-08-22), when git() took an argv array and `git(wt, 'status
// --porcelain')` became `git(wt, ['status', '--porcelain'])`. Each run printed
// MUTATION DID NOT APPLY for it and then ran the other six, so the one mutant
// standing for every risk label was a no-op for a month while the rest of the
// report read like coverage. Now a stale anchor stops the run before any
// mutant is written.

const sha256 = (buf) => require('crypto').createHash('sha256').update(buf).digest('hex');
const ORIGINAL_BYTES = fs.readFileSync(SUBJECT);
const ORIGINAL = ORIGINAL_BYTES.toString('utf8');

const MUTANTS = [
  {
    // Placed after the shared-worktree, live-transcript and existence checks,
    // which run first since those guards were added. So it nulls every label
    // the worktree's own git state decides, and those three must still hold.
    name: 'worktreeRisk returns null past the existence check (every worktree on disk looks disposable)',
    from: "  const status = git(wt, ['status', '--porcelain']);",
    to: "  if (true) return null; // MUTANT\n  const status = git(wt, ['status', '--porcelain']);",
    // Every risk-bearing case below the mutation point must fail. If only some
    // do, the others were vacuous.
    mustFail: [
      'dirty: risk label', 'local-only: risk label', 'local-only-report: risk label',
      'unpushed: risk label', 'orphan: risk label', 'not-a-repo: risk label', 'dash-branch: risk label',
    ],
    mustPass: ['shared worktree: labelled shared-worktree', 'fresh transcript: labelled live-transcript'],
  },
  {
    name: 'dirty check removed (uncommitted files stop being noticed)',
    from: '  if (status.length > 0) {',
    to: '  if (false && status.length > 0) { // MUTANT',
    mustFail: ['dirty: risk label'],
    // And the OTHER gates must still hold, or this mutant proves nothing
    // specific — it would just be breaking everything again.
    mustPass: ['unpushed: risk label', 'orphan: risk label'],
  },
  {
    name: 'ephemeral clock ignored (scheduled sessions age like hand-started work)',
    from: '  } else if (ageDays >= (ephemeral ? EPHEMERAL_DAYS : STALE_DAYS)) {',
    to: '  } else if (ageDays >= STALE_DAYS) { // MUTANT',
    mustFail: ['sched-stale: state'],
  },
  {
    name: 'merged floor removed (a PR that merged minutes ago counts as finished)',
    from: '  if (prs.length && prs.every(settled) && idleMinutes < MERGED_MIN_MINUTES) {',
    to: '  if (false) { // MUTANT',
    mustFail: ['merged-warm: state'],
    // The cold half of the pair must survive, or this is just "broke merged".
    mustPass: ['merged-cold: state'],
  },
  {
    // The opposite defect, and the one that actually shipped: the floor exists
    // but is sized in half-days, so finished sessions read ACTIVE for hours.
    // Removing the floor and OVERSIZING it are different bugs and a suite that
    // only catches the first will not notice the second coming back.
    name: 'merged floor oversized back to 12h (finished sessions read ACTIVE for half a day)',
    from: 'const DEFAULT_MERGED_MIN_MINUTES = 30;',
    to: 'const DEFAULT_MERGED_MIN_MINUTES = 720; // MUTANT',
    mustFail: ['merged floor releases a session idle for hours'],
    // The warm case must still be held back and the cold one still released, or
    // this mutant broke the verdict rather than the floor's size.
    mustPass: ['merged-warm: state', 'merged-cold: state'],
  },
  {
    name: 'workspace guard removed (--archive-orphaned writes the LIVE workspace too)',
    from: '    if (!ws || ws === currentWorkspace || !orphanedWorkspaces.has(ws)) {',
    to: '    if (false) { // MUTANT',
    mustFail: ['archive-orphaned: LIVE record NOT archived'],
    // The orphaned half must still be written, or this just broke the feature
    // rather than removing the guard specifically.
    mustPass: ['archive-orphaned: orphaned record IS archived'],
  },
  {
    name: 'fail-open on unreadable git (unknown treated as safe)',
    from: "  if (status === null) return 'git-unreadable';",
    to: '  if (status === null) return null; // MUTANT',
    mustFail: ['not-a-repo: risk label'],
  },
];

// Refuse before writing anything. A count of 1 on every anchor is the only
// state in which each mutant below is known to change the code it names.
const unanchored = MUTANTS
  .map((m) => ({ m, count: ORIGINAL.split(m.from).length - 1 }))
  .filter(({ count }) => count !== 1);
if (unanchored.length) {
  for (const { m, count } of unanchored) {
    console.error(`REFUSING: anchor for "${m.name}" occurs ${count} times in session-sweep.js, not once.\n    ${JSON.stringify(m.from)}`);
  }
  console.error(`\n${unanchored.length} of ${MUTANTS.length} anchors are stale or ambiguous. Nothing was mutated or run. Re-anchor them against the current subject.`);
  process.exit(2);
}

// The suite prints each failed check as `  ✗ <name>` on stderr, followed by
// indented expected/actual lines. Passing checks print nothing by name, so
// the names here are exactly the set of assertions that went red.
function failedNames(out) {
  return new Set([...out.matchAll(/^ {2}✗ (.+)$/gm)].map((x) => x[1]));
}

let slipped = 0;
let unmeasured = 0;
let restored = false;

try {
  for (const m of MUTANTS) {
    fs.writeFileSync(SUBJECT, ORIGINAL.split(m.from).join(m.to), 'utf8');

    const res = spawnSync(process.execPath, [SUITE], { encoding: 'utf8', timeout: 300000 });
    const out = (res.stdout || '') + (res.stderr || '');

    if (res.status === 0) {
      console.log(`✗ ${m.name}\n    SUITE STILL PASSED. The gate can be removed without the suite noticing.`);
      slipped++;
      continue;
    }
    if (res.status !== 1) {
      console.log(`? ${m.name}\n    suite gave no verdict (status ${res.status}, signal ${res.signal}, ${res.error ? res.error.code : 'no spawn error'}). Not a finding either way.`);
      unmeasured++;
      continue;
    }

    const failed = failedNames(out);
    const missed = (m.mustFail || []).filter((a) => !failed.has(a));
    const wronglyFailed = (m.mustPass || []).filter((a) => failed.has(a));
    const seen = `\n    failed (${failed.size}): ${[...failed].join(' | ')}`;

    if (missed.length) {
      console.log(`✗ ${m.name}\n    suite went red, but NOT on: ${missed.join(', ')}${seen}`);
      slipped++;
    } else if (wronglyFailed.length) {
      console.log(`✗ ${m.name}\n    collateral damage, these failed too: ${wronglyFailed.join(', ')}${seen}`);
      slipped++;
    } else {
      console.log(`✓ ${m.name}\n    red on every predicted assertion: ${m.mustFail.join(', ')}${seen}`);
    }
  }
} finally {
  fs.writeFileSync(SUBJECT, ORIGINAL, 'utf8');
  const before = sha256(ORIGINAL_BYTES);
  const after = sha256(fs.readFileSync(SUBJECT));
  const status = git('status --porcelain -- plugins/autodev-core/scripts/session-sweep.js');
  restored = before === after && !status;
  console.log(restored
    ? `\nsubject restored clean (sha256 ${before} before and after)`
    : `\n!! SUBJECT NOT RESTORED: sha256 ${before} before, ${after} after. ${status}`);
}

console.log(slipped
  ? `\n${slipped} of ${MUTANTS.length} mutants slipped through. The suite is weaker than its green suggests.`
  : unmeasured
    ? `\n${unmeasured} of ${MUTANTS.length} mutants produced no verdict. Re-run before reading this as coverage.`
    : `\nAll ${MUTANTS.length} mutants were caught by their own assertion.`);
process.exitCode = slipped || !restored ? 1 : (unmeasured ? 2 : 0);
