'use strict';
// Suite for plugins/autodev-core/scripts/check-ci-freshness.js.
//
// The subject exists because a green check is a claim about the merge that was
// TESTED, and GitHub does not re-run a `pull_request` workflow when the BASE
// moves. `[measured 2026-09-11 on qr]` all 12 open PRs were behind main, and
// merging each into current main locally changed the verdict three times.
//
// THREE THINGS THIS SUITE IS BUILT NOT TO DO, each from a failure in this fleet:
//
//   · IT DOES NOT DERIVE THE COMPARISON THE WAY THE SUBJECT DOES. An agreement
//     test cannot see shared wrongness: if the suite asked the subject's own
//     freshness() what "stale" means, both would go wrong together and stay
//     green. Every expectation below is computed here, from Date.parse over the
//     authored fixture literals, with this file's own comparison.
//
//   · IT DOES NOT GRADE THE SYNTAX THE DEFECT WAS BORN FROM. A peer's gate
//     written from one instance matched `$VAR/scripts/` and missed the same bug
//     written as a bare identifier. So the cases here drive the real CLI over
//     fixture DATA and assert VERDICTS, never the subject's source text.
//
//   · ITS CONTROL CANNOT SILENTLY NOT RUN. A control whose output is
//     indistinguishable from a real one is worse than no control; that bit a
//     session in this repo on 2026-09-10. The known-positive sets a witness,
//     and the witness is asserted.
//
// Only the GitHub transport is replaced, via a --require preload that routes on
// the gh argv. The subject carries no test hook.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-ci-freshness.js');

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail ? '  (' + detail + ')' : '')); }
}

// ---------------------------------------------------------------------------
// The fixture clock. Authored as literals so the suite can do its own
// arithmetic over them; nothing below asks the subject what these mean.
// ---------------------------------------------------------------------------
const TRUNK_TIP_AT = '2026-09-11T19:38:03Z';
const STALE_RUN_AT = '2026-09-10T10:50:52Z';   // 33h BEFORE the tip: the qr shape
const FRESH_RUN_AT = '2026-09-11T20:07:51Z';   // ~30m after: past any recompute race
const RACE_RUN_AT  = '2026-09-11T19:38:17Z';   // +14s: the one that was not evidence either
const GRACE_SECONDS = 60;

// This suite's OWN comparison, written independently of the subject's.
function suiteSaysStale(runIso, tipIso) { return Date.parse(runIso) <= Date.parse(tipIso); }
function suiteSaysInRace(runIso, tipIso, graceSeconds) {
    const d = Date.parse(runIso) - Date.parse(tipIso);
    return d > 0 && d <= graceSeconds * 1000;
}

// Sanity on the fixture clock itself: if these literals stopped meaning what
// their names say, every case below would be vacuous while still passing.
check('fixture: the stale run really does predate the trunk tip',
    suiteSaysStale(STALE_RUN_AT, TRUNK_TIP_AT));
check('fixture: the fresh run really does post-date the trunk tip by more than the grace',
    !suiteSaysStale(FRESH_RUN_AT, TRUNK_TIP_AT) && !suiteSaysInRace(FRESH_RUN_AT, TRUNK_TIP_AT, GRACE_SECONDS));
check('fixture: the race run really does land inside the grace window',
    suiteSaysInRace(RACE_RUN_AT, TRUNK_TIP_AT, GRACE_SECONDS),
    String((Date.parse(RACE_RUN_AT) - Date.parse(TRUNK_TIP_AT)) / 1000) + 's');

