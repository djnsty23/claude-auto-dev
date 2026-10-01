#!/usr/bin/env node
// Test runner for claude-auto-dev. Pure Node, zero dependencies.
// Discovers every tooling/test-*.js suite (excluding itself and the optional
// pool module), runs each in its own child process, then runs validate.js as a
// final consistency gate. Prints a concise `SUITE pass/fail` summary.
//
// EXIT: 1 when any suite, validate or the tree check FAILED; 2 when nothing
// failed but something produced no verdict (INDETERMINATE); 0 otherwise. Set
// through process.exitCode, never process.exit(), so a large report piped to a
// slow reader is never cut short (see the end of this file).
//
// COVERAGE IS COLLECTED IN THIS PASS. Each suite runs with its own
// NODE_V8_COVERAGE directory; when it ends its dumps are reduced to the plugin
// sources the census reads, and when the whole run has settled a receipt is
// published (tooling/coverage-receipt.js). `npm run check:coverage` grades that
// receipt instead of running every suite a second time. --no-receipt turns
// collection off and leaves an inherited NODE_V8_COVERAGE alone, which is how
// find-untested-functions.js --fresh measures from scratch.
//
// node:sqlite is built in on Node 22+ and loads without a flag on this project's
// runtime, so no extra flags are passed to children. If a future Node build
// required `--experimental-sqlite`, add it to CHILD_FLAGS below.
// Run: node tooling/test-all.js [--serial] [--no-receipt]   (or: npm test)

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSuite } = require('./suite-tmp.js');
const receipts = require('./coverage-receipt.js');

const scriptsDir = __dirname;
const repoRoot = path.resolve(scriptsDir, '..');

// Extra flags to pass to each child node process (none needed on Node 22+).
const CHILD_FLAGS = [];

// A SUITE NEVER INHERITS THE OPERATOR'S PROFILE. claude-paths.configDir() reads
// CLAUDE_CONFIG_DIR before HOME, so a suite that fakes HOME and spreads
// process.env into its child still points that child at the REAL config dir
// when the shell running the gate has one set (a second Claude profile does).
// [measured 2026-09-23] with it set, test-brain-panels and test-fleet-notify go
// red, and test-brain-panels writes a marker into the operator's config dir. A
// suite that needs a config dir sets its own. check-suites-can-fail.js and
// find-untested-functions.js strip the same name from the children they spawn.
const LEAKY_ENV = ['CLAUDE_CONFIG_DIR'];
const suiteEnv = () => {
  const env = { ...process.env };
  for (const k of LEAKY_ENV) delete env[k];
  return env;
};

const argv = process.argv.slice(2);
const USAGE = 'usage: node tooling/test-all.js [--serial] [--no-receipt]\n'
  + 'Runs every tooling/test-*.js suite, then validate.js, and checks the run left the tree alone.\n'
  + '--serial      ignore tooling/test-all-pool.js and run one suite at a time\n'
  + '--no-receipt  collect no coverage and publish no receipt (an inherited NODE_V8_COVERAGE is kept)\n'
  + 'Exit 0 all passed, 1 anything failed, 2 nothing failed but something gave no verdict.';

// A mutation sweep (find-vacuous-assertions.js) OVERWRITES its subject in place,
// restoring between mutants. So a suite run that overlaps a sweep reads a file
// that does not exist on disk by the time the result is printed. On 2026-08-17
// this produced a clean 25/25 measured against a half-mutated check-superseded.js
// — a pass that was not about any real version of the code.
//
// The sweep already writes `<subject>.vacuity-backup` before its first mutation
// and removes it on clean exit, so that file is exactly the in-flight marker; no
// new mechanism is needed. Its presence means either a sweep is running now, or
// one died and left the subject mutated. Both make a pass here meaningless.
//
// This guard is safe because the sweep invokes `node <suite>` directly and never
// routes through this runner — verified at find-vacuous-assertions.js:224.
function sweepInFlight() {
  const stale = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.vacuity-backup'));
  if (!stale.length) return false;
  console.error('\nRefusing to run: a mutation sweep is in flight or died mid-run.\n');
  console.error('Found: ' + stale.join(', '));
  console.error('\nThe sweep rewrites its subject in place, so any result printed now would');
  console.error('describe a mutant rather than the committed code. Wait for the sweep to');
  console.error('finish, or recover the subject by re-running `npm run check:vacuity`');
  console.error('(it restores from the backup first), then re-run the tests.\n');
  return true;
}

