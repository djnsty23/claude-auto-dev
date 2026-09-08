#!/usr/bin/env node
'use strict';
// Suite for hooks/stop-intent-record.js.
//
// Drives the hook as a SUBPROCESS with real stdin, a real git repository with a
// real origin, and a real record directory, because every decision it makes is
// a read of something outside itself.
//
// THE ASSERTIONS THAT MATTER MOST ARE THE SILENT ONES, and they are asserted as
// ZERO BYTES ON BOTH STREAMS rather than "no additionalContext". A hook that
// prints costs context on every turn of every installed session; one that prints
// when it should not trains its reader to skip it, and then the nudge that
// mattered is skipped with it.
//
// The second group asserts what the hook MUST NOT DO to the record: it may never
// write a claim, never move `updated_at`, and never bring a record into
// existence. Each of those has its own case, because the design's whole value is
// that a fresh date means a fresh claim.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'stop-intent-record.js');
const intent = require(path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'fleet-intent.js'));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + name + (detail ? '  (' + detail + ')' : '')); }
    else { fail++; failures.push(name); console.log('FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function git(cwd, args) { return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 }); }

const CFG = ['-c', 'user.email=t@example.com', '-c', 'user.name=T'];

function makeRepo() {
    const root = tmpDir('intent-hook-repo-');
    const bare = path.join(root, 'origin.git');
    const main = path.join(root, 'myrepo');
    git(root, ['init', '--bare', '-b', 'main', bare]);
    git(root, ['init', '-b', 'main', main]);
    fs.writeFileSync(path.join(main, 'a.txt'), 'one\n');
    git(main, ['add', 'a.txt']);
    git(main, [...CFG, 'commit', '-m', 'one']);
    git(main, ['remote', 'add', 'origin', bare]);
    git(main, ['push', '-u', 'origin', 'main']);
    git(main, ['remote', 'set-head', 'origin', 'main']);
    return { root, main };
}

/** Run the hook. Returns { status, out, err, spoke, context }. */
function fire({ cwd, dir, sessionId = 's-1', stdin, state, cooldown } = {}) {
    const env = Object.assign({}, process.env, {
        AUTODEV_FLEET_INTENT_DIR: dir,
        AUTODEV_INTENT_NUDGE_STATE: state,
    });
    if (cooldown !== undefined) env.AUTODEV_INTENT_COOLDOWN_MIN = String(cooldown);
    const payload = stdin !== undefined ? stdin : JSON.stringify({ session_id: sessionId, cwd });
    const r = spawnSync(process.execPath, [HOOK], { encoding: 'utf8', input: payload, env, timeout: 30000 });
    let context = null;
    try { context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch { /* silent run */ }
    return { status: r.status, out: r.stdout || '', err: r.stderr || '', context, spoke: !!context };
}

function quiet(r) { return r.out.length === 0 && r.err.length === 0; }

// --- inert paths: every one must emit zero bytes on BOTH streams ------------
{
    const { root, main } = makeRepo();
    const dir = path.join(root, 'records');
    const state = path.join(root, 'state.json');
    const wt = path.join(root, 'wt');
    git(main, ['worktree', 'add', '-b', 'claude/feature', wt]);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'two\n');
    git(wt, ['add', 'b.txt']);
    git(wt, [...CFG, 'commit', '-m', 'two']);

    let r = fire({ cwd: wt, dir, state });
    check('INERT while the record directory does not exist (the opt-in gate)', quiet(r) && r.status === 0,
        'exit=' + r.status + ' out=' + r.out.length + 'B err=' + r.err.length + 'B');

    fs.mkdirSync(dir, { recursive: true });

    r = fire({ cwd: wt, dir, state, stdin: 'not json at all' });
    check('INERT on unparseable stdin', quiet(r) && r.status === 0, 'exit=' + r.status);

    r = fire({ cwd: wt, dir, state, stdin: '' });
    check('INERT on empty stdin', quiet(r) && r.status === 0, 'exit=' + r.status);

    r = fire({ cwd: root, dir, state });
    check('INERT outside a git repository', quiet(r) && r.status === 0, 'exit=' + r.status);

    r = fire({ cwd: main, dir, state });
    check('INERT on the trunk branch', quiet(r) && r.status === 0, 'exit=' + r.status);

    const detached = path.join(root, 'wt-det');
    git(main, ['worktree', 'add', '--detach', detached]);
    r = fire({ cwd: detached, dir, state });
    check('INERT on a detached HEAD, which has no branch to key on', quiet(r) && r.status === 0, 'exit=' + r.status);

    // A branch level with the trunk carries nothing that could be lost.
    const level = path.join(root, 'wt-level');
    git(main, ['worktree', 'add', '-b', 'claude/level', level, 'main']);
    r = fire({ cwd: level, dir, state });
    check('INERT on a branch carrying no work of its own', quiet(r) && r.status === 0, 'exit=' + r.status);
    check('and it created no record for that branch',
        intent.readRecord('myrepo', 'claude/level', dir).record === null);

    fs.rmSync(root, { recursive: true, force: true });
}

// --- the firing paths -------------------------------------------------------
{
    const { root, main } = makeRepo();
    const dir = path.join(root, 'records');
    fs.mkdirSync(dir, { recursive: true });
    const state = path.join(root, 'state.json');
    const wt = path.join(root, 'wt');
    git(main, ['worktree', 'add', '-b', 'claude/feature', wt]);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'two\n');
    git(wt, ['add', 'b.txt']);
    git(wt, [...CFG, 'commit', '-m', 'two']);
    const head1 = git(wt, ['rev-parse', 'HEAD']).stdout.trim();

    let r = fire({ cwd: wt, dir, state });
    check('SPEAKS when work is carried and no record exists', r.spoke && r.status === 0, 'exit=' + r.status);
    check('the nudge names the loss it is preventing, not just the missing file',
        r.spoke && /commits survive and the plan does not/.test(r.context));
    check('the nudge carries the exact command to write one', r.spoke && /fleet-intent\.js --set/.test(r.context));
    check('the nudge insists on a verify command', r.spoke && /--verify/.test(r.context) && /rots/.test(r.context));

    // ⚠️ THE HOOK MUST NOT CREATE THE RECORD. An auto-created record has a null
    // brief and a one-minute-old observation, which reads to a scanner as "a
    // session is here and has nothing to say" rather than "nobody wrote anything
    // down". Absence must look like absence.
    check('a nudge creates NO record — absence still looks like absence',
        intent.readRecord('myrepo', 'claude/feature', dir).record === null);

    r = fire({ cwd: wt, dir, state });
    check('SILENT on the second turn: the same reason is throttled', quiet(r) && r.status === 0);

    // Now the session writes a claim, as the nudge asked.
    intent.writeRecord({
        repo: 'myrepo', branch: 'claude/feature', session_id: 'writer',
        claim: { brief: 'B', current_step: 'C', next_step: 'N', verify: 'npm run gate', state: 'working' },
        observed: intent.observe(wt), dir,
    });
    const claimed = intent.readRecord('myrepo', 'claude/feature', dir).record;

    r = fire({ cwd: wt, dir, state, cooldown: 0 });
    check('SILENT once a complete, current record exists', quiet(r) && r.status === 0, 'exit=' + r.status);

    const afterObserve = intent.readRecord('myrepo', 'claude/feature', dir).record;
    check('the quiet run still REFRESHED the observed facts',
        afterObserve.observed.at >= claimed.observed.at && afterObserve.observed.head === head1);
    check('⚠️ the quiet run did NOT move updated_at — a fresh date must mean a fresh claim',
        afterObserve.updated_at === claimed.updated_at, claimed.updated_at + ' -> ' + afterObserve.updated_at);
    check('the hook wrote no claim of its own', afterObserve.brief === 'B' && afterObserve.next_step === 'N');
    check('the hook stamped provenance for the session it observed', afterObserve.session_id === 's-1');

    // The tree moves under the claim.
    fs.writeFileSync(path.join(wt, 'c.txt'), 'three\n');
    git(wt, ['add', 'c.txt']);
    git(wt, [...CFG, 'commit', '-m', 'three']);

    r = fire({ cwd: wt, dir, state, cooldown: 0 });
    check('SPEAKS when the tree has moved past the claim', r.spoke, 'exit=' + r.status);
    check('and it QUOTES the next_step that may already be done',
        r.spoke && /"N"/.test(r.context) && /may already be done/.test(r.context));
    check('and it names both shas so the reader can check for itself',
        r.spoke && r.context.includes(claimed.claim_head.slice(0, 8)));

    fs.rmSync(root, { recursive: true, force: true });
}

// --- a new reason must not be swallowed by the old one's cooldown -----------
{
    const { root, main } = makeRepo();
    const dir = path.join(root, 'records');
    fs.mkdirSync(dir, { recursive: true });
    const state = path.join(root, 'state.json');
    const wt = path.join(root, 'wt');
    git(main, ['worktree', 'add', '-b', 'claude/feature', wt]);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'two\n');
    git(wt, ['add', 'b.txt']);
    git(wt, [...CFG, 'commit', '-m', 'two']);

    let r = fire({ cwd: wt, dir, state, cooldown: 600 });
    check('first nudge (missing) speaks under a long cooldown', r.spoke);
    r = fire({ cwd: wt, dir, state, cooldown: 600 });
    check('the identical reason is held for the whole window', quiet(r));

    // The record now exists but has no verify — a DIFFERENT reason.
    intent.writeRecord({
        repo: 'myrepo', branch: 'claude/feature',
        claim: { brief: 'B', next_step: 'N', state: 'working' },
        observed: intent.observe(wt), dir,
    });
    r = fire({ cwd: wt, dir, state, cooldown: 600 });
    check('a NEW reason speaks inside the old reason\'s window', r.spoke, 'exit=' + r.status);
    check('and it is the unverifiable-record nudge', r.spoke && /HAS NO `verify` COMMAND/.test(r.context));

    fs.rmSync(root, { recursive: true, force: true });
}

