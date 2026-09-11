#!/usr/bin/env node
'use strict';
/**
 * spawn-budget.js - one answer to "the child did not finish in time", for the
 * suites that spawn their subject and read its exit code.
 *
 * WHY THIS EXISTS. `[measured 2026-09-07]` three suites went red on this machine
 * under concurrent load and green when re-run serially, at origin/main and at an
 * unrelated feature branch alike, so no change caused it:
 *
 *   test-hook-execution-evidence  10 passed, 2 failed - both `status=null
 *                                 signal=SIGTERM ETIMEDOUT`, plus an
 *                                 `infrastructure:` line. The timeout was
 *                                 counted TWICE, once correctly and once as
 *                                 two assertion failures.
 *   test-path-filter-deadlock     19 passed, 1 failed - "--strict turns the
 *                                 same finding into exit 1 (exit null)". A
 *                                 killed child, reported as a wrong exit code.
 *   test-quota-tripwire           "180 passed, 0 failed" AND a red exit. The
 *                                 exit was right; the printed tally never
 *                                 mentions the infrastructure verdict that
 *                                 produced it.
 *
 * Three shapes, one cause: every budget in tooling/ is a constant chosen against
 * an idle machine, and each suite invented its own handling for blowing it.
 *
 * WHAT WAS MEASURED BEFORE PICKING A DESIGN. A CPU-bound child costing 2.05s at
 * idle, a budget of 3000ms (the same ~1.5x headroom the real suites have), and
 * 120 busy workers on 14 cores. Trials are "did the child finish":
 *
 *   variant                                        idle   under load   ms/trial
 *   A  fixed budget                     (today)     4/4      0/4          3,040
 *   D  fixed budget + retry once, same budget       4/4      0/4          6,084
 *   C  scaled by a spawn-latency probe              4/4      1/4         12,510
 *   C2e scaled by a CPU probe taken at suite start   -       0/4         11,061
 *   C2 scaled by a CPU probe measured NOW           3/3      4/4         23,164
 *   G  plain fixed budget x10                       3/3      4/4         21,485
 *   C3 base budget; on timeout re-probe + retry      -       4/4         26,148
 *
 * Four of those refute something worth writing down.
 *
 *   - RETRYING AT THE SAME BUDGET BUYS NOTHING (D: 0/4, at exactly twice the
 *     cost). The load that blew the first attempt is still there for the second.
 *     "Retry once on timeout" is only a fix when the retry is given a DIFFERENT
 *     budget, which is what separates D from C3.
 *   - A SPAWN-LATENCY PROBE UNDER-MEASURES CONTENTION (C: 1/4). Bare `node -e 0`
 *     went 33ms -> 126-153ms, a factor of ~4, while CPU-bound work slowed ~9x on
 *     the same box at the same moment. The startup cost is dominated by fixed
 *     work that degrades sublinearly, so a probe built from it is systematically
 *     optimistic.
 *   - `os.loadavg()` IS NOT USABLE HERE AT ALL, and is not in the table because
 *     it never got as far as a trial. It read 133.8 and 22.0 while this machine
 *     was idle enough to start node in 33ms, and 55.9 while it was genuinely 8.6x
 *     contended. It lags by minutes in both directions.
 *   - A CACHED PROBE IS WORSE THAN NO PROBE (C2e: 0/4). Taken on a quiet machine
 *     it read 3.7 and the run then needed ~9; the inflated budget still blew, and
 *     cost 11s doing it. Contention has to be measured at the moment the question
 *     is asked, which is exactly the moment a timeout fires.
 *
 * SO: C3. Spend nothing on a healthy run - the base budget is used as-is and no
 * probe runs. On a timeout, measure contention right then and retry once with a
 * budget scaled by what was just measured. C2 and G also held (4/4), and G is the
 * boring variant, but both pay their inflated budget on EVERY run including an
 * idle one, so a genuinely hung child takes ~10x longer to detect on a quiet
 * machine. C3 keeps the base budget when nothing is contended.
 *
 * AND THE PART NO BUDGET CAN FIX. Under enough load the retry blows too. That is
 * not a defect, it is the honest answer: the run could not measure. What must
 * never happen is a suite reporting it as a claim about the code. So this module
 * also carries `classify`, and every caller is expected to keep three outcomes
 * apart in its PRINTED TALLY, not only in its exit code:
 *
 *      verdict          the child answered; the assertion decides
 *      infrastructure   no verdict; indeterminate, exit 2, never a red assertion
 *
 * A tally that reports only passed/failed while exiting 2 is the shape CLAUDE.md
 * warns about - a green message describing something other than the code.
 *
 *   node tooling/spawn-budget.js --help
 *   node tooling/spawn-budget.js --selftest
 *   node tooling/spawn-budget.js --probe     # print this machine's factor now
 */