// A SUITE MUST NOT REWRITE THE TREE IT GRADES.
//
// This repo already has the scar. find-vacuous-assertions.js overwrites its
// subject with mutants; a killed run left one in place, a later `git add -A`
// swept it into a commit, and an `if (!installed.plugins[...])` shipped to a
// PUBLIC repo as `if (true)`. Nothing caught it — validate passed and the
// pre-push hook passed, because a mutation that survives its suite is by
// definition one the suite cannot see.
//
// So this records the working tree before the suites and compares after. It is
// deliberately a comparison and not a cleanliness check — the tree is often
// legitimately dirty while working, and the property that matters is that
// running the gate CHANGED NOTHING, not that everything was committed first.
//
// HEAD is captured alongside the status, and the two halves mean different
// things. [measured 2026-09-03] a status-only snapshot reports GREEN when
// someone COMMITS during a run: the tree is clean before and clean after, so the
// two strings match while the run graded one version of a file at the start and
// a different one at the end.
//
// TWO VERDICTS, NOT ONE. With HEAD stable, a status change can only be
// something this run did, so it is a FAIL: a suite rewrote what it grades.
// With HEAD moved, someone else committed (several sessions share a clone),
// and the run graded a mixture of two trees. That is not evidence about any
// suite, so it is INDETERMINATE with the evidence printed, and a suite that
// failed on its own in the same run stays FAILED: a commit elsewhere cannot
// excuse it.
function treeVerdict(before, after) {
  if (!before) return { state: 'pass', evidence: { git: 'not a git repo; the check was skipped' } };
  if (!after) return { state: 'indet', evidence: { git: 'git could not be read after the run' } };
  const was = new Set(before.status);
  const added = after.status.filter((l) => !was.has(l));
  const gone = before.status.filter((l) => !after.status.includes(l));
  const evidence = {
    headBefore: before.head, headAfter: after.head,
    treeBefore: before.tree, treeAfter: after.tree,
    statusAdded: added.slice(0, 15), statusGone: gone.slice(0, 15),
  };
  if (after.head !== before.head) return { state: 'indet', why: 'head-moved', evidence };
  if (added.length || gone.length || after.statusHash !== before.statusHash) return { state: 'fail', why: 'tree-modified', evidence };
  return { state: 'pass', evidence };
}

function printTreeVerdict(v) {
  if (v.state === 'pass') return;
  const e = v.evidence;
  console.error('\n=== tree-inert ===');
  if (v.why === 'head-moved') {
    console.error('HEAD MOVED DURING THE RUN. This run graded a mixture of two trees: INDETERMINATE.');
    console.error('  was:  HEAD ' + e.headBefore);
    console.error('  now:  HEAD ' + e.headAfter);
    console.error('A commit landed mid-run, so a status-only check reports GREEN. Re-run on a');
    console.error('settled tree before believing it. Suites that failed on their own stay FAILED.');
  } else if (v.why === 'tree-modified') {
    console.error('THE TEST RUN MODIFIED THE WORKING TREE. A suite rewrote what it grades.');
    for (const l of e.statusAdded) console.error('  now:  ' + l);
    for (const l of e.statusGone) console.error('  was:  ' + l);
    console.error('No exit code can see this: only looking at the tree afterwards can.');
  } else {
    console.error('The tree could not be compared: ' + (e.git || 'unknown'));
  }
  console.error('evidence: ' + JSON.stringify(e));
}

