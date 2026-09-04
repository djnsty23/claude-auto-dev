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

    // ---- it must not eat a hand-written RESUME.md ---------------------------
    //
    // `[measured 2026-08-25]` a peer ran this an hour after it shipped and it
    // replaced a TRACKED, hand-written 2,427-line project handoff with a 3kB
    // snapshot. RESUME.md as a project doc is a convention in more than one repo
    // here, so the collision is likely rather than exotic.
    //
    // The test is AUTHORSHIP, not tracking. Refusing on tracked alone would stop
    // the tool updating its own committed output, and a tool that cannot run
    // twice is one nobody runs once.
    {
        const repo = newRepo('handwritten');
        const doc = path.join(repo, 'RESUME.md');
        const original = 'A hand-written project handoff.\nReal work nobody can reconstruct.\n';
        fs.writeFileSync(doc, original);
        git(repo, ['add', 'RESUME.md']);
        git(repo, ['commit', '-qm', 'the handoff']);

        const r = run(repo, []);
        check('it REFUSES to overwrite a tracked file it did not write', r.status === 3,
            'status ' + r.status);
        check('  and the file is byte-identical afterwards',
            fs.readFileSync(doc, 'utf8') === original);
        has('  and says why, on stderr', r.err, 'REFUSING to overwrite');
        has('  and names the escape hatches', r.err, '--out');

        // --force is the escape hatch, and it must actually work or the refusal
        // becomes a dead end rather than a guard.
        const f = run(repo, ['--force']);
        check('  --force overrides it', f.status === 0, 'status ' + f.status);
        check('  ...and the file is genuinely replaced',
            fs.readFileSync(doc, 'utf8') !== original);

        // Now the file carries our marker, so a plain rerun must succeed. This
        // is the half a tracking-only check would break.
        const again = run(repo, []);
        check('  a rerun over OUR OWN output needs no --force', again.status === 0,
            'status ' + again.status);
    }

    {
        // A SMALL untracked foreign file is a stray. Replaceable.
        const repo = newRepo('untracked-resume');
        fs.writeFileSync(path.join(repo, 'RESUME.md'), 'scratch\n');
        const r = run(repo, []);
        check('a small UNTRACKED foreign RESUME.md is replaced without ceremony', r.status === 0,
            'status ' + r.status);
    }

    // ---- a LARGE untracked file is the hole the first guard left open -------
    //
    // `[measured 2026-08-25]` The first version keyed on tracking alone. A peer
    // named the gap the same hour: "a repo where RESUME.md is untracked loses it
    // outright." Tracking is what made the first incidents RECOVERABLE, not what
    // made them wrong — a guard that only fires where `git restore` would have
    // saved you anyway protects the case that needed it least.
    //
    // The file destroyed in the third incident was 458 KB / 6,132 lines against
    // a 5 KB snapshot. Two orders of magnitude is a hard stop, not a warning.
    {
        const repo = newRepo('untracked-huge');
        const doc = path.join(repo, 'RESUME.md');
        const original = 'A hand-maintained cold-start document.\n' + 'x'.repeat(40000);
        fs.writeFileSync(doc, original);
        // Deliberately NOT committed: this is the unrecoverable case.
        const r = run(repo, []);
        check('a LARGE untracked foreign file is refused too', r.status === 3, 'status ' + r.status);
        check('  and is byte-identical afterwards', fs.readFileSync(doc, 'utf8') === original);
        has('  and the refusal cites the size, not tracking', r.err, 'far larger than the');
        has('  and says an untracked one is unrecoverable', r.err, 'not recoverable at all');
        const f = run(repo, ['--force']);
        check('  --force still overrides', f.status === 0, 'status ' + f.status);
    }

    // ---- a LARGE file that QUOTES the marker --------------------------------
    //
    // `[measured 2026-09-05]` The marker test used to run BEFORE `tracked` and
    // `huge` were computed, so quoting the marker was an unconditional write
    // permit. Measured on the real file, one variable, the ordering:
    //
    //     shipped script   exit 0   25,804 b -> 2,141 b   23,663 bytes destroyed
    //     reordered        exit 3   25,804 b -> 25,804 b  intact
    //
    // The document that triggered it carried the string once, inside a paragraph
    // whose whole purpose was to say the file is NOT generated. The files most
    // likely to quote a marker are exactly the long hand-written handoffs this
    // guard exists to protect.
    //
    // Same class as a mutation-test token tripping a secret scanner, polarity
    // reversed: that caused a false alarm, this caused a silent deletion.
    //
    // MARKER is read OUT OF THE SUBJECT rather than spelled here, so the two
    // cannot drift. A test hard-coding the string would keep passing against a
    // subject whose marker had changed, which is the same one-fact-in-two-files
    // defect this case is about.
    {
        const src = fs.readFileSync(SUBJECT, 'utf8');
        const m = src.match(/^const MARKER = '([^']+)';/m);
        check('the suite can read MARKER out of the subject', !!m,
            'no `const MARKER = ...` line; this case would be vacuous without it');

        if (m) {
            const marker = m[1];
            const repo = newRepo('quoted-marker');
            const doc = path.join(repo, 'RESUME.md');
            // Big enough to clear SUSPICIOUS_BYTES and to dwarf what the script
            // writes for a fixture repo, which is what `huge` tests.
            const original = 'This file is NOT generated. It is hand-written.\n'
                + 'The string ' + marker + ' appears above only to explain the\n'
                + 'convention and warn the next reader about it.\n'
                + 'x'.repeat(60000) + '\n';
            fs.writeFileSync(doc, original);
            git(repo, ['add', 'RESUME.md']);
            git(repo, ['commit', '-qm', 'a handoff that documents the marker']);

            const r = run(repo, []);
            check('a LARGE file QUOTING the marker is refused, not adopted',
                r.status === 3, 'status ' + r.status);
            check('  and is byte-identical afterwards',
                fs.readFileSync(doc, 'utf8') === original);
            has('  and the refusal names the quoting, not foreign authorship',
                r.err, 'QUOTES');
            lacks('  and does NOT claim we did not write it, which would be unprovable',
                r.err, 'it was not written by this script');

            // The half a naive fix would break: our own output carries the marker
            // and is SMALL, so a rerun must still need no --force.
            const small = newRepo('small-marker');
            const sdoc = path.join(small, 'RESUME.md');
            const first = run(small, []);
            check('  a fresh write still succeeds', first.status === 0, 'status ' + first.status);
            check('  ...and carries the marker',
                fs.readFileSync(sdoc, 'utf8').indexOf(marker) !== -1);
            check('  ...and a rerun over our own small output needs no --force',
                run(small, []).status === 0);
        }
    }

    // ---- the closing advice must be DERIVED, not prescribed -----------------
    //
    // Reported by a peer working a GTM/analytics engagement with no package.json
    // and no CHANGELOG: the advice told them to run a gate and read a changelog,
    // so a reader "burns its first minutes looking for files that do not exist".
    // This script exists to stop unverified things rendering as fact, and its
    // last section asserted two.
    {
        const bare = newRepo('no-code');
        const r = run(bare, ['--print']);
        has('with no package.json it SAYS there is no gate', r.out, 'no `package.json` here');
        has('  and tells the reader not to go hunting', r.out, 'hunting');
        lacks('  and does not prescribe a gate', r.out, 'before believing anything is green');
        lacks('  and does not prescribe CHANGELOG.md', r.out, 'Read `CHANGELOG.md`');

        const coded = newRepo('with-gate');
        fs.writeFileSync(path.join(coded, 'package.json'),
            JSON.stringify({ name: 'x', scripts: { test: 'echo t', validate: 'echo v' } }));
        fs.writeFileSync(path.join(coded, 'CHANGELOG.md'), '# c\n');
        const r2 = run(coded, ['--print']);
        has('with a package.json it names the script it READ', r2.out, 'npm run test');
        lacks('  preferring the fuller run over validate', r2.out, 'npm run validate');
        has('  and lists only docs that exist', r2.out, '`CHANGELOG.md`');
        lacks('  not ones that do not', r2.out, '`DECISIONS.md`');
        has('  and says the steps were derived', r2.out, 'derived from what is actually in');
    }

    // ---- --help MUST NOT WRITE ----------------------------------------------
    //
    // `[measured 2026-09-02]` it did. The flag was unrecognised and fell through
    // to the main path, so asking what this script does REGENERATED RESUME.md in
    // the working tree. --help is the one argument a reader uses to decide
    // whether to run something, and check-entrypoints.js probes every
    // plugins/*/scripts/*.js with exactly it — contained there only because that
    // probe copies the repo first, which is its isolation rather than this
    // script's good behaviour.
    //
    // Asserted on the FILESYSTEM, not on the output. A usage string proves the
    // branch printed; only an unchanged file proves it did not also write.
    {
        const repo = newRepo('helpnowrite');
        const target = path.join(repo, 'RESUME.md');
        fs.writeFileSync(target, 'SENTINEL — --help must not overwrite this\n');
        const before = fs.readFileSync(target, 'utf8');

        const r = run(repo, ['--help']);
        check('--help exits 0', r.status === 0, 'exit ' + r.status);
        check('--help leaves RESUME.md byte-identical',
            fs.readFileSync(target, 'utf8') === before,
            'the file was rewritten by a flag that only asks what the script does');
        has('--help names the only non-writing mode', r.out, '--print');
        has('--help says it writes by default', r.out, 'WRITES A FILE');

        // The planted positive. Without it the assertions above pass against a
        // script that never writes at all, which would be a different defect
        // wearing the same green.
        const r2 = run(repo, []);
        check('planted positive: a bare run DOES write, so the check above is about --help',
            fs.readFileSync(target, 'utf8') !== before, 'exit ' + r2.status);
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
