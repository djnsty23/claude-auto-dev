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
// branches-ignore INVERTS branches, and the inversion is the point: both read as
// restrictive at a glance and mean opposite things. `branches: [main]` keeps a
// push OFF feature branches; `branches-ignore: [master]` keeps it ON all of them,
// which is where drafts live. A peer's fleet survey got a row wrong on exactly
// this, and it is a live shape in one repo here.
{
    const body = 'name: CI\non:\n  push:\n    branches-ignore:\n      - master\n  pull_request:\njobs:\n  test:\n' + GUARD;
    const r = run([root('ignore-trunk', body)]);
    check('branches-ignore listing only trunk leaves feature pushes firing, so INERT',
        r.status === 1, 'exit ' + r.status);
    check('  and the inline form agrees with the block form',
        run([root('ignore-trunk-inline',
            'name: CI\non:\n  push:\n    branches-ignore: [main]\n  pull_request:\njobs:\n  test:\n' + GUARD)]).status === 1);
}
// A non-trunk name could be anything, including a branch nobody drafts on.
{
    const body = 'name: CI\non:\n  push:\n    branches-ignore: [docs-only]\n  pull_request:\njobs:\n  test:\n' + GUARD;
    const r = run([root('ignore-other', body), '--json']);
    let p = null;
    try { p = JSON.parse(r.out); } catch { /* stays null */ }
    check('branches-ignore naming a NON-trunk branch stays UNKNOWN',
        p && p.rows[0].pushReachesDrafts === 'unknown' && p.rows[0].inert === false,
        'reach=' + (p && p.rows[0].pushReachesDrafts));
}
{
    const body = 'name: CI\non:\n  push:\n    branches-ignore: [docs/*]\n  pull_request:\njobs:\n  test:\n' + GUARD;
    const r = run([root('ignore-glob', body), '--json']);
    let p = null;
    try { p = JSON.parse(r.out); } catch { /* stays null */ }
    check('a GLOB in branches-ignore stays UNKNOWN, not guessed',
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

// --- partial coverage, through the process boundary ------------------------
// The subject's own selftest asserts partialCoverage() in-process. These drive
// the CLI instead, because the exit code and the printed population are the
// contract a caller actually consumes, and an in-process assertion cannot see
// either. A finding that computes correctly and exits 0 is still a broken gate.

/** A root carrying several named workflows. */
function multiRoot(name, files) {
    const r = path.join(tmp, name);
    const wf = path.join(r, '.github', 'workflows');
    fs.mkdirSync(wf, { recursive: true });
    for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(wf, file), body);
    return r;
}

{
    const mixed = multiRoot('mixed', {
        'guarded.yml': 'name: P\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  t:\n' + GUARD,
        'unguarded.yml': 'name: B\non:\n  push:\n    paths:\n      - docs/**\n  pull_request:\njobs:\n'
            + '  g:\n    runs-on: windows-latest\n',
        'cron.yml': 'name: N\non:\n  schedule:\n    - cron: "0 3 * * *"\njobs:\n  x:\n    runs-on: ubuntu-latest\n',
    });
    const r = run([mixed]);
    check('PARTIAL coverage is reported and exits 1',
        r.status === 1 && /PARTIAL/.test(r.out), `exit ${r.status}`);
    check('  the unguarded workflow is named in the output',
        /unguarded\.yml/.test(r.out));
    check('  the guarded one is shown as guarded, not as the gap',
        /guarded:[\s\S]*guarded\.yml/.test(r.out));
    check('  the cron-only workflow is excluded from the reachable population',
        /2 reachable by a draft pull request/.test(r.out));
    check('  the population names BOTH denominators, not just the finding',
        /3 workflow\(s\)/.test(r.out) && /2 reachable/.test(r.out));
    check('  the windows cost signal is printed as a signal, with no minute total',
        /windows runner/.test(r.out) && !/\d+\s*(billable|minutes\/month)/.test(r.out));

    const j = run([mixed, '--json']);
    let parsed = null;
    try { parsed = JSON.parse(j.out); } catch { /* stays null */ }
    check('--json carries the partial finding and exits 1',
        j.status === 1 && parsed && parsed.partial
        && parsed.partial.unguarded.length === 1 && parsed.partial.guarded.length === 1,
        `exit ${j.status}`);
}

// THE TWO CONSISTENT STATES, which must NOT be reported. Without both, this
// check would fire on every repo that never adopted the pattern, which is most
// of them, and a gate that cries wolf gets muted.
{
    const none = multiRoot('none-guarded', {
        'a.yml': 'name: A\non: [push, pull_request]\njobs:\n  x:\n    runs-on: ubuntu-latest\n',
        'b.yml': 'name: B\non: [push, pull_request]\njobs:\n  y:\n    runs-on: ubuntu-latest\n',
    });
    const r = run([none]);
    check('a repo where NOTHING guards exits 0 and is not reported',
        r.status === 0 && !/PARTIAL/.test(r.out), `exit ${r.status}`);
    check('  and it says plainly that this is not an endorsement',
        /NOT an endorsement/.test(r.out));

    const all = multiRoot('all-guarded', {
        'a.yml': 'name: A\non:\n  pull_request:\njobs:\n  x:\n' + GUARD,
        'b.yml': 'name: B\non:\n  pull_request:\njobs:\n  y:\n' + GUARD,
    });
    const r2 = run([all]);
    check('a repo where EVERY draft-reachable workflow guards exits 0',
        r2.status === 0 && !/PARTIAL/.test(r2.out), `exit ${r2.status}`);
}

// A workflow a draft cannot reach is never the gap, even beside a guarded one.
// This is the case that would turn every repo with a nightly cron into a
// finding, so it is asserted through the CLI rather than trusted.
{
    const cronBeside = multiRoot('cron-beside', {
        'guarded.yml': 'name: P\non:\n  pull_request:\njobs:\n  t:\n' + GUARD,
        'nightly.yml': 'name: N\non:\n  schedule:\n    - cron: "0 3 * * *"\n  workflow_dispatch:\njobs:\n'
            + '  x:\n    runs-on: macos-latest\n',
    });
    const r = run([cronBeside]);
    check('a cron/dispatch-only workflow beside a guarded one is NOT a partial finding',
        r.status === 0 && !/PARTIAL/.test(r.out), `exit ${r.status}`);
    check('  and the reachable population is 1, not 2',
        /1 reachable by a draft pull request/.test(r.out));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`subject: ${path.relative(path.resolve(__dirname, '..'), SUBJECT)}; every case plants its `
    + 'own workflow fixture, because this repo carries no draft-skip guard and a live run here '
    + 'would report zero forever. Both findings are covered, each with its own negatives: for '
    + 'INERT, three near-misses; for PARTIAL, both consistent states and an unreachable workflow.');
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exit(fail ? 1 : 0);