// ---------------------------------------------------------------------------
// The transport preload: routes on the gh argv, throws where asked to.
// ---------------------------------------------------------------------------
const PRELOAD = [
    "const cp = require('child_process');",
    "const fs = require('fs');",
    'const original = cp.execFileSync;',
    'cp.execFileSync = function (command, args, options) {',
    "  if (command !== 'gh') return original.call(this, command, args, options);",
    "  const F = JSON.parse(fs.readFileSync(process.env.CI_FRESHNESS_FIXTURE, 'utf8'));",
    "  const line = args.join(' ');",
    '  for (const pattern of (F.fail || [])) {',
    "    if (line.indexOf(pattern) !== -1) { const e = new Error('gh refused: ' + pattern); e.status = 1; throw e; }",
    '  }',
    "  if (args[0] === 'repo' && args[1] === 'view') {",
    "    const scoped = args[2] && args[2].indexOf('--') !== 0;",
    "    return JSON.stringify(scoped ? (F.repoScoped || F.repo) : F.repo);",
    '  }',
    "  if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(F.prs || []);",
    "  if (args[0] === 'api') {",
    '    const url = args[1];',
    "    const runs = url.match(/commits\\/([^/]+)\\/check-runs/);",
    '    if (runs) {',
    '      const hit = (F.runs || {})[runs[1]];',
    "      if (hit === undefined) return JSON.stringify({ total_count: 0, check_runs: [] });",
    "      if (hit === 'MALFORMED') return 'this is not json';",
    '      return JSON.stringify(hit);',
    '    }',
    "    const tip = url.match(/commits\\/(.+)$/);",
    '    if (tip) {',
    '      const hit = (F.tips || {})[tip[1]];',
    "      if (hit === undefined) { const e = new Error('no such ref'); e.status = 1; throw e; }",
    '      return JSON.stringify(hit);',
    '    }',
    '  }',
    "  const e = new Error('unrouted gh call: ' + line); e.status = 1; throw e;",
    '};',
].join('\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-freshness-'));
const preloadPath = path.join(tmp, 'github-transport.cjs');
const fixturePath = path.join(tmp, 'fixture.json');
fs.writeFileSync(preloadPath, PRELOAD);

function run(subjectPath, fixture, extraArgs) {
    fs.writeFileSync(fixturePath, JSON.stringify(fixture));
    const r = spawnSync(process.execPath,
        ['--require', preloadPath, subjectPath, '--grace-seconds', String(GRACE_SECONDS), '--json'].concat(extraArgs || []),
        { cwd: tmp, encoding: 'utf8', env: Object.assign({}, process.env, { CI_FRESHNESS_FIXTURE: fixturePath }) });
    let result = null;
    try { result = JSON.parse(r.stdout); } catch (e) { result = null; }
    return { exit: r.status, result, detail: JSON.stringify({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 400) }) };
}

const REPO = { nameWithOwner: 'fixture/repo', defaultBranchRef: { name: 'main' } };
const JOBS = ['test (ubuntu-latest)', 'test (macos-latest)', 'test (windows-latest)'];

function runsAt(when, conclusion, names) {
    const list = (names || JOBS).map((name) => ({ name, status: 'completed', conclusion, completed_at: when }));
    return { total_count: list.length, check_runs: list };
}

/** A repo whose trunk tip is TRUNK_TIP_AT and whose only PR is `pr`. */
function world(pr, runs, extra) {
    return Object.assign({
        repo: REPO,
        prs: [Object.assign({ number: 1, baseRefName: 'main', headRefName: 'feature', headRefOid: 'head1111',
            isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }, pr)],
        tips: { main: { sha: 'trunktip0000', commit: { committer: { date: TRUNK_TIP_AT } } } },
        runs: Object.assign({ trunktip0000: runsAt(TRUNK_TIP_AT, 'success') }, runs),
    }, extra || {});
}

// ===========================================================================
// OUTCOME 1 — a STALE green. The green board that is not evidence.
// ===========================================================================
const staleWorld = world({}, { head1111: runsAt(STALE_RUN_AT, 'success') });

/**
 * The stale-case assertion, factored out so the MUTATION check below can run
 * the very same predicate against a broken subject and watch it go red.
 * @returns {{ok:boolean, detail:string}}
 */
function assertStaleIsUnmeasured(subjectPath) {
    const r = run(subjectPath, staleWorld);
    const pr = r.result && r.result.prs && r.result.prs[0];
    const ok = !!pr
        && pr.verdict === 'UNMEASURED'
        && pr.subtype === 'STALE-EVIDENCE'
        && r.exit === 2
        && r.result.population.measuredGreen === 0
        && r.result.population.unmeasured === 1;
    return { ok, detail: r.detail, pr, result: r.result, exit: r.exit };
}

