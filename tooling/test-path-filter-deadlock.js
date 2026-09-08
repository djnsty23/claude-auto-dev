#!/usr/bin/env node
'use strict';

// Tests for scripts/check-path-filter-deadlock.js.
//
// THE RISK THIS SUITE IS ABOUT is a checker that cannot fire. This repo's own
// workflow carries no path filter at all, so a live run here reports zero
// forever and would look identical to a working check. Every case plants its
// own workflow fixture and points the checker at it.
//
// The suite drives the CLI rather than calling in-process, because the EXIT CODE
// is the contract here and it is unusual: this check is advisory by default and
// gates only under --strict. An in-process assertion cannot see that, and a
// finding that computes correctly while exiting the wrong way is a broken gate
// in whichever direction it is wrong.

const __sb = require('./spawn-budget.js');
// A STUBBED OR BROKEN HELPER IS A RED, NOT AN INDETERMINATE RUN.
// check-suites-can-fail.js proves a suite can fail by replacing its subject with
// `module.exports = {}` and requiring every covering suite to exit 1. Once these
// suites started requiring a shared helper, that stub made `runBudgeted`
// undefined; the resulting TypeError reached the uncaughtException handler,
// which correctly calls an unexpected throw INFRASTRUCTURE and exits 2 -- and
// the sweep reads a 2 as a REFUSAL, not a failure, so it reported a mid-sweep
// conflict and went INDETERMINATE. The honest classification poisoned the canary
// that proves the suite works. `[measured 2026-09-08]` found by the session on
// the same three suites; reproduced here at 55a841a with the stub applied by
// hand: two suites exited 2 and test-path-filter-deadlock, which has no
// uncaughtException handler, exited 1 -- three suites, one stub, two answers.
// A missing export is a defect in this repo's own code and belongs in the RED
// column. Only a CHILD PROCESS that produced no verdict is infrastructure.
for (const __fn of ['classify', 'reason', 'runBudgeted', 'tally', 'exitCode']) {
    if (typeof __sb[__fn] !== 'function') {
        console.error('FAIL  spawn-budget.js does not export ' + __fn + '() -- this suite\'s own '
            + 'helper is missing or stubbed. That is a RED, not an indeterminate run.');
        process.exit(1);
    }
}
const { classify, reason, runBudgeted, tally, exitCode } = __sb;
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-path-filter-deadlock.js');

let pass = 0;
let fail = 0;
let infra = 0;
const failures = [];
const indeterminate = [];
function check(label, ok, detail) {
    if (ok) pass++; else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pfd-suite-'));

function root(name, files) {
    const r = path.join(tmp, name);
    const wf = path.join(r, '.github', 'workflows');
    fs.mkdirSync(wf, { recursive: true });
    for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(wf, file), body);
    return r;
}

