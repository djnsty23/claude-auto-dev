#!/usr/bin/env node
'use strict';

// Tests for scripts/check-draft-skip-guard.js.
//
// THE RISK THIS SUITE IS ABOUT is a checker that cannot fire. This repo's own
// workflow carries NO draft-skip guard, so a live run here reports zero forever
// and would look identical to a working check. Every case below therefore plants
// its own workflow fixture and points the checker at it.
//
// Both arms are asserted. One planted positive that must be reported, and three
// near-misses that must not, each failing for a different reason: a guard on a
// pull_request-only workflow (correct usage), a push trigger with no guard
// (nothing to defeat), and a root with no workflows at all (no population).

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-draft-skip-guard.js');

let pass = 0;
let fail = 0;
const failures = [];
function check(label, ok, detail) {
    if (ok) pass++; else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-suite-'));

/** A root carrying one workflow with the given body. */
function root(name, body) {
    const r = path.join(tmp, name);
    const wf = path.join(r, '.github', 'workflows');
    fs.mkdirSync(wf, { recursive: true });
    fs.writeFileSync(path.join(wf, 'ci.yml'), body);
    return r;
}

function run(args) {
    const r = spawnSync(process.execPath, [SUBJECT].concat(args), { encoding: 'utf8', timeout: 20000 });
    return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const GUARD = '    if: github.event.pull_request.draft == false\n';

// --- the positive: this check can fire ------------------------------------
{
    const r = run([root('inert', 'name: CI\non: [push, pull_request]\njobs:\n  test:\n' + GUARD)]);
    check('a guard beside a push trigger exits 1', r.status === 1, 'exit ' + r.status);
    check('  and names the file', /\.github[/\\]workflows[/\\]ci\.yml/.test(r.out));
    check('  and says WHY it is inert, not merely that it is',
        /null on a push event/.test(r.out));
    check('  and prints the population before the verdict',
        /1 workflow\(s\) in .*, 1 carrying a draft-skip guard/.test(r.out));
}
{
    // The mapping form, which looks nothing like the inline one. UNFILTERED:
    // this fixture read `branches: [main]` when first written, which made it a
    // CORRECT workflow asserted as inert, and it passed because the subject was
    // wrong in the same direction. A fixture and an assertion sharing an error
    // agree with each other perfectly and prove nothing.
    const body = 'name: CI\non:\n  push:\n    paths-ignore:\n      - docs/**\n  pull_request:\njobs:\n  test:\n' + GUARD;
    const r = run([root('inert-map', body)]);
    check('the `on:` / `  push:` mapping form with no branch filter is caught too',
        r.status === 1, 'exit ' + r.status);
}

// --- the near-misses, each silent for a different reason -------------------
{
    const body = 'name: CI\non:\n  pull_request:\n    types: [opened, ready_for_review, synchronize]\njobs:\n  test:\n' + GUARD;
    const r = run([root('working', body)]);
    check('a guard on a pull_request-ONLY workflow exits 0', r.status === 0, 'exit ' + r.status);
    check('  and is still counted as carrying a guard, not ignored',
        /1 carrying a draft-skip guard/.test(r.out));
    check('  and does NOT print the not-an-endorsement note, which is for the no-guard case',
        !/NOT an endorsement/.test(r.out));
}

// THE CASE THAT CAUGHT THE FIRST VERSION OF THE SUBJECT, and the reason this
// block exists at all. A push filtered to a trunk branch never fires where draft
// PRs live, so it cannot defeat the guard. The first version asked "does this
// trigger on push" and reported a correct workflow as INERT on its first run
// against a repo that was not this one. I relayed that to a peer as an
// instruction to seven sessions before reading the file.
{
    const body = 'name: CI\non:\n  push:\n    branches:\n      - main\n  pull_request:\njobs:\n  test:\n' + GUARD;
    const r = run([root('filtered-block', body)]);
    check('a push filtered to main does NOT defeat the guard (block list form)',
        r.status === 0, 'exit ' + r.status);
    check('  and it is not quietly downgraded to unclear either',
        !/could not tell/i.test(r.out));
}
{
    const body = 'name: CI\non:\n  push:\n    branches: [main, master]\n  pull_request:\njobs:\n  test:\n' + GUARD;
    check('the inline `branches: [main, master]` form is also safe',
        run([root('filtered-inline', body)]).status === 0);
}
// A glob could match a feature branch. Refusing to guess is the point: a wrong
// confident verdict here sends somebody to change working CI.
{
    const body = 'name: CI\non:\n  push:\n    branches: [release/*]\n  pull_request:\njobs:\n  test:\n' + GUARD;
    const r = run([root('glob', body), '--json']);
    let p = null;
    try { p = JSON.parse(r.out); } catch { /* stays null */ }
    check('a glob branch filter is UNKNOWN rather than guessed',
        p && p.rows[0].pushReachesDrafts === 'unknown' && p.rows[0].inert === false,
        'reach=' + (p && p.rows[0].pushReachesDrafts));
}
// branches-ignore inverts the test and this checker does not attempt it.
{
    const body = 'name: CI\non:\n  push:\n    branches-ignore: [docs/*]\n  pull_request:\njobs:\n  test:\n' + GUARD;
    const r = run([root('ignore', body), '--json']);
    let p = null;
    try { p = JSON.parse(r.out); } catch { /* stays null */ }
    check('branches-ignore is UNKNOWN, not silently treated as unfiltered',
        p && p.rows[0].pushReachesDrafts === 'unknown', 'reach=' + (p && p.rows[0].pushReachesDrafts));
}
{
    const r = run([root('noguard', 'name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n')]);
    check('a push trigger with no guard exits 0', r.status === 0, 'exit ' + r.status);
    check('  and refuses to read as an endorsement of adding one',
        /NOT an endorsement/.test(r.out));
}

// --- no population is not a clean run -------------------------------------
// Asserted on the EXIT CODE alone. A caveat in the text is not a substitute for
// a status a caller can branch on, and an `||` across the two would be satisfied
// by either while the other is false.
{
    const bare = path.join(tmp, 'empty');
    fs.mkdirSync(bare, { recursive: true });
    const r = run([bare]);
    check('a root with no .github/workflows exits 2, never 0', r.status === 2, 'exit ' + r.status);
    check('  and says the run vouches for nothing', /vouches for NOTHING/.test(r.err + r.out));
}

// --- the subject's own selftest, and --help --------------------------------
{
    const r = run(['--selftest']);
    check('--selftest exits 0', r.status === 0, 'exit ' + r.status);
    check('  and reports its case count rather than a bare verdict',
        /\d+ passed, \d+ failed/.test(r.out));
}
{
    const t0 = Date.now();
    const r = run(['--help']);
    const ms = Date.now() - t0;
    check('--help exits 0 with usage inside the entrypoint budget',
        r.status === 0 && r.out.includes('usage:') && ms < 10000, `exit ${r.status}, ${ms}ms`);
    check('  and --help does not scan anything', !/workflow\(s\) in/.test(r.out));
}

// --- json ------------------------------------------------------------------
{
    const r = run([root('json', 'name: CI\non: [push, pull_request]\njobs:\n  test:\n' + GUARD), '--json']);
    let parsed = null;
    try { parsed = JSON.parse(r.out); } catch { /* stays null */ }
    check('--json emits parseable JSON carrying the population and the findings',
        parsed && parsed.scanned === 1 && parsed.inert === 1 && Array.isArray(parsed.rows),
        'scanned=' + (parsed && parsed.scanned));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`subject: ${path.relative(path.resolve(__dirname, '..'), SUBJECT)}; every case plants its `
    + 'own workflow fixture, because this repo carries no draft-skip guard and a live run here '
    + 'would report zero forever. One positive that must fire, three near-misses that must not.');
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exit(fail ? 1 : 0);
