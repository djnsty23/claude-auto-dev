#!/usr/bin/env node
'use strict';
// Suite for hooks/usage-checkpoint.js.
//
// Drives the hook as a SUBPROCESS against REAL git repositories in tmpdir, with
// a real ledger and a real intent directory, because every decision it makes is
// a read of something outside itself and a test that handed it a parsed object
// would be testing this file's model of a repository rather than a repository.
//
// The assertions that matter most are the SILENT ones. This hook commits and
// pushes; firing when it should not is the expensive failure, so every quiet
// path asserts ZERO BYTES on stdout AND stderr. A mutant that swaps one stream
// for the other has survived in this repo before, which is why both are checked
// every time rather than "no context".
//
// The push paths are exercised against a real BARE repository on disk as the
// origin, not against a network: a suite that skipped the push would leave the
// single riskiest thing this hook does unexercised, and a suite that reached
// GitHub would be a different kind of untrustworthy.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'usage-checkpoint.js');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
    if (ok) {
        pass++;
        console.log('PASS  ' + name + (detail ? '  (' + detail + ')' : ''));
    } else {
        fail++;
        failures.push(name);
        console.log('FAIL  ' + name + (detail ? '  (' + detail + ')' : ''));
    }
}

function tmpDir(prefix) {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function git(args, cwd, input) {
    return spawnSync('git', args, { cwd, encoding: 'utf8', input });
}

/**
 * A repository with an origin, one commit, and a non-default branch checked
 * out — the ordinary shape of an agent's worktree. `origin` is a real bare
 * repo beside it so pushes are exercised without a network.
 */
function repo({ branch = 'claude/work', withOrigin = true, name = 'demo' } = {}) {
    const base = tmpDir('ckpt-');
    const top = path.join(base, name);
    fs.mkdirSync(top, { recursive: true });
    git(['init', '-q', '-b', 'main', '.'], top);
    git(['config', 'user.email', 'suite@example.invalid'], top);
    git(['config', 'user.name', 'Suite'], top);
    git(['config', 'commit.gpgsign', 'false'], top);
    fs.writeFileSync(path.join(top, 'seed.txt'), 'seed\n');
    git(['add', 'seed.txt'], top);
    git(['commit', '-q', '-m', 'seed'], top);

    let originPath = null;
    if (withOrigin) {
        originPath = path.join(base, name + '-origin.git');
        git(['init', '-q', '--bare', originPath], base);
        git(['remote', 'add', 'origin', originPath], top);
        git(['push', '-q', 'origin', 'main'], top);
        git(['remote', 'set-head', 'origin', 'main'], top);
    }
    if (branch !== 'main') git(['checkout', '-q', '-b', branch], top);
    return { base, top, originPath, branch };
}

/** Dirty the tree, and backdate mtimes so an age threshold can be exercised. */
function dirty(top, { modified = ['seed.txt'], untracked = ['new.txt'], ageMinutes = 0 } = {}) {
    for (const f of modified) fs.appendFileSync(path.join(top, f), 'changed\n');
    for (const f of untracked) {
        fs.mkdirSync(path.dirname(path.join(top, f)), { recursive: true });
        fs.writeFileSync(path.join(top, f), 'untracked\n');
    }
    if (ageMinutes > 0) {
        const when = new Date(Date.now() - ageMinutes * 60_000);
        for (const f of modified.concat(untracked)) {
            try { fs.utimesSync(path.join(top, f), when, when); } catch { /* best effort */ }
        }
    }
}

let sessionCounter = 0;
function run(r, { env = {}, sessionId, cwd, payload } = {}) {
    const id = sessionId || 'sess-' + (++sessionCounter);
    const body = payload !== undefined ? payload : JSON.stringify({
        session_id: id,
        cwd: cwd || r.top,
        transcript_path: path.join(r.base, 't.jsonl'),
        hook_event_name: 'Stop',
    });
    const res = spawnSync(process.execPath, [HOOK], {
        input: body,
        encoding: 'utf8',
        env: Object.assign({}, process.env, {
            AUTODEV_CHECKPOINT: '',
            AUTODEV_CHECKPOINT_PUSH: '',
            AUTODEV_CHECKPOINT_AGE_MINUTES: '',
            AUTODEV_CHECKPOINT_MIN_INTERVAL: '',
            AUTODEV_CHECKPOINT_CEILING: '',
            AUTODEV_CHECKPOINT_FRACTION: '',
            AUTODEV_CHECKPOINT_PROBE_MINUTES: '',
            AUTODEV_CHECKPOINT_EMAIL: 'suite@example.invalid',
            AUTODEV_CHECKPOINT_NAME: 'Suite',
            AUTODEV_CHECKPOINT_STATE: r.ledger || (r.ledger = path.join(r.base, 'ledger.json')),
            AUTODEV_FLEET_INTENT_DIR: r.intent || (r.intent = path.join(r.base, 'intent')),
            // No quota probe unless a test asks for one: a suite that shelled out
            // to the real quota-burn would grade this machine's transcripts.
            AUTODEV_QUOTA_BURN: path.join(r.base, 'no-such-quota-burn.js'),
        }, env),
        timeout: 90_000,
    });
    return { id, status: res.status, out: String(res.stdout || ''), err: String(res.stderr || '') };
}

/** The assertion this hook lives or dies by. */
function silentRun(name, res, extra) {
    check(name, res.out === '' && res.err === '' && res.status === 0,
        (extra ? extra + '; ' : '') + 'exit=' + res.status
        + ' stdout=' + JSON.stringify(res.out.slice(0, 120))
        + ' stderr=' + JSON.stringify(res.err.slice(0, 120)));
}

function parsed(res) {
    try { return JSON.parse(res.out); } catch { return null; }
}

function headSubject(top) {
    const r = git(['log', '-1', '--format=%s'], top);
    return String(r.stdout || '').trim();
}

function intentFile(r, repoName, branch) {
    return path.join(r.intent, repoName + '--' + branch.replace(/\//g, '-') + '.json');
}

// ── silence ────────────────────────────────────────────────────────────────

{
    const r = repo();
    silentRun('silent: clean tree', run(r));
}

{
    const r = repo();
    dirty(r.top, { ageMinutes: 0 });
    silentRun('silent: at-risk work younger than the age threshold', run(r));
}

{
    const r = repo({ branch: 'main' });
    dirty(r.top, { ageMinutes: 999 });
    const res = run(r);
    silentRun('silent: refuses the default branch even with old at-risk work', res);
    check('default branch got no checkpoint commit', headSubject(r.top) === 'seed',
        'HEAD subject=' + JSON.stringify(headSubject(r.top)));
}

{
    // A repo whose default branch is NOT called main. The remote's own HEAD is
    // the authority; "main" is a convention, not a fact.
    const base = tmpDir('ckpt-trunk-');
    const top = path.join(base, 'demo');
    fs.mkdirSync(top, { recursive: true });
    git(['init', '-q', '-b', 'trunk', '.'], top);
    git(['config', 'user.email', 'suite@example.invalid'], top);
    git(['config', 'user.name', 'Suite'], top);
    fs.writeFileSync(path.join(top, 'seed.txt'), 'seed\n');
    git(['add', 'seed.txt'], top);
    git(['commit', '-q', '-m', 'seed'], top);
    const originPath = path.join(base, 'origin.git');
    git(['init', '-q', '--bare', originPath], base);
    git(['remote', 'add', 'origin', originPath], top);
    git(['push', '-q', 'origin', 'trunk'], top);
    git(['remote', 'set-head', 'origin', 'trunk'], top);
    const r = { base, top, branch: 'trunk' };
    dirty(top, { ageMinutes: 999 });
    silentRun('silent: refuses a default branch that is not called main', run(r));
    check('non-main trunk got no checkpoint commit', headSubject(top) === 'seed',
        'HEAD subject=' + JSON.stringify(headSubject(top)));
}

{
    const r = repo();
    dirty(r.top, { ageMinutes: 999 });
    git(['checkout', '-q', '--detach'], r.top);
    silentRun('silent: refuses a detached HEAD', run(r));
}

{
    const r = repo();
    dirty(r.top, { ageMinutes: 999 });
    silentRun('silent: AUTODEV_CHECKPOINT=off', run(r, { env: { AUTODEV_CHECKPOINT: 'off' } }));
    check('disabled means no commit', headSubject(r.top) === 'seed',
        'HEAD subject=' + JSON.stringify(headSubject(r.top)));
}

{
    const r = repo();
    dirty(r.top, { ageMinutes: 999 });
    silentRun('silent: payload is not JSON', run(r, { payload: 'not json at all' }));
    silentRun('silent: payload has no session_id',
        run(r, { payload: JSON.stringify({ cwd: r.top, hook_event_name: 'Stop' }) }));
}

{
    const outside = tmpDir('ckpt-nonrepo-');
    const r = { base: outside, top: outside, branch: 'n/a' };
    fs.writeFileSync(path.join(outside, 'loose.txt'), 'x\n');
    silentRun('silent: cwd is not a git repository', run(r));
}

// ── hooks_profile: this hook GUARDS, so the profile must not reach it ──────
/* tooling/test-hooks-profile.js classifies this hook GUARDING and asserts only
   that the guard STRING is absent from the source. That is a check on what is
   NOT written, and it passes just as well on a hook that reads the profile under
   a different spelling, or that grew a `minimal` branch later. The property that
   matters is behavioural: with the profile set to minimal, the rescue still runs.

   "A guard the model could switch off is no guard" — and the model can ask the
   user for a setting. This is the case that makes that sentence true here. */
{
    for (const [key, value] of [
        ['CLAUDE_PLUGIN_OPTION_HOOKS_PROFILE', 'minimal'],
        ['CLAUDE_PLUGIN_OPTION_hooks_profile', 'minimal'],
        ['CLAUDE_PLUGIN_OPTION_HOOKS_PROFILE', 'MINIMAL'],
    ]) {
        const r = repo();
        dirty(r.top, { untracked: ['new.txt'], ageMinutes: 90 });
        const res = run(r, { env: { [key]: value } });
        check('still checkpoints under ' + key + '=' + value,
            /^wip\(checkpoint\)/.test(headSubject(r.top)) && res.status === 0,
            'HEAD=' + JSON.stringify(headSubject(r.top)) + ' exit=' + res.status);
        check('  and still says so, rather than acting in silence',
            Boolean(parsed(res)), 'stdout=' + JSON.stringify(res.out.slice(0, 160)));
    }

    /* The control the three cases above need: the same setup with NO profile set
       also checkpoints. Without it, "minimal changed nothing" would be equally
       consistent with a setup that checkpoints unconditionally for another
       reason — and with one that was broken in the same way in every arm. */
    const c = repo();
    dirty(c.top, { untracked: ['new.txt'], ageMinutes: 90 });
    const cres = run(c);
    check('control: the same setup checkpoints with no profile set',
        /^wip\(checkpoint\)/.test(headSubject(c.top)) && cres.status === 0,
        'HEAD=' + JSON.stringify(headSubject(c.top)));

    /* And the source must not learn to read it. Kept here beside the behaviour
       rather than only in test-hooks-profile.js, so a reader of THIS file sees
       that the omission is deliberate and not an oversight. */
    const src = fs.readFileSync(HOOK, 'utf8');
    check('the hook never reads a plugin option at all',
        !/CLAUDE_PLUGIN_OPTION/i.test(src),
        (src.match(/CLAUDE_PLUGIN_OPTION\w*/gi) || []).join(','));
}

// ── the checkpoint ─────────────────────────────────────────────────────────

{
    const r = repo();
    dirty(r.top, { untracked: ['new.txt', 'nested/deep.txt'], ageMinutes: 90 });
    const res = run(r);
    const j = parsed(res);

    check('fires on at-risk work past the age threshold', Boolean(j), 'stdout=' + res.out.slice(0, 200));
    check('exits 0 when it fires', res.status === 0, 'exit=' + res.status);
    check('writes nothing to stderr when it fires', res.err === '', JSON.stringify(res.err.slice(0, 200)));
    check('emits no decision field, so it cannot fight stop-auto-check',
        Boolean(j) && !('decision' in j) && !('continue' in j), JSON.stringify(Object.keys(j || {})));
    check('speaks to the operator and to the model',
        Boolean(j) && typeof j.systemMessage === 'string' && j.systemMessage.length > 0
        && j.hookSpecificOutput && j.hookSpecificOutput.hookEventName === 'Stop'
        && typeof j.hookSpecificOutput.additionalContext === 'string'
        && j.hookSpecificOutput.additionalContext.length > 0);
    check('names WHICH signal fired it',
        Boolean(j) && /minutes/.test(j.systemMessage) && /exposure/.test(j.hookSpecificOutput.additionalContext),
        j && j.systemMessage);
    check('says the usage fraction was unavailable when no ceiling is configured',
        Boolean(j) && /AUTODEV_CHECKPOINT_CEILING/.test(j.systemMessage), j && j.systemMessage);

    check('commits the at-risk work', /^wip\(checkpoint\)/.test(headSubject(r.top)),
        'HEAD subject=' + JSON.stringify(headSubject(r.top)));

    const after = git(['status', '--porcelain'], r.top).stdout;
    check('leaves the working tree clean', String(after).trim() === '',
        JSON.stringify(String(after).slice(0, 200)));

    const files = String(git(['show', '--name-only', '--format=', 'HEAD'], r.top).stdout).trim().split('\n');
    check('carries the UNTRACKED files a git bundle would have lost',
        files.includes('new.txt') && files.includes('nested/deep.txt'), files.join(','));
    check('carries the modified tracked file', files.includes('seed.txt'), files.join(','));

    const remote = String(git(['log', '-1', '--format=%s', 'refs/heads/' + r.branch], r.originPath).stdout).trim();
    check('pushes the branch to origin', /^wip\(checkpoint\)/.test(remote), 'origin subject=' + JSON.stringify(remote));
    check('reports the push in the operator line',
        Boolean(j) && j.systemMessage.includes('pushed to origin/' + r.branch), j && j.systemMessage);
}

{
    // .gitignore must be respected: the contract says "including untracked
    // (respecting .gitignore)", and a checkpoint that swept node_modules into a
    // commit would be a worse outcome than the one it prevents.
    const r = repo();
    fs.writeFileSync(path.join(r.top, '.gitignore'), 'secret.env\nbuild/\n');
    fs.mkdirSync(path.join(r.top, 'build'));
    fs.writeFileSync(path.join(r.top, 'build', 'out.js'), 'compiled\n');
    fs.writeFileSync(path.join(r.top, 'secret.env'), 'TOKEN=hunter2\n');
    dirty(r.top, { untracked: ['real.txt'], ageMinutes: 90 });
    fs.utimesSync(path.join(r.top, '.gitignore'), new Date(Date.now() - 90 * 60_000), new Date(Date.now() - 90 * 60_000));
    const res = run(r);
    check('fires with ignored files present', Boolean(parsed(res)), res.out.slice(0, 200));
    // Asserted BEFORE the exclusion checks below, because "did not commit the
    // secret" passes vacuously when no checkpoint commit exists at all — which
    // is exactly what a mutant that broke staging produced on the first run.
    check('gitignore case: a checkpoint commit actually exists to inspect',
        /^wip\(checkpoint\)/.test(headSubject(r.top)), 'HEAD subject=' + JSON.stringify(headSubject(r.top)));
    const files = String(git(['show', '--name-only', '--format=', 'HEAD'], r.top).stdout).trim().split('\n');
    check('does NOT commit a .gitignored secret',
        !files.includes('secret.env') && !files.some((f) => f.startsWith('build/')), files.join(','));
    check('does commit the untracked file that is not ignored', files.includes('real.txt'), files.join(','));
}

// ── the intent record ──────────────────────────────────────────────────────

{
    const r = repo({ name: 'proj' });
    dirty(r.top, { ageMinutes: 90 });
    run(r, { sessionId: 'sess-record' });
    const f = intentFile(r, 'proj', 'claude/work');
    check('writes the record at <repo>--<branch>.json with / flattened', fs.existsSync(f), f);
    const rec = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    check('record state is checkpointed', rec.state === 'checkpointed', String(rec.state));
    check('record is keyed by repo and branch, not by cwd',
        rec.repo === 'proj' && rec.branch === 'claude/work', rec.repo + ' / ' + rec.branch);
    check('record carries session_id as provenance', rec.session_id === 'sess-record', String(rec.session_id));
    check('record has every contract field',
        ['repo', 'branch', 'session_id', 'brief', 'current_step', 'next_step', 'verify', 'state', 'updated_at']
            .every((k) => typeof rec[k] === 'string' && rec[k].length > 0),
        JSON.stringify(Object.keys(rec)));
    check('record adds no field the contract does not have',
        Object.keys(rec).length === 9, JSON.stringify(Object.keys(rec)));
    check('updated_at is ISO8601', /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(String(rec.updated_at)), String(rec.updated_at));
    check('verify is a runnable command, not prose',
        /^git -C \S+ log /.test(String(rec.verify)), String(rec.verify));
    check('brief says the hook wrote it rather than inventing an intent',
        /usage-checkpoint hook/.test(String(rec.brief)), String(rec.brief).slice(0, 80));
}

{
    // A record another session already wrote. Its brief and next_step are what
    // makes the work resumable; this hook knows neither and must not overwrite
    // them with its own mechanics.
    const r = repo({ name: 'proj' });
    r.intent = path.join(r.base, 'intent');
    fs.mkdirSync(r.intent, { recursive: true });
    const f = intentFile(r, 'proj', 'claude/work');
    fs.writeFileSync(f, JSON.stringify({
        repo: 'proj',
        branch: 'claude/work',
        session_id: 'an-earlier-session',
        brief: 'add the retry budget to the dispatcher',
        current_step: 'writing the backoff test',
        next_step: 'wire the budget into fleet-notify',
        verify: 'node tooling/test-dispatch-readiness.js',
        state: 'working',
        updated_at: '2026-09-08T00:00:00.000Z',
    }, null, 2));
    dirty(r.top, { ageMinutes: 90 });
    run(r, { sessionId: 'sess-later' });
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    check('preserves an existing brief', rec.brief === 'add the retry budget to the dispatcher', rec.brief);
    check('preserves an existing next_step', rec.next_step === 'wire the budget into fleet-notify', rec.next_step);
    check('preserves an existing verify', rec.verify === 'node tooling/test-dispatch-readiness.js', rec.verify);
    check('flips state from working to checkpointed', rec.state === 'checkpointed', rec.state);
    check('refreshes updated_at', rec.updated_at !== '2026-09-08T00:00:00.000Z', rec.updated_at);
}

{
    // A worktree keys as its PARENT repo, never as the directory it sits in: a
    // worktree outlives the session in it, so a record keyed by directory is
    // served to whoever next occupies it.
    const r = repo({ name: 'parentrepo' });
    const wt = path.join(r.base, 'parentrepo', '.claude', 'worktrees', 'some-name');
    git(['worktree', 'add', '-q', '-b', 'claude/wt-branch', wt], r.top);
    fs.appendFileSync(path.join(wt, 'seed.txt'), 'wt change\n');
    fs.writeFileSync(path.join(wt, 'wt-new.txt'), 'x\n');
    const old = new Date(Date.now() - 90 * 60_000);
    fs.utimesSync(path.join(wt, 'seed.txt'), old, old);
    fs.utimesSync(path.join(wt, 'wt-new.txt'), old, old);
    const res = run(r, { cwd: wt, sessionId: 'sess-wt' });
    check('fires inside a worktree', Boolean(parsed(res)), res.out.slice(0, 200) + res.err.slice(0, 200));
    check('worktree record is keyed by the parent repo, not the worktree directory',
        fs.existsSync(intentFile(r, 'parentrepo', 'claude/wt-branch')),
        fs.existsSync(r.intent) ? fs.readdirSync(r.intent).join(',') : '(no intent dir)');
}

// ── throttle ───────────────────────────────────────────────────────────────

{
    const r = repo();
    dirty(r.top, { ageMinutes: 90 });
    const first = run(r, { sessionId: 'sess-throttle' });
    check('throttle: first run fires', Boolean(parsed(first)), first.out.slice(0, 120));
    dirty(r.top, { modified: ['seed.txt'], untracked: ['second.txt'], ageMinutes: 90 });
    const second = run(r, { sessionId: 'sess-throttle' });
    silentRun('throttle: a second run inside the interval is silent', second);
    const third = run(r, { sessionId: 'sess-throttle', env: { AUTODEV_CHECKPOINT_MIN_INTERVAL: '0.0001' } });
    check('throttle: fires again once the interval has passed', Boolean(parsed(third)), third.out.slice(0, 120));
}

// ── the usage signal ───────────────────────────────────────────────────────

/** A stand-in for quota-burn.js that reports a fixed window cost. */
function fakeQuotaBurn(base, cost) {
    const p = path.join(base, 'fake-quota-burn.js');
    fs.writeFileSync(p, 'console.log(JSON.stringify({ windowCost: ' + cost
        + ', windowStart: "2026-09-01T23:00:00.000Z" }));\n');
    return p;
}

{
    // Young work: only the usage signal can fire here, which is what makes this
    // an escalation rather than a duplicate of the age threshold.
    const r = repo();
    dirty(r.top, { ageMinutes: 0 });
    const res = run(r, {
        env: {
            AUTODEV_QUOTA_BURN: fakeQuotaBurn(r.base, 4200),
            AUTODEV_CHECKPOINT_CEILING: '4608',
        },
    });
    const j = parsed(res);
    check('usage signal fires on young work when the ceiling is nearly gone', Boolean(j), res.out.slice(0, 200));
    check('usage signal reports the fraction it measured',
        Boolean(j) && /91% of the configured \$4608 ceiling/.test(j.systemMessage), j && j.systemMessage);
    check('usage signal is named as such to the model',
        Boolean(j) && /usage —/.test(j.hookSpecificOutput.additionalContext),
        j && j.hookSpecificOutput.additionalContext.slice(0, 160));
}

{
    const r = repo();
    dirty(r.top, { ageMinutes: 0 });
    silentRun('usage signal stays quiet well below the ceiling', run(r, {
        env: {
            AUTODEV_QUOTA_BURN: fakeQuotaBurn(r.base, 500),
            AUTODEV_CHECKPOINT_CEILING: '4608',
        },
    }));
}

{
    // A quota source that cannot be read must not become a zero: a zero reads as
    // "plenty of headroom", which is the one wrong answer.
    const r = repo();
    dirty(r.top, { ageMinutes: 0 });
    const broken = path.join(r.base, 'broken-quota.js');
    fs.writeFileSync(broken, 'process.stderr.write("boom\\n"); process.exit(3);\n');
    silentRun('an unreadable quota source does not read as zero consumption', run(r, {
        env: { AUTODEV_QUOTA_BURN: broken, AUTODEV_CHECKPOINT_CEILING: '4608' },
    }));
}

{
    const r = repo();
    dirty(r.top, { ageMinutes: 90 });
    const res = run(r, {
        env: { AUTODEV_QUOTA_BURN: fakeQuotaBurn(r.base, 4200), AUTODEV_CHECKPOINT_CEILING: '4608' },
    });
    const j = parsed(res);
    check('with a ceiling set, the line does not claim the fraction was unreadable',
        Boolean(j) && !/AUTODEV_CHECKPOINT_CEILING/.test(j.systemMessage), j && j.systemMessage);
}

// ── failure modes, all of which must fail open ─────────────────────────────

{
    const r = repo({ withOrigin: false });
    dirty(r.top, { ageMinutes: 90 });
    const res = run(r);
    const j = parsed(res);
    check('no origin: still commits', /^wip\(checkpoint\)/.test(headSubject(r.top)), headSubject(r.top));
    check('no origin: exits 0', res.status === 0, 'exit=' + res.status);
    check('no origin: writes nothing to stderr', res.err === '', JSON.stringify(res.err.slice(0, 200)));
    check('no origin: says the work is on one machine only',
        Boolean(j) && /NOT PUSHED/.test(j.systemMessage)
        && /THE PUSH DID NOT HAPPEN/.test(j.hookSpecificOutput.additionalContext),
        j && j.systemMessage);
}

{
    const r = repo();
    dirty(r.top, { ageMinutes: 90 });
    const res = run(r, { env: { AUTODEV_CHECKPOINT_PUSH: 'off' } });
    check('push off: commits locally', /^wip\(checkpoint\)/.test(headSubject(r.top)), headSubject(r.top));
    const remote = git(['log', '-1', '--format=%s', 'refs/heads/' + r.branch], r.originPath);
    check('push off: origin never receives the branch', remote.status !== 0,
        'origin exit=' + remote.status);
}

{
    // The push fails but the commit stands. The record must still say
    // checkpointed — the commit IS the checkpoint — and the transcript must say
    // the work never left the machine.
    const r = repo();
    dirty(r.top, { ageMinutes: 90 });
    fs.rmSync(r.originPath, { recursive: true, force: true });
    const res = run(r, { sessionId: 'sess-pushfail' });
    const j = parsed(res);
    check('push failure: exits 0', res.status === 0, 'exit=' + res.status);
    check('push failure: writes nothing to stderr', res.err === '', JSON.stringify(res.err.slice(0, 200)));
    check('push failure: the commit still stands', /^wip\(checkpoint\)/.test(headSubject(r.top)), headSubject(r.top));
    check('push failure: is reported, not swallowed',
        Boolean(j) && /NOT PUSHED/.test(j.systemMessage), j && j.systemMessage);
}

{
    // Nothing can be committed. The record must NOT claim checkpointed: chip 3
    // re-dispatches off that field, and a record saying the work is saved when
    // it is still only in a working tree sends the next session to a branch
    // without it.
    const r = repo({ name: 'proj' });
    dirty(r.top, { ageMinutes: 90 });
    const res = run(r, { sessionId: 'sess-commitfail', env: { AUTODEV_CHECKPOINT_EMAIL: '', AUTODEV_CHECKPOINT_NAME: '' , GIT_CONFIG_GLOBAL: path.join(r.base, 'nope'), GIT_CONFIG_SYSTEM: path.join(r.base, 'nope') } });
    // The repo has a local identity, so this run still succeeds; the case that
    // matters is asserted below by making the index unwritable instead.
    check('identity override absent is not itself a failure', res.status === 0, 'exit=' + res.status);
}

{
    const r = repo({ name: 'proj' });
    dirty(r.top, { ageMinutes: 90 });
    /* A COMMIT THAT CANNOT BE MADE, INJECTED PORTABLY. This used to chmod
       .git/objects to 0o500. On Windows that is a no-op for a DIRECTORY — Node
       maps chmod to the read-only attribute, and not for directories — so the
       commit SUCCEEDED and four assertions below failed on windows-latest, twice,
       while macOS and ubuntu passed. The assertions were right; the injection was
       not portable, and a failure injection that silently does nothing turns a
       test of the failure path into a test of the success path.

       `.git/index.lock` is the portable mechanism: git refuses to write the index
       while it exists, on every platform, through permissions nobody has to own.
       The control below proves the injection took effect rather than assuming it —
       that is the whole lesson of the chmod version. */
    const lock = path.join(r.top, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    const res = run(r, { sessionId: 'sess-nocommit' });
    check('commit failure: the injection actually took effect (git could not touch the index)',
        fs.existsSync(lock),
        fs.existsSync(lock) ? 'lock held throughout the run'
            : 'index.lock GONE — git removed it, so the failure path was never exercised');
    fs.rmSync(lock, { force: true });
    const j = parsed(res);
    check('commit failure: exits 0', res.status === 0, 'exit=' + res.status);
    check('commit failure: writes nothing to stderr', res.err === '', JSON.stringify(res.err.slice(0, 300)));
    check('commit failure: no checkpoint commit exists', headSubject(r.top) === 'seed', headSubject(r.top));
    check('commit failure: is reported to the model as still at risk',
        Boolean(j) && /THE COMMIT DID NOT HAPPEN/.test(j.hookSpecificOutput.additionalContext),
        j && j.hookSpecificOutput.additionalContext.slice(0, 200));
    // A line that opens "your worktree was committed" and closes "the commit did
    // not happen" makes the reader pick a half to believe. It must never say both.
    check('commit failure: does not also claim the worktree WAS committed',
        Boolean(j) && !/worktree was committed/.test(j.hookSpecificOutput.additionalContext)
        && /could NOT be committed/.test(j.hookSpecificOutput.additionalContext),
        j && j.hookSpecificOutput.additionalContext.slice(0, 120));
    const f = intentFile(r, 'proj', 'claude/work');
    const rec = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    check('commit failure: the record does NOT claim checkpointed', rec.state === 'blocked', String(rec.state));
}

{
    // An intent directory that cannot be written costs a record, never a turn.
    const r = repo();
    dirty(r.top, { ageMinutes: 90 });
    const blocked = path.join(r.base, 'blocked-intent');
    fs.writeFileSync(blocked, 'this is a file, not a directory\n');
    r.intent = path.join(blocked, 'sub');
    const res = run(r);
    check('unwritable intent dir: exits 0', res.status === 0, 'exit=' + res.status);
    check('unwritable intent dir: writes nothing to stderr', res.err === '', JSON.stringify(res.err.slice(0, 200)));
    check('unwritable intent dir: the commit still happened',
        /^wip\(checkpoint\)/.test(headSubject(r.top)), headSubject(r.top));
    const j = parsed(res);
    check('unwritable intent dir: is reported',
        Boolean(j) && /COULD NOT BE WRITTEN/.test(j.hookSpecificOutput.additionalContext),
        j && j.hookSpecificOutput.additionalContext.slice(0, 200));
}

{
    // A ledger that cannot be written costs a repeated checkpoint, never a turn.
    const r = repo();
    dirty(r.top, { ageMinutes: 90 });
    const blockedLedger = path.join(r.base, 'blocked-ledger');
    fs.writeFileSync(blockedLedger, 'not a directory\n');
    r.ledger = path.join(blockedLedger, 'state.json');
    const res = run(r);
    check('unwritable ledger: exits 0', res.status === 0, 'exit=' + res.status);
    check('unwritable ledger: writes nothing to stderr', res.err === '', JSON.stringify(res.err.slice(0, 200)));
    check('unwritable ledger: the commit still happened',
        /^wip\(checkpoint\)/.test(headSubject(r.top)), headSubject(r.top));
}

// ── the --help contract ────────────────────────────────────────────────────

{
    const res = spawnSync(process.execPath, [HOOK, '--help'], { encoding: 'utf8' });
    check('--help exits 0 and describes the trigger',
        res.status === 0 && /AUTODEV_CHECKPOINT_AGE_MINUTES/.test(String(res.stdout))
        && /not readable/.test(String(res.stdout)),
        'exit=' + res.status);
    check('--help writes nothing to stderr', String(res.stderr || '') === '',
        JSON.stringify(String(res.stderr || '').slice(0, 200)));
}

console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
if (fail) {
    console.log('failed: ' + failures.join('; '));
    process.exitCode = 1;
}
