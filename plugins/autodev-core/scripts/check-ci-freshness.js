#!/usr/bin/env node
'use strict';
/**
 * check-ci-freshness.js — a green check is a claim about the merge that was
 * tested, not about the merge you are about to perform.
 *
 * WHY THIS EXISTS. `[measured 2026-09-11 ~19:50Z on qr, ~40 minutes of local
 * gate runs]` a `pull_request`-triggered workflow builds the MERGE ref — the
 * PR's head merged into its base — but GitHub only schedules it when the PR is
 * PUSHED. **It does not re-run when the BASE moves.** So a check run older than
 * the tip it would merge into tested a merge commit that no longer exists.
 * Nothing marks that stale. Nothing goes yellow. The board stays green.
 *
 * On qr that day all 12 open PRs were behind main and not one contained the
 * trunk tip. Merging each into current main locally and running the full gate
 * changed the verdict three times:
 *
 *   · #91  green board, RED on current main — six dangling symbols, three of
 *          them introduced by its own CHILD PR, so it documented symbols that
 *          do not exist until #94 lands.
 *   · #94  MERGEABLE/CLEAN, CONFLICTS onto main.
 *   · #106 MERGEABLE/CLEAN, CONFLICTS onto main.
 *
 * The last two are one fact: GitHub measures a stacked PR against its stack
 * PARENT, not the trunk. **A stacked PR's mergeable flag says nothing about the
 * trunk**, and neither does its green board.
 *
 * One PR's newest run POST-DATED the trunk tip by 14 seconds, inside the window
 * where the merge ref may not have been recomputed yet. Even that one was not
 * evidence, which is why GRACE_SECONDS exists below and defaults above 14.
 *
 * WHAT IT ANSWERS, per open PR: is this PR's newest COMPLETED check run newer
 * than the tip of the branch it would merge into? Anything older is UNMEASURED
 * — not red, not green.
 *
 * THE SIX RULES IT ENCODES, each from a failure this fleet has paid for:
 *
 *   1. THREE OUTCOMES, NEVER TWO. measured-green / measured-red / UNMEASURED,
 *      plus COULD-NOT-CHECK when the API did not answer. Collapsing "could not
 *      tell" into either real verdict is the specific move that makes a gate
 *      confidently wrong. An unknown must never read as authorised.
 *   2. THE POPULATION IS PRINTED BESIDE EVERY COUNT. "3 of 12 measured" is a
 *      different statement from "3 measured", and only the denominator tells a
 *      real zero from an empty scan.
 *   3. THE WHOLE CONCLUSION SET PER (head, job), NEVER LATEST-PER-JOB. autodev's
 *      PR heads get two CI runs that can disagree on the same commit; taking
 *      the latest turns a coin-flip into a pass. The REST check-runs endpoint
 *      defaults to `filter=latest`, so this passes `filter=all` and REFUSES to
 *      judge a truncated page rather than judging part of the set.
 *   4. A STACKED PR'S BASE IS READ EXPLICITLY. `baseRefName` is not always the
 *      trunk. Where it is not, the freshness question is asked against the base
 *      the PR actually merges into, and the result carries `trunkClaim: NONE`
 *      so nobody reads it as a statement about the trunk.
 *   5. "THE JOB DID NOT RUN" IS NOT "THE JOB IS ABSENT". A workflow skipped by
 *      path filtering leaves its checks PENDING, not concluded. A job that the
 *      base tip runs and the head does not is ABSENT, and a missing platform
 *      job looks exactly like a green board. Both are UNMEASURED and both are
 *      named, never folded together.
 *   6. `process.exitCode`, NEVER `process.exit()`. `[measured 2026-09-09]` on
 *      Node 24.19.0 an immediate exit delivered 65,536 of 1,048,576 bytes
 *      through a pipe; setting exitCode and letting the loop drain delivered
 *      all of it. Exit 0 does not prove the output survived.
 *
 * IT COMPARES THE FACT, NOT A SHAPE. The comparison is two instants — the
 * newest completed run against the base tip's commit time. It reads no
 * workflow syntax and matches no pattern, so it cannot be defeated by writing
 * the same CI another way.
 *
 * Usage:
 *   node check-ci-freshness.js                      # the repo in cwd, every open PR
 *   node check-ci-freshness.js --repo owner/name
 *   node check-ci-freshness.js --pr 227             # one PR (repeatable)
 *   node check-ci-freshness.js --grace-seconds 60
 *   node check-ci-freshness.js --limit 50 --json
 *   node check-ci-freshness.js --selftest           # no network
 *
 * Exit: 0 every examined PR measured-green · 1 at least one measured-RED ·
 *       3 at least one COULD-NOT-CHECK · 2 at least one UNMEASURED · 4 bad usage.
 * Red outranks blindness outranks staleness: a known defect is the loudest
 * thing found, and "we could not tell" must never be quieter than "it is old".
 */