const cp = require('child_process');

// The spin below costs this many ms on an idle Apple M4 Pro (node 24.19.0,
// median of 5: 125,125,126,126,132). It is a FAST-MACHINE FLOOR, not a
// per-machine calibration: a slower box legitimately reads above 1 and
// legitimately deserves a larger budget. Drift in this constant only ever sizes
// a retry that a timeout already justified, and CONTENTION_MAX bounds it.
const SPIN_FLOOR_MS = 120;
const SPIN_ITERATIONS = 2e7;
const CONTENTION_MAX = 20;

/**
 * How much slower is CPU-bound work on this machine RIGHT NOW than on an idle
 * fast one? Never cached: a factor measured before the load arrived is worse
 * than no factor at all (C2e above, 0/4).
 */
function contentionFactor() {
    // TEST-ONLY OVERRIDE, and it exists because this file shipped the same defect
    // three times: an assertion whose truth depended on where the ambient factor
    // happened to land. `> base` is false at factor 1.0 (an idle machine);
    // `=== cap` is false below the cap. Both passed standalone and went red in a
    // gate, which is the class this module exists to remove.
    //
    // The cure is not more careful assertions, it is DETERMINISM: the suite runs
    // the selftest pinned at the floor (1) and well above it, so both extremes
    // are covered on every machine instead of whichever one the box supplies.
    // It only ever sizes a retry that a timeout already justified, and it is
    // clamped exactly like a measured value.
    const pinned = process.env.AUTODEV_SPAWN_BUDGET_FACTOR;
    if (pinned !== undefined && pinned !== '') {
        const v = Number(pinned);
        if (Number.isFinite(v)) return Math.min(CONTENTION_MAX, Math.max(1, v));
    }
    const started = Date.now();
    let x = 0;
    for (let i = 0; i < SPIN_ITERATIONS; i++) x = (x * 31 + i) % 1000003;
    const spun = Date.now() - started || 1;
    // `x` is returned nowhere on purpose; referencing it keeps the loop from
    // being optimised away, which would make every factor read 1.
    if (x === Number.MAX_SAFE_INTEGER) throw new Error('unreachable');
    return Math.min(CONTENTION_MAX, Math.max(1, spun / SPIN_FLOOR_MS));
}

/**
 * Did this spawnSync result come back because OUR timeout killed it?
 * `timedOut` is not a spawnSync field; node reports it as an ETIMEDOUT error.
 */
function timedOut(r) {
    return !!(r && r.error && r.error.code === 'ETIMEDOUT');
}

/**
 * Classify a spawnSync result as a verdict or as infrastructure.
 *
 * `expect` says which otherwise-suspicious outcomes this call site deliberately
 * provoked, so they reach the assertion instead of being absorbed:
 *   'exit2'  the subject is being driven down a rejection path that exits 2
 *   'kill'   the child is a loop this call site ends BY DESIGN with its timeout
 *
 * Under 'kill' exactly one shape is a verdict - our timeout fired and the child
 * died to the SIGTERM it sent - plus an early numeric self-exit, which is the
 * behavioural red the scenario exists to catch and so must reach the assertion.
 */
function classify(r, expect) {
    if (expect === 'kill') {
        const ourKill = timedOut(r) && r.signal === 'SIGTERM' && r.status === null;
        const earlySelfExit = !r.error && !r.signal && (r.status === 0 || r.status === 1);
        return (ourKill || earlySelfExit) ? 'verdict' : 'infrastructure';
    }
    if (r.error || r.signal || r.status === null) return 'infrastructure';
    if (r.status === 2 && expect !== 'exit2') return 'infrastructure';
    return 'verdict';
}

/** One line naming why a result was classified infrastructure. */
function reason(r) {
    if (timedOut(r)) return 'ETIMEDOUT';
    if (r.error) return String(r.error.code || r.error.message);
    if (r.signal) return 'signal ' + r.signal;
    return 'status ' + r.status;
}

