#!/usr/bin/env node
'use strict';
/**
 * Suite for session-exit.js.
 *
 * The load-bearing property is the one that is easiest to lose: **null must not
 * render as empty.** "no unpushed commits" and "git was never asked" are
 * opposite facts, and once both flatten to a blank section the reader trusts the
 * blank. Every section therefore has THREE outcomes to pin, not two - populated,
 * a real zero, and could-not-read - and the third is the one a careless refactor
 * collapses into the second.
 *
 * Everything runs against throwaway git repos in a temp dir. Nothing reads this
 * machine.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'session-exit.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-exit-'));
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

function run(cwd, args) {
    const r = spawnSync(process.execPath, [SUBJECT].concat(args || []), {
        cwd, encoding: 'utf8',
        // PATH is kept so git resolves; nothing else about this machine is read.
        env: Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: path.join(tmp, 'nogit') }),
    });
    return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function newRepo(name) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 't@t']);
    git(dir, ['config', 'user.name', 'T']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-qm', 'first']);
    return dir;
}

try {
    // ---- a repo with NO upstream: unpushed is UNKNOWABLE, not zero ----------
    //
    // This is the assertion the whole design exists for. Without an upstream
    // there is no answer to "ahead of origin", and rendering that as "None"
    // tells a reader their work is safely pushed when nothing checked.
    {
        const repo = newRepo('no-upstream');
        const r = run(repo, ['--print']);
        check('exits 0 with no upstream', r.status === 0, 'status ' + r.status);
        has('unpushed reports COULD NOT READ', r.out, '**COULD NOT READ.**');
        has('...and says explicitly it is not a zero', r.out, 'This is not "none".');
        // Scoped to the UNPUSHED section on purpose. The uncommitted section in
        // this same fixture is legitimately a real zero, so a repo-wide `lacks`
        // asserts something the subject never promised.
        const unpushedSection = r.out.split('## Unpushed commits')[1].split('## ')[0];
        check('...and that section does NOT claim a real zero',
            unpushedSection.indexOf('A real zero') === -1, unpushedSection.trim().slice(0, 90));
        check('...while a DIFFERENT section in the same run does, so the two are distinguishable',
            r.out.indexOf('None. A real zero') !== -1);
        has('the branch is still reported', r.out, '`main`');
        has('no upstream is named as such', r.out, '_none tracked_');
    }

    // ---- a repo WITH an upstream and nothing ahead: a real zero -------------
    {
        const bare = path.join(tmp, 'origin.git');
        execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'pipe' });
        const repo = newRepo('pushed');
        git(repo, ['remote', 'add', 'origin', bare]);
        git(repo, ['push', '-q', '-u', 'origin', 'main']);

        const r = run(repo, ['--print']);
        has('a tracked branch with nothing ahead is a REAL zero', r.out,
            'None. A real zero: the command ran and returned nothing.');
        lacks('...and is not reported as unreadable', r.out, 'unpushed COULD NOT READ');
        has('the upstream is named', r.out, 'origin/main');

        // ---- and now one commit ahead: it must be listed by subject ---------
        fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
        git(repo, ['add', '.']);
        git(repo, ['commit', '-qm', 'the unpushed one']);
        const r2 = run(repo, ['--print']);
        has('an unpushed commit is listed by its subject', r2.out, 'the unpushed one');
        lacks('...so that section is no longer a zero', r2.out,
            '## Unpushed commits\n\nNone.');

        // ---- dirty vs clean, same three-way distinction ---------------------
        fs.writeFileSync(path.join(repo, 'c.txt'), 'three\n');
        const r3 = run(repo, ['--print']);
        has('an untracked file shows in uncommitted changes', r3.out, 'c.txt');
    }

    // ---- --print must not write, --out must be honoured ---------------------
    {
        const repo = newRepo('writes');
        const before = fs.readdirSync(repo).slice().sort().join(',');
        run(repo, ['--print']);
        check('--print writes no file', fs.readdirSync(repo).slice().sort().join(',') === before,
            fs.readdirSync(repo).join(','));

        const out = path.join(tmp, 'elsewhere.md');
        const r = run(repo, ['--out', out]);
        check('--out writes where it is told', fs.existsSync(out));
        check('  and says where it wrote', r.out.indexOf(out) !== -1, r.out.slice(0, 120));
        // Not `open PR(s)`: gh cannot answer for a fixture repo with no GitHub
        // remote, so the honest render there is `PRs UNKNOWN`. Asserting the
        // happy shape would have pinned an environment, not a behaviour.
        const measured = (r.out.split('measured: ')[1] || '').split('\n')[0];
        check('  and prints what it MEASURED, not just that it wrote',
            measured.indexOf('unpushed') !== -1 && measured.indexOf('dirty') !== -1
            && (measured.indexOf('PR') !== -1), JSON.stringify(measured));
        check('  naming UNKNOWN where a probe could not answer, rather than 0',
            measured.indexOf('UNKNOWN') !== -1, JSON.stringify(measured));
        check('  the file is non-trivial', fs.existsSync(out) && fs.readFileSync(out, 'utf8').length > 400);
        lacks('  and RESUME.md was not written instead', fs.readdirSync(repo).join(','), 'RESUME.md');
    }

    // ---- outside a git repo it must degrade loudly, not crash ---------------
    {
        const plain = path.join(tmp, 'not-a-repo');
        fs.mkdirSync(plain, { recursive: true });
        const r = run(plain, ['--print']);
        check('outside a repo it still exits 0', r.status === 0, 'status ' + r.status);
        has('...and says so rather than inventing a branch', r.out, '_not a git repo_');
        has('...and every section reports unreadable', r.out, '**COULD NOT READ.**');
    }

    // ---- the peer block must refuse to speak for peers ----------------------
    {
        const repo = newRepo('peers');
        const r = run(repo, ['--print', '--peers']);
        has('--peers prints a request, not an assertion', r.out, 'I cannot see your branch');
        has('...and says why it cannot write their file', r.out, 'only ask');
        has('...and warns against joining peers on id', r.out, 'cwd AND branch, never on id');
    }
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
