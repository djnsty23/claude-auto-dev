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

let pass = 0, fail = 0;
const failures = [];
function check(label, ok, detail) {
    if (ok) pass++; else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : '  (' + detail + ')'}`);
}

// --- the CLI contract, which only a subprocess can see ----------------------
{
    const st = spawnSync(process.execPath, [SUBJECT, '--selftest'], { encoding: 'utf8', timeout: 300000 });
    // NOTE the selftest pins AUTODEV_SPAWN_BUDGET_DEADLINE on itself in both
    // directions, so it is correct whether or not a parent published one.
    const childFails = (st.stdout || '').split('\n').filter((l) => l.startsWith('FAIL'));
    check("the module's own --selftest is RUN here, so it is not a check nobody executes",
        st.status === 0,
        `status=${st.status} signal=${st.signal}`
        + (childFails.length ? ' -> ' + childFails.join(' | ') : ''));
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
        const fails = (r.stdout || '').split('\n').filter((l) => l.startsWith('FAIL'));
        check(`  and it passes with the contention factor pinned at ${pin}, not only at whatever `
            + 'this machine happens to measure', r.status === 0,
            `status=${r.status}` + (fails.length ? ' -> ' + fails.join(' | ') : ''));
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
    const dFails = (withDeadline.stdout || '').split('\n').filter((l) => l.startsWith('FAIL'));
    check('  and the SAME selftest passes with a parent deadline published, the way the '
        + 'sweep runs every suite', withDeadline.status === 0,
        `status=${withDeadline.status}` + (dFails.length ? ' -> ' + dFails.join(' | ') : ''));
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
// This child is slow ONCE: it counts its own runs and returns immediately from
// the second onwards. So a pass here means the retry re-executed the child,
// which is the half of variant C3 that variant A does not have.
{
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sb-suite-'));
    try {
        const marker = path.join(dir, 'runs');
        const child = path.join(dir, 'slow-once.js');
        // It TALLIES its runs rather than dropping a boolean marker. The first
        // draft used a boolean, and mutating the retry away left it passing —
        // the child still ran once and still wrote the flag, so an assertion
        // labelled "executed twice" was decided by "executed at all".
        fs.writeFileSync(child, `const fs=require('fs');\n`
            + `const M=${JSON.stringify(marker)};\n`
            + `const n=(fs.existsSync(M)?Number(fs.readFileSync(M,'utf8')):0)+1;\n`
            + `fs.writeFileSync(M,String(n));\n`
            + `if (n>1) process.exit(0);\n`
            + `setInterval(function(){}, 1000);\n`);

        const r = sb.runBudgeted(process.execPath, [child], { encoding: 'utf8', timeout: 700 });
        check('a child that blows the base budget is re-run', r.attempts === 2, `attempts=${r.attempts}`);
        check('  and the second run is what produces the verdict',
            sb.classify(r) === 'verdict' && r.status === 0, `${sb.classify(r)} status=${r.status}`);
        const runs = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0;
        check('  and the child itself counted exactly two executions', runs === 2, `runs=${runs}`);

        // The control that makes the case above mean something: the same child,
        // with retry off, is infrastructure. Without this, "attempts===2" could
        // pass on a module that always ran twice and never classified anything.
        fs.rmSync(marker, { force: true });
        const noRetry = sb.runBudgeted(process.execPath, [child],
            { encoding: 'utf8', timeout: 700, retryOnTimeout: false });
        check('  control: with the retry off the identical child is infrastructure, never a pass',
            noRetry.attempts === 1 && sb.classify(noRetry) === 'infrastructure',
            `attempts=${noRetry.attempts} ${sb.classify(noRetry)}`);
    } finally {
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
{
    const r = spawnSync(process.execPath,
        ['-e', 'console.log("PASS  assertion one");console.log("PASS  assertion two");'
             + 'setInterval(function(){},1000)'],
        { encoding: 'utf8', timeout: 1200 });
    check('a timed-out child still carries its output, so there is evidence to report',
        !!r.error && r.error.code === 'ETIMEDOUT' && (r.stdout || '').includes('assertion one'),
        `${r.error && r.error.code} stdout=${JSON.stringify((r.stdout || '').slice(0, 80))}`);
    check('  and lastWords turns it into one bounded line naming what was in flight',
        sb.lastWords(r).includes('assertion two') && sb.lastWords(r).length < 600,
        sb.lastWords(r));
    check('  CONTROL: a silent child is reported as silent, not as the previous child\'s output',
        sb.lastWords({ stdout: '', stderr: '' }).includes('wrote nothing'),
        sb.lastWords({ stdout: '', stderr: '' }));
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
    const r = spawnSync(process.execPath,
        ['-e', 'process.stderr.write("WARN-WRITTEN-FIRST\\n");'
             + 'process.stdout.write("STDOUT-EARLIER\\n");'
             + 'process.stdout.write("STDOUT-TRUE-TAIL\\n");'
             + 'setInterval(function(){},1000)'],
        { encoding: 'utf8', timeout: 1200 });
    const lw = sb.lastWords(r);

    check('the child really did time out with both streams written, or this proves nothing',
        !!r.error && r.error.code === 'ETIMEDOUT'
            && (r.stdout || '').includes('STDOUT-TRUE-TAIL')
            && (r.stderr || '').includes('WARN-WRITTEN-FIRST'),
        `${r.error && r.error.code} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);

    // The assertion that goes red on the old implementation: its output was
    // `last output: "STDOUT-EARLIER | STDOUT-TRUE-TAIL | WARN-WRITTEN-FIRST"`,
    // so the stdout tail it presented ended with a stderr line.
    const stdoutLabel = /last stdout: "([^"]*)"/.exec(lw);
    check('stdout\'s reported tail is stdout\'s ACTUAL tail, not a stderr line appended to it',
        !!stdoutLabel && stdoutLabel[1].endsWith('STDOUT-TRUE-TAIL'),
        lw);
    check('  and the stderr line is attributed to stderr rather than presented as last',
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

console.log(`\n${sb.tally(pass, fail, process.exitCode === 2 ? 1 : 0)}`);
console.log(`subject: tooling/spawn-budget.js; its own --selftest is spawned here so the exit `
    + `code is asserted, the retry is proven by a child that is slow exactly once, and the `
    + `tally/exit agreement is decided by comparing the pair over all 27 combinations.`);
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exit(sb.exitCode(fail, process.exitCode === 2 ? 1 : 0));