const { execFileSync } = require('child_process');

// Above the measured 14-second recomputation race. A run that completes inside
// this window after the base moved may have been built from a merge ref
// computed before the move, so it is not evidence either way.
const DEFAULT_GRACE_SECONDS = 60;

// REST conclusions arrive lowercase; GraphQL's arrive upper. Both are upcased
// before lookup so one vocabulary serves both transports.
const TERMINAL_GOOD = new Set(['SUCCESS', 'NEUTRAL']);
const TERMINAL_BAD = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE']);
const NOT_EVIDENCE = new Set(['SKIPPED']);
const STILL_RUNNING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);

const VERDICT = {
    GREEN: 'measured-green',
    RED: 'measured-red',
    UNMEASURED: 'UNMEASURED',
    BLIND: 'COULD-NOT-CHECK',
};

/** An empty string is not a value; jq's `//` disagrees, and that has cost verdicts. */
function present(v) {
    return v !== null && v !== undefined && String(v).trim() !== '';
}

/** Epoch ms for an ISO instant, or null. A null here must never read as 0. */
function toMs(iso) {
    if (!present(iso)) return null;
    const t = Date.parse(String(iso));
    return Number.isFinite(t) ? t : null;
}

/** The gh transport, isolated so a suite can replace it without a test hook here. */
function gh(args, cwd) {
    try {
        return execFileSync('gh', args, {
            cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
        });
    } catch (e) {
        return null;
    }
}

/** @returns {{ok:true,value:any}|{ok:false,error:string}} — never throws. */
function ghJson(args, cwd) {
    const raw = gh(args, cwd);
    if (raw === null) return { ok: false, error: 'gh did not answer: gh ' + args.join(' ') };
    try {
        return { ok: true, value: JSON.parse(raw) };
    } catch (e) {
        return { ok: false, error: 'gh returned unparseable JSON for: gh ' + args.join(' ') };
    }
}

/** One check run's conclusion, bucketed. Unrecognised is its own bucket, never good. */
function classifyRun(run) {
    const status = present(run && run.status) ? String(run.status).toUpperCase() : null;
    const concl = present(run && run.conclusion) ? String(run.conclusion).toUpperCase()
        : (present(run && run.state) ? String(run.state).toUpperCase() : null);
    if (status !== null && status !== 'COMPLETED') return 'RUNNING';
    if (concl === null) return 'RUNNING';
    if (STILL_RUNNING.has(concl)) return 'RUNNING';
    if (NOT_EVIDENCE.has(concl)) return 'NOT_EVIDENCE';
    if (TERMINAL_GOOD.has(concl)) return 'GOOD';
    if (TERMINAL_BAD.has(concl)) return 'BAD';
    return 'UNRECOGNISED';
}

/**
 * Every conclusion each job reported on this head, not the latest one.
 * @returns {Map<string,{classes:string[], conclusions:string[], completedAt:number[]}>}
 */
function groupByJob(runs) {
    const byJob = new Map();
    for (const run of runs || []) {
        const name = present(run && run.name) ? String(run.name) : '(unnamed)';
        if (!byJob.has(name)) byJob.set(name, { classes: [], conclusions: [], completedAt: [] });
        const entry = byJob.get(name);
        entry.classes.push(classifyRun(run));
        entry.conclusions.push(present(run && run.conclusion) ? String(run.conclusion).toUpperCase() : null);
        const t = toMs(run && (run.completed_at || run.completedAt));
        if (t !== null) entry.completedAt.push(t);
    }
    return byJob;
}

/**
 * The freshness question, as two instants and nothing else.
 * @returns {'FRESH'|'STALE'|'WITHIN_GRACE'|'NO_EVIDENCE'}
 */