{
    const a = assertStaleIsUnmeasured(SUBJECT);
    check('STALE: an all-passing board whose newest run predates the trunk tip is UNMEASURED, not green',
        a.ok, a.detail);
    check('STALE: the suite\'s own independent comparison agrees it is stale, so the case is not vacuous',
        suiteSaysStale(STALE_RUN_AT, TRUNK_TIP_AT) && a.pr && a.pr.freshness === 'STALE', a.detail);
    check('STALE: the reason names both instants, so a reader can check the arithmetic',
        !!a.pr && a.pr.reasons.some((x) => x.indexOf(STALE_RUN_AT.replace('Z', '.000Z')) !== -1
            && x.indexOf(TRUNK_TIP_AT.replace('Z', '.000Z')) !== -1), a.detail);
    check('STALE: every job passed, and that does not make it green',
        !!a.pr && a.pr.population.failing === 0 && a.pr.population.passing === 3 && a.pr.verdict !== 'measured-green', a.detail);
    check('STALE: exit is 2 — stale, not 0 and not 1', a.exit === 2, a.detail);
}

// ===========================================================================
// OUTCOME 2 — a FRESH green, and a FRESH red, so "green" is reachable at all.
// A suite where nothing can ever be green proves only that it says no.
// ===========================================================================
{
    const r = run(SUBJECT, world({}, { head1111: runsAt(FRESH_RUN_AT, 'success') }));
    const pr = r.result && r.result.prs && r.result.prs[0];
    check('FRESH: a passing board newer than the trunk tip IS measured-green',
        !!pr && pr.verdict === 'measured-green' && pr.subtype === 'FRESH-AND-PASSING' && r.exit === 0, r.detail);
    check('FRESH: the suite\'s own comparison independently agrees it is fresh',
        !suiteSaysStale(FRESH_RUN_AT, TRUNK_TIP_AT) && !!pr && pr.freshness === 'FRESH', r.detail);
    check('FRESH: a green verdict against the trunk says so in its trunk claim',
        !!pr && pr.baseIsTrunk === true && /about main/.test(pr.trunkClaim), r.detail);
}

// ===========================================================================
// THE KNOWN-POSITIVE CONTROL — the check must be able to SEE a real failure.
// A detector that can only report absence is indistinguishable from one that
// looks at nothing, so this runs a planted red and a witness proves it ran.
// ===========================================================================
let controlRan = false;
let controlSaw = null;
{
    const r = run(SUBJECT, world({}, {
        head1111: { total_count: 3, check_runs: [
            { name: JOBS[0], status: 'completed', conclusion: 'success', completed_at: FRESH_RUN_AT },
            { name: JOBS[1], status: 'completed', conclusion: 'failure', completed_at: FRESH_RUN_AT },
            { name: JOBS[2], status: 'completed', conclusion: 'success', completed_at: FRESH_RUN_AT },
        ] },
    }));
    const pr = r.result && r.result.prs && r.result.prs[0];
    controlRan = true;
    controlSaw = pr ? pr.verdict + '/' + pr.subtype + '/exit' + r.exit : 'nothing';
    check('CONTROL: a planted failing job on fresh evidence is measured-RED',
        !!pr && pr.verdict === 'measured-red' && pr.subtype === 'FAILING-JOB' && r.exit === 1, r.detail);
    check('CONTROL: the red names the failing job rather than only counting it',
        !!pr && pr.jobs.some((j) => j.name === JOBS[1] && j.conclusions.indexOf('FAILURE') !== -1), r.detail);
}
// The witness. A control that silently did not run produces output identical to
// a real one; this is the only thing that tells them apart.
check('CONTROL EXECUTED: the known-positive control block actually ran', controlRan === true);
check('CONTROL EXECUTED: and it produced a real verdict, not an empty result',
    controlSaw === 'measured-red/FAILING-JOB/exit1', String(controlSaw));