// THREE OUTCOMES, NOT TWO. A suite that never ran, was killed, or exited 2
// produced NO VERDICT. Exit 2 is this repo's refusal/indeterminate convention.
// [measured 2026-09-07] this aggregator once collapsed 2 into 1 and printed a
// bare FAIL for a run whose own stderr said `infrastructure: the checker did not
// produce a verdict (ETIMEDOUT)`: somebody else's load handed over as a red
// suite. A run that graded nothing is still not a run that passed.
function classify(res) {
  if (res.error) return { state: 'indet', reason: `DID NOT RUN: ${res.error.code || res.error.message}` };
  if (res.signal) return { state: 'indet', reason: `terminated by signal ${res.signal} before completing` };
  if (res.status === 2) return { state: 'indet', reason: 'exited 2, a refusal or indeterminate result, not a verdict' };
  if (res.status === 0) return { state: 'pass', reason: null };
  return { state: 'fail', reason: `exited ${res.status}` };
}

// One suite, start to finish. THE INTERFACE A POOL USES: async, and it resolves
// only after the child has closed, its temp root is gone, its log is closed and
// its coverage is reduced. Coverage, logs and the result record stay owned by
// this runner; a pool decides only WHEN each runOne starts.
//
//   item  { label, args }      args are node's argv after the executable
//   opt   { echo }             echo:false keeps output out of this stdout
//                              (the log still gets it), for a pool that
//                              prints each suite's log whole when it ends
//   =>    { label, state, reason, status, signal, error, ms, log, dump,
//           tmpRemoved, stdioHeld }
function makeRunOne(run) {
  return async function runOne(item, opt) {
    const echo = !opt || opt.echo !== false;
    const env = suiteEnv();
    let logFd = null;
    let logRel = null;
    if (run) {
      env.NODE_V8_COVERAGE = path.join(run.runDir, 'raw', item.label);
      logRel = path.join('logs', item.label + '.log');
      logFd = fs.openSync(path.join(run.runDir, logRel), 'w');
    }
    const tee = (stream) => (chunk) => {
      if (echo) stream.write(chunk);
      if (logFd !== null) fs.writeSync(logFd, chunk);
    };
    const t0 = Date.now();
    const res = await spawnSuite(process.execPath, item.args, {
      cwd: repoRoot,
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
    }, { label: item.label, onStdout: tee(process.stdout), onStderr: tee(process.stderr) });
    const ms = Date.now() - t0;
    if (logFd !== null) fs.closeSync(logFd);
    const c = classify(res);
    if (c.state !== 'pass' && c.reason && c.state === 'indet') console.error(`\n[${item.label}] ${c.reason}`);
    let dump = null;
    if (run) {
      try { dump = receipts.reduceSuite(run, item.label); } catch (e) { dump = { label: item.label, error: e.message, rawDumps: 0 }; }
    }
    return {
      label: item.label, state: c.state, reason: c.reason,
      status: res.status, signal: res.signal || null, error: res.error ? (res.error.code || res.error.message) : null,
      ms, log: logRel ? logRel.split(path.sep).join('/') : null, dump,
      tmpRemoved: res.tmpRemoved, stdioHeld: res.stdioHeld,
    };
  };
}

// THE OPTIONAL POOL. tooling/test-all-pool.js, when present and --serial is
// not given, decides the order and overlap of runOne calls. Absent, the run is
// serial. Present but broken (it throws on load, lacks runSuites, rejects, or
// returns a result set that is not exactly one per suite) is a FAIL of its own,
// printed by name, and the suites it did not deliver run serially after it, so
// a broken pool is never silently a smaller run.
function loadPool() {
  const p = path.join(scriptsDir, receipts.POOL_FILE);
  if (argv.includes('--serial') || !fs.existsSync(p)) return { pool: null };
  try {
    const pool = require(p);
    if (!pool || typeof pool.runSuites !== 'function') return { error: 'it does not export runSuites(items, runOne)' };
    return { pool };
  } catch (e) {
    return { error: 'it threw on load: ' + (e && e.message) };
  }
}