/**
 * How much wall time is left before a PARENT that will kill this process does so.
 *
 * WHY A MODULE ABOUT BUDGETS NEEDS TO KNOW ABOUT SOMEONE ELSE'S. Until now the
 * budget a suite grants itself and the budget its parent grants the suite were
 * two unrelated numbers, and `[measured 2026-09-10]` the inner one was the
 * LARGER for four suites: against check-suites-can-fail.js's fixed 900000 ms
 * per child, test-entrypoints can self-grant 69.2 min across its call sites
 * (73.5 min in execution — its three-name --help loop runs one site three
 * times), test-session-sweep 52 min, test-coordinator-write-guard 47.3 min and
 * test-hook-execution-evidence 25 min. test-entrypoints' --json call carries
 * `maxTimeout: 900000`, numerically identical to the whole outer budget, so ONE
 * widened retry can consume it alone.
 *
 * The consequence is not that things are slow, it is that NOBODY GETS TO
 * REPORT. The outer kill lands mid-retry, so the suite never reaches `tally` or
 * `exitCode` and never prints the `INDETERMINATE` line this module exists to
 * produce; the parent, holding only ETIMEDOUT, records a conflict and exits 2
 * with no cause. Three runs over five hours did exactly that and produced no
 * diagnosis between them.
 *
 * So a parent with a kill deadline publishes it, in epoch ms, and every budget
 * below is clamped to what remains. Absent the variable NOTHING changes — which
 * is the whole compatibility story for every file that calls in here.
 */
const DEADLINE_ENV = 'AUTODEV_SPAWN_BUDGET_DEADLINE';
const DEADLINE_FLOOR_MS = 1000;

function deadlineRemaining(now) {
    const raw = process.env[DEADLINE_ENV];
    if (raw === undefined || raw === '') return null;
    const at = Number(raw);
    if (!Number.isFinite(at)) return null;
    return at - (now === undefined ? Date.now() : now);
}

/**
 * Clamp a budget to the parent's deadline. Only ever NARROWS: the floor applies
 * to the remaining time, never to the budget, so a caller asking for less than
 * the floor still gets what it asked for.
 *
 * The floor is there because a deadline already blown must still let the attempt
 * run and fail honestly rather than turning into a zero-length spawn — a child
 * that never ran, reported as a child that did not finish, is a different lie
 * than the one being fixed.
 *
 * ⚠️ The first version was `max(FLOOR, min(ms, rem))`, which RAISED every budget
 * below the floor: a 400 ms base became 1000 ms, and five selftest assertions
 * about widening and about maxTimeout went red the moment a parent published a
 * deadline — passing standalone, failing inside the gate, which is the class this
 * module exists to remove. A clamp that can widen is not a clamp.
 */
function clampToDeadline(ms) {
    const rem = deadlineRemaining();
    if (rem === null) return ms;
    return Math.min(ms, Math.max(DEADLINE_FLOOR_MS, rem));
}

/**
 * The child's own account of itself, for the caller that has to report a result
 * carrying no exit code.
 *
 * `[measured 2026-09-10]` a spawnSync child killed on timeout comes back with
 * its stdout and stderr POPULATED — everything it managed to write before the
 * SIGTERM. Every suite here prints its assertions as it goes, so the last lines
 * name the assertion that was in flight. check-suites-can-fail.js's
 * `completed()` had all of it in hand at each of three timeouts and printed
 * `ETIMEDOUT` alone, which is why five hours of runs located nothing. A timeout
 * is going to cost its budget whatever happens; it may as well be spent on
 * evidence.
 */
