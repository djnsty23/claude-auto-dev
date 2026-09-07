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
    check("the module's own --selftest is RUN here, so it is not a check nobody executes",
        st.status === 0, `status=${st.status} signal=${st.signal}`);
    const m = /population: (\d+) assertions run, (\d+) passed, (\d+) failed/.exec(st.stdout || '');
    check('  and it reports the population it ran, not a bare verdict', !!m,
        JSON.stringify((st.stdout || '').slice(-200)));
    check('  with nothing failing', m && m[3] === '0', m && m[3]);
    check('  over a non-trivial number of cases', !!m && Number(m[1]) >= 20, m ? m[1] : 'none');

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

console.log(`\n${sb.tally(pass, fail, process.exitCode === 2 ? 1 : 0)}`);
console.log(`subject: tooling/spawn-budget.js; its own --selftest is spawned here so the exit `
    + `code is asserted, the retry is proven by a child that is slow exactly once, and the `
    + `tally/exit agreement is decided by comparing the pair over all 27 combinations.`);
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exit(sb.exitCode(fail, process.exitCode === 2 ? 1 : 0));
