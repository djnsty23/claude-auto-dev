#!/usr/bin/env node
'use strict';
// Tests for tooling/spawn-budget.js — the budget-and-classification policy the
// three load-flaky suites share.
//
// WHAT THIS IS FOR. `[measured 2026-09-07]` three suites went red under
// concurrent load and green when re-run serially. One reported a killed child as
// the subject exiting the wrong way, one reported the same timeout twice (once
// as infrastructure, once as two red assertions), and one printed
// "180 passed, 0 failed" while exiting 2. The module fixes the class; this suite
// is what stops it coming back.
//
// TWO THINGS IT DOES THAT THE MODULE'S OWN --selftest CANNOT.
//
//   1. It SPAWNS the CLI and reads the exit code. No in-process assertion can
//      see one, and the module's selftest is consumed by exit status.
//   2. It asserts a RELATIONAL property across the two reporting functions:
//      for every combination of failures and indeterminates, a non-zero exit
//      must be accompanied by a tally that says so. That is precisely the
//      invariant test-quota-tripwire violated, and no per-value assertion on
//      either function alone can decide it.
//
// It also guards the wiring: the three suites and the hook checker must not go
// back to a bare spawnSync with a fixed budget, which is the only way this class
// returns.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOLING = __dirname;
const SUBJECT = path.join(TOOLING, 'spawn-budget.js');
const sb = require('./spawn-budget.js');