// ===========================================================================
// OUTCOME 3 — the API could not answer. Never green, never red.
// ===========================================================================
{
    let r = run(SUBJECT, Object.assign(world({}, { head1111: runsAt(FRESH_RUN_AT, 'success') }), { fail: ['pr list'] }));
    check('BLIND: gh failing on the PR list is COULD-NOT-CHECK, and the scan says so',
        !!r.result && r.result.blind === true && r.exit === 3, r.detail);
    check('BLIND: a blind scan reports an unknown population, never a clean zero',
        !!r.result && r.result.population.openPrs === null && r.result.population.examined === 0, r.detail);

    r = run(SUBJECT, Object.assign(world({}, { head1111: runsAt(FRESH_RUN_AT, 'success') }), { fail: ['repo view'] }));
    check('BLIND: gh failing on the repo lookup is COULD-NOT-CHECK', !!r.result && r.result.blind === true && r.exit === 3, r.detail);

    r = run(SUBJECT, world({ baseRefName: 'gone' }, { head1111: runsAt(FRESH_RUN_AT, 'success') }));
    const pr = r.result && r.result.prs && r.result.prs[0];
    check('BLIND: an unreadable base tip is COULD-NOT-CHECK for that PR, not a verdict about it',
        !!pr && pr.verdict === 'COULD-NOT-CHECK' && pr.subtype === 'NO-BASE-TIP' && r.exit === 3, r.detail);
    check('BLIND: a per-PR blindness still prints the denominator',
        !!r.result && r.result.population.examined === 1 && r.result.population.openPrs === 1, r.detail);

    r = run(SUBJECT, world({}, { head1111: 'MALFORMED' }));
    check('BLIND: unparseable check-run JSON is COULD-NOT-CHECK, never a pass',
        !!r.result && r.result.prs[0].verdict === 'COULD-NOT-CHECK' && r.result.prs[0].subtype === 'NO-CHECK-RUNS', r.detail);
}

// ===========================================================================
// The design constraints that are not the three outcomes.
// ===========================================================================

// #3 — the WHOLE conclusion set per (head, job). autodev's heads get two CI
// runs that can disagree on the same commit; latest-per-job turns that into a
// pass. Proved with the disagreeing pair in the order where "latest" is GREEN.
{
    const r = run(SUBJECT, world({}, {
        head1111: { total_count: 2, check_runs: [
            { name: JOBS[0], status: 'completed', conclusion: 'failure', completed_at: '2026-09-11T20:00:00Z' },
            { name: JOBS[0], status: 'completed', conclusion: 'success', completed_at: FRESH_RUN_AT },
        ] },
    }));
    const pr = r.result && r.result.prs && r.result.prs[0];
    check('WHOLE SET: one job reporting both a pass and a fail on one head is NOT green',
        !!pr && pr.verdict !== 'measured-green', r.detail);
    check('WHOLE SET: the disagreement is named, not averaged away',
        !!pr && pr.population.disagreeing === 1 && pr.reasons.some((x) => /coin-flip/.test(x)), r.detail);
    check('WHOLE SET: both runs are kept, so the count is 2 runs over 1 job',
        !!pr && pr.population.checkRuns === 2 && pr.population.jobsOnHead === 1, r.detail);

    const truncated = run(SUBJECT, world({}, {
        head1111: { total_count: 250, check_runs: runsAt(FRESH_RUN_AT, 'success').check_runs },
    }));
    const tpr = truncated.result && truncated.result.prs[0];
    check('WHOLE SET: a truncated page is refused rather than judged on the part that arrived',
        !!tpr && tpr.verdict === 'UNMEASURED' && tpr.subtype === 'TRUNCATED-SET', truncated.detail);
}

