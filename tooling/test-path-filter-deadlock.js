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

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-path-filter-deadlock.js');

let pass = 0;
let fail = 0;
const failures = [];
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

function run(args) {
    const r = spawnSync(process.execPath, [SUBJECT].concat(args), { encoding: 'utf8', timeout: 20000 });
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
    const r = run([bare]);
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

// ---- the pipe delivers every byte -----------------------------------------
//
// node's process.stdout is ASYNCHRONOUS when it is a pipe on darwin and
// synchronous when it is a pipe on linux/win32, and process.exit() does not
// drain a pending async write. A run that prints past the 64KiB OS pipe buffer
// and then exits hands its caller exactly 65536 bytes under a status that says
// nothing failed — the shape rendered-layout-gate.js shipped with until
// 2026-09-07. --json here carries one row per workflow, so it grows with the
// repo it is pointed at.
//
// TWO ASSERTIONS, and the first is what stops the second passing by
// construction: the output must EXCEED one pipe buffer, and the piped byte count
// must equal the same run redirected to a FILE, where the write is synchronous
// on every platform.
{
    const PIPE_BUF = 64 * 1024;
    const files = {};
    for (let i = 0; i < 380; i++) {
        files['workflow-' + String(i).padStart(4, '0') + '.yml'] =
            'name: w' + i + '\non:\n  pull_request:\n    paths:\n      - src/**\n      - docs/**\n'
            + 'jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n';
    }
    const bigRoot = root('big', files);

    const viaFileBytes = (args) => {
        const out = path.join(tmp, 'via-file.out');
        const fd = fs.openSync(out, 'w');
        spawnSync(process.execPath, [SUBJECT].concat(args), { stdio: ['ignore', fd, 'ignore'] });
        fs.closeSync(fd);
        return fs.statSync(out).size;
    };
    const piped = spawnSync(process.execPath, [SUBJECT, bigRoot, '--json'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const pipeBytes = Buffer.byteLength(piped.stdout || '', 'utf8');
    const fileBytes = viaFileBytes([bigRoot, '--json']);

    check('--json over many workflows exceeds one pipe buffer, so the next check is not vacuous',
        fileBytes > PIPE_BUF, JSON.stringify({ bytes: fileBytes, buffer: PIPE_BUF }));
    check('  and through a PIPE it delivers every byte it writes to a FILE',
        pipeBytes === fileBytes, JSON.stringify({ pipe: pipeBytes, file: fileBytes }));
    check('  and the piped JSON still parses at that size',
        (() => { try { return JSON.parse(piped.stdout).rows.length === 380; } catch { return false; } })(),
        'tail ' + JSON.stringify((piped.stdout || '').slice(-40)));

    // The human report shares the exit path, so it shares the defect. BE CLEAR
    // WHAT THIS LINE CATCHES: it is a stream of small console.log calls, which
    // drain opportunistically while the parent reads, so it strands far less at
    // the exit than the single JSON write above — measurably so on the sibling
    // suites, where the equivalent line stays green under the mutation. It
    // states the equality; it is not cover for this defect.
    const reportPipe = spawnSync(process.execPath, [SUBJECT, bigRoot],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    check('  the human report through a PIPE also delivers every byte',
        Buffer.byteLength(reportPipe.stdout || '', 'utf8') === viaFileBytes([bigRoot]),
        Buffer.byteLength(reportPipe.stdout || '', 'utf8'));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`subject: ${path.relative(path.resolve(__dirname, '..'), SUBJECT)}; every case plants its `
    + 'own workflow fixture, because this repo carries no path filter and a live run here would '
    + 'report zero forever. One positive, four negatives including a filter on push that cannot '
    + 'affect a pull request, and both exit modes asserted.');
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exit(fail ? 1 : 0);