let pass = 0, fail = 0, undecidedCount = 0;
const failures = [];
function check(label, ok, detail) {
    if (ok) pass++; else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : '  (' + detail + ')'}`);
}
// A case this run could not decide, because the child it needed never reached
// its first statement. Counted as infrastructure: exit 2, never a red.
function undecided(label, detail) {
    undecidedCount++;
    console.log(`INDETERMINATE  ${label}  (${detail})`);
}
// An assertion on a child run through sb.untilWrittenBeforeKill: graded only
// when some rung got the child to its first write before the kill.
function checkWritten(run, label, ok, detail) {
    if (!run.verdict) { undecided(label, run.trail); return; }
    check(label, ok, `${detail} [${run.trail}]`);
}
// The selftest has the same three outcomes. Exit 2 with no FAIL line is a case
// it could not decide, reported as such rather than as a red.
function checkSelftest(label, r, detail) {
    const out = r.stdout || '';
    const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
    if (r.status === 2 && fails.length === 0 && /, \d+ indeterminate/.test(out)) {
        undecided(label, out.split('\n').filter((l) => l.startsWith('INDETERMINATE')).join(' | '));
        return;
    }
    check(label, r.status === 0, detail + (fails.length ? ' -> ' + fails.join(' | ') : ''));
}

// --- the CLI contract, which only a subprocess can see ----------------------
{
    const st = spawnSync(process.execPath, [SUBJECT, '--selftest'], { encoding: 'utf8', timeout: 300000 });
    // NOTE the selftest pins AUTODEV_SPAWN_BUDGET_DEADLINE on itself in both
    // directions, so it is correct whether or not a parent published one.
    const childFails = (st.stdout || '').split('\n').filter((l) => l.startsWith('FAIL'));
    checkSelftest("the module's own --selftest is RUN here, so it is not a check nobody executes",
        st, `status=${st.status} signal=${st.signal}`);
    const m = /population: (\d+) assertions run, (\d+) passed, (\d+) failed/.exec(st.stdout || '');
    check('  and it reports the population it ran, not a bare verdict', !!m,
        JSON.stringify((st.stdout || '').slice(-200)));
    check('  with nothing failing', m && m[3] === '0',
        (m ? m[3] + ' failed' : 'no population line')
        + (childFails.length ? ': ' + childFails.join(' | ') : ''));
    check('  over a non-trivial number of cases', !!m && Number(m[1]) >= 20, m ? m[1] : 'none');

    // BOTH EXTREMES, ON EVERY MACHINE. The selftest above runs at whatever the box
    // happens to be doing, and this file's history is three assertions that were
    // true only in part of that range: `> base` is false at factor 1.0, `=== cap`
    // is false below the cap. Each passed standalone and went red in a gate.
    // Pinning the factor turns "the machine did not happen to expose it" into a
    // covered case.
    for (const pin of ['1', '8', '20']) {
        const r = spawnSync(process.execPath, [SUBJECT, '--selftest'], {
            encoding: 'utf8', timeout: 300000,
            env: { ...process.env, AUTODEV_SPAWN_BUDGET_FACTOR: pin },
        });
        checkSelftest(`  and it passes with the contention factor pinned at ${pin}, not only at whatever `
            + 'this machine happens to measure', r, `status=${r.status}`);
    }
    // The floor is the case that actually bit: an idle fast machine returns
    // exactly 1, and a strict `>` against the base is false there.
    const atFloor = spawnSync(process.execPath, [SUBJECT, '--probe'], {
        encoding: 'utf8', timeout: 300000,
        env: { ...process.env, AUTODEV_SPAWN_BUDGET_FACTOR: '0.01' },
    });
    check('  and a pinned factor below the floor is clamped up to 1, never used raw',
        /contention factor 1\.00/.test(atFloor.stdout || ''), (atFloor.stdout || '').trim());

    // AND WITH A PARENT DEADLINE PUBLISHED, which is how check-suites-can-fail.js
    // runs every suite. `[measured 2026-09-10]` the first clamp read
    // `max(FLOOR, min(ms, rem))` and so WIDENED every budget below the 1000 ms
    // floor — a 400 ms base became 1000 — and five of the selftest's assertions
    // about widening and about maxTimeout went red the moment a deadline existed.
    // The selftest alone could not see it: it is spawned without one here.
    const withDeadline = spawnSync(process.execPath, [SUBJECT, '--selftest'], {
        encoding: 'utf8', timeout: 300000,
        env: Object.assign({}, process.env,
            { [sb.DEADLINE_ENV]: String(Date.now() + 870000) }),
    });
    checkSelftest('  and the SAME selftest passes with a parent deadline published, the way the '
        + 'sweep runs every suite', withDeadline, `status=${withDeadline.status}`);
    const dm = /population: (\d+) assertions run/.exec(withDeadline.stdout || '');
    check('    over the same population, so the deadline did not silently skip cases',
        !!dm && !!m && dm[1] === m[1], `${dm && dm[1]} vs ${m && m[1]}`);

    const h = spawnSync(process.execPath, [SUBJECT, '--help'], { encoding: 'utf8', timeout: 60000 });
    check('--help RETURNS rather than doing anything, which check-entrypoints requires of '
        + 'every tooling/*.js', h.status === 0 && /usage:/.test(h.stdout || ''), `status=${h.status}`);

    const pr = spawnSync(process.execPath, [SUBJECT, '--probe'], { encoding: 'utf8', timeout: 300000 });
    const pm = /contention factor (\d+\.\d+)/.exec(pr.stdout || '');
    check('--probe prints a measured factor and exits 0', pr.status === 0 && !!pm,
        `status=${pr.status} out=${JSON.stringify((pr.stdout || '').slice(0, 120))}`);
    check('  and the factor is at or above the fast-machine floor of 1',
        !!pm && Number(pm[1]) >= 1, pm && pm[1]);

    const bare = spawnSync(process.execPath, [SUBJECT], { encoding: 'utf8', timeout: 60000 });
    check('run bare it prints usage and exits 0 rather than doing something destructive',
        bare.status === 0 && /usage:/.test(bare.stdout || ''), `status=${bare.status}`);
}

// --- the retry actually re-runs the child, and a widened budget can win ------
// On an idle machine the contention factor is ~1, so a child that is slow every
// time cannot be rescued by any budget and would prove nothing about the retry.
// This child is slow ONCE: it hangs on the first attempt and returns at once on
// the second. So a pass here means the retry re-executed the child, which is
// the half of variant C3 that variant A does not have.
//
// WHO NUMBERS THE ATTEMPT. The first draft let the child count its own runs in
// a marker file, which made "which attempt is this" depend on the child
// reaching its first statement. `[measured 2026-09-24]` with node startup held
// back 1500 ms (a NODE_OPTIONS --require shim matching this child only), the
// first attempt was killed before it counted, the retry then counted itself as
// run 1 and hung, and the suite went red on a correct module: "infrastructure
// status=null", "runs=0". So the PARENT numbers the attempts now, through a spy
// on child_process.spawnSync that writes the number to a file before each spawn
// and records the budget, wall time and pid of each. A late start can no longer
// renumber anything.
//
// That leaves one legitimate second shape. The first attempt can be killed
// before it logs, and the log then reads "2" alone. It is accepted only when
// the spy saw that first attempt spawned under the 700 ms base and running to
// its kill, so an attempt that ENDED early without logging is still graded. The stall control below takes
// that path deterministically on every run, so it is never untested code.
//
// THE RETRY'S BUDGET IS NOT THE CLAIM HERE. It is sized by the contention
// factor, which the selftest covers pinned at 1, 8 and 20. Pinned here at
// CONTENTION_MAX, so the retry gets 14 s instead of whatever the box measures,
// and only a stall past that is left undecided rather than red.
{
    const cp = require('child_process');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sb-suite-'));
    const realSpawnSync = cp.spawnSync;
    const pinnedBefore = process.env.AUTODEV_SPAWN_BUDGET_FACTOR;
    try {
        const attemptFile = path.join(dir, 'attempt');
        const log = path.join(dir, 'log');
        const child = path.join(dir, 'slow-once.js');
        // It LOGS every attempt that reached its first statement rather than
        // dropping a boolean marker. The first draft used a boolean, and
        // mutating the retry away left it passing: the child still ran once and
        // still wrote the flag, so an assertion labelled "executed twice" was
        // decided by "executed at all".
        fs.writeFileSync(child, `const fs=require('fs');\n`
            + `const k=fs.readFileSync(${JSON.stringify(attemptFile)},'utf8');\n`
            + `if (process.env.SB_STALL_FIRST && k==='1') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000);\n`
            + `fs.appendFileSync(${JSON.stringify(log)},k+'\\n');\n`
            + `if (k!=='1') process.exit(0);\n`
            + `setInterval(function(){}, 1000);\n`);

        let spawns = [];
        cp.spawnSync = function spy(command, args, opts) {
            fs.writeFileSync(attemptFile, String(spawns.length + 1));
            const started = Date.now();
            const res = realSpawnSync.apply(this, arguments);
            spawns.push({ budgetMs: opts && opts.timeout, wallMs: Date.now() - started, pid: res.pid });
            return res;
        };
        process.env.AUTODEV_SPAWN_BUDGET_FACTOR = String(sb.CONTENTION_MAX);
        const attempt = (extraEnv, retryOnTimeout) => {
            spawns = [];
            fs.rmSync(log, { force: true });
            const r = sb.runBudgeted(process.execPath, [child], {
                encoding: 'utf8', timeout: 700, retryOnTimeout,
                env: Object.assign({}, process.env, extraEnv),
            });
            const logged = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').join(',') : '';
            const killedAtBudget = (s) => !!s && s.wallMs >= 0.9 * s.budgetMs;
            // The first attempt ran out the BASE budget, not merely whatever
            // budget it was given: a module that spawned it under 1 ms would
            // otherwise leave "2" alone and pass as a stall.
            const firstRanOutBase = spawns.length > 0 && spawns[0].budgetMs === sb.clampToDeadline(700)
                && killedAtBudget(spawns[0]);
            const trail = spawns.map((s, i) => `attempt ${i + 1}: ${s.wallMs}ms of ${s.budgetMs}ms`).join(', ')
                + ` | logged "${logged}"`;
            return { r, logged, spawns: spawns.slice(), killedAtBudget, firstRanOutBase, trail };
        };

        const a = attempt({}, undefined);
        // Undecided only when the RETRY never reached its first statement
        // before its 14 s kill. Every other outcome is graded.
        const retryStalled = a.spawns.length === 2 && sb.timedOut(a.r)
            && !a.logged.split(',').includes('2') && a.killedAtBudget(a.spawns[1]);
        const grade = retryStalled ? (label) => undecided(label, a.trail) : check;
        grade('a child that blows the base budget is re-run', a.r.attempts === 2,
            `attempts=${a.r.attempts} | ${a.trail}`);
        grade('  and spawnSync was really called twice, counted by the spy and not by the module',
            a.spawns.length === 2, a.trail);
        grade('  and the second run is what produces the verdict',
            sb.classify(a.r) === 'verdict' && a.r.status === 0 && a.spawns.length === 2
                && a.r.pid === a.spawns[1].pid,
            `${sb.classify(a.r)} status=${a.r.status} | ${a.trail}`);
        grade('  and the child itself logged both executions, or only the second when the spy saw '
            + 'the first run out its budget',
            a.logged === '1,2' || (a.logged === '2' && a.firstRanOutBase), a.trail);

        // CONTROL for the second shape: the first attempt is held past its
        // budget on purpose, so it is killed before it logs. The retry must
        // still be graded, on "2" alone, with the spy's wall time as the reason.
        const s = attempt({ SB_STALL_FIRST: '1' }, undefined);
        const sStalled = s.spawns.length === 2 && sb.timedOut(s.r)
            && !s.logged.includes('2') && s.killedAtBudget(s.spawns[1]);
        (sStalled ? (label) => undecided(label, s.trail) : check)(
            '  control: a first attempt killed before it logged leaves "2" alone, and the retry '
            + 'still produces the verdict',
            s.logged === '2' && s.spawns.length === 2 && s.firstRanOutBase
                && sb.classify(s.r) === 'verdict' && s.r.status === 0 && s.r.pid === s.spawns[1].pid,
            `${sb.classify(s.r)} status=${s.r.status} | ${s.trail}`);

        // The control that makes the case above mean something: the same child,
        // with retry off, is infrastructure. Without this, "attempts===2" could
        // pass on a module that always ran twice and never classified anything.
        const n = attempt({}, false);
        check('  control: with the retry off the identical child is infrastructure, never a pass',
            n.r.attempts === 1 && n.spawns.length === 1 && sb.classify(n.r) === 'infrastructure',
            `attempts=${n.r.attempts} ${sb.classify(n.r)} | ${n.trail}`);
    } finally {
        cp.spawnSync = realSpawnSync;
        if (pinnedBefore === undefined) delete process.env.AUTODEV_SPAWN_BUDGET_FACTOR;
        else process.env.AUTODEV_SPAWN_BUDGET_FACTOR = pinnedBefore;
        try { fs.rmSync(dir, { recursive: true, force: true }); }
        catch (e) { console.error('suite fixture cleanup FAILED (' + (e.code || e.message) + ') — left at ' + dir); process.exitCode = 2; }
    }
}

// --- the relational property, which is the defect that started this ---------
// A per-value assertion on tally() or on exitCode() alone cannot decide this:
// both were individually correct in test-quota-tripwire, and their DISAGREEMENT
// was the bug. So compare them, over the whole matrix, and print the pair that
// fails rather than a count.
{
    const disagree = [];
    for (const p of [0, 1, 7]) {
        for (const f of [0, 1, 3]) {
            for (const i of [0, 1, 2]) {
                const line = sb.tally(p, f, i);
                const code = sb.exitCode(f, i);
                // The invariant: a reader must be able to derive the exit code
                // from the printed line alone.
                const lineSaysRed = /[1-9]\d* failed/.test(line) || /INDETERMINATE/.test(line);
                if ((code !== 0) !== lineSaysRed) disagree.push(`p=${p} f=${f} i=${i} -> exit ${code}, line ${JSON.stringify(line)}`);
            }
        }
    }
    check('over all 27 (passed, failed, indeterminate) combinations, a non-zero exit is always '
        + 'visible in the printed tally', disagree.length === 0, disagree.join(' ; '));
    check('  and the matrix really covered a red exit with a zero failure count — the exact '
        + 'shape that shipped', sb.exitCode(0, 1) === 2 && /INDETERMINATE/.test(sb.tally(180, 0, 1)),
        sb.tally(180, 0, 1));
    check('  while an all-green run still prints a bare line and exits 0',
        sb.tally(180, 0, 0) === '180 passed, 0 failed' && sb.exitCode(0, 0) === 0, sb.tally(180, 0, 0));
}

// --- the wiring, so the class cannot come back quietly ----------------------
// Each of these spawns its subject and reads an exit code, which is exactly the
// shape that needs a budget policy. A bare spawnSync here means a fixed budget
// chosen against an idle machine, and that is the whole defect.
{
    const WIRED = [
        'test-hook-execution-evidence.js',
        'test-path-filter-deadlock.js',
        'test-quota-tripwire.js',
        'find-untested-hooks.js',
    ];
    let scanned = 0;
    const offenders = [];
    const unwired = [];
    for (const name of WIRED) {
        const file = path.join(TOOLING, name);
        if (!fs.existsSync(file)) { unwired.push(name + ' (missing)'); continue; }
        scanned++;
        const src = fs.readFileSync(file, 'utf8');
        if (!/require\('\.\/spawn-budget\.js'\)/.test(src)) unwired.push(name);
        // Comments discussing spawnSync are fine; a CALL is not.
        if (/\bspawnSync\s*\(/.test(src)) offenders.push(name);
    }
    check(`all ${WIRED.length} subject-spawning files require the shared budget policy `
        + `(${scanned} read)`, scanned === WIRED.length && unwired.length === 0, unwired.join(', '));
    check('  and none of them still calls spawnSync directly with a fixed budget',
        offenders.length === 0, offenders.join(', '));
    // A population floor: an empty WIRED list would pass both assertions above.
    check('  population floor: the wiring check read a non-empty set', scanned >= 4, `scanned=${scanned}`);
}

// --- the parent deadline, end to end and OUT OF PROCESS ----------------------
// The module's selftest sets the variable on itself, which cannot show that a
// budget published by a PARENT reaches a child. This spawns one, which is the
// shape check-suites-can-fail.js uses: it gives each suite 900000 ms and now
// publishes a deadline so the budgets inside cannot outlive it.
//
// `[measured 2026-09-10]` four suites could self-grant more than that outer
// budget — test-entrypoints 69.2 min across its call sites, test-session-sweep
// 52, test-coordinator-write-guard 47.3, test-hook-execution-evidence 25 — so an
// inner timeout guaranteed the outer kill landed mid-retry and the suite never
// printed the INDETERMINATE line it had computed.
{
    const child = `
        const sb = require(${JSON.stringify(SUBJECT)});
        const t0 = Date.now();
        const r = sb.runBudgeted(process.execPath, ['-e', 'setInterval(function(){},1000)'],
            { encoding: 'utf8', timeout: 120000 });
        console.log(JSON.stringify({ spent: Date.now() - t0, budgetMs: r.budgetMs,
            attempts: r.attempts, reason: sb.reason(r) }));
    `;
    const deadlineMs = 2500;
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['-e', child], {
        encoding: 'utf8', timeout: 60000,
        env: Object.assign({}, process.env, { [sb.DEADLINE_ENV]: String(Date.now() + deadlineMs) }),
    });
    const wall = Date.now() - t0;
    let got = null;
    try { got = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { /* asserted */ }
    check('a child honours a deadline its PARENT published, not the 120s budget it asked for',
        !!got && got.spent < 30000 && wall < 45000,
        `wall=${wall}ms child=${JSON.stringify(got)} stderr=${(r.stderr || '').slice(0, 200)}`);
    check('  and the two attempts together still fit inside the published deadline window, '
        + 'which is the property the outer kill used to destroy',
        !!got && got.attempts >= 1 && got.budgetMs <= deadlineMs,
        `${JSON.stringify(got)}`);
    check('  and the child RAN and reported rather than being killed by the outer timeout, '
        + 'which is the whole difference: a verdict instead of a bare ETIMEDOUT',
        r.status === 0 && !r.error, `status=${r.status} error=${r.error && r.error.code}`);

    // The control. Without it the three above could pass on a machine where the
    // child simply happened to be fast, or on a module that ignored the budget
    // entirely and returned at once.
    // The control's env is BUILT, not inherited: check-suites-can-fail.js
    // publishes a deadline to this very suite, so inheriting it would clamp the
    // child the control exists to show unclamped — passing standalone and going
    // red inside the gate, which is the failure class this module is for.
    const noDeadlineEnv = Object.assign({}, process.env);
    delete noDeadlineEnv[sb.DEADLINE_ENV];
    const plain = spawnSync(process.execPath, ['-e', `
        const sb = require(${JSON.stringify(SUBJECT)});
        const t0 = Date.now();
        sb.runBudgeted(process.execPath, ['-e', 'setInterval(function(){},1000)'],
            { encoding: 'utf8', timeout: 4000, retryOnTimeout: false });
        console.log(String(Date.now() - t0));
    `], { encoding: 'utf8', timeout: 60000, env: noDeadlineEnv });
    const plainSpent = Number((plain.stdout || '0').trim());
    check('  CONTROL: with NO deadline published the identical call really does wait out its '
        + 'own budget, so the cases above are not passing on a fast child',
        plain.status === 0 && plainSpent >= 3500, `spent=${plainSpent}ms status=${plain.status}`);
}

// --- lastWords: the evidence a killed child leaves, which callers discarded ---
//
// Both real-child cases below need the child to WRITE before the kill, and a
// spawnSync timeout counts from the spawn, so node's startup races it.
// `[measured 2026-09-24]` a 48 ms idle child did not start within 1000 ms during
// a gate, and with startup held back 1500 ms by a shim both cases went red on a
// correct module ("ETIMEDOUT stdout=\"\""). So each child proves it wrote by
// creating a file AFTER its output, on a channel other than the pipes under
// test, and sb.untilWrittenBeforeKill re-runs only an attempt that was killed at
// its budget without that file, on 4x and then 16x. The first rung is the old
// 1200 ms, so a healthy run costs the same. An attempt that ended early is
// graded. A child that never starts on any rung is INDETERMINATE, never red.
const os = require('os');
const writtenThenHang = 'require("fs").writeFileSync(process.env.SB_READY_FILE,"1");setInterval(function(){},1000)';
const killedAfterWriting = (script, tag) => {
    const ready = path.join(os.tmpdir(), `sb-ready-${process.pid}-${tag}`);
    return sb.untilWrittenBeforeKill((ms) => spawnSync(process.execPath, ['-e', script + writtenThenHang],
        { encoding: 'utf8', timeout: ms, env: Object.assign({}, process.env, { SB_READY_FILE: ready }) }),
    ready, 1200);
};
{
    const run = killedAfterWriting('console.log("PASS  assertion one");console.log("PASS  assertion two");', 'lw');
    const r = run.r;
    checkWritten(run, 'a timed-out child still carries its output, so there is evidence to report',
        !!r.error && r.error.code === 'ETIMEDOUT' && (r.stdout || '').includes('assertion one'),
        `${r.error && r.error.code} stdout=${JSON.stringify((r.stdout || '').slice(0, 80))}`);
    checkWritten(run, '  and lastWords turns it into one bounded line naming what was in flight',
        sb.lastWords(r).includes('assertion two') && sb.lastWords(r).length < 600,
        sb.lastWords(r));
    check('  CONTROL: a silent child is reported as silent, not as the previous child\'s output',
        sb.lastWords({ stdout: '', stderr: '' }).includes('wrote nothing'),
        sb.lastWords({ stdout: '', stderr: '' }));
}

// --- lastWords: A CHILD THAT NEVER STARTED WAS NOT KILLED ---
//
// `[measured 2026-09-24]` a planted ENOENT reached a gate log through
// find-untested-hooks.js as "the child wrote nothing before it was killed".
// Real spawns, and the expected words are written here by hand rather than
// read from the module, so the selftest and this case cannot weaken together.
{
    const missing = spawnSync(process.execPath + '.missing', ['-e', '0'], { encoding: 'utf8' });
    check('a spawn of a missing executable really never started, or this proves nothing',
        !!missing.error && missing.error.code === 'ENOENT' && !(missing.pid > 0)
            && missing.status === null && missing.signal === null,
        `error=${missing.error && missing.error.code} pid=${missing.pid} status=${missing.status} signal=${missing.signal}`);
    check('  and lastWords says it never started, and never that it was killed',
        /never started/.test(sb.lastWords(missing)) && !/killed/.test(sb.lastWords(missing)),
        sb.lastWords(missing));
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(3)'], { encoding: 'utf8' });
    check('  and a silent child that exited 3 is reported as exited, not killed',
        exited.status === 3 && /exited/.test(sb.lastWords(exited)) && !/killed/.test(sb.lastWords(exited)),
        `status=${exited.status} -> ${sb.lastWords(exited)}`);
    const killed = spawnSync(process.execPath, ['-e', 'setInterval(function(){},1000)'],
        { encoding: 'utf8', timeout: 1 });
    check('  CONTROL: a silent child a 1 ms timeout killed is still reported as killed',
        !!killed.error && killed.error.code === 'ETIMEDOUT' && /killed/.test(sb.lastWords(killed)),
        `${killed.error && killed.error.code} pid=${killed.pid} -> ${sb.lastWords(killed)}`);
}

// --- lastWords: STDERR IS NOT THE TAIL OF STDOUT ---
//
// Every fixture above writes stderr LAST, so concatenating the two pipes
// happened to produce the right order and the bug was unreachable from them.
// This is the case they could not express: stderr written FIRST, stdout after
// it, then a hang. The old implementation reported the chronologically first
// line as the child's last output.
//
// Real spawned child, not a synthetic object: the ordering only exists when
// something actually writes in that order.
{
    const run = killedAfterWriting('process.stderr.write("WARN-WRITTEN-FIRST\\n");'
             + 'process.stdout.write("STDOUT-EARLIER\\n");'
             + 'process.stdout.write("STDOUT-TRUE-TAIL\\n");', 'order');
    const r = run.r;
    const lw = sb.lastWords(r);

    checkWritten(run, 'the child really did time out with both streams written, or this proves nothing',
        !!r.error && r.error.code === 'ETIMEDOUT'
            && (r.stdout || '').includes('STDOUT-TRUE-TAIL')
            && (r.stderr || '').includes('WARN-WRITTEN-FIRST'),
        `${r.error && r.error.code} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);

    // The assertion that goes red on the old implementation: its output was
    // `last output: "STDOUT-EARLIER | STDOUT-TRUE-TAIL | WARN-WRITTEN-FIRST"`,
    // so the stdout tail it presented ended with a stderr line.
    const stdoutLabel = /last stdout: "([^"]*)"/.exec(lw);
    checkWritten(run, 'stdout\'s reported tail is stdout\'s ACTUAL tail, not a stderr line appended to it',
        !!stdoutLabel && stdoutLabel[1].endsWith('STDOUT-TRUE-TAIL'),
        lw);
    checkWritten(run, '  and the stderr line is attributed to stderr rather than presented as last',
        !!stdoutLabel && !stdoutLabel[1].includes('WARN-WRITTEN-FIRST')
            && /last stderr: "[^"]*WARN-WRITTEN-FIRST/.test(lw),
        lw);

    // CONTROL, with provenance independent of the function: the literals below
    // are written here by hand, not derived from anything lastWords computes,
    // so weakening the function cannot weaken this case in the same motion.
    const planted = sb.lastWords({ stdout: 'A-OUT\n', stderr: 'B-ERR\n' });
    check('  CONTROL: with both streams present, each is reported under its own label',
        /last stdout: "A-OUT"/.test(planted) && /last stderr: "B-ERR"/.test(planted),
        planted);
    check('  CONTROL: a stderr-only child still reports its stderr, so the split did not drop it',
        /last stderr: "ONLY-ERR"/.test(sb.lastWords({ stdout: '', stderr: 'ONLY-ERR\n' })),
        sb.lastWords({ stdout: '', stderr: 'ONLY-ERR\n' }));
    check('  CONTROL: a stdout-only child is not given an empty stderr label',
        !/last stderr/.test(sb.lastWords({ stdout: 'ONLY-OUT\n', stderr: '' })),
        sb.lastWords({ stdout: 'ONLY-OUT\n', stderr: '' }));
    check('  and the two-stream line is still bounded, so the second label cannot flood it',
        sb.lastWords({ stdout: 'x'.repeat(50000), stderr: 'y'.repeat(50000) }, 200).length < 500,
        String(sb.lastWords({ stdout: 'x'.repeat(50000), stderr: 'y'.repeat(50000) }, 200).length));
}