// #4 — a stacked PR's base is read explicitly, and no verdict about it is
// allowed to read as a claim about the trunk. This is qr #94 and #106.
{
    const r = run(SUBJECT, {
        repo: REPO,
        prs: [{ number: 94, baseRefName: 'parent-pr', headRefName: 'child', headRefOid: 'head1111',
            isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }],
        tips: {
            main: { sha: 'trunktip0000', commit: { committer: { date: TRUNK_TIP_AT } } },
            'parent-pr': { sha: 'parenttip000', commit: { committer: { date: '2026-09-10T09:00:00Z' } } },
        },
        runs: { parenttip000: runsAt('2026-09-10T09:30:00Z', 'success'), head1111: runsAt(STALE_RUN_AT, 'success') },
    });
    const pr = r.result && r.result.prs && r.result.prs[0];
    check('STACKED: the freshness question is asked against the PR\'s OWN base, not the trunk',
        !!pr && pr.base === 'parent-pr' && pr.baseTipSha === 'parenttip000', r.detail);
    check('STACKED: a run newer than the stack parent is measured-green ONLY about that parent',
        !!pr && pr.verdict === 'measured-green' && pr.baseIsTrunk === false, r.detail);
    check('STACKED: the result carries an explicit NONE trunk claim',
        !!pr && /^NONE/.test(pr.trunkClaim) && /not main/.test(pr.trunkClaim), r.detail);
    check('STACKED: MERGEABLE/CLEAN is reported without being treated as a trunk statement',
        !!pr && pr.mergeable === 'MERGEABLE' && pr.reasons.some((x) => /stack parent/.test(x) && /mergeable flag/.test(x)), r.detail);
    check('STACKED: the stale trunk tip is NOT what this PR was compared against',
        !!pr && pr.baseTipAt === '2026-09-10T09:00:00.000Z', r.detail);
}

// #5 — "the job did not run" and "the job is absent" are different, and both
// are UNMEASURED. A path-filtered workflow leaves PENDING; a missing platform
// job leaves nothing at all and looks exactly like a green board.
{
    let r = run(SUBJECT, world({}, {
        head1111: { total_count: 3, check_runs: [
            { name: JOBS[0], status: 'completed', conclusion: 'success', completed_at: FRESH_RUN_AT },
            { name: JOBS[1], status: 'completed', conclusion: 'success', completed_at: FRESH_RUN_AT },
            { name: JOBS[2], status: 'queued', conclusion: null, completed_at: null },
        ] },
    }));
    let pr = r.result && r.result.prs && r.result.prs[0];
    check('DID NOT RUN: a queued job is UNMEASURED/JOB-DID-NOT-RUN, not a pass and not a failure',
        !!pr && pr.verdict === 'UNMEASURED' && pr.subtype === 'JOB-DID-NOT-RUN' && pr.population.pending === 1, r.detail);

    r = run(SUBJECT, world({}, { head1111: runsAt(FRESH_RUN_AT, 'success', [JOBS[0], JOBS[1]]) }));
    pr = r.result && r.result.prs && r.result.prs[0];
    check('ABSENT: a job the base tip runs and the head does not is UNMEASURED/ABSENT-JOB',
        !!pr && pr.verdict === 'UNMEASURED' && pr.subtype === 'ABSENT-JOB', r.detail);
    check('ABSENT: the missing job is named, since on a board it looks identical to a pass',
        !!pr && pr.absentJobs.length === 1 && pr.absentJobs[0] === JOBS[2], r.detail);
    check('ABSENT and DID-NOT-RUN are different subtypes, never folded together',
        true && pr.subtype === 'ABSENT-JOB');

    r = run(SUBJECT, world({}, { head1111: { total_count: 0, check_runs: [] } }));
    pr = r.result && r.result.prs && r.result.prs[0];
    check('NO CHECKS AT ALL: an empty board is UNMEASURED/NO-CHECKS-AT-ALL, not clean',
        !!pr && pr.verdict === 'UNMEASURED' && pr.subtype === 'NO-CHECKS-AT-ALL', r.detail);

    r = run(SUBJECT, world({}, { head1111: runsAt(FRESH_RUN_AT, 'skipped') }));
    pr = r.result && r.result.prs && r.result.prs[0];
    check('SKIPPED ONLY: a board of nothing but SKIPPED is absence, not a pass',
        !!pr && pr.verdict === 'UNMEASURED' && pr.subtype === 'SKIPPED-ONLY', r.detail);
}