// A child that produced no verdict is INFRASTRUCTURE, and until 2026-09-07 this
// suite had no notion of one. A 20s budget blown under concurrent load came back
// with status null, and `s.status === 1` then printed
// `--strict turns the same finding into exit 1  (exit null)` -- a killed child
// reported as the checker exiting the wrong way, which is a claim about the code
// that the run had no evidence for. It cuts the other way too: `--help does not
// scan anything` asserts an ABSENCE, and empty stdout from a killed child
// satisfies it, so the same timeout produced a false GREEN in the same run.
//
// The assertions still print what they saw, as they do in
// test-hook-execution-evidence. What changed is that the tally and the exit code
// now say the run was indeterminate, so neither the red nor the green above can
// be read as a verdict about check-path-filter-deadlock.js.
// `expect` names an outcome this call site deliberately provokes, so it reaches
// the assertion instead of being absorbed. Only 'exit2' is used here: the
// no-workflows case drives the subject down its own indeterminate path on
// purpose, and that 2 is the answer being asserted, not a failure to answer.
function run(args, expect) {
    const r = runBudgeted(process.execPath, [SUBJECT].concat(args), { encoding: 'utf8', timeout: 20000 });
    if (classify(r, expect) === 'infrastructure') {
        infra++;
        const what = 'the subject run ' + JSON.stringify(args);
        indeterminate.push(what + ' (' + reason(r) + ')');
        console.error('infrastructure: ' + what + ' produced no verdict (' + reason(r)
            + '; ' + r.attempts + ' attempt(s), budget ' + r.budgetMs + 'ms)');
    }
    return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// --- the finding -----------------------------------------------------------
{
    const r0 = root('pr-filtered', {
        'gate.yml': 'name: G\non:\n  pull_request:\n    paths:\n      - src/**\njobs:\n  x:\n    runs-on: ubuntu-latest\n',
    });
    const r = run([r0]);
    check('a path filter on a pull_request trigger is reported',
        /AT RISK/.test(r.out) && /gate\.yml/.test(r.out));
    check('  and it is ADVISORY, exiting 0 by default',
        r.status === 0, `exit ${r.status}`);
    check('  the output names the PENDING consequence, not just the filter',
        /PENDING/.test(r.out) && /never merge/i.test(r.out));
    check('  and says plainly which half it cannot answer',
        /branch protection/i.test(r.out));
    check('  and names the one lookup that settles it',
        /required_status_checks/.test(r.out));
    check('  and gives the documented remedy rather than only the problem',
        /SAME NAME/.test(r.out));

    const s = run([r0, '--strict']);
    check('--strict turns the same finding into exit 1',
        s.status === 1 && /AT RISK/.test(s.out), `exit ${s.status}`);
}

// --- the negatives ---------------------------------------------------------
// The push-only case is the one that matters most: a filter there cannot
// withhold a pull request check, so reporting it would flag a shape that has
// nothing to do with merging.
{
    const r0 = root('push-only', {
        'cron.yml': 'name: C\non:\n  schedule:\n    - cron: "0 3 * * *"\n  push:\n    paths:\n      - state/**\njobs:\n  x:\n    runs-on: ubuntu-latest\n',
    });
    const r = run([r0]);
    check('a path filter on PUSH only is not reported',
        r.status === 0 && !/AT RISK/.test(r.out), `exit ${r.status}`);
    check('  and the clean message says what was actually established',
        /No pull_request trigger here carries a path filter/.test(r.out));

    const s = run([r0, '--strict']);
    check('  and --strict does not invent a finding either',
        s.status === 0 && !/AT RISK/.test(s.out), `exit ${s.status}`);
}

{
    const r0 = root('unfiltered', {
        'ci.yml': 'name: A\non: [push, pull_request]\njobs:\n  x:\n    runs-on: ubuntu-latest\n',
    });
    const r = run([r0]);
    check('the inline trigger form cannot express a filter and is not reported',
        r.status === 0 && !/AT RISK/.test(r.out), `exit ${r.status}`);
}

{
    const r0 = root('commented', {
        'g.yml': 'name: G\non:\n  pull_request:\n    # paths:\n    #   - src/**\njobs:\n  x:\n    runs-on: ubuntu-latest\n',
    });
    const r = run([r0]);
    check('a commented-out filter governs nothing and is not reported',
        r.status === 0 && !/AT RISK/.test(r.out), `exit ${r.status}`);
}

// --- population and the no-population case ---------------------------------
{
    const r0 = root('mixed', {
        'a.yml': 'name: A\non:\n  pull_request:\n    paths:\n      - src/**\njobs:\n  x:\n    runs-on: ubuntu-latest\n',
        'b.yml': 'name: B\non:\n  push:\n    paths:\n      - docs/**\njobs:\n  y:\n    runs-on: ubuntu-latest\n',
        'c.yml': 'name: C\non:\n  pull_request:\njobs:\n  z:\n    runs-on: ubuntu-latest\n',
    });
    const r = run([r0]);
    check('the population is printed beside the count, not just the finding',
        /3 workflow\(s\)/.test(r.out) && /1 with a path filter/.test(r.out));

    const j = run([r0, '--json']);
    let parsed = null;
    try { parsed = JSON.parse(j.out); } catch { /* stays null */ }
    check('--json carries the population and the findings',
        parsed && parsed.scanned === 3 && parsed.atRisk === 1 && Array.isArray(parsed.rows),
        'scanned=' + (parsed && parsed.scanned));
}

{
    const bare = path.join(tmp, 'bare');
    fs.mkdirSync(bare, { recursive: true });
    const r = run([bare], 'exit2');
    check('a root with no .github/workflows exits 2, never 0', r.status === 2, `exit ${r.status}`);
    check('  and says the run vouches for nothing', /vouches for NOTHING/.test(r.err));
}

// --- entry points ----------------------------------------------------------
{
    const r = run(['--selftest']);
    check('--selftest exits 0', r.status === 0, `exit ${r.status}`);
    check('  and reports its case count rather than a bare verdict',
        /\d+ passed, \d+ failed/.test(r.out) && /cases:/.test(r.out));

    const h = run(['--help']);
    check('--help exits 0 with usage', h.status === 0 && /usage:/.test(h.out));
    check('  and --help does not scan anything', !/workflow\(s\) in/.test(h.out));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${tally(pass, fail, infra)}`);
console.log(`subject: ${path.relative(path.resolve(__dirname, '..'), SUBJECT)}; every case plants its `
    + 'own workflow fixture, because this repo carries no path filter and a live run here would '
    + 'report zero forever. One positive, four negatives including a filter on push that cannot '
    + 'affect a pull request, and both exit modes asserted.');
if (fail) console.log(`failed: ${failures.join(' | ')}`);
if (infra) console.log(`indeterminate: ${indeterminate.join(' | ')}`);
process.exit(exitCode(fail, infra));