function freshness(newestCompletedMs, baseTipMs, graceMs) {
    if (newestCompletedMs === null || baseTipMs === null) return 'NO_EVIDENCE';
    const delta = newestCompletedMs - baseTipMs;
    // Each branch states its OWN condition. Written as a fall-through chain the
    // grace test read `delta <= graceMs`, which a NEGATIVE delta also satisfies,
    // so it was relying on the stale branch above to guard it. Mutation testing
    // found that: breaking the stale test sent stale runs into the grace branch
    // instead of past it, and a guard that only works while its neighbour works
    // is one edit from silence.
    if (delta <= 0) return 'STALE';
    if (delta > 0 && delta <= graceMs) return 'WITHIN_GRACE';
    return 'FRESH';
}

/**
 * The per-PR verdict. Pure: every input is already fetched, so the suite can
 * drive it without a transport and a reader can see the whole decision at once.
 *
 * @param {object} pr             number, baseRefName, headRefOid, isDraft, ...
 * @param {object} ctx            { baseTipMs, baseTipSha, trunk, graceMs,
 *                                  headRuns, headRunsComplete, baseJobNames }
 */
function assessPr(pr, ctx) {
    const reasons = [];
    const baseIsTrunk = pr.baseRefName === ctx.trunk;

    if (!baseIsTrunk) {
        reasons.push('base is ' + pr.baseRefName + ', NOT the trunk ' + ctx.trunk
            + '; GitHub measures a stacked PR against its stack parent, so neither this verdict '
            + 'nor its mergeable flag is a statement about the trunk');
    }

    // Rule 3: a truncated page is not the whole conclusion set, and half a set
    // cannot be judged. Refuse rather than judge the part that arrived.
    if (ctx.headRunsComplete === false) {
        reasons.push('the check-run page was truncated, so the whole conclusion set for this head was never read');
        return { verdict: VERDICT.UNMEASURED, subtype: 'TRUNCATED-SET', baseIsTrunk, reasons, jobs: [], freshness: null, newestCompletedMs: null };
    }

    const byJob = groupByJob(ctx.headRuns);
    const jobs = [];
    let good = 0, bad = 0, running = 0, notEvidence = 0, unrecognised = 0, disagreeing = 0;
    let newestCompletedMs = null;

    for (const [name, e] of byJob) {
        const distinct = [...new Set(e.classes)];
        // Rule 3 again: two runs of one job on one commit that disagree is not a
        // pass. Reporting the disagreement is the whole point of reading the set.
        if (distinct.length > 1 && distinct.includes('GOOD') && distinct.includes('BAD')) disagreeing++;
        if (e.classes.includes('BAD')) bad++;
        else if (e.classes.includes('UNRECOGNISED')) unrecognised++;
        else if (e.classes.includes('RUNNING')) running++;
        else if (e.classes.every((c) => c === 'NOT_EVIDENCE')) notEvidence++;
        else good++;
        for (const t of e.completedAt) if (newestCompletedMs === null || t > newestCompletedMs) newestCompletedMs = t;
        jobs.push({ name, runs: e.classes.length, classes: distinct, conclusions: e.conclusions });
    }

    // Rule 5, half one: a job the base tip runs and this head does not is ABSENT,
    // which on a board looks exactly like a job that passed.
    const headNames = new Set(byJob.keys());
    const absent = (ctx.baseJobNames || []).filter((n) => !headNames.has(n));

    const fresh = freshness(newestCompletedMs, ctx.baseTipMs, ctx.graceMs);

    // Freshness is asked FIRST and on its own. A red measured against a trunk
    // that has since moved is not a measurement of the merge you would perform,
    // so it does not get to be `measured-red` either — but the stale evidence is
    // carried forward by name rather than discarded.
    if (fresh === 'NO_EVIDENCE') {
        reasons.push(byJob.size === 0
            ? 'no check run exists on head ' + String(pr.headRefOid || '').slice(0, 12)
              + '; a board with nothing on it is not a green board'
            : 'no check run on this head has COMPLETED, so there is no instant to compare against the base tip');
        if (running > 0) {
            reasons.push(running + ' job(s) are still PENDING — which is also what a workflow skipped by path '
                + 'filtering leaves behind, so this is "did not run", not "is absent"');
        }
    } else if (fresh === 'STALE') {
        reasons.push('the newest completed check run (' + new Date(newestCompletedMs).toISOString()
            + ') PREDATES the tip of ' + pr.baseRefName + ' (' + new Date(ctx.baseTipMs).toISOString()
            + ' at ' + String(ctx.baseTipSha || '').slice(0, 12) + '), so it tested a merge that no longer exists');
    } else if (fresh === 'WITHIN_GRACE') {
        reasons.push('the newest completed check run post-dates the base tip by only '
            + Math.round((newestCompletedMs - ctx.baseTipMs) / 1000) + 's, inside the '
            + Math.round(ctx.graceMs / 1000) + 's window where the merge ref may not have been recomputed yet');
    }

    if (absent.length) {
        reasons.push(absent.length + ' job(s) run on the base tip and are ABSENT from this head: ' + absent.join(', ')
            + '; an absent job is indistinguishable from a passing one on the board');
    }
    if (disagreeing > 0) {
        reasons.push(disagreeing + ' job(s) reported BOTH a passing and a failing run on this same head; '
            + 'taking the latest would turn that coin-flip into a pass');
    }
    if (unrecognised > 0) reasons.push(unrecognised + ' job(s) reported a conclusion this script does not recognise');
    if (notEvidence > 0) reasons.push(notEvidence + ' job(s) only ever reported SKIPPED, which is absence, not a pass');
    if (pr.isDraft) reasons.push('it is a DRAFT, so a gate guarded by `draft == false` reports SKIPPED rather than running');

    const population = {
        jobsOnHead: byJob.size, checkRuns: (ctx.headRuns || []).length,
        passing: good, failing: bad, pending: running, skippedOnly: notEvidence,
        unrecognised, disagreeing, absentVsBase: absent.length,
    };

    let verdict, subtype;
    if (fresh === 'STALE' || fresh === 'NO_EVIDENCE' || fresh === 'WITHIN_GRACE') {
        verdict = VERDICT.UNMEASURED;
        subtype = fresh === 'STALE' ? 'STALE-EVIDENCE'
            : fresh === 'WITHIN_GRACE' ? 'INSIDE-RECOMPUTE-RACE'
                : byJob.size === 0 ? 'NO-CHECKS-AT-ALL' : 'NOTHING-COMPLETED';
    } else if (absent.length || unrecognised > 0 || running > 0 || notEvidence > 0 || disagreeing > 0) {
        verdict = VERDICT.UNMEASURED;
        subtype = absent.length ? 'ABSENT-JOB'
            : disagreeing > 0 ? 'DISAGREEING-RUNS'
                : running > 0 ? 'JOB-DID-NOT-RUN'
                    : notEvidence > 0 ? 'SKIPPED-ONLY' : 'UNRECOGNISED-CONCLUSION';
    } else if (bad > 0) {
        verdict = VERDICT.RED;
        subtype = 'FAILING-JOB';
        reasons.push(bad + ' job(s) failed on evidence newer than the base tip');
    } else {
        verdict = VERDICT.GREEN;
        subtype = 'FRESH-AND-PASSING';
    }

    return {
        number: pr.number, head: String(pr.headRefOid || '').slice(0, 12), base: pr.baseRefName,
        baseIsTrunk, isDraft: !!pr.isDraft,
        mergeable: pr.mergeable || null, mergeStateStatus: pr.mergeStateStatus || null,
        trunkClaim: baseIsTrunk ? 'this verdict is about ' + ctx.trunk
            : 'NONE — measured against ' + pr.baseRefName + ', not ' + ctx.trunk,
        verdict, subtype, freshness: fresh,
        newestCompletedAt: newestCompletedMs === null ? null : new Date(newestCompletedMs).toISOString(),
        baseTipAt: ctx.baseTipMs === null ? null : new Date(ctx.baseTipMs).toISOString(),
        baseTipSha: ctx.baseTipSha || null,
        population, jobs, absentJobs: absent, reasons,
    };
}

