#!/usr/bin/env node
'use strict';
/**
 * check-pr-ready.js - answer "is this pull request actually safe to merge?"
 * without the four traps that made a coordinator get it wrong three times in
 * one day.
 *
 * WHY THIS EXISTS. The obvious probe is a jq expression over
 * `gh pr view --json statusCheckRollup`, and every hand-rolled version of it
 * failed differently:
 *
 *   1. `.conclusion // "NONE"` looks like it defaults a missing value. jq's `//`
 *      falls through on null and false, NOT on an empty string, and an
 *      in-progress check reports conclusion as "". So a filter written to catch
 *      unfinished checks matched nothing and the run was declared TERMINAL while
 *      every check was still running.
 *   2. The inverse: `select(.conclusion != "SUCCESS")` counts those same empty
 *      strings as failures, so four PENDING checks were reported as four
 *      FAILING ones.
 *   3. A SKIPPED check is not a passing check. A draft PR whose gate carries
 *      `draft == false` reports SKIPPED, and the rollup then looks untroubled
 *      while carrying no evidence at all. `[measured 2026-09-05]` a draft sat
 *      MERGEABLE/CLEAN with its main gate never run.
 *   4. Rollups carry an entry with a null name, null status and null conclusion
 *      on every PR in every repo checked. It is an artifact, not a check, and
 *      counting it as unknown makes every PR permanently unmergeable.
 *
 * THE RULE IT ENCODES: an unrecognised state is the DANGEROUS case. Anything
 * this cannot classify counts as not-ready, and says so by name, rather than
 * falling through to success.
 *
 * IT PRINTS THE POPULATION. A verdict with no denominator is indistinguishable
 * from a finder that returned nothing, so every run says how many checks it saw
 * and how each was classified.
 *
 * Usage:
 *   node check-pr-ready.js <pr-number> [--repo <path|owner/repo>] [--json]
 *   node check-pr-ready.js --selftest
 *
 * Exit: 0 ready, 2 not ready, 3 could not tell (gh failed, no such PR).
 * Never throws; a crash would be indistinguishable from a verdict.
 */

const { execFileSync } = require('child_process');

const TERMINAL_GOOD = new Set(['SUCCESS', 'NEUTRAL']);
const TERMINAL_BAD = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE']);
const NOT_EVIDENCE = new Set(['SKIPPED']);

function gh(args, cwd) {
    try {
        return execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        return null;
    }
}

/** An empty string is not a value. jq's `//` disagrees, which is trap 1 and 2. */
function present(v) {
    return v !== null && v !== undefined && String(v).trim() !== '';
}

/**
 * @returns {{verdict:'READY'|'NOT_READY'|'CANNOT_TELL', reasons:string[],
 *            population:object, checks:Array}}
 */
function checkPrReady(prNumber, cwd) {
    const raw = gh(['pr', 'view', String(prNumber), '--json',
        'number,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,baseRefName,headRefName'], cwd);
    if (raw === null) {
        return { verdict: 'CANNOT_TELL', reasons: ['gh could not answer for PR ' + prNumber + ' in ' + (cwd || process.cwd())], population: {}, checks: [] };
    }
    let pr;
    try { pr = JSON.parse(raw); } catch (e) {
        return { verdict: 'CANNOT_TELL', reasons: ['gh returned unparseable JSON'], population: {}, checks: [] };
    }

    const reasons = [];
    const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];

    let good = 0, bad = 0, pending = 0, skipped = 0, artifact = 0, unknown = 0;
    const checks = [];

    for (const c of rollup) {
        const name = present(c.name) ? c.name : (present(c.context) ? c.context : null);
        const status = present(c.status) ? String(c.status).toUpperCase() : null;
        const concl = present(c.conclusion) ? String(c.conclusion).toUpperCase()
            : (present(c.state) ? String(c.state).toUpperCase() : null);

        // Trap 4: an entry with no name AND no status AND no conclusion is a
        // rollup artifact, seen on every PR in every repo. Counting it as
        // unknown makes everything permanently unmergeable.
        if (name === null && status === null && concl === null) { artifact++; continue; }

        const label = name || '(unnamed)';
        if (status !== null && status !== 'COMPLETED') { pending++; checks.push([label, status + '/pending']); continue; }
        if (concl === null) { pending++; checks.push([label, 'no conclusion yet']); continue; }
        if (NOT_EVIDENCE.has(concl)) { skipped++; checks.push([label, 'SKIPPED']); continue; }
        if (TERMINAL_GOOD.has(concl)) { good++; checks.push([label, concl]); continue; }
        if (TERMINAL_BAD.has(concl)) { bad++; checks.push([label, concl]); continue; }
        unknown++; checks.push([label, 'UNRECOGNISED:' + concl]);
    }

    const population = {
        rollupEntries: rollup.length, passing: good, failing: bad,
        pending, skipped, rollupArtifacts: artifact, unrecognised: unknown,
    };

    if (pr.state !== 'OPEN') reasons.push('state is ' + pr.state + ', not OPEN');
    // Trap 3: a draft's checks are not evidence, whatever the rollup shows.
    if (pr.isDraft) reasons.push('it is a DRAFT, so a guarded gate reports SKIPPED and the rollup is not evidence');
    if (bad > 0) reasons.push(bad + ' check(s) FAILED');
    if (pending > 0) reasons.push(pending + ' check(s) have not completed');
    if (unknown > 0) reasons.push(unknown + ' check(s) reported a state this script does not recognise, counted as not-ready');
    if (present(pr.mergeable) && pr.mergeable !== 'MERGEABLE') reasons.push('mergeable is ' + pr.mergeable);
    if (present(pr.mergeStateStatus) && !['CLEAN', 'UNSTABLE'].includes(pr.mergeStateStatus)) {
        reasons.push('mergeStateStatus is ' + pr.mergeStateStatus);
    }
    // UNSTABLE with everything terminal and green means only the artifact row is
    // unresolved, which is why it is allowed above but noted here.
    if (pr.mergeStateStatus === 'UNSTABLE' && bad === 0 && pending === 0) {
        reasons.push('mergeStateStatus is UNSTABLE with no failing or pending check; usually the rollup artifact');
    }
    if (good === 0 && skipped > 0) reasons.push('every check that ran was SKIPPED, so nothing was actually verified');
    if (rollup.length === 0) reasons.push('the rollup is EMPTY, which looks identical to a clean one and is not');

    const blocking = reasons.filter((r) => !r.startsWith('mergeStateStatus is UNSTABLE with no'));
    return { verdict: blocking.length === 0 ? 'READY' : 'NOT_READY', reasons, population, checks, pr };
}

