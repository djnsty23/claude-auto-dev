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

const fs = require('fs');
const { execSync, spawnSync } = require('child_process');

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

const ORIGINAL = fs.readFileSync(SUBJECT, 'utf8');

const MUTANTS = [
  {
    name: 'worktreeRisk always returns null (every worktree looks disposable)',
    apply: (s) => s.replace(
      "  const status = git(wt, 'status --porcelain');",
      "  if (true) return null; // MUTANT\n  const status = git(wt, 'status --porcelain');"
    ),
    // Every risk-bearing case must fail. If only some do, the others were vacuous.
    mustFail: ['dirty: risk label', 'unpushed: risk label', 'orphan: risk label', 'not-a-repo: risk label'],
  },
  {
    name: 'dirty check removed (uncommitted files stop being noticed)',
    apply: (s) => s.replace(
      '  if (status.length > 0) {',
      '  if (false && status.length > 0) { // MUTANT'
    ),
    mustFail: ['dirty: risk label'],
    // And the OTHER gates must still hold, or this mutant proves nothing
    // specific — it would just be breaking everything again.
    mustPass: ['unpushed: risk label', 'orphan: risk label'],
  },
  {
    name: 'ephemeral clock ignored (scheduled sessions age like hand-started work)',
    apply: (s) => s.replace(
      '  } else if (ageDays >= (ephemeral ? EPHEMERAL_DAYS : STALE_DAYS)) {',
      '  } else if (ageDays >= STALE_DAYS) { // MUTANT'
    ),
    mustFail: ['sched-stale: state'],
  },
  {
    name: 'merged floor removed (a PR that merged minutes ago counts as finished)',
    apply: (s) => s.replace(
      '  if (prs.length && prs.every(settled) && ageDays * 24 < MERGED_MIN_HOURS) {',
      '  if (false) { // MUTANT'
    ),
    mustFail: ['merged-warm: state'],
    // The cold half of the pair must survive, or this is just "broke merged".
    mustPass: ['merged-cold: state'],
  },
  {
    name: 'workspace guard removed (--archive-orphaned writes the LIVE workspace too)',
    apply: (s) => s.replace(
      "    if (!ws || ws === currentWorkspace || !orphanedWorkspaces.has(ws)) {",
      '    if (false) { // MUTANT'
    ),
    mustFail: ['archive-orphaned: LIVE record NOT archived'],
    // The orphaned half must still be written, or this just broke the feature
    // rather than removing the guard specifically.
    mustPass: ['archive-orphaned: orphaned record IS archived'],
  },
  {
    name: 'fail-open on unreadable git (unknown treated as safe)',
    apply: (s) => s.replace(
      "  if (status === null) return 'git-unreadable';",
      '  if (status === null) return null; // MUTANT'
    ),
    mustFail: ['not-a-repo: risk label'],
  },
];

let allGood = true;

try {
  for (const m of MUTANTS) {
    const mutated = m.apply(ORIGINAL);
    if (mutated === ORIGINAL) {
      console.log(`✗ ${m.name}\n    MUTATION DID NOT APPLY — the anchor text is gone, so this mutant tested nothing.`);
      allGood = false;
      continue;
    }
    fs.writeFileSync(SUBJECT, mutated, 'utf8');

    const res = spawnSync(process.execPath, [SUITE], { encoding: 'utf8', timeout: 300000 });
    const out = (res.stdout || '') + (res.stderr || '');

    if (res.status === 0) {
      console.log(`✗ ${m.name}\n    SUITE STILL PASSED. The gate can be removed without the suite noticing.`);
      allGood = false;
      continue;
    }

    const missed = (m.mustFail || []).filter((a) => !out.includes(a));
    const wronglyFailed = (m.mustPass || []).filter((a) => out.includes(a));

    if (missed.length) {
      console.log(`✗ ${m.name}\n    suite went red, but NOT on: ${missed.join(', ')}`);
      allGood = false;
    } else if (wronglyFailed.length) {
      console.log(`✗ ${m.name}\n    collateral damage — these failed too: ${wronglyFailed.join(', ')}`);
      allGood = false;
    } else {
      console.log(`✓ ${m.name}\n    suite failed on exactly: ${m.mustFail.join(', ')}`);
    }
  }
} finally {
  fs.writeFileSync(SUBJECT, ORIGINAL, 'utf8');
  const after = git('status --porcelain -- plugins/autodev-core/scripts/session-sweep.js');
  console.log(after ? `\n!! SUBJECT NOT RESTORED: ${after}` : '\nsubject restored clean');
}

console.log(allGood
  ? `\nAll ${MUTANTS.length} mutants were caught by their own assertion.`
  : `\nSome mutants slipped through — the suite is weaker than its green suggests.`);
process.exit(allGood ? 0 : 1);