/** Branch tip sha and commit instant, or an error. Cached by the caller. */
function branchTip(repo, branch, cwd) {
    const r = ghJson(['api', 'repos/' + repo + '/commits/' + branch], cwd);
    if (!r.ok) return { ok: false, error: r.error };
    const sha = r.value && r.value.sha;
    const when = r.value && r.value.commit && r.value.commit.committer && r.value.commit.committer.date;
    const ms = toMs(when);
    if (!present(sha) || ms === null) return { ok: false, error: 'no tip commit or no commit date for ' + branch };
    return { ok: true, sha, ms };
}

/**
 * Every check run on a commit — `filter=all`, because the endpoint's DEFAULT is
 * `filter=latest` and that is exactly the latest-per-job read this refuses.
 * @returns {{ok:true, runs:Array, complete:boolean}|{ok:false,error:string}}
 */
function checkRunsFor(repo, sha, cwd) {
    const r = ghJson(['api', 'repos/' + repo + '/commits/' + sha + '/check-runs?filter=all&per_page=100'], cwd);
    if (!r.ok) return { ok: false, error: r.error };
    const runs = Array.isArray(r.value && r.value.check_runs) ? r.value.check_runs : [];
    const total = Number(r.value && r.value.total_count);
    const complete = !Number.isFinite(total) || total <= runs.length;
    return { ok: true, runs, complete };
}

