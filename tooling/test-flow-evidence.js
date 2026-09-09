#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/flow-evidence.js — the record a
// runtime flow check leaves behind, and the refusals that keep a screenshot
// from closing a story on its own.
// Run: node tooling/test-flow-evidence.js
// Exits 1 on any failure; 0 if all pass.
//
// Driven as a subprocess, following tooling/test-pre-tool-filter.js: the exit
// code and the stdout line are the contract `auto` reads, so that is what is
// asserted. The three exit codes are asserted separately on purpose — a
// REFUSED record (no assertion) and a FAILED one (assertion did not hold) are
// different findings and a suite that only checked "non-zero" could not tell
// a validator that lost its verdict from one that lost its schema.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'flow-evidence.js');

// A record is bound to the revision it was measured on, so the fixture is a
// throwaway repository with three commits: BASE, its child HEAD on the main
// line, and OTHER on a branch off BASE. realpath, because macOS spells the
// tmpdir two ways and the refusal message names the resolved path.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-evidence-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const outside = path.join(tmp, 'outside');
fs.mkdirSync(outside);

function git(cwd, ...args) {
    const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return (r.stdout || '').trim();
}
git(repo, 'init', '-q');
fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
git(repo, 'add', 'a.txt');
git(repo, 'commit', '-q', '-m', 'base');
const BASE = git(repo, 'rev-parse', 'HEAD');
git(repo, 'checkout', '-q', '-b', 'other');
fs.writeFileSync(path.join(repo, 'b.txt'), 'other\n');
git(repo, 'add', 'b.txt');
git(repo, 'commit', '-q', '-m', 'other');
const OTHER = git(repo, 'rev-parse', 'HEAD');
git(repo, 'checkout', '-q', '-');
fs.writeFileSync(path.join(repo, 'a.txt'), 'head\n');
git(repo, 'add', 'a.txt');
git(repo, 'commit', '-q', '-m', 'head');
const HEAD = git(repo, 'rev-parse', 'HEAD');

// Screenshot paths resolve from the repository root, so the fixture's lives
// there and records name it as `after.png` wherever the record itself sits.
const shot = path.join(repo, 'after.png');
fs.writeFileSync(shot, 'not really a png, existence is what is checked');

function valid(overrides = {}) {
    return Object.assign({
        story: 'S99-001',
        commit: HEAD,
        flow: ['navigate /generate', 'form_input #url = https://example.com', 'click Generate'],
        assertion: { subject: 'dom', claim: 'exactly one QR image with a data: src is rendered', expected: 1 },
        observed: 1,
        screenshots: ['after.png'],
        consoleErrors: 0,
        timestamp: new Date().toISOString(),
    }, overrides);
}