// The 14-second case: the one run that post-dated the trunk tip and still was
// not evidence, because the merge ref may not have been recomputed yet.
{
    const r = run(SUBJECT, world({}, { head1111: runsAt(RACE_RUN_AT, 'success') }));
    const pr = r.result && r.result.prs && r.result.prs[0];
    check('RACE: a run 14s after the trunk tip is UNMEASURED/INSIDE-RECOMPUTE-RACE, not green',
        !!pr && pr.verdict === 'UNMEASURED' && pr.subtype === 'INSIDE-RECOMPUTE-RACE', r.detail);
    check('RACE: the suite\'s own arithmetic independently places it inside the window',
        suiteSaysInRace(RACE_RUN_AT, TRUNK_TIP_AT, GRACE_SECONDS) && !!pr && pr.freshness === 'WITHIN_GRACE', r.detail);
    // And the window is a parameter, not a belief: with a zero grace the same
    // fixture is fresh, which proves the subtype above came from the comparison.
    const zero = spawnSync(process.execPath, ['--require', preloadPath, SUBJECT, '--grace-seconds', '0', '--json'],
        { cwd: tmp, encoding: 'utf8', env: Object.assign({}, process.env, { CI_FRESHNESS_FIXTURE: fixturePath }) });
    let zr = null; try { zr = JSON.parse(zero.stdout); } catch (e) { zr = null; }
    check('RACE: with --grace-seconds 0 the same fixture is FRESH, so the window is doing the work',
        !!zr && zr.prs[0].verdict === 'measured-green', JSON.stringify({ s: zero.status, o: zero.stdout.slice(0, 400) }));
}

// --repo must scope the default-branch lookup. `gh repo view` with no positional
// argument answers about the checkout in cwd, so asking about another repo from
// this one took the target's NAME from the flag and its TRUNK from the local
// checkout. Both are usually called main, which is what makes it dangerous: it
// is right by coincidence until it is not, and then it is confidently wrong.
{
    const r = run(SUBJECT, {
        repo: { nameWithOwner: 'local/checkout', defaultBranchRef: { name: 'local-trunk' } },
        repoScoped: { nameWithOwner: 'fixture/repo', defaultBranchRef: { name: 'main' } },
        prs: [{ number: 7, baseRefName: 'main', headRefName: 'f', headRefOid: 'head1111', isDraft: false }],
        tips: {
            main: { sha: 'trunktip0000', commit: { committer: { date: TRUNK_TIP_AT } } },
            'local-trunk': { sha: 'wrongtip0000', commit: { committer: { date: '2020-01-01T00:00:00Z' } } },
        },
        runs: { trunktip0000: runsAt(TRUNK_TIP_AT, 'success'), head1111: runsAt(STALE_RUN_AT, 'success') },
    }, ['--repo', 'fixture/repo']);
    check('--repo scopes the default-branch lookup to the TARGET repo, not the local checkout',
        !!r.result && r.result.trunk === 'main', r.detail);
    check('--repo: with the wrong trunk this PR would read green; with the right one it is STALE',
        !!r.result && r.result.prs[0].subtype === 'STALE-EVIDENCE'
        && r.result.prs[0].baseTipSha === 'trunktip0000', r.detail);
}

// #2 — the population beside every count.
{
    const r = run(SUBJECT, {
        repo: REPO,
        prs: [
            { number: 1, baseRefName: 'main', headRefName: 'a', headRefOid: 'headAAAA', isDraft: false },
            { number: 2, baseRefName: 'main', headRefName: 'b', headRefOid: 'headBBBB', isDraft: false },
        ],
        tips: { main: { sha: 'trunktip0000', commit: { committer: { date: TRUNK_TIP_AT } } } },
        runs: { trunktip0000: runsAt(TRUNK_TIP_AT, 'success'),
            headAAAA: runsAt(FRESH_RUN_AT, 'success'), headBBBB: runsAt(STALE_RUN_AT, 'success') },
    }, ['--pr', '1']);
    check('POPULATION: examining 1 of 2 open PRs says BOTH numbers',
        !!r.result && r.result.population.examined === 1 && r.result.population.openPrs === 2, r.detail);
    check('POPULATION: the counts sum to the examined total, so a verdict cannot go missing',
        !!r.result && (r.result.population.measuredGreen + r.result.population.measuredRed
            + r.result.population.unmeasured + r.result.population.couldNotCheck) === r.result.population.examined, r.detail);

    const human = spawnSync(process.execPath, ['--require', preloadPath, SUBJECT, '--grace-seconds', String(GRACE_SECONDS)],
        { cwd: tmp, encoding: 'utf8', env: Object.assign({}, process.env, { CI_FRESHNESS_FIXTURE: fixturePath }) });
    check('POPULATION: the human rendering prints the denominator too, not only --json',
        /of 2 open PR\(s\) examined/.test(human.stdout), human.stdout.slice(0, 300));
}