/**
 * The whole scan. Every count it prints carries its denominator.
 * @param {object} opts { repo, cwd, graceMs, limit, only:number[] }
 */
function checkCiFreshness(opts) {
    const cwd = opts.cwd || process.cwd();
    const graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : DEFAULT_GRACE_SECONDS * 1000;

    let repo = opts.repo || null;
    let trunk = opts.trunk || null;
    if (!repo || !trunk) {
        const r = ghJson(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'], cwd);
        if (!r.ok) {
            return { blind: true, error: r.error, repo, trunk,
                population: { openPrs: null, examined: 0, measuredGreen: 0, measuredRed: 0, unmeasured: 0, couldNotCheck: 0 }, prs: [] };
        }
        repo = repo || (r.value && r.value.nameWithOwner);
        trunk = trunk || (r.value && r.value.defaultBranchRef && r.value.defaultBranchRef.name);
    }
    if (!present(repo) || !present(trunk)) {
        return { blind: true, error: 'could not establish the repo or its default branch', repo, trunk,
            population: { openPrs: null, examined: 0, measuredGreen: 0, measuredRed: 0, unmeasured: 0, couldNotCheck: 0 }, prs: [] };
    }

    const listed = ghJson(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(opts.limit || 100),
        '--json', 'number,baseRefName,headRefName,headRefOid,isDraft,mergeable,mergeStateStatus'], cwd);
    if (!listed.ok) {
        return { blind: true, error: listed.error, repo, trunk,
            population: { openPrs: null, examined: 0, measuredGreen: 0, measuredRed: 0, unmeasured: 0, couldNotCheck: 0 }, prs: [] };
    }
    const all = Array.isArray(listed.value) ? listed.value : [];
    const wanted = Array.isArray(opts.only) && opts.only.length
        ? all.filter((p) => opts.only.includes(Number(p.number)))
        : all;

    const tips = new Map();
    const baseJobs = new Map();
    const out = [];

    for (const pr of wanted) {
        const base = pr.baseRefName;
        if (!tips.has(base)) tips.set(base, branchTip(repo, base, cwd));
        const tip = tips.get(base);
        if (!tip.ok) {
            out.push({ number: pr.number, head: String(pr.headRefOid || '').slice(0, 12), base,
                baseIsTrunk: base === trunk, verdict: VERDICT.BLIND, subtype: 'NO-BASE-TIP',
                trunkClaim: 'NONE — the base tip could not be read',
                reasons: ['could not read the tip of ' + base + ': ' + tip.error],
                population: {}, jobs: [], absentJobs: [] });
            continue;
        }

        if (!baseJobs.has(tip.sha)) {
            const br = checkRunsFor(repo, tip.sha, cwd);
            baseJobs.set(tip.sha, br.ok ? [...groupByJob(br.runs).keys()] : null);
        }

        const head = checkRunsFor(repo, pr.headRefOid, cwd);
        if (!head.ok) {
            out.push({ number: pr.number, head: String(pr.headRefOid || '').slice(0, 12), base,
                baseIsTrunk: base === trunk, verdict: VERDICT.BLIND, subtype: 'NO-CHECK-RUNS',
                trunkClaim: 'NONE — the head check runs could not be read',
                reasons: [head.error], population: {}, jobs: [], absentJobs: [] });
            continue;
        }

        out.push(assessPr(pr, {
            baseTipMs: tip.ms, baseTipSha: tip.sha, trunk, graceMs,
            headRuns: head.runs, headRunsComplete: head.complete,
            baseJobNames: baseJobs.get(tip.sha) || [],
        }));
    }

    const count = (v) => out.filter((p) => p.verdict === v).length;
    return {
        blind: false, repo, trunk, graceSeconds: Math.round(graceMs / 1000),
        population: {
            openPrs: all.length, examined: out.length,
            measuredGreen: count(VERDICT.GREEN), measuredRed: count(VERDICT.RED),
            unmeasured: count(VERDICT.UNMEASURED), couldNotCheck: count(VERDICT.BLIND),
        },
        prs: out,
    };
}

