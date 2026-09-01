#!/usr/bin/env node
'use strict';
/**
 * Suite for auto-brain-survey.js.
 *
 * This script exists to feed overnight briefs, so its failure mode is not a
 * crash — it is a plausible wrong number that becomes a brief somebody works
 * three hours against. The assertions below therefore pin the DISTINCTIONS that
 * change what a brief says, not merely that output appears:
 *
 *   - a client remote is called out, because those must never be pushed
 *   - a trunk that is not main/master is called out, because comparing against
 *     the wrong one inverts verdicts rather than merely dating them
 *   - "gh cannot answer" never renders as "0 open PRs"
 *   - "not a node project" never renders as "no gate found"
 *
 * Every fixture is a throwaway git repo. Nothing reads this machine.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'auto-brain-survey.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-brain-'));
const ROOT = path.join(tmp, 'code');
fs.mkdirSync(ROOT, { recursive: true });
let pass = 0, fail = 0;

function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail ? '  (' + detail + ')' : '')); }
}
const has = (label, hay, needle) =>
    check(label, hay.indexOf(needle) !== -1, 'missing: ' + JSON.stringify(needle));
const lacks = (label, hay, needle) =>
    check(label, hay.indexOf(needle) === -1, 'unexpectedly present: ' + JSON.stringify(needle));

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

/**
 * A repo cloned from a REAL local bare remote, so `git ls-remote` can answer.
 *
 * Every other fixture here points `origin` at a URL that does not resolve,
 * which is fine for the checks they make and useless for this one: the whole
 * defect being pinned is a DISAGREEMENT between the cached refs/remotes/origin/HEAD
 * and what the remote actually says, and you cannot have a disagreement with a
 * remote that never answers.
 *
 * `staleTo` plants the defect the way git itself produces it. git writes
 * refs/remotes/origin/HEAD once at clone time and never touches it again on
 * fetch, so a clone taken before the default branch moved keeps pointing at the
 * old one indefinitely. Repointing the symbolic ref by hand reproduces that
 * state exactly rather than approximating it.
 */
function clonedRepo(name, o) {
    const bare = path.join(tmp, name + '.git');
    const seed = path.join(tmp, name + '-seed');
    fs.mkdirSync(seed, { recursive: true });
    git(seed, ['init', '-q', '-b', o.defaultBranch]);
    git(seed, ['config', 'user.email', 't@t']);
    git(seed, ['config', 'user.name', 'T']);
    fs.writeFileSync(path.join(seed, 'seed.txt'), 'seed' + String.fromCharCode(10));
    git(seed, ['add', '.']);
    git(seed, ['commit', '-qm', 'seed']);
    for (const b of o.alsoBranches || []) git(seed, ['branch', b]);
    execFileSync('git', ['clone', '-q', '--bare', seed, bare], { stdio: 'pipe' });
    // A bare repo's HEAD is what ls-remote --symref reports as the default.
    git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/' + o.defaultBranch]);

    const dir = path.join(ROOT, name);
    execFileSync('git', ['clone', '-q', bare, dir], { stdio: 'pipe' });
    git(dir, ['config', 'user.email', 't@t']);
    git(dir, ['config', 'user.name', 'T']);
    if (o.staleTo) git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/' + o.staleTo]);
    return dir;
}

function repo(name, opts) {
    const o = opts || {};
    const dir = path.join(ROOT, name);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q', '-b', o.branch || 'main']);
    git(dir, ['config', 'user.email', 't@t']);
    git(dir, ['config', 'user.name', 'T']);
    if (o.pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(o.pkg));
    for (const f of o.files || []) fs.writeFileSync(path.join(dir, f), 'x\n');
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-qm', o.subject || 'seed']);
    if (o.remote) git(dir, ['remote', 'add', 'origin', o.remote]);
    if (o.dirty) fs.writeFileSync(path.join(dir, 'scratch.txt'), 'dirty\n');
    return dir;
}