function lastWords(r, maxBytes) {
    const cap = maxBytes === undefined ? 400 : maxBytes;

    // TWO PIPES ARE NOT ONE STREAM, and this used to pretend they were:
    // `String(r.stdout) + String(r.stderr)`, then the last three lines of the
    // concatenation, labelled `last output:`. Whenever the child wrote anything
    // at all to stderr, those stderr lines ARE the tail by construction — so a
    // warning emitted in the child's first second is reported as the last thing
    // it did, and the stdout that says where it actually got to is cut off
    // exactly when a reader needs it.
    //
    // `[measured 2026-09-11]` a child writing stderr FIRST, then two stdout
    // lines, then hanging until the kill, reported its chronologically FIRST
    // line as its last output. The fixtures could not see it: every one of them
    // wrote stderr last, so concatenating happened to give the right order, and
    // the control shared the subject's blind spot exactly.
    //
    // The real cost was a sweep conflict reading `test-all.js (runner canary
    // run) did not run (ETIMEDOUT) — last output: "...stale sandbox left by dead
    // pid ... verify and delete it manually"`. Those are stderr warnings about
    // OTHER sessions' leftovers. The runner prints `=== <suite> ===` to stdout
    // as it goes, so the one fact that would have said how far the canary got
    // was in the buffer and discarded by this function.
    //
    // Interleaving cannot be reconstructed after the fact from two separate
    // pipes — the ordering information is simply not in the result object. So
    // this reports each stream's own tail, labelled, and claims nothing about
    // which came last.
    const tailOf = (raw, bytes) => {
        const text = String(raw || '').replace(/\s+$/, '');
        if (!text) return null;
        const tail = text.length > bytes ? text.slice(-bytes) : text;
        const lines = tail.split('\n').filter((l) => l.trim()).slice(-3);
        return lines.length ? lines.join(' | ') : null;
    };
    // Both streams present: split the budget, so adding the second label cannot
    // widen the conflict line past what a single stream was already allowed.
    const share = (String(r && r.stdout || '').trim() && String(r && r.stderr || '').trim())
        ? Math.max(1, Math.ceil(cap / 2))
        : cap;
    const out = tailOf(r && r.stdout, share);
    const err = tailOf(r && r.stderr, share);
    if (!out && !err) return 'the child wrote nothing before it was killed';
    const parts = [];
    if (out) parts.push('last stdout: ' + JSON.stringify(out));
    if (err) parts.push('last stderr: ' + JSON.stringify(err));
    return parts.join(' · ');
}

/**
 * spawnSync with the C3 budget policy.
 *
 * opts.timeout      base budget in ms (required; there is no default worth one)
 * opts.retryOnTimeout   default true. Set false where a timeout is the EXPECTED
 *                   outcome - retrying there would wait out a deliberate budget
 *                   a second time, at a scaled multiple of it.
 * opts.maxTimeout   optional ceiling on the WIDENED budget. Contention is
 *                   clamped at 20, so an already-long base budget can widen a
 *                   long way: the 240s checker budget in
 *                   test-hook-execution-evidence would reach 80 minutes inside
 *                   `npm test`. A machine that contended produces an
 *                   indeterminate run either way, so the cap only bounds how
 *                   long the reader waits to be told so.
 * Every other option is passed through to spawnSync untouched.
 *
 * Returns the spawnSync result with three fields added:
 *   budgetMs   the budget the returned attempt actually ran under
 *   attempts   1, or 2 when a timeout was retried
 *   factor     the contention measured at the timeout, or null if none was
 */
function runBudgeted(command, args, opts) {
    const o = Object.assign({}, opts);
    const base = o.timeout;
    if (!(base > 0)) throw new Error('runBudgeted requires opts.timeout in ms');
    const retry = o.retryOnTimeout !== false;
    const cap = o.maxTimeout;
    delete o.retryOnTimeout;
    delete o.maxTimeout;
    if (cap !== undefined && !(cap >= base)) {
        throw new Error('opts.maxTimeout must be at least opts.timeout');
    }

    // Clamped to the parent's kill deadline if it published one, so the budget
    // this module grants can never outlive the budget something else is
    // enforcing on this process. See deadlineRemaining().
    const firstBudget = clampToDeadline(base);
    let r = cp.spawnSync(command, args, Object.assign(o, { timeout: firstBudget }));
    if (!timedOut(r) || !retry) {
        return Object.assign(r, { budgetMs: firstBudget, attempts: 1, factor: null });
    }
    // The child blew a budget that is comfortable on an idle machine. Ask how
    // contended this machine is at THIS moment, and give the retry that much
    // more room. Measured 4/4 where retrying at the same budget was 0/4.
    //
    // THE WIDENING IS INERT BELOW CORE SATURATION, and that is not a reason to
    // drop the retry. `[measured 2026-09-10, 14 cores]` contentionFactor() reads
    // 1.00 with 0 and with 7 extra busy workers, 1.38 at 14 and 2.47 at 28, so
    // at the 1-min loads this project's gate actually runs at (5-15) the retry
    // gets the SAME budget that just failed. What it still buys is RE-EXECUTION
    // — which is the whole point of the `slow-once` child in
    // test-spawn-budget.js, a child the retry rescues at any budget — so the
    // honest reading is that a quiet machine pays one extra full budget for a
    // second attempt and no extra head-room, not that the second attempt is
    // worthless. The cost is real either way, which is why the clamp below
    // matters: under a parent deadline that second budget can no longer be spent
    // past the moment the parent kills this process.
    const factor = contentionFactor();
    const widened = clampToDeadline(
        Math.min(cap === undefined ? Infinity : cap, Math.round(base * factor)));
    r = cp.spawnSync(command, args, Object.assign(o, { timeout: widened }));
    return Object.assign(r, { budgetMs: widened, attempts: 2, factor });
}

