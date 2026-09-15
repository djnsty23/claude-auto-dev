#!/usr/bin/env node
'use strict';
// Suite for scripts/fleet-intent.js — the record that survives a session.
//
// The module's own --selftest covers the pure functions and is RUN HERE as one
// case, deliberately: a selftest that nothing invokes is a suite nobody grades.
// What this file adds is everything the selftest cannot reach — the CLI as a
// subprocess, and the module against a REAL git repository, because `repoName`,
// `branchOf` and `observe` are wrong in exactly the way a hand-built fixture
// cannot show: a worktree's top-level directory is not its repo's name.
//
// THE ASSERTIONS THAT MATTER MOST are the three invariants the design rests on:
//   * an observation never moves `updated_at`
//   * re-asserting an identical claim never moves `updated_at`
//   * a slug collision serves NO record rather than someone else's
// Each has a planted counterexample here, so a mutant that breaks one is killed
// by a named case rather than by a count.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'fleet-intent.js');
const intent = require(SUBJECT);

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + name + (detail ? '  (' + detail + ')' : '')); }
    else { fail++; failures.push(name); console.log('FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function git(cwd, args) {
    return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
}

/**
 * A real repository with a real origin and a real worktree.
 *
 * Nothing here is faked, because the two facts under test — that a worktree
 * resolves to its PARENT repo's name, and that `on_trunk` follows origin/HEAD —
 * exist only in git's own answers.
 */
function makeRepo() {
    const root = tmpDir('fleet-intent-repo-');
    const bare = path.join(root, 'origin.git');
    const main = path.join(root, 'myrepo');
    git(root, ['init', '--bare', '-b', 'main', bare]);
    git(root, ['init', '-b', 'main', main]);
    const cfg = ['-c', 'user.email=t@example.com', '-c', 'user.name=T'];
    fs.writeFileSync(path.join(main, 'a.txt'), 'one\n');
    git(main, ['add', 'a.txt']);
    git(main, [...cfg, 'commit', '-m', 'one']);
    git(main, ['remote', 'add', 'origin', bare]);
    git(main, ['push', '-u', 'origin', 'main']);
    git(main, ['remote', 'set-head', 'origin', 'main']);
    return { root, bare, main, cfg };
}

function commit(cwd, cfg, name, body) {
    fs.writeFileSync(path.join(cwd, name), body);
    git(cwd, ['add', name]);
    git(cwd, [...cfg, 'commit', '-m', name]);
    return git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
}

function run(args, opts) {
    return spawnSync(process.execPath, [SUBJECT, ...args], Object.assign({ encoding: 'utf8', timeout: 30000 }, opts));
}

// --- the module's own controls ---------------------------------------------
{
    const r = run(['--selftest']);
    check('--selftest passes and reports how many controls ran',
        r.status === 0 && /\d+ controls/.test(r.stdout), 'exit=' + r.status);

    // A selftest that cannot fail proves nothing. Plant a defect in a COPY and
    // require the selftest to notice: this is the control on the control.
    const dir = tmpDir('fleet-intent-mutant-');
    const copy = path.join(dir, 'fleet-intent.js');
    const src = fs.readFileSync(SUBJECT, 'utf8');
    // The mutant: an observation is allowed to refresh the claim's date.
    const mutated = src.replace('if (changed || !prior.updated_at) {', 'if (true) {');
    check('the mutant text actually differs from the source', mutated !== src);
    fs.writeFileSync(copy, mutated);
    const m = spawnSync(process.execPath, [copy, '--selftest'], { encoding: 'utf8', timeout: 30000 });
    check('the selftest FAILS when updated_at is allowed to move on an unchanged claim',
        m.status !== 0, 'exit=' + m.status);
    fs.rmSync(dir, { recursive: true, force: true });
}

// --- against a real repository ----------------------------------------------
{
    const { root, main, cfg } = makeRepo();
    const wt = path.join(root, 'wt-feature');
    git(main, ['worktree', 'add', '-b', 'claude/feature', wt]);

    check('repoName in the main checkout is the repo, not the path',
        intent.repoName(main) === 'myrepo', String(intent.repoName(main)));
    check('repoName in a WORKTREE is still the repo, not the worktree directory',
        intent.repoName(wt) === 'myrepo', String(intent.repoName(wt)));
    check('branchOf reads the worktree branch', intent.branchOf(wt) === 'claude/feature');

    const head0 = git(wt, ['rev-parse', 'HEAD']).stdout.trim();
    const o0 = intent.observe(wt);
    check('observe reads HEAD', o0.head === head0);
    check('a branch at the trunk reads on_trunk true', o0.on_trunk === true, String(o0.on_trunk));
    check('a clean tree reads dirty false', o0.dirty === false, String(o0.dirty));

    const head1 = commit(wt, cfg, 'b.txt', 'two\n');
    const o1 = intent.observe(wt);
    check('a branch ahead of the trunk reads on_trunk false', o1.on_trunk === false, String(o1.on_trunk));
    check('observe follows the new HEAD', o1.head === head1 && head1 !== head0);

    // detached HEAD has no branch to key on, and must say so rather than invent one
    git(wt, ['checkout', '--detach', 'HEAD']);
    check('a detached HEAD yields no branch', intent.branchOf(wt) === null, String(intent.branchOf(wt)));

    check('repoName outside any repo is null', intent.repoName(root) === null || intent.repoName(root) === undefined,
        String(intent.repoName(root)));

    fs.rmSync(root, { recursive: true, force: true });
}

// --- the three invariants, each with a planted counterexample ---------------
{
    const dir = tmpDir('fleet-intent-inv-');

    const a = intent.writeRecord({
        repo: 'r', branch: 'claude/x', session_id: 's1',
        claim: { brief: 'B', next_step: 'N', verify: 'npm run gate', state: 'working' },
        observed: { at: '2026-09-08T00:00:00.000Z', head: 'aaaaaaa' }, dir,
    });

    // INVARIANT 1 — an observation must not move updated_at.
    const b = intent.writeRecord({
        repo: 'r', branch: 'claude/x', session_id: 's2', claim: null,
        observed: { at: '2026-09-08T09:00:00.000Z', head: 'bbbbbbb' }, dir,
    });
    check('an observation does NOT move updated_at', b.record.updated_at === a.record.updated_at,
        a.record.updated_at + ' -> ' + b.record.updated_at);
    check('an observation DOES move observed.at', b.record.observed.at !== a.record.observed.at);
    check('an observation leaves claim_head pinned to the tree the claim was about',
        b.record.claim_head === 'aaaaaaa', String(b.record.claim_head));
    check('a nine-hour-old claim over a moved tree is reported as moved',
        intent.assess(b.record, { head: 'bbbbbbb' }).moved === true);

    // INVARIANT 2 — an identical claim is the same claim.
    const c = intent.writeRecord({ repo: 'r', branch: 'claude/x', claim: { brief: 'B' }, observed: { at: 'x', head: 'ccc' }, dir });
    check('re-asserting an identical claim does NOT move updated_at', c.record.updated_at === a.record.updated_at);
    /* THE CLOCK MUST NOT DECIDE THIS. `updated_at` is an ISO string at MILLISECOND
       resolution, so "the date moved" compared against a sibling write asks whether
       a millisecond elapsed between the two — and on a fast disk it does not.
       `[measured 2026-09-12]` this assertion failed 7 times in 30 runs on macOS
       before the sentinel below, and its mirror image inside fleet-intent.js's own
       selftest let the updated_at mutant survive 6 times in 25. Both directions of
       the same defect: one hid a real break, the other invented one. Two suites and
       three assertions were reading a stopwatch that does not tick fast enough.

       Pinning the stored date to a known past value makes "did it move" answerable
       at any resolution, and keeps the assertion about the WRITE rather than the
       host's disk speed. */
    const PAST = '2000-01-01T00:00:00.000Z';
    const dpath = path.join(dir, intent.keyFor('r', 'claude/x') + '.json');
    const pinned = JSON.parse(fs.readFileSync(dpath, 'utf8'));
    pinned.updated_at = PAST;
    fs.writeFileSync(dpath, JSON.stringify(pinned, null, 1) + '\n');

    const d = intent.writeRecord({ repo: 'r', branch: 'claude/x', claim: { brief: 'DIFFERENT' }, observed: { at: 'x', head: 'ccc' }, dir });
    check('a CHANGED claim does move updated_at', d.record.updated_at !== PAST,
        PAST + ' -> ' + d.record.updated_at);
    check('  and it moves it FORWARD, to a parseable date',
        Date.parse(d.record.updated_at) > Date.parse(PAST), String(d.record.updated_at));
    check('a changed claim re-pins claim_head to the tree it was made about', d.record.claim_head === 'ccc');

    // A partial write must not destroy the rest — the commonest write under a
    // usage limit is `--state checkpointed` alone.
    const e = intent.writeRecord({ repo: 'r', branch: 'claude/x', claim: { state: 'checkpointed' }, observed: { at: 'x', head: 'ccc' }, dir });
    check('writing only --state keeps the brief', e.record.brief === 'DIFFERENT');
    check('writing only --state keeps the verify command', e.record.verify === 'npm run gate');
    check('writing only --state keeps the next_step', e.record.next_step === 'N');

    // INVARIANT 3 — a slug collision serves nothing.
    intent.writeRecord({ repo: 'r', branch: 'claude-y', claim: { brief: 'SOMEONE ELSE' }, observed: null, dir });
    const col = intent.readRecord('r', 'claude/y', dir);
    check('two branch names that slug alike collide onto one file',
        intent.keyFor('r', 'claude/y') === intent.keyFor('r', 'claude-y'));
    check('a collision serves NO record', col.record === null);
    check('a collision is reported as a collision, not as an absence', col.collision === true);
    check('the branch that owns the file still reads its own record',
        intent.readRecord('r', 'claude-y', dir).record.brief === 'SOMEONE ELSE');

    // Provenance is recorded and is never the key.
    check('session_id is stored as provenance', b.record.session_id === 's2');
    check('the filename contains no session id', !intent.keyFor('r', 'claude/x').includes('s1'));

    fs.rmSync(dir, { recursive: true, force: true });
}

// --- reading: absence, staleness, and the fifth state -----------------------
{
    const dir = tmpDir('fleet-intent-read-');
    const env = Object.assign({}, process.env, { AUTODEV_FLEET_INTENT_DIR: dir });

    let r = run(['--list'], { env });
    check('--list on an empty dir exits 1 and says the scan was empty',
        r.status === 1 && /0 record file\(s\)/.test(r.stdout) && /statement about the directory/.test(r.stdout),
        'exit=' + r.status);

    r = run(['--read', '--repo', 'r', '--branch', 'claude/none'], { env });
    check('--read with no record exits 1 and names the file it looked at',
        r.status === 1 && /no intent record/.test(r.stdout) && /looked at/.test(r.stdout), 'exit=' + r.status);

    intent.writeRecord({ repo: 'r', branch: 'claude/z', claim: { brief: 'B', state: 'working' }, observed: { at: 'x', head: 'aaa' }, dir });
    r = run(['--read', '--repo', 'r', '--branch', 'claude/z'], { env });
    check('a record with no verify says so in the words that matter',
        r.status === 0 && /verify\s+\(NONE/.test(r.stdout) && /rots/.test(r.stdout), 'exit=' + r.status);

    intent.writeRecord({ repo: 'r', branch: 'claude/w', claim: { brief: 'B', state: 'sleeping' }, observed: null, dir });
    r = run(['--read', '--repo', 'r', '--branch', 'claude/w'], { env });
    check('an unrecognised state is printed as itself, not folded into a neighbour',
        /state "sleeping" is not one of/.test(r.stdout) && /sleeping/.test(r.stdout));

    r = run(['--read', '--repo', 'r', '--branch', 'claude/z', '--json'], { env });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* stays null */ }
    check('--json emits parseable JSON carrying the record, the observation and the assessment',
        !!parsed && !!parsed.record && 'observed' in parsed && !!parsed.assessment);
    check('--read of ANOTHER branch does not observe THIS tree and call it moved',
        !!parsed && parsed.assessment.moved === null && parsed.observed_here === false,
        parsed && 'moved=' + parsed.assessment.moved + ' observed_here=' + parsed.observed_here);
    check('and it says out loud that the tree was not read from here',
        /not read from here/.test(run(['--read', '--repo', 'r', '--branch', 'claude/z'], { env }).stdout));

    r = run(['--list'], { env });
    check('--list reports a population count matching the files written',
        new RegExp('^' + fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length + ' record file\\(s\\)').test(r.stdout),
        r.stdout.split('\n')[0]);

    fs.rmSync(dir, { recursive: true, force: true });
}

// --- refusals ---------------------------------------------------------------
{
    const dir = tmpDir('fleet-intent-refuse-');
    const env = Object.assign({}, process.env, { AUTODEV_FLEET_INTENT_DIR: dir });
    const nowhere = tmpDir('fleet-intent-nogit-');
    const r = run(['--set', '--brief', 'x'], { env, cwd: nowhere });
    check('--set outside a git repo exits 2 and says it COULD NOT RUN, rather than inventing a key',
        r.status === 2 && /COULD NOT RUN/.test(r.stderr), 'exit=' + r.status);
    check('a refusal writes no record', !fs.existsSync(dir) || fs.readdirSync(dir).length === 0);

    let threw = false;
    try { intent.writeRecord({ repo: 'r', branch: null, claim: {}, dir }); } catch { threw = true; }
    check('writeRecord refuses a record with no branch', threw);

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(nowhere, { recursive: true, force: true });
}

// --- help -------------------------------------------------------------------
{
    const r = run(['--help']);
    check('--help returns, exits 0, and names the four states',
        r.status === 0 && /working \| checkpointed \| complete \| blocked/.test(r.stdout), 'exit=' + r.status);
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
console.log('subject: plugins/autodev-core/scripts/fleet-intent.js; ' + (pass + fail)
    + ' cases over the module selftest and a mutant that must break it, a REAL git repo with a '
    + 'bare origin and a linked worktree (repo name, branch, on_trunk, dirty, detached HEAD), the '
    + 'three design invariants each with a planted counterexample (an observation must not move '
    + 'updated_at, an identical claim must not move it, a slug collision must serve nothing), '
    + 'partial-write merging, absence and population reporting, an unrecognised fifth state, and '
    + 'the refusal paths.');
if (fail) {
    console.log('failed: ' + failures.join('; '));
    process.exit(1);
}
