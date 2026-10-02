#!/usr/bin/env node
'use strict';
// Suite for pinned acceptance tests in plugins/autodev-core/scripts/unattended-worker.js
// (`brief --pin`, `enqueue --pin`, `verdict --decision accept`) and the same
// check in brain-judge.js before a judge accept is written.
//
// WHY. A brief can name the test that decides whether the work is done. A worker
// that edits that test to get green still reports green, and a judge reading the
// report accepts it. So a brief pins the test's blob at the base, and accept is
// refused when the worker's result head carries a different blob or none.
//
// Every refusal is paired with the control that the same record, with the file
// untouched, is accepted. A head that cannot be found is "could not check" and
// refused too, because a guessed pass is the expensive mistake.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const SUBJECT = path.join(SCRIPTS, 'unattended-worker.js');

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail === undefined ? '' : '  (' + detail + ')')); }
}

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-acceptance-')));
const home = path.join(scratch, 'home');
fs.mkdirSync(home);
const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_TERMINAL_PROMPT: '0', AUTODEV_LEDGER_LOCK_WAIT_MS: '300' };
delete env.CLAUDE_CONFIG_DIR;

function cli(args) {
    const r = spawnSync(process.execPath, [SUBJECT, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* help text or a crash */ }
    return { status: r.status, stdout: r.stdout, json, detail: (r.stdout || '').slice(0, 600) + (r.stderr || '').slice(0, 300) };
}
const code = (r) => (r.json && r.json.error ? r.json.error.code : null);
const msg = (r) => (r.json && r.json.error ? r.json.error.message : '');
const val = (r) => (r.json && r.json.ok ? r.json.value : null);
function g(cwd, ...args) {
    return execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=' + path.join(scratch, 'no-hooks'), ...args],
        { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A repo with a bare origin holding main: one source file and one acceptance test.
const origin = path.join(scratch, 'origin.git');
const repo = path.join(scratch, 'repo');
const PIN = 'tests/acceptance.test.js';
g(scratch, 'init', '--bare', origin);
g(scratch, 'init', repo);
fs.mkdirSync(path.join(repo, 'src'));
fs.mkdirSync(path.join(repo, 'tests'));
fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'module.exports = (a, b) => a - b;\n');
fs.writeFileSync(path.join(repo, PIN), "assert.equal(add(1, 2), 3);\n");
g(repo, 'add', '.');
g(repo, 'commit', '-q', '-m', 'init');
g(repo, 'branch', '-M', 'main');
g(repo, 'remote', 'add', 'origin', origin);
g(repo, 'push', '-q', 'origin', 'main');
g(repo, 'fetch', '-q', 'origin');
const baseSha = g(repo, 'rev-parse', 'origin/main');
const pinBlob = g(repo, 'rev-parse', `origin/main:${PIN}`);
const ledger = path.join(scratch, 'ledger.json');
const briefFile = path.join(scratch, 'brief.md');
fs.writeFileSync(briefFile, 'MISSION. Make add() add.\nACCEPTANCE. tests/acceptance.test.js passes.\n');
const readLedger = () => (fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, 'utf8')).records : []);
const recOf = (id) => readLedger().find((r) => r.taskId === id) || {};
const session = (n) => `local_0000000${n}-0000-4000-8000-000000000000`;

/** brief with a pin, record a session, settle: a finished record awaiting its verdict. */
function finished(slug, extra = []) {
    const b = cli(['brief', '--repo', repo, '--slug', slug, '--brief-file', briefFile, '--return', 'coordinator-a1', '--ledger', ledger, '--pin', PIN, ...extra]);
    const taskId = `worker-${slug}`;
    cli(['record', '--task-id', taskId, '--session', session(slug.length % 10), '--ledger', ledger]);
    cli(['settle', '--task-id', taskId, '--run-status', 'succeeded', '--report-read', '--ledger', ledger]);
    return { b, taskId };
}
/** The worker's branch: claude/<slug> from the base, with `edit` applied and committed. */
function workOn(slug, edit) {
    const wt = path.join(scratch, 'wt-' + slug);
    g(repo, 'worktree', 'add', '-q', wt, '-b', `claude/${slug}`, 'origin/main');
    fs.writeFileSync(path.join(wt, 'src', 'app.js'), 'module.exports = (a, b) => a + b;\n');
    if (edit) edit(wt);
    g(wt, 'add', '-A');
    g(wt, 'commit', '-q', '-m', 'work');
    return wt;
}
const accept = (taskId, extra = []) => cli(['verdict', '--task-id', taskId, '--decision', 'accept', '--reason', 'report reads done', '--ledger', ledger, ...extra]);