// --- the sweep's two budgets: one number cannot serve two sizes of child ---
//
// check-suites-can-fail.js spawns a child per suite, and at checkRunner a child
// that is the WHOLE of test-all.js. They shared 900000 ms. Measured runtimes of
// that runner: 890s (2026-09-11) and 827s (2026-09-12) — so the budget was 1.1%
// above its own subject at worst, and the canary timed out on ordinary variation.
//
// Asserted by RUNNING sweepBudgetFor, not by grepping the sweep for a constant.
{
    const runner = sb.sweepBudgetFor('test-all.js');
    const perSuite = sb.sweepBudgetFor('test-pre-tool-filter.js');

    check('the whole-runner child gets a bigger budget than a single-suite child',
        runner > perSuite, `runner=${runner} perSuite=${perSuite}`);

    // Provenance independent of the module: 890000 and 900000 are written here by
    // hand. Deriving the floor from SWEEP_MEASURED_RUNNER_MS alone would let a
    // future edit lower the measurement and this assertion in one motion.
    check('  and it clears the worst MEASURED runner runtime with real headroom, not 1.1%',
        runner >= 2 * 890000, `runner=${runner} vs 2x890000=${2 * 890000}`);
    check('  and the recorded measurement still matches the one that sized it',
        sb.SWEEP_MEASURED_RUNNER_MS === 890000, String(sb.SWEEP_MEASURED_RUNNER_MS));

    // CONTROL: this must not become a blanket raise. The per-suite budget is the
    // number CLAUDE.md argues at length must NOT go up, and it has not.
    check('  CONTROL: the per-suite budget is unchanged at 900000, so this is not a blanket raise',
        perSuite === 900000, String(perSuite));
    check('  CONTROL: an unknown suite name gets the per-suite budget, not the runner one',
        sb.sweepBudgetFor('test-does-not-exist.js') === 900000,
        String(sb.sweepBudgetFor('test-does-not-exist.js')));

    // WIRING: the policy is worth nothing if the sweep still spawns on a literal.
    // Same shape as test-subject-evidence.js's wiring check, and the same
    // limitation — it reads source. The assertions above run the real function;
    // this one only proves the sweep asks it.
    const sweepSrc = fs.readFileSync(path.join(__dirname, 'check-suites-can-fail.js'), 'utf8');
    check('  the sweep derives its budget from sweepBudgetFor rather than a literal',
        /sb\.sweepBudgetFor\(suite\)/.test(sweepSrc), 'check-suites-can-fail.js does not call sweepBudgetFor');
    check('  and no longer hardcodes the 900000 literal it used to share',
        !/=\s*900000/.test(sweepSrc), 'a bare 900000 is still assigned in the sweep');
}

const infra = undecidedCount + (process.exitCode === 2 ? 1 : 0);
console.log(`\n${sb.tally(pass, fail, infra)}`);
console.log(`subject: tooling/spawn-budget.js; its own --selftest is spawned here so the exit `
    + `code is asserted, the retry is proven by a child that is slow exactly once, and the `
    + `tally/exit agreement is decided by comparing the pair over all 27 combinations.`);
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exit(sb.exitCode(fail, infra));