/** Exit code for a result. Red outranks blindness outranks staleness. */
function exitCodeFor(result) {
    if (result.blind) return 3;
    const p = result.population;
    if (p.measuredRed > 0) return 1;
    if (p.couldNotCheck > 0) return 3;
    if (p.unmeasured > 0) return 2;
    return 0;
}

function render(result) {
    const out = [];
    if (result.blind) {
        out.push('  verdict: ' + VERDICT.BLIND);
        out.push('  ' + result.error);
        out.push('  population: 0 of unknown open PRs examined — this is not a clean scan, it is no scan');
        return out.join('\n');
    }
    const p = result.population;
    out.push('  repo ' + result.repo + '  trunk ' + result.trunk + '  grace ' + result.graceSeconds + 's');
    out.push('  population: ' + p.examined + ' of ' + p.openPrs + ' open PR(s) examined = '
        + p.measuredGreen + ' measured-green, ' + p.measuredRed + ' measured-RED, '
        + p.unmeasured + ' UNMEASURED, ' + p.couldNotCheck + ' COULD-NOT-CHECK');
    for (const pr of result.prs) {
        out.push('');
        out.push('  #' + pr.number + '  ' + pr.verdict + ' (' + pr.subtype + ')'
            + '  head ' + pr.head + ' -> ' + pr.base + (pr.baseIsTrunk ? '' : '  [STACKED]')
            + (pr.isDraft ? '  [DRAFT]' : ''));
        out.push('    trunk claim: ' + pr.trunkClaim);
        if (pr.population && pr.population.jobsOnHead !== undefined) {
            out.push('    jobs: ' + pr.population.jobsOnHead + ' job(s) over ' + pr.population.checkRuns
                + ' check run(s) = ' + pr.population.passing + ' passing, ' + pr.population.failing + ' failing, '
                + pr.population.pending + ' pending, ' + pr.population.skippedOnly + ' skipped-only, '
                + pr.population.unrecognised + ' unrecognised, ' + pr.population.disagreeing + ' disagreeing, '
                + pr.population.absentVsBase + ' absent vs base');
        }
        if (pr.newestCompletedAt || pr.baseTipAt) {
            out.push('    newest completed run ' + (pr.newestCompletedAt || '(none)')
                + '  vs base tip ' + (pr.baseTipAt || '(unknown)'));
        }
        for (const r of pr.reasons) out.push('    - ' + r);
    }
    if (p.examined === 0) out.push('\n  NOTE: zero PRs examined. That is a statement about the scan, not about the repo.');
    return out.join('\n');
}