try {
    // ---- brief and enqueue store the pin with its blob at the base -------------
    const a = finished('pin-edit');
    const ra = recOf(a.taskId);
    check('brief --pin stores the path with its blob sha at the base',
        ra && Array.isArray(ra.pins) && ra.pins.length === 1 && ra.pins[0].path === PIN && ra.pins[0].blob === pinBlob && ra.pinBase === baseSha, a.b.detail);
    check('  and the composed prompt tells the worker the test is pinned',
        val(a.b) && /pinned/i.test(val(a.b).createScheduledTask.prompt) && val(a.b).createScheduledTask.prompt.includes(PIN), a.b.detail);
    const missing = cli(['brief', '--repo', repo, '--slug', 'pin-missing', '--brief-file', briefFile, '--return', 'c', '--ledger', ledger, '--pin', 'tests/nope.test.js']);
    check('brief refuses a pin that does not exist at the base', code(missing) === 'pin-missing' && msg(missing).includes('tests/nope.test.js'), missing.detail);
    const escape = cli(['brief', '--repo', repo, '--slug', 'pin-escape', '--brief-file', briefFile, '--return', 'c', '--ledger', ledger, '--pin', '../outside.js']);
    check('brief refuses a pin outside the repo', code(escape) === 'bad-pin', escape.detail);
    const q = cli(['enqueue', '--repo', repo, '--slug', 'pin-queued', '--brief-file', briefFile, '--return', 'c', '--ledger', ledger, '--pin', `${PIN},src/app.js`]);
    const rq = recOf('worker-pin-queued');
    check('enqueue --pin takes a comma list and stores each blob',
        rq && rq.pins && rq.pins.length === 2 && rq.pins[0].blob === pinBlob && rq.pins[1].path === 'src/app.js', q.detail);

    // ---- acceptance 1: a pinned test edited on the branch ----------------------
    workOn('pin-edit', (wt) => fs.writeFileSync(path.join(wt, PIN), 'assert.equal(add(1, 2), add(1, 2));\n'));
    let r = accept(a.taskId);
    check('accept is refused when the pinned test was edited on the branch, naming the path',
        r.status !== 0 && code(r) === 'pin-changed' && msg(r).includes(PIN), r.detail);
    check('  and no verdict was written', recOf(a.taskId).taskId === a.taskId && !recOf(a.taskId).verdict, JSON.stringify(recOf(a.taskId).verdict));
    r = cli(['verdict', '--task-id', a.taskId, '--decision', 'follow-up', '--reason', 'the test was edited', '--ledger', ledger]);
    check('follow-up is never refused on a changed pin', r.status === 0 && recOf(a.taskId).verdict.decision === 'follow-up', r.detail);
    r = cli(['verdict', '--task-id', a.taskId, '--decision', 'escalate', '--reason', 'needs a person', '--ledger', ledger]);
    check('escalate is never refused on a changed pin', r.status === 0 && recOf(a.taskId).verdict.decision === 'escalate', r.detail);
    r = accept(a.taskId, ['--allow-pin-change', 'the test itself had the bug; reviewed the diff']);
    const va = recOf(a.taskId).verdict;
    check('--allow-pin-change lets accept through and stores the reason on the verdict',
        r.status === 0 && va.decision === 'accept' && va.allowPinChange === 'the test itself had the bug; reviewed the diff'
        && va.pinCheck && va.pinCheck.state === 'changed', r.detail);

    // The control: the same shape of record, the pinned file untouched.
    const b = finished('pin-clean');
    workOn('pin-clean');
    r = accept(b.taskId);
    const vb = recOf(b.taskId).verdict;
    check('the same record with the pinned test untouched is accepted', r.status === 0 && vb && vb.decision === 'accept', r.detail);
    check('  and the verdict records which head it checked', vb && vb.pinCheck && vb.pinCheck.state === 'unchanged'
        && vb.pinCheck.head === g(repo, 'rev-parse', 'claude/pin-clean'), JSON.stringify(vb && vb.pinCheck));

    // A deleted pin is a changed pin.
    const c = finished('pin-del');
    workOn('pin-del', (wt) => fs.unlinkSync(path.join(wt, PIN)));
    r = accept(c.taskId);
    check('accept is refused when the pinned test was deleted', code(r) === 'pin-changed' && /deleted/.test(msg(r)), r.detail);

    // A pushed branch whose local copy is gone still gets checked.
    const e = finished('pin-pushed');
    const wtE = workOn('pin-pushed', (wt) => fs.writeFileSync(path.join(wt, PIN), '// gone\n'));
    g(wtE, 'push', '-q', 'origin', 'claude/pin-pushed');
    g(repo, 'worktree', 'remove', '--force', wtE);
    g(repo, 'branch', '-D', 'claude/pin-pushed');
    g(repo, 'fetch', '-q', 'origin');
    r = accept(e.taskId);
    check('a branch that exists only on origin is still checked', code(r) === 'pin-changed', r.detail);

    // ---- acceptance 2: the branch head is unknown --------------------------------
    const d = finished('pin-nohead');
    r = accept(d.taskId);
    check('with no branch anywhere, accept is refused as could-not-check',
        r.status !== 0 && code(r) === 'pin-unchecked' && /could not check/i.test(msg(r)), r.detail);
    // --head names the result when the branch is gone: the clean commit passes.
    r = accept(d.taskId, ['--head', g(repo, 'rev-parse', 'claude/pin-clean')]);
    check('--head <sha> names the result head, and a clean head is accepted', r.status === 0 && recOf(d.taskId).verdict.pinCheck.headSource === 'flag', r.detail);

    // A record with no pins is accepted exactly as before.
    cli(['brief', '--repo', repo, '--slug', 'no-pins', '--brief-file', briefFile, '--return', 'c', '--ledger', ledger]);
    cli(['record', '--task-id', 'worker-no-pins', '--session', session(9), '--ledger', ledger]);
    cli(['settle', '--task-id', 'worker-no-pins', '--run-status', 'succeeded', '--report-read', '--ledger', ledger]);
    r = accept('worker-no-pins');
    check('a record with no pins is accepted with no branch at all', r.status === 0 && recOf('worker-no-pins').verdict.decision === 'accept', r.detail);

    // ---- brain-judge applies the same check before it records accept -----------
    const bj = require(path.join(SCRIPTS, 'brain-judge.js'));
    check('brain-judge exports writeVerdict, so the judge path can be driven', typeof bj.writeVerdict === 'function');
    if (typeof bj.writeVerdict !== 'function') bj.writeVerdict = () => ({ applied: false, note: 'not exported' });
    const f = finished('judge-edit');
    workOn('judge-edit', (wt) => fs.writeFileSync(path.join(wt, PIN), '// weakened\n'));
    const w = bj.writeVerdict({ ledger }, f.taskId, 'accept', 'the report shows every ask done');
    const vf = recOf(f.taskId).verdict;
    check('a judge accept on a changed pin is written as escalate, naming the path',
        w.applied === true && vf && vf.decision === 'escalate' && vf.by === 'judge' && vf.reason.includes(PIN), JSON.stringify({ w, vf }));
    const h = finished('judge-clean');
    workOn('judge-clean');
    const w2 = bj.writeVerdict({ ledger }, h.taskId, 'accept', 'the report shows every ask done');
    check('  and a judge accept on an untouched pin is written as accept', w2.applied === true && recOf(h.taskId).verdict.decision === 'accept', JSON.stringify(w2));

    // ---- help describes the flags ------------------------------------------------
    const help = cli(['--help']).stdout;
    check('--help names --pin and --allow-pin-change', /--pin/.test(help) && /--allow-pin-change/.test(help), help.slice(-400));
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