// #6 and the entrypoint contract: --help returns, and nothing is truncated.
{
    const h = spawnSync(process.execPath, [SUBJECT, '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    check('--help returns rather than entering a scan', h.status === 0 && /check-ci-freshness/.test(h.stdout), JSON.stringify({ s: h.status, e: h.error && String(h.error) }));
    check('--help needs no network: it never reaches gh', !/gh did not answer/.test(h.stdout + h.stderr));
    const s = spawnSync(process.execPath, [SUBJECT, '--selftest'], { encoding: 'utf8', timeout: 20000 });
    check('--selftest passes as a subprocess', s.status === 0 && /0 failed/.test(s.stdout), s.stdout.slice(-300));
    const bad = spawnSync(process.execPath, [SUBJECT, '--grace-seconds', 'banana'], { encoding: 'utf8', timeout: 10000 });
    check('a non-numeric grace is refused with exit 4, not silently defaulted', bad.status === 4, JSON.stringify({ s: bad.status, e: bad.stderr.slice(0, 200) }));
    // Grep the CODE, not the prose. The subject's own header names the banned
    // call in order to forbid it, so an un-stripped grep matches the warning
    // and reports the defect it warns about. Naive stripping is sufficient
    // here and its limit is stated rather than hidden: a `//` inside a string
    // literal would confuse it, and this subject contains none.
    const code = fs.readFileSync(SUBJECT, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
    check('the subject never calls process.exit(), which truncates an async pipe',
        !/process\.exit\(/.test(code),
        'found: ' + (code.match(/.{0,60}process\.exit\(.{0,40}/) || [''])[0]);
    check('and it does set process.exitCode, so the exit is not merely absent',
        /process\.exitCode\s*=/.test(code));
}

// ===========================================================================
// MUTATION — break the timestamp comparison and watch THIS suite's own stale
// row go red. A check nobody has watched fail is a hypothesis.
// ===========================================================================
{
    const src = fs.readFileSync(SUBJECT, 'utf8');
    // The comparison, mutated at the fact rather than at a pattern: a run older
    // than its base tip stops counting as stale.
    // A literal needle is an implementation description and WILL rot; the guard
    // below is what makes that safe. It already fired once, on the commit that
    // rewrote freshness(), and refused to report a mutation result rather than
    // reporting a green one from a mutation that never applied.
    const NEEDLE = 'if (delta <= 0) return \'STALE\';';
    check('MUTATION: the timestamp comparison is where this suite thinks it is',
        src.indexOf(NEEDLE) !== -1, 'if this fails the mutation below is vacuous and every claim about it is void');

    if (src.indexOf(NEEDLE) !== -1) {
        const mutantPath = path.join(tmp, 'mutant-check-ci-freshness.js');
        const mutated = src.replace(NEEDLE, 'if (false) return \'STALE\';');
        check('MUTATION: the mutant really differs from the subject', mutated !== src);
        fs.writeFileSync(mutantPath, mutated);

        // The SAME predicate the real stale row uses, run against the mutant.
        const m = assertStaleIsUnmeasured(mutantPath);
        check('MUTATION: with the comparison broken, the stale row FAILS — the suite can go red',
            m.ok === false, 'the mutant still satisfied the stale assertion, so that row proves nothing: ' + m.detail);
        // Not merely "it went red": the mutant must fail the way the DEFECT
        // predicts. With the stale test gone, a run 33 hours older than the
        // trunk tip is reported as FRESH and the PR reads measured-green —
        // which is the exact wrong answer this script exists to refuse.
        check('MUTATION: and it fails the specific way the defect predicts — the stale PR reads GREEN',
            !!m.pr && m.pr.verdict === 'measured-green' && m.pr.freshness === 'FRESH' && m.exit === 0, m.detail);
        check('MUTATION: the unmutated subject still passes that same row, so the red was the mutation',
            assertStaleIsUnmeasured(SUBJECT).ok === true);
    }
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