function selftest() {
    let pass = 0, fail = 0;
    const t = (label, cond, detail) => {
        if (cond) { pass++; console.log('  ok   ' + label); }
        else { fail++; console.log('  FAIL ' + label + (detail ? '  (' + detail + ')' : '')); }
    };

    t('present: an empty string is not a value', present('') === false);
    t('present: 0 IS a value, unlike jq //', present(0) === true);
    t('toMs: a bad instant is null, never 0', toMs('not-a-date') === null);
    t('toMs: null in, null out', toMs(null) === null);
    t('toMs: a real instant parses', toMs('2026-09-11T19:38:03Z') === Date.parse('2026-09-11T19:38:03Z'));

    // The comparison, as two instants and nothing else.
    const G = 60000;
    t('freshness: a run older than the base tip is STALE', freshness(1000, 2000, G) === 'STALE');
    t('freshness: a run at exactly the base tip is STALE, not fresh', freshness(2000, 2000, G) === 'STALE');
    t('freshness: 14s after the tip is inside the recompute race', freshness(14000, 0, G) === 'WITHIN_GRACE');
    t('freshness: well after the tip is FRESH', freshness(120000, 0, G) === 'FRESH');
    t('freshness: no completed run is NO_EVIDENCE, not STALE', freshness(null, 2000, G) === 'NO_EVIDENCE');
    t('freshness: no base tip is NO_EVIDENCE, not FRESH', freshness(2000, null, G) === 'NO_EVIDENCE');

    t('SKIPPED is absence, not a pass', classifyRun({ status: 'completed', conclusion: 'skipped' }) === 'NOT_EVIDENCE');
    t('an in-progress run is RUNNING, not failing', classifyRun({ status: 'in_progress', conclusion: null }) === 'RUNNING');
    t('startup_failure is terminal-bad', classifyRun({ status: 'completed', conclusion: 'startup_failure' }) === 'BAD');
    t('an invented conclusion is UNRECOGNISED, never GOOD',
        classifyRun({ status: 'completed', conclusion: 'definitely_not_real' }) === 'UNRECOGNISED');

    const grouped = groupByJob([
        { name: 'test (ubuntu)', status: 'completed', conclusion: 'success', completed_at: '2026-09-10T10:00:00Z' },
        { name: 'test (ubuntu)', status: 'completed', conclusion: 'failure', completed_at: '2026-09-10T11:00:00Z' },
    ]);
    t('two runs of one job on one commit are kept as two, not collapsed',
        grouped.get('test (ubuntu)').classes.length === 2);
    t('the disagreement is visible in the group', grouped.get('test (ubuntu)').classes.includes('GOOD')
        && grouped.get('test (ubuntu)').classes.includes('BAD'));

    t('exitCodeFor: a measured-red outranks an unmeasured',
        exitCodeFor({ blind: false, population: { measuredRed: 1, couldNotCheck: 1, unmeasured: 5 } }) === 1);
    t('exitCodeFor: blindness outranks staleness',
        exitCodeFor({ blind: false, population: { measuredRed: 0, couldNotCheck: 1, unmeasured: 5 } }) === 3);
    t('exitCodeFor: an all-green scan is 0',
        exitCodeFor({ blind: false, population: { measuredRed: 0, couldNotCheck: 0, unmeasured: 0 } }) === 0);

    console.log('\nselftest: ' + pass + ' passed, ' + fail + ' failed');
    return fail === 0;
}

module.exports = {
    checkCiFreshness, assessPr, groupByJob, classifyRun, freshness, toMs, present,
    branchTip, checkRunsFor, exitCodeFor, render, selftest,
    VERDICT, DEFAULT_GRACE_SECONDS,
};

if (require.main === module) {
    const argv = process.argv.slice(2);
    const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

    if (argv.includes('--help')) {
        console.log('check-ci-freshness.js [--repo owner/name] [--pr N]... [--grace-seconds N] [--limit N] [--json]\n'
            + 'Refuses to call a PR green when its newest completed check run predates the tip it would merge into.\n'
            + 'Three outcomes and a fourth for blindness: measured-green, measured-red, UNMEASURED, COULD-NOT-CHECK.\n'
            + 'Exit 0 all green · 1 a measured RED · 3 a COULD-NOT-CHECK · 2 an UNMEASURED · 4 bad usage.');
        process.exitCode = 0;
    } else if (argv.includes('--selftest')) {
        process.exitCode = selftest() ? 0 : 1;
    } else {
        const graceRaw = Number(val('--grace-seconds', String(DEFAULT_GRACE_SECONDS)));
        if (!Number.isFinite(graceRaw) || graceRaw < 0) {
            console.error('--grace-seconds must be a non-negative number');
            process.exitCode = 4;
        } else {
            const only = [];
            for (let i = 0; i < argv.length; i++) if (argv[i] === '--pr' && argv[i + 1]) only.push(Number(argv[i + 1]));
            const result = checkCiFreshness({
                repo: val('--repo', null), cwd: process.cwd(), graceMs: graceRaw * 1000,
                limit: Number(val('--limit', '100')) || 100, only,
            });
            if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
            else console.log(render(result));
            // Rule 6: exitCode, not exit(). An immediate exit truncates this pipe.
            process.exitCode = exitCodeFor(result);
        }
    }
}