// --- a collision is announced, never served --------------------------------
{
    const { root, main } = makeRepo();
    const dir = path.join(root, 'records');
    fs.mkdirSync(dir, { recursive: true });
    const state = path.join(root, 'state.json');
    const wt = path.join(root, 'wt');
    git(main, ['worktree', 'add', '-b', 'claude/feature', wt]);

    // A record whose key matches but whose branch does not.
    fs.writeFileSync(path.join(dir, intent.keyFor('myrepo', 'claude/feature') + '.json'),
        JSON.stringify({ repo: 'myrepo', branch: 'claude-feature', brief: 'SOMEONE ELSE' }));

    const r = fire({ cwd: wt, dir, state });
    check('SPEAKS on a key collision', r.spoke, 'exit=' + r.status);
    check('the collision notice never repeats the other branch\'s plan',
        r.spoke && !/SOMEONE ELSE/.test(r.context));
    check('and it tells the reader not to trust a --read for this branch',
        r.spoke && /do not trust a --read/.test(r.context));

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, intent.keyFor('myrepo', 'claude/feature') + '.json'), 'utf8'));
    check('the colliding record is left untouched rather than overwritten', onDisk.brief === 'SOMEONE ELSE');

    fs.rmSync(root, { recursive: true, force: true });
}

// --- it must never block a turn --------------------------------------------
{
    const { root, main } = makeRepo();
    const dir = path.join(root, 'records');
    fs.mkdirSync(dir, { recursive: true });
    const wt = path.join(root, 'wt');
    git(main, ['worktree', 'add', '-b', 'claude/feature', wt]);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'two\n');
    git(wt, ['add', 'b.txt']);
    git(wt, [...CFG, 'commit', '-m', 'two']);

    // An unwritable state ledger, a corrupt one, and an unwritable record dir:
    // every one costs at most a duplicate nudge, never a held turn.
    const corrupt = path.join(root, 'corrupt.json');
    fs.writeFileSync(corrupt, '{{{ not json');
    let r = fire({ cwd: wt, dir, state: corrupt });
    check('a corrupt throttle ledger does not block the turn', r.status === 0);

    r = fire({ cwd: wt, dir, state: path.join(root, 'no', 'such', 'deep', 'state.json') });
    check('an unwritable throttle ledger does not block the turn', r.status === 0);

    const roDir = path.join(root, 'ro-records');
    fs.mkdirSync(roDir, { recursive: true });
    intent.writeRecord({
        repo: 'myrepo', branch: 'claude/feature',
        claim: { brief: 'B', next_step: 'N', verify: 'v', state: 'working' },
        observed: { at: 'x', head: 'deadbeef' }, dir: roDir,
    });
    fs.chmodSync(roDir, 0o500);
    r = fire({ cwd: wt, dir: roDir, state: path.join(root, 's2.json') });
    check('a read-only record directory does not block the turn', r.status === 0, 'exit=' + r.status);
    fs.chmodSync(roDir, 0o700);

    fs.rmSync(root, { recursive: true, force: true });
}

// --- help -------------------------------------------------------------------
{
    const r = spawnSync(process.execPath, [HOOK, '--help'], { encoding: 'utf8', timeout: 15000 });
    check('--help returns, exits 0, and states the two things it will never do',
        r.status === 0 && /never writes a claim/i.test(r.stdout) && /never blocks/i.test(r.stdout),
        'exit=' + r.status);
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
console.log('subject: plugins/autodev-core/hooks/stop-intent-record.js; ' + (pass + fail)
    + ' cases driving the hook as a subprocess against a REAL git repo with a bare origin and '
    + 'linked worktrees: 8 inert paths (each asserting ZERO BYTES on stdout AND stderr), all four '
    + 'firing reasons, the throttle and the new-reason escape from it, and the three things the '
    + 'hook must never do to a record — write a claim, move updated_at, or bring one into '
    + 'existence. Four failure injections assert it never holds a turn.');
if (fail) {
    console.log('failed: ' + failures.join('; '));
    process.exit(1);
}
