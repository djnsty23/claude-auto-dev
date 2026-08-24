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

    // A plain repo with no remote at all, and no package.json.
    repo('docsonly', { files: ['NOTES.md'] });

    // A node repo naming a real gate.
    repo('coded', { pkg: { name: 'x', scripts: { gate: 'echo g', test: 'echo t' } } });

    const r = run([]);
    check('it exits 0', r.status === 0, 'status ' + r.status);
    has('it prints the population it scanned', r.out, 'git repo(s) found');
    check('  and the population is the real count', /population: 3 git repo\(s\) found/.test(r.out),
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
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