let n = 0;
// Records are written INSIDE the fixture repository and the validator is run
// from a cwd OUTSIDE it, so the repository it checks against is the one found
// by walking up from the record, not the cwd's.
function run(record, label, { args = [], dir = repo, cwd = outside } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rec-${++n}.json`);
    fs.writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record));
    const r = spawnSync('node', [SCRIPT, file, ...args], { encoding: 'utf8', cwd });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '', label };
}

const cases = [
    // [label, record, expectedExit, stdout must contain]
    ['a sound record with a held assertion passes', valid(), 0, 'PASS'],
    ['a held assertion on an object value passes', valid({
        assertion: { subject: 'api', claim: 'the row came back with the account id', expected: { id: 7, account: 'a1' } },
        observed: { account: 'a1', id: 7 },
    }), 0, 'PASS'],
    ['no screenshots is allowed when the assertion holds', valid({ screenshots: [] }), 0, 'PASS'],

    // ---- REFUSED: defects in the record. Exit 2. ----
    ['no assertion is refused, screenshots or not', valid({ assertion: undefined }), 2, 'assertion: missing'],
    ['a visual subject is refused', valid({ assertion: { subject: 'visual', claim: 'the page renders', expected: true } }), 2, 'not a state subject'],
    ['a screenshot subject is refused', valid({ assertion: { subject: 'screenshot', claim: 'after.png matches', expected: true } }), 2, 'not a state subject'],
    ['"looked fine" is refused', valid({ assertion: { subject: 'dom', claim: 'looked fine', expected: true } }), 2, 'names no outcome'],
    ['"the page looks ok." is refused', valid({ assertion: { subject: 'dom', claim: 'the page looks ok.', expected: true } }), 2, 'names no outcome'],
    ['"works as expected" is refused', valid({ assertion: { subject: 'dom', claim: 'works as expected', expected: true } }), 2, 'names no outcome'],
    ['a real claim containing "right" is not refused', valid({
        assertion: { subject: 'text', claim: 'the right-hand total reads the same as the header total', expected: '12' }, observed: '12',
    }), 0, 'PASS'],
    ['an empty claim is refused', valid({ assertion: { subject: 'dom', claim: '', expected: 1 } }), 2, 'assertion.claim'],
    ['no expected value is refused', valid({ assertion: { subject: 'dom', claim: 'one QR image rendered' } }), 2, 'assertion.expected'],
    ['a null expected value is refused', valid({ assertion: { subject: 'dom', claim: 'one QR image rendered', expected: null } }), 2, 'assertion.expected'],
    ['no observed value is refused', valid({ observed: undefined }), 2, 'observed: missing'],
    ['a null observed value is refused', valid({ observed: null }), 2, 'observed: missing'],
    ['an empty flow is refused', valid({ flow: [] }), 2, 'flow:'],
    ['a flow that is not an array is refused', valid({ flow: 'navigate /generate' }), 2, 'flow:'],
    ['a blank flow step is refused', valid({ flow: ['navigate /generate', '  '] }), 2, 'flow:'],
    ['a missing story id is refused', valid({ story: '' }), 2, 'story:'],
    ['a screenshot path that does not exist is refused, naming the path it resolved to',
        valid({ screenshots: ['missing.png'] }), 2, `missing.png does not exist (resolved from the repository root as ${path.join(repo, 'missing.png')})`],
    ['a screenshot path resolves from the repository root even when the record sits in a subdirectory',
        valid(), 0, 'PASS', { dir: path.join(repo, '.claude', 'evidence', 'S99-001') }],

    // ---- The record is bound to a revision. ----
    ['a commit that is a real ancestor of HEAD passes', valid({ commit: BASE }), 0, 'PASS'],
    ['a commit on another branch is refused', valid({ commit: OTHER }), 2, `commit: ${OTHER} is not reachable from ${HEAD}`],
    ['a missing commit is refused', valid({ commit: undefined }), 2, 'commit: must be the 40-character sha'],
    ['an abbreviated sha is refused', valid({ commit: HEAD.slice(0, 7) }), 2, 'commit: must be the 40-character sha'],
    ['a malformed sha is refused', valid({ commit: 'g'.repeat(40) }), 2, 'commit: must be the 40-character sha'],
    ['a well-formed sha that is not a commit in the repository is refused', valid({ commit: 'a'.repeat(40) }), 2, 'is not a commit in'],
    ['--at overrides HEAD: the other-branch commit passes when verified at itself', valid({ commit: OTHER }), 0, 'PASS', { args: ['--at', OTHER] }],
    ['--at overrides HEAD: HEAD is refused when verified at its parent', valid(), 2, `commit: ${HEAD} is not reachable from ${BASE}`, { args: ['--at', BASE] }],
    ['--at=<sha> is accepted', valid({ commit: BASE }), 0, 'PASS', { args: [`--at=${HEAD}`] }],
    ['an --at that names no commit is refused, not treated as HEAD', valid(), 2, 'commit: cannot be verified', { args: ['--at', 'no-such-ref'] }],
    ['an --at beginning with a dash is refused rather than handed to git as an option', valid(), 2, 'commit: cannot be verified', { args: ['--at', '--output=x'] }],
    ['a record outside any repository is checked against the cwd repository', valid(), 0, 'PASS', { dir: outside, cwd: repo }],
    ['a record outside any repository with no repository cwd is refused', valid(), 2, 'is not a git repository', { dir: outside, cwd: outside }],
    ['screenshots as a string is refused', valid({ screenshots: 'after.png' }), 2, 'screenshots:'],
    ['a string console count is refused', valid({ consoleErrors: '0' }), 2, 'consoleErrors'],
    ['a negative console count is refused', valid({ consoleErrors: -1 }), 2, 'consoleErrors'],
    ['a missing console count is refused', valid({ consoleErrors: undefined }), 2, 'consoleErrors'],
    ['an unparseable timestamp is refused', valid({ timestamp: 'yesterday' }), 2, 'timestamp'],
    ['a future timestamp is refused', valid({ timestamp: new Date(Date.now() + 3600 * 1000).toISOString() }), 2, 'in the future'],
    ['a record that is a bare array is refused', '[1,2]', 2, 'not a JSON object'],
    ['invalid JSON is refused', '{ not json', 2, 'not valid JSON'],
    ['the --template output is refused as-is, because observed is null', null, 2, 'observed: missing'],

    // ---- FAIL: the record is sound and the product is wrong. Exit 1. ----
    ['an assertion that does not hold fails', valid({ observed: 2 }), 1, 'expected 1, observed 2'],
    ['a type mismatch fails rather than coercing', valid({ observed: '1' }), 1, 'expected 1, observed "1"'],
    ['an object assertion that does not hold fails', valid({
        assertion: { subject: 'api', claim: 'row carries the account', expected: { id: 7, account: 'a1' } },
        observed: { id: 7 },
    }), 1, 'assertion: expected'],
    ['console errors fail a held assertion', valid({ consoleErrors: 3 }), 1, '3 error(s)'],
    ['console errors at the recorded baseline pass', valid({ consoleErrors: 2, consoleErrorsBaseline: 2 }), 0, 'PASS'],
    ['console errors above the recorded baseline fail', valid({ consoleErrors: 3, consoleErrorsBaseline: 2 }), 1, 'against a baseline of 2'],
    ['a string baseline is refused', valid({ consoleErrors: 2, consoleErrorsBaseline: '2' }), 2, 'consoleErrorsBaseline'],
    ['a null baseline means strict', valid({ consoleErrors: 1, consoleErrorsBaseline: null }), 1, '1 error(s)'],
    ['a before value equal to the after value fails as a blind probe', valid({ observedBefore: 1 }), 1, 'did not see the change'],
    ['a before value that differs is fine', valid({ observedBefore: 0 }), 0, 'PASS'],
];

let failed = 0;
let checks = 0;
function report(ok, label, detail) {
    checks++;
    if (ok) { console.log(`ok    ${label}`); return; }
    failed++;
    console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`);
}