/**
 * The tally line every caller should print, so the summary a reader ends on
 * agrees with the exit code the runner reads.
 */
function tally(pass, fail, infra) {
    let line = `${pass} passed, ${fail} failed`;
    if (infra > 0) {
        line += `, ${infra} INDETERMINATE (infrastructure: a child produced no verdict, `
            + 'so this run is not a claim about the code)';
    }
    return line;
}

/** Exit precedence 2 -> 1 -> 0: indeterminate outranks red, red outranks green. */
function exitCode(fail, infra) {
    return infra > 0 ? 2 : (fail > 0 ? 1 : 0);
}

module.exports = {
    contentionFactor, timedOut, classify, reason, runBudgeted, tally, exitCode,
    lastWords, deadlineRemaining, clampToDeadline,
    SPIN_FLOOR_MS, CONTENTION_MAX, DEADLINE_ENV, DEADLINE_FLOOR_MS,
};

// --- CLI -------------------------------------------------------------------
// This file lives in tooling/ and is not a test-*.js, so check-entrypoints
// probes it with --help and requires it to RETURN. It also must do nothing
// destructive when run bare, which for a module means printing usage.
if (require.main === module) {
    const argv = process.argv.slice(2);
    if (argv.includes('--probe')) {
        const f = contentionFactor();
        console.log(`contention factor ${f.toFixed(2)} (floor ${SPIN_FLOOR_MS}ms, max ${CONTENTION_MAX})`);
        process.exit(0);
    }
    if (argv.includes('--selftest')) {
        // A real selftest, not a smoke test: every branch is driven against a
        // child whose outcome is forced, and each case names the shape it
        // proves. Population is printed, so an empty run is visible.
        const cases = [];
        const t = (label, ok, detail) => cases.push([label, ok, detail]);
        const NODE = process.execPath;

        const clean = runBudgeted(NODE, ['-e', 'process.exit(0)'], { encoding: 'utf8', timeout: 30000 });
        t('a clean child is a verdict', classify(clean) === 'verdict', classify(clean));
        t('  and costs exactly one attempt, with no probe', clean.attempts === 1 && clean.factor === null,
            `attempts=${clean.attempts} factor=${clean.factor}`);

        const red = runBudgeted(NODE, ['-e', 'process.exit(1)'], { encoding: 'utf8', timeout: 30000 });
        t('an exit 1 is a verdict, not infrastructure', classify(red) === 'verdict', classify(red));

        const two = runBudgeted(NODE, ['-e', 'process.exit(2)'], { encoding: 'utf8', timeout: 30000 });
        t('an UNEXPECTED exit 2 is infrastructure', classify(two) === 'infrastructure', classify(two));
        t('  and the same exit 2 is a verdict where the call site expects it',
            classify(two, 'exit2') === 'verdict', classify(two, 'exit2'));

        // A child that outlives any budget. Retry is disabled so the selftest
        // does not pay the widened budget twice.
        const HANG = 'setInterval(function () {}, 1000)';
        const hung = runBudgeted(NODE, ['-e', HANG], { encoding: 'utf8', timeout: 700, retryOnTimeout: false });
        t('a timed-out child is recognised as timed out', timedOut(hung), reason(hung));
        t('  and is infrastructure, never a red assertion', classify(hung) === 'infrastructure', classify(hung));
        t('  and reports ETIMEDOUT as its reason', reason(hung) === 'ETIMEDOUT', reason(hung));
        t('  and retryOnTimeout:false really does stop at one attempt', hung.attempts === 1,
            `attempts=${hung.attempts}`);

        const hungRetried = runBudgeted(NODE, ['-e', HANG], { encoding: 'utf8', timeout: 400 });
        t('a timeout is retried once by default', hungRetried.attempts === 2, `attempts=${hungRetried.attempts}`);
        t('  and the retry budget is never NARROWER than the first attempt, and equals '
            + 'the base scaled by the measured factor — the whole difference between '
            + 'variant C3 and variant D, which reuses the same budget',
            hungRetried.budgetMs >= 400
                && hungRetried.budgetMs === Math.round(400 * hungRetried.factor),
            `budgetMs=${hungRetried.budgetMs} factor=${hungRetried.factor}`);
        t('  and the widening is the contention measured at the timeout',
            hungRetried.factor !== null && hungRetried.budgetMs === Math.round(400 * hungRetried.factor),
            `factor=${hungRetried.factor} budgetMs=${hungRetried.budgetMs}`);
        t('  and a retried timeout is still infrastructure, not a pass',
            classify(hungRetried) === 'infrastructure', classify(hungRetried));

        const f = contentionFactor();
        t('the contention factor is a real number at or above the floor of 1',
            typeof f === 'number' && f >= 1 && f <= CONTENTION_MAX, String(f));

        // The kill contract, which is the one shape where a timeout is the
        // ANSWER. Driven against a real loop child rather than a hand-built
        // object, so it exercises the same fields a call site will see.
        const loop = runBudgeted(NODE, ['-e', HANG], { encoding: 'utf8', timeout: 700, retryOnTimeout: false });
        t("under expect:'kill' our own timeout kill is the verdict",
            classify(loop, 'kill') === 'verdict', classify(loop, 'kill'));
        const early = runBudgeted(NODE, ['-e', 'process.exit(0)'], { encoding: 'utf8', timeout: 30000 });
        t("under expect:'kill' an early self-exit reaches the assertion rather than "
            + 'being absorbed as infrastructure', classify(early, 'kill') === 'verdict',
            classify(early, 'kill'));
        // The remaining 'kill' shapes are the ones a real child cannot be made
        // to produce identically on every platform, so they are driven as
        // literal results. That is still the real classify() over the real
        // fields; only the way the fields were obtained differs.
        //
        // The first draft of this case DID spawn a child, with
        // `process.kill(process.pid, "SIGUSR1")`. It failed, and the code was
        // right: node's default SIGUSR1 handler opens the debugger rather than
        // terminating, so the child exited 0 and classify correctly called it
        // an early self-exit. The mutation was wrong, not the subject.
        const asIf = (over) => Object.assign({ error: undefined, signal: null, status: null }, over);
        t("under expect:'kill' a SIGKILL is infrastructure, not our SIGTERM timeout",
            classify(asIf({ error: { code: 'ETIMEDOUT' }, signal: 'SIGKILL' }), 'kill') === 'infrastructure');
        t("under expect:'kill' a self-SIGTERM with no timeout is infrastructure, which is "
            + 'the shape that got through when the signal was asserted alone',
            classify(asIf({ signal: 'SIGTERM' }), 'kill') === 'infrastructure');
        t("under expect:'kill' an ETIMEDOUT carrying a numeric status is infrastructure",
            classify(asIf({ error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM', status: 0 }), 'kill') === 'infrastructure');
        t('  control: the shape those three are contrasted with really is a verdict, '
            + 'so they are not all passing on a classify that says infrastructure to everything',
            classify(asIf({ error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM' }), 'kill') === 'verdict');

        t('the tally line stays quiet when nothing was indeterminate',
            tally(3, 1, 0) === '3 passed, 1 failed', tally(3, 1, 0));
        t('  and names the indeterminate count when there was one',
            /^7 passed, 0 failed, 2 INDETERMINATE/.test(tally(7, 0, 2)), tally(7, 0, 2));
        t('exit precedence puts infrastructure above a red assertion',
            exitCode(5, 1) === 2 && exitCode(5, 0) === 1 && exitCode(0, 0) === 0,
            `${exitCode(5, 1)}/${exitCode(5, 0)}/${exitCode(0, 0)}`);

        // A cap set EQUAL to the base always binds, because the factor is clamped
        // at or above 1 and so the widened budget can never fall below the base.
        // That makes this decidable without knowing how fast the machine is.
        //
        // It is worth saying why, because the first draft got it wrong in the
        // way this whole module exists to prevent: it used base 300 with a cap
        // of 450 and asserted the result was exactly 450, which holds only when
        // the factor exceeds 1.5. On an idle fast machine the factor sits near
        // 1, so it passed standalone and went red in a full gate run — a
        // machine-speed dependent assertion, inside the module for removing
        // machine-speed dependent assertions.
        const capped = runBudgeted(NODE, ['-e', HANG],
            { encoding: 'utf8', timeout: 300, maxTimeout: 300 });
        t('maxTimeout caps the widened retry budget', capped.attempts === 2 && capped.budgetMs === 300,
            `attempts=${capped.attempts} budgetMs=${capped.budgetMs}`);
        t('  and the cap holds whatever the factor measured, rather than only when it is small',
            capped.budgetMs <= 300 && capped.factor >= 1, `budgetMs=${capped.budgetMs} factor=${capped.factor}`);
        t('  control: without a cap the SAME base widens to the measured factor instead, so '
            + 'the cap is what clamped it and not an incidental equality',
            hungRetried.budgetMs === Math.round(400 * hungRetried.factor)
                && hungRetried.budgetMs >= 400, `budgetMs=${hungRetried.budgetMs} factor=${hungRetried.factor}`);

        // THE PARENT DEADLINE. Driven against a real hung child, and both
        // directions are covered on every machine rather than whichever one the
        // box supplies: absent the variable nothing changes, present it the
        // budget is what REMAINS and not what was asked for.
        //
        // THE VARIABLE IS CONTROLLED, NOT OBSERVED. The first draft read the
        // ambient environment for the "no deadline" half, and that is the exact
        // trap the factor-pinning block above exists to close: this selftest is
        // spawned by check-suites-can-fail.js, which now PUBLISHES a deadline to
        // every suite it runs, so an assertion that nothing is published would
        // have passed standalone and gone red inside the gate. Both halves are
        // pinned, and the restore is in a finally.
        {
            const saved = process.env[DEADLINE_ENV];
            try {
                delete process.env[DEADLINE_ENV];
                t('with no deadline published, deadlineRemaining() is null',
                    deadlineRemaining() === null, String(deadlineRemaining()));
                t('  and clampToDeadline is then the identity, so every caller that publishes '
                    + 'nothing is untouched',
                    clampToDeadline(123456) === 123456, String(clampToDeadline(123456)));
                // A deadline 1200ms out against a 60000ms base: the attempt must
                // run for about the REMAINDER, not the base, and must not be
                // rounded down to nothing.
                process.env[DEADLINE_ENV] = String(Date.now() + 1200);
                const rem = deadlineRemaining();
                t('a published deadline is read as the time remaining',
                    rem !== null && rem > 0 && rem <= 1200, String(rem));
                t('  and a large budget is clamped down to it',
                    clampToDeadline(60000) <= 1200, String(clampToDeadline(60000)));
                const t0 = Date.now();
                const near = runBudgeted(NODE, ['-e', HANG],
                    { encoding: 'utf8', timeout: 60000, retryOnTimeout: false });
                const spent = Date.now() - t0;
                t('  and a 60s budget under a 1.2s deadline really does end in about 1.2s, '
                    + 'which is the whole defect: an inner budget outliving the outer one',
                    timedOut(near) && spent < 20000, `spent=${spent}ms ${reason(near)}`);
                t('  and the attempt reports the CLAMPED budget it ran under, not the one asked for',
                    near.budgetMs <= 1200, `budgetMs=${near.budgetMs}`);

                // A deadline already in the past must still spawn. Returning a
                // zero-length budget would trade this module's failure mode for
                // a different one — a child that never ran, reported as a child
                // that did not finish.
                process.env[DEADLINE_ENV] = String(Date.now() - 5000);
                t('a deadline already blown clamps to the floor rather than to zero',
                    clampToDeadline(60000) === DEADLINE_FLOOR_MS, String(clampToDeadline(60000)));
                const past = runBudgeted(NODE, ['-e', 'process.exit(3)'],
                    { encoding: 'utf8', timeout: 60000, retryOnTimeout: false });
                t('  and a fast child under a blown deadline still runs and still answers',
                    past.status === 3, `status=${past.status} ${reason(past)}`);

                // The clamp must only ever NARROW. This is the assertion the
                // first draft lacked, and its absence cost five reds.
                process.env[DEADLINE_ENV] = String(Date.now() + 600000);
                t('a budget SMALLER than the deadline floor is left alone, never widened to it',
                    clampToDeadline(400) === 400, String(clampToDeadline(400)));
                t('  and a budget comfortably inside a distant deadline is untouched',
                    clampToDeadline(30000) === 30000, String(clampToDeadline(30000)));
                process.env[DEADLINE_ENV] = String(Date.now() - 5000);
                t('  and even under a BLOWN deadline a small budget is not inflated to the floor',
                    clampToDeadline(400) === 400, String(clampToDeadline(400)));

                process.env[DEADLINE_ENV] = 'not-a-number';
                t('an unparseable deadline is ignored, never treated as zero',
                    deadlineRemaining() === null && clampToDeadline(777) === 777,
                    `${deadlineRemaining()} / ${clampToDeadline(777)}`);
            } finally {
                if (saved === undefined) delete process.env[DEADLINE_ENV];
                else process.env[DEADLINE_ENV] = saved;
            }
        }

        // lastWords: the evidence a killed child leaves behind, which the caller
        // reporting ETIMEDOUT currently throws away.
        {
            const noisy = runBudgeted(NODE,
                ['-e', 'console.log("PASS  first");console.log("PASS  second");'
                     + 'console.error("working on third");setInterval(function(){},1000)'],
                { encoding: 'utf8', timeout: 900, retryOnTimeout: false });
            t('a killed child still carries the output it managed to write',
                timedOut(noisy) && (noisy.stdout || '').includes('PASS  first'),
                `${reason(noisy)} stdout=${JSON.stringify((noisy.stdout || '').slice(0, 60))}`);
            const lw = lastWords(noisy);
            t('  and lastWords names the work that was in flight when it died',
                lw.includes('PASS  second') && lw.includes('working on third'), lw);
            t('  and it is bounded, so a chatty child cannot flood the conflict line',
                lastWords({ stdout: 'x'.repeat(50000) }, 200).length < 400,
                String(lastWords({ stdout: 'x'.repeat(50000) }, 200).length));
            t('  and a child that wrote nothing says so rather than returning an empty string',
                lastWords({ stdout: '', stderr: '' }) === 'the child wrote nothing before it was killed',
                lastWords({ stdout: '', stderr: '' }));
            t('  control: a child that DID write is not reported as silent, so the line '
                + 'above is not passing on a function that says "nothing" to everything',
                lastWords({ stdout: 'something\n' }) !== 'the child wrote nothing before it was killed',
                lastWords({ stdout: 'something\n' }));
            // The fixture above writes stderr LAST, which is why concatenating the
            // two pipes looked correct for as long as it did. This one writes it
            // FIRST: the stderr line must not be presented as the tail of stdout.
            const ordered = runBudgeted(NODE,
                ['-e', 'process.stderr.write("WARN-FIRST\\n");'
                     + 'process.stdout.write("OUT-LAST\\n");setInterval(function(){},1000)'],
                { encoding: 'utf8', timeout: 900, retryOnTimeout: false });
            const ow = lastWords(ordered);
            t('  and a stderr line written FIRST is attributed to stderr, not reported as the last stdout',
                /last stdout: "[^"]*OUT-LAST"/.test(ow) && /last stderr: "[^"]*WARN-FIRST/.test(ow), ow);
        }

        let bad = false;
        try { runBudgeted(NODE, ['-e', '0'], { encoding: 'utf8' }); } catch { bad = true; }
        t('a missing budget is refused rather than silently defaulted', bad);

        let capBad = false;
        try { runBudgeted(NODE, ['-e', '0'], { encoding: 'utf8', timeout: 500, maxTimeout: 100 }); }
        catch { capBad = true; }
        t('a maxTimeout below the base budget is refused, not silently narrowing it', capBad);

        let p = 0, fl = 0;
        for (const [label, ok, detail] of cases) {
            console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : '  (' + detail + ')'}`);
            ok ? p++ : fl++;
        }
        console.log(`\npopulation: ${cases.length} assertions run, ${p} passed, ${fl} failed`);
        process.exit(fl ? 1 : 0);
    }
    console.log('usage: node tooling/spawn-budget.js [--selftest|--probe]');
    console.log('  A library for suites that spawn their subject: a base budget, and on a');
    console.log('  timeout one retry at a budget scaled by contention measured at that moment.');
    console.log('  Required by test-hook-execution-evidence, test-path-filter-deadlock and');
    console.log('  test-quota-tripwire. Measurements behind the policy are in the header.');
    process.exit(0);
}