async function runSerial(items, runOne) {
  const out = [];
  for (const item of items) {
    console.log(`\n=== ${item.label} ===`);
    out.push(await runOne(item));
  }
  return out;
}

async function main() {
  if (argv.includes('--help')) { console.log(USAGE); return 0; }
  const unknown = argv.filter((a) => !['--serial', '--no-receipt'].includes(a));
  if (unknown.length) { console.error('unknown argument(s): ' + unknown.join(' ') + '\n' + USAGE); return 2; }

  const suites = receipts.discoverSuites(scriptsDir);
  if (suites.length === 0) {
    console.error('No test suites found in ' + scriptsDir + ' (0 files matched tooling/test-*.js)');
    return 1;
  }
  if (sweepInFlight()) return 2;

  const items = suites.map((f) => ({ label: f.replace(/\.js$/, ''), args: [...CHILD_FLAGS, path.join(scriptsDir, f)] }));
  const expected = items.map((i) => i.label).concat('validate');

  const treeBefore = receipts.treeIdentity(repoRoot);
  let run = null;
  if (!argv.includes('--no-receipt')) {
    try {
      run = receipts.beginRun(repoRoot);
    } catch (e) {
      // No receipt this run, said out loud; the suites still run and grade.
      console.error(`[coverage] no receipt this run: ${e.message}. check:coverage will refuse until a run publishes one.`);
    }
  }
  const runOne = makeRunOne(run);

  const results = [];
  const { pool, error: poolError } = loadPool();
  let pending = items;
  if (poolError) {
    console.error(`\n[test-all-pool] FAILED: tooling/${receipts.POOL_FILE} is present and ${poolError}. Running serially.`);
    results.push({ label: 'test-all-pool', state: 'fail', reason: poolError });
  } else if (pool) {
    let got = [];
    try {
      got = await pool.runSuites(items.slice(), runOne);
    } catch (e) {
      const why = 'runSuites rejected: ' + (e && e.message);
      console.error(`\n[test-all-pool] FAILED: ${why}`);
      results.push({ label: 'test-all-pool', state: 'fail', reason: why });
      got = [];
    }
    const byLabel = new Map();
    const strays = [];
    for (const r of Array.isArray(got) ? got : []) {
      if (!r || !items.some((i) => i.label === r.label) || byLabel.has(r.label)) strays.push(r && r.label);
      else byLabel.set(r.label, r);
    }
    if (!Array.isArray(got) || strays.length) {
      const why = !Array.isArray(got) ? 'runSuites did not resolve to an array' : `runSuites returned unknown or duplicate result(s): ${strays.join(', ')}`;
      console.error(`\n[test-all-pool] FAILED: ${why}`);
      results.push({ label: 'test-all-pool', state: 'fail', reason: why });
    }
    for (const i of items) if (byLabel.has(i.label)) results.push(byLabel.get(i.label));
    pending = items.filter((i) => !byLabel.has(i.label));
    if (pending.length && results.some((r) => r.label === 'test-all-pool')) {
      console.error(`[test-all-pool] running the ${pending.length} suite(s) it did not deliver serially`);
    } else if (pending.length) {
      const why = `runSuites delivered no result for ${pending.length} suite(s): ${pending.slice(0, 5).map((p) => p.label).join(', ')}`;
      console.error(`\n[test-all-pool] FAILED: ${why}. Running them serially.`);
      results.push({ label: 'test-all-pool', state: 'fail', reason: why });
    }
  }
  results.push(...(await runSerial(pending, runOne)));

  // Final gate: the consistency validator.
  console.log('\n=== validate ===');
  results.push(await runOne({ label: 'validate', args: [...CHILD_FLAGS, path.join(scriptsDir, 'validate.js')] }));

  // Did running the gate change the tree it was grading?
  const treeAfter = receipts.treeIdentity(repoRoot);
  const tv = treeVerdict(treeBefore, treeAfter);
  printTreeVerdict(tv);
  const treeRow = { label: 'tree-inert', state: tv.state, reason: tv.why || null, evidence: tv.evidence };

  // --- Summary ---
  const rows = results.concat(treeBefore ? [treeRow] : []);
  console.log('\n──────── summary ────────');
  let failed = 0;
  let indeterminate = 0;
  const indetLabels = [];
  for (const r of rows) {
    console.log(`${r.state === 'pass' ? 'PASS ' : r.state === 'fail' ? 'FAIL ' : 'INDET'}  ${r.label}`);
    if (r.state === 'fail') failed++;
    else if (r.state === 'indet') { indeterminate++; indetLabels.push(r.label); }
  }
  console.log(
    `\n${rows.length - failed - indeterminate}/${rows.length} suites passed` +
      (failed ? `, ${failed} FAILED` : '') +
      (indeterminate ? `, ${indeterminate} INDETERMINATE` : '')
  );
  if (indeterminate) {
    console.log(
      '\nINDETERMINATE means no verdict: a suite did not run, was killed or refused (exit 2),\n' +
      'or HEAD moved under the run. Its own output above names the cause. These are NOT\n' +
      'evidence that anything is broken in the code under test, and on a loaded machine\n' +
      'they are usually starvation rather than a regression. Re-run them alone on a quiet\n' +
      'machine before attributing them to a change:\n' +
      indetLabels.filter((l) => l !== 'tree-inert').map((l) => '  node tooling/' + l + '.js').join('\n')
    );
  }
  const verdict = failed ? 'fail' : indeterminate ? 'indet' : 'pass';

  // The receipt is published after everything has settled, whatever the
  // verdict: a red receipt is a true record, and check:coverage refuses it.
  if (run) {
    try {
      const sourcesEnd = receipts.sourceHashes(repoRoot);
      const executed = results.filter((r) => expected.includes(r.label)).map((r) => r.label);
      const published = receipts.publish(run, {
        tree: { before: treeBefore && strip(treeBefore), after: treeAfter && strip(treeAfter) },
        sources: { start: run.sourcesStart.digest, end: sourcesEnd.digest, count: sourcesEnd.count, files: sourcesEnd.files },
        expectedSuites: expected,
        executedSuites: executed,
        outcomes: results.map((r) => ({ label: r.label, state: r.state, reason: r.reason || null, status: r.status === undefined ? null : r.status, signal: r.signal || null, ms: r.ms === undefined ? null : r.ms, log: r.log || null })),
        treeInert: treeBefore ? { state: tv.state, why: tv.why || null, evidence: tv.evidence } : null,
        verdict,
        dumps: results.filter((r) => r.dump).map((r) => r.dump),
      });
      console.log(`\n[coverage] receipt ${published.runId} published (${verdict}): ${run.receiptPath}`);
    } catch (e) {
      console.error(`\n[coverage] the receipt was NOT published: ${e.message}. check:coverage will refuse.`);
    }
  }

  return failed ? 1 : indeterminate ? 2 : 0;
}

const strip = (t) => ({ head: t.head, tree: t.tree, statusHash: t.statusHash });

// process.exitCode, never process.exit(). stdout to a pipe is asynchronous on
// POSIX and exit() drops whatever has not drained (CLAUDE.md, "process.exit()
// can truncate pending output"); this runner prints hundreds of KB. On Windows
// a pipe is written synchronously, so the truncation cannot be seen there
// `[measured 2026-10-02]` (4 MiB then exit() arrived whole), which is why
// test-runner-evidence.js also refuses any exit() call in this file by reading it.
main().then((code) => { process.exitCode = code; }, (e) => {
  console.error('[test-all] the runner itself failed: ' + (e && e.stack || e));
  process.exitCode = 2;
});