for (const [label, record, expectedExit, needle, opts] of cases) {
    let r;
    if (record === null) {
        const t = spawnSync('node', [SCRIPT, '--template'], { encoding: 'utf8', cwd: repo });
        if (t.status !== 0) { report(false, label, `--template exited ${t.status}`); continue; }
        r = run(t.stdout, label, opts);
    } else {
        r = run(record, label, opts);
    }
    const ok = r.code === expectedExit && r.out.includes(needle) && r.err === '';
    report(ok, label, `expected exit ${expectedExit} containing ${JSON.stringify(needle)}\n      got exit ${r.code}, stdout ${JSON.stringify(r.out.trim())}, stderr ${JSON.stringify(r.err.trim())}`);
}

// The template, filled in and saved where the skill says to save it, must
// pass with the screenshot at the path the template names. `[measured
// 2026-09-09]` it did not: the template emitted a repository-relative path
// and the reader resolved it against the record's directory.
{
    const t = spawnSync('node', [SCRIPT, '--template'], { encoding: 'utf8', cwd: repo });
    const tpl = JSON.parse(t.stdout);
    report(tpl.commit === HEAD, 'the --template fills commit with HEAD of the cwd repository',
        `expected ${HEAD}, got ${JSON.stringify(tpl.commit)}`);
    report(tpl.screenshots.length === 1 && tpl.screenshots[0] === '.claude/evidence/S00-000/after.png',
        'the --template names the documented screenshot path', JSON.stringify(tpl.screenshots));

    const dir = path.join(repo, '.claude', 'evidence', 'S00-000');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'flow.json');
    const png = path.join(repo, ...'.claude/evidence/S00-000/after.png'.split('/'));
    fs.writeFileSync(file, JSON.stringify(Object.assign({}, tpl, { observed: 1 })));

    fs.writeFileSync(png, 'png');
    const present = spawnSync('node', [SCRIPT, file], { encoding: 'utf8', cwd: outside });
    report(present.status === 0 && /PASS S00-000/.test(present.stdout) && present.stderr === '',
        'a template-shaped record at .claude/evidence/<story>/flow.json passes when the template\'s screenshot path exists',
        `exit ${present.status}, stdout ${JSON.stringify(present.stdout.trim())}, stderr ${JSON.stringify(present.stderr.trim())}`);

    fs.rmSync(png);
    const absent = spawnSync('node', [SCRIPT, file], { encoding: 'utf8', cwd: outside });
    const needle = `.claude/evidence/S00-000/after.png does not exist (resolved from the repository root as ${png})`;
    report(absent.status === 2 && absent.stdout.includes(needle) && absent.stderr === '',
        'the same record with the screenshot absent is refused, naming the path it resolved to',
        `exit ${absent.status}, expected ${JSON.stringify(needle)}, stdout ${JSON.stringify(absent.stdout.trim())}`);

    const noRepo = spawnSync('node', [SCRIPT, '--template'], { encoding: 'utf8', cwd: outside });
    report(noRepo.status === 0 && JSON.parse(noRepo.stdout).commit === null,
        'the --template outside a repository leaves commit null rather than guessing',
        `exit ${noRepo.status}, stdout ${JSON.stringify(noRepo.stdout.trim())}`);
}