function run(args) {
    const r = spawnSync(process.execPath, [SUBJECT, '--root', ROOT].concat(args || []),
        { encoding: 'utf8' });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

try {
    // A client repo: bitbucket remote. gh cannot answer for it, and it must
    // never be pushed to a personal remote.
    repo('clientproj', {
        remote: 'https://bitbucket.org/someorg/thing.git',
        pkg: { name: 'c', scripts: { test: 'echo t', lint: 'echo l' } },
        dirty: true,
    });

    // Two clones from REAL local bare remotes, for the trunk-cache checks.
    // `staletrunk` is the defect: cloned when the default was `oldtrunk`, and
    // the default has since moved to `main`. git leaves refs/remotes/origin/HEAD
    // pointing at the old one forever, so a survey reading it reports a trunk
    // that was retired, and every ahead/behind number it prints is measured
    // against the wrong base.
    clonedRepo('staletrunk', { defaultBranch: 'main', alsoBranches: ['oldtrunk'], staleTo: 'oldtrunk' });
    // The control. Same construction, cache NOT planted. It must not be flagged,
    // or the warning above is unreadable noise rather than a finding.
    clonedRepo('freshtrunk', { defaultBranch: 'main' });

    // A plain repo with no remote at all, and no package.json.
    repo('docsonly', { files: ['NOTES.md'] });

    // A node repo naming a real gate.
    repo('coded', { pkg: { name: 'x', scripts: { gate: 'echo g', test: 'echo t' } } });

    const r = run([]);
    check('it exits 0', r.status === 0, 'status ' + r.status);
    has('it prints the population it scanned', r.out, 'git repo(s) found');
    // DERIVED, not hardcoded. This assertion read `population: 3` and went red
    // the moment two fixtures were added for the trunk-cache checks -- a true
    // result reported as a failure, which is the shape that trains people to
    // bump the number without reading it. Count the fixtures on disk instead,
    // so adding one can never be indistinguishable from the survey miscounting.
    const expected = fs.readdirSync(ROOT).filter(
        (d) => fs.existsSync(path.join(ROOT, d, '.git'))).length;
    check('  and the population is the real count',
        r.out.indexOf('population: ' + expected + ' git repo(s) found') !== -1,
        (r.out.split('\n').find((l) => l.indexOf('population') !== -1) || '').trim());

    // ---- the client distinction, which decides whether a brief may push -----
    has('a bitbucket remote is flagged as CLIENT', r.out, '[CLIENT');
    has('  and is named in the summary', r.out, 'client repos (never push to a personal remote): clientproj');

    // ---- unanswerable is not zero, which is the whole point -----------------
    //
    // A brief built on "0 open PRs" for a repo gh cannot see sends someone to
    // look at nothing. The two must never render alike.
    has('gh being unable to answer is stated, not flattened to zero', r.out, 'open PRs: COULD NOT CHECK');
    has('  with the reason', r.out, 'not a GitHub remote');
    has('  and the repo is listed in the summary', r.out, 'repos where gh could not answer: clientproj');

    // ---- "no gate" has two meanings and they are different ------------------
    has('a repo with no package.json says there is no gate to run', r.out, 'not a node project');
    has('a repo naming a gate lists it', r.out, 'gate: gate, test');
    lacks('  and a node project is never described as not-a-node-project wrongly',
        r.out.split('### coded')[1].split('###')[0], 'not a node project');

    // ---- dirty counts, since a brief may be about uncommitted work ----------
    check('a dirty repo reports a non-zero count',
        /clientproj[\s\S]*?dirty 1/.test(r.out), 'no "dirty 1" under clientproj');
    check('a clean repo reports zero, not UNREADABLE',
        /docsonly[\s\S]*?dirty 0/.test(r.out), 'no "dirty 0" under docsonly');

    // ---- a large RESUME.md must be called out before anything overwrites it -
    {
        const d = path.join(ROOT, 'docsonly');
        fs.writeFileSync(path.join(d, 'RESUME.md'), 'x'.repeat(25000));
        const r2 = run([]);
        has('a large RESUME.md is flagged as probably hand-written', r2.out, 'probably hand-written');
        has('  and names what protects it', r2.out, 'session-exit.js refuses');
        fs.unlinkSync(path.join(d, 'RESUME.md'));
    }

    // ---- json mode must carry the same distinctions -------------------------
    {
        const j = run(['--json']);
        let parsed = null;
        try { parsed = JSON.parse(j.out); } catch { /* asserted below */ }
        check('--json emits parseable JSON', !!parsed, j.out.slice(0, 160));
        const byName = {};
        for (const x of (parsed && parsed.repos) || []) byName[x.name] = x;
        check('  the client flag survives', byName.clientproj && byName.clientproj.isClient === true);
        check('  prs is null rather than an empty array when gh cannot answer',
            byName.clientproj && byName.clientproj.prs === null,
            JSON.stringify(byName.clientproj && byName.clientproj.prs));
        check('  and a reason is carried alongside it',
            !!(byName.clientproj && byName.clientproj.prsWhy));
        check('  notNode marks the non-node repo', byName.docsonly && byName.docsonly.notNode === true);
        check('  gates are listed for the node repo',
            byName.coded && Array.isArray(byName.coded.gates) && byName.coded.gates[0] === 'gate');
    }

    // ---- an empty root is a real zero, and must say so ----------------------
    {
        const empty = path.join(tmp, 'nothing');
        fs.mkdirSync(empty, { recursive: true });
        const r3 = spawnSync(process.execPath, [SUBJECT, '--root', empty], { encoding: 'utf8' });
        const out = (r3.stdout || '') + (r3.stderr || '');
        has('an empty root still prints a population', out, 'population: 0 git repo(s) found');
        has('  and does not crash', out, 'SUMMARY');
    }

    {
        // THE TRUNK CACHE. This is the check the survey shipped without, and the
        // omission cost three merges on 2026-09-01: two clones still resolved
        // origin/HEAD to a branch retired two days earlier, the survey printed it
        // as `trunk`, and a session briefed another session on that reading.
        const r = run([]);
        has('a stale cached origin/HEAD is reported as stale',
            r.out, 'THE CACHED origin/HEAD IN THIS CLONE IS STALE');
        has('  and names what the cache wrongly says', r.out, 'it says origin/oldtrunk');
        has('  and what the remote actually says', r.out, 'the remote says origin/main');
        has('  and gives the command that repairs the clone', r.out, 'remote set-head origin -a');

        // The numbers must already USE the remote value. A warning that tells you
        // the trunk is wrong while still measuring against it is worse than none:
        // it reads as handled.
        const stale = r.out.split('### staletrunk')[1].split('###')[0];
        has('  the trunk it reports is the REMOTE one, not the cached one',
            stale, 'trunk origin/main');
        lacks('  and never reports the stale cached ref as the trunk',
            stale.split('CACHED origin/HEAD')[0], 'trunk origin/oldtrunk');

        // The control: an identical clone with an accurate cache says nothing.
        const fresh = r.out.split('### freshtrunk')[1].split('###')[0];
        lacks('a clone whose cache matches its remote is NOT flagged',
            fresh, 'IS STALE');
        lacks('  and is not reported as unverified either', fresh, 'NOT confirmed against the remote');

        // A remote that cannot answer is a THIRD outcome, never folded into the
        // other two. Every other fixture here points origin at a URL that does not
        // resolve, so `docsonly`-style repos exercise it: the survey must say the
        // value is cached and unverified rather than presenting it as measured.
        const client = r.out.split('### clientproj')[1].split('###')[0];
        check('a repo whose remote cannot answer says its trunk is unverified',
            client.indexOf('NOT confirmed against the remote') !== -1 ||
            client.indexOf('COULD NOT CHECK') !== -1,
            'clientproj neither flagged unverified nor COULD NOT CHECK');
    }
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