function render(r) {
    const out = [];
    out.push('  verdict: ' + r.verdict);
    if (r.pr) out.push('  #' + r.pr.number + ' ' + r.pr.state + ' draft=' + r.pr.isDraft
        + ' ' + r.pr.mergeable + '/' + r.pr.mergeStateStatus
        + '  ' + r.pr.headRefName + ' -> ' + r.pr.baseRefName);
    const p = r.population;
    out.push('  population: ' + (p.rollupEntries || 0) + ' rollup entries = '
        + (p.passing || 0) + ' passing, ' + (p.failing || 0) + ' failing, '
        + (p.pending || 0) + ' pending, ' + (p.skipped || 0) + ' skipped, '
        + (p.rollupArtifacts || 0) + ' artifact, ' + (p.unrecognised || 0) + ' unrecognised');
    for (const [n, s] of r.checks) out.push('    ' + n + ': ' + s);
    if (r.reasons.length) { out.push('  why not ready:'); for (const x of r.reasons) out.push('    - ' + x); }
    return out.join('\n');
}

function selftest() {
    let pass = 0, fail = 0;
    const t = (label, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label + (detail ? '  (' + detail + ')' : '')); } };

    // present() is the whole of traps 1 and 2, so it gets its own cases.
    t('present: empty string is NOT a value', present('') === false);
    t('present: null is not a value', present(null) === false);
    t('present: undefined is not a value', present(undefined) === false);
    t('present: "SUCCESS" is a value', present('SUCCESS') === true);
    t('present: 0 IS a value, unlike jq //', present(0) === true);

    t('SKIPPED is not counted as evidence', NOT_EVIDENCE.has('SKIPPED'));
    t('SUCCESS is terminal-good', TERMINAL_GOOD.has('SUCCESS'));
    t('STARTUP_FAILURE is terminal-bad, not unknown', TERMINAL_BAD.has('STARTUP_FAILURE'));
    t('an invented conclusion is in NEITHER set, so it counts as unrecognised',
        !TERMINAL_GOOD.has('DEFINITELY_NOT_A_REAL_CONCLUSION') && !TERMINAL_BAD.has('DEFINITELY_NOT_A_REAL_CONCLUSION'));

    console.log('\nselftest: ' + pass + ' passed, ' + fail + ' failed');
    return fail === 0;
}

module.exports = { checkPrReady, present, render };

if (require.main === module) {
    const argv = process.argv.slice(2);
    if (argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
    if (argv.includes('--help') || argv.length === 0) {
        console.log('check-pr-ready.js <pr-number> [--repo <path>] [--json]\n'
            + 'Answers whether a PR is safe to merge, treating an unrecognised state as NOT ready.\n'
            + 'Exit 0 ready, 2 not ready, 3 could not tell.');
        process.exit(0);
    }
    const num = argv.find((a) => /^\d+$/.test(a));
    const ri = argv.indexOf('--repo');
    const cwd = ri !== -1 ? argv[ri + 1] : process.cwd();
    if (!num) { console.error('need a PR number'); process.exit(3); }
    const r = checkPrReady(num, cwd);
    if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else console.log(render(r));
    process.exit(r.verdict === 'READY' ? 0 : r.verdict === 'NOT_READY' ? 2 : 3);
}