// A record's commit must be checked against the repository the record sits
// in, not the cwd's: the same record file passes from a foreign cwd that is
// itself a repository, because the walk-up from the record wins.
{
    const foreign = path.join(tmp, 'foreign');
    fs.mkdirSync(foreign);
    git(foreign, 'init', '-q');
    fs.writeFileSync(path.join(foreign, 'f.txt'), 'f\n');
    git(foreign, 'add', 'f.txt');
    git(foreign, 'commit', '-q', '-m', 'foreign');
    const r = run(valid(), 'foreign-cwd', { cwd: foreign });
    report(r.code === 0 && /PASS/.test(r.out) && r.err === '',
        'a record inside a repository is verified against that repository, not the cwd\'s',
        `exit ${r.code}, stdout ${JSON.stringify(r.out.trim())}, stderr ${JSON.stringify(r.err.trim())}`);
}

// The three exits must be distinct for the same file across the three states,
// or `auto` cannot tell a missing check from a failing one.
{
    const passing = run(valid(), 'exit-triple');
    const failing = run(valid({ observed: 0 }), 'exit-triple');
    const refused = run(valid({ assertion: undefined }), 'exit-triple');
    const distinct = new Set([passing.code, failing.code, refused.code]).size === 3;
    report(distinct, 'PASS, FAIL and REFUSED exit with three distinct codes',
        `exit codes are not three distinct values: ${passing.code}/${failing.code}/${refused.code}`);
}

// Missing file and no argument are refusals too, not crashes.
{
    const r = spawnSync('node', [SCRIPT, path.join(tmp, 'nope.json')], { encoding: 'utf8', cwd: outside });
    report(r.status === 2 && /no such file/.test(r.stdout) && !r.stderr, 'a missing record file is refused, not thrown',
        `exit ${r.status} ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)}`);
    const u = spawnSync('node', [SCRIPT], { encoding: 'utf8', cwd: outside });
    report(u.status === 2 && /usage/.test(u.stdout), 'no argument prints usage and exits 2',
        `exit ${u.status} ${JSON.stringify(u.stdout)}`);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failed ? `\n${failed} failure(s)` : `\nAll ${checks} checks passed`);
process.exitCode = failed ? 1 : 0;
