#!/usr/bin/env node
'use strict';

// Acceptance tests for check-dispatch-readiness.js.
//
// Every fixture is a REAL git repository built in a temp directory, because the
// three findings are all statements about git ancestry and a stubbed git would
// only prove the stub agrees with itself. Fixtures are synthetic throughout: no
// repo of the operator's is named, and this file ships in a public tree.
//
// The negatives matter as much as the positives here. A checker that flags every
// worktree is useless in a fleet that runs eleven of them, and the failure this
// script exists to prevent is silent, so an over-firing version gets muted and
// then misses the real one.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SUBJECT = path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'check-dispatch-readiness.js');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
    if (cond) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (extra ? '  — ' + extra : '')); }
}

function git(cwd, args) {
    return execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    }).trim();
}

function write(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, 'utf8'); }

/** An origin plus a clone, so `--remotes=origin` and ancestry are real. */
function makeRepo(base, name) {
    const bare = path.join(base, name + '.git');
    fs.mkdirSync(bare, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore', windowsHide: true });

    const work = path.join(base, name);
    execFileSync('git', ['clone', bare, work], { stdio: 'ignore', windowsHide: true });
    git(work, ['config', 'user.email', 't@example.invalid']);
    git(work, ['config', 'user.name', 'T']);
    write(path.join(work, 'a.txt'), 'one\n');
    git(work, ['add', '.']);
    git(work, ['commit', '-m', 'one']);
    git(work, ['push', '-u', 'origin', 'main']);
    return { bare, work };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-ready-'));
let subject;
try {
    subject = require(SUBJECT);

    // ---- fixture: a repo whose TRUNK is a branch other than the default -------
    // This is the shape that produced the real incident: origin/HEAD says one
    // thing, development lands somewhere else.
    const { work } = makeRepo(TMP, 'alpha');
    git(work, ['checkout', '-q', '-b', 'deploy']);
    write(path.join(work, 'b.txt'), 'trunk work\n');
    git(work, ['add', '.']);
    git(work, ['commit', '-m', 'trunk moves ahead']);
    git(work, ['push', '-q', '-u', 'origin', 'deploy']);
    git(work, ['checkout', '-q', 'main']);

    const rightBase = path.join(TMP, 'wt-right');
    git(work, ['worktree', 'add', '-q', rightBase, 'origin/deploy']);
    const wrongBase = path.join(TMP, 'wt-wrong');
    git(work, ['worktree', 'add', '-q', wrongBase, 'origin/main']);

    // ---- 1. the base check, both directions ---------------------------------
    const r1 = subject.inspect(work, { trunk: 'origin/deploy' });

    // ⚠️ realpath BOTH SIDES, never path.resolve. Two spellings of one directory
    // compare unequal, and which spelling you get depends on who produced it.
    // [measured 2026-09-03] this suite passed on a local Windows box and failed
    // 4 of 18 on the Windows CI runner, whose temp directory is an 8.3 SHORT
    // NAME (`RUNNER~1`) while git reports the long form. There is no short name
    // locally, so the defect is invisible on the machine that wrote it — which
    // is why "it passes on my machine" is not evidence here.
    // This repo already documents the same class on macOS, where /var and
    // /private/var are one directory. Resolve before comparing, always.
    // `.native` FIRST, and it is the only one that works. [measured 2026-09-03]
    // against a real 8.3 name (`AVERYL~1` beside `averylongdirectoryname`):
    //   path.resolve        short === long   FALSE
    //   fs.realpathSync     short === long   FALSE   <- the fix that did not work
    //   realpathSync.native short === long   TRUE
    // realpathSync resolves symlinks and normalises separators; it does NOT
    // expand a short name. Only the native call does, because it goes through
    // GetFinalPathNameByHandle. The first attempt at this used the non-native
    // form, passed locally, and failed the runner identically to the original
    // bug — a fix aimed at the right class with the wrong API.
    const real = (p) => {
        try { return fs.realpathSync.native(p); } catch { /* fall through */ }
        try { return fs.realpathSync(p); } catch { return path.resolve(p); }
    };
    const rowFor = (res, dir) => res.rows.find((r) => real(r.worktree) === real(dir));
    const kinds = (row) => (row ? row.findings.map((f) => f.kind) : ['<row missing>']);

    // Named for what it proves: that the rows came from THIS repository. The
    // earlier version asserted `ok && rows.length >= 3`, and an adversarial
    // mutation that bypassed every git read and returned three fabricated rows
    // left it green. A count is not provenance, so this identifies the three
    // worktrees the fixture actually built.
    ok('inspect ENUMERATES the worktrees this fixture built, not merely three rows',
        r1.ok && r1.rows.length >= 3
            && [work, rightBase, wrongBase].every((d) => rowFor(r1, d) !== undefined),
        'rows=' + (r1.rows ? r1.rows.length : 'none')
            + ' matched=' + [work, rightBase, wrongBase].filter((d) => rowFor(r1, d)).length + '/3');

    ok('a worktree forked BEFORE the trunk is WRONG BASE',
        kinds(rowFor(r1, wrongBase)).includes('WRONG BASE'), kinds(rowFor(r1, wrongBase)).join(','));
    ok('  and it says how many commits are missing',
        (rowFor(r1, wrongBase) || { findings: [] }).findings
            .some((f) => f.kind === 'WRONG BASE' && /\d+ commit/.test(f.detail)));
    ok('a worktree ON the trunk is NOT flagged',
        !kinds(rowFor(r1, rightBase)).includes('WRONG BASE'), kinds(rowFor(r1, rightBase)).join(','));

    // ---- 1b. a DIFFERENT SPELLING of the same directory must still match ----
    // The CI failure was an 8.3 short name (`RUNNER~1`), which cannot be made on
    // a machine that has none. A symlink is the same property reachable
    // everywhere: two paths naming one directory, which `path.resolve` cannot
    // collapse because it never touches the filesystem.
    //
    // MUTATION-TESTED, and the first version FAILED that test. It compared
    // `path.join(dir, '.') + sep` against `dir` — two spellings `path.resolve`
    // also normalises — so it passed with the defect reinstalled and could
    // never have caught anything. An assertion that cannot fail is worse than
    // no assertion, because it reads as coverage.
    let differs = false;
    const alias = path.join(TMP, 'alias-wrong');
    try {
        // 'junction' is the Windows form that needs no elevation.
        fs.symlinkSync(wrongBase, alias, 'junction');
        // Self-check: the two spellings must actually DIFFER, or this proves
        // nothing. Deriving the precondition from the fixture rather than
        // assuming the platform provides it.
        differs = fs.realpathSync(alias) !== path.resolve(alias);
    } catch { /* no privilege to link: report unverified, never pass */ }
    if (differs) {
        ok('a differently-spelled path finds the same worktree row',
            rowFor(r1, alias) === rowFor(r1, wrongBase) && rowFor(r1, alias) !== undefined,
            'alias=' + (rowFor(r1, alias) ? 'found' : 'MISSING'));
    } else {
        console.log('UNVERIFIED  path-spelling assertion did not run — no distinct second '
            + 'spelling available here. This is absent coverage, not a pass.');
    }

    // ---- 2. no trunk given: the base check must not run at all ---------------
    // BOTH base findings, not just WRONG BASE. The earlier version named only
    // one, so a mutation that forced the base check to run and reported every
    // row TRUNK UNREADABLE left it green — the check ran, which is exactly what
    // the heading says must not happen, and the assertion could not see it.
    // Assert the contract the heading states, not one symptom of breaking it.
    const BASE_KINDS = new Set(['WRONG BASE', 'TRUNK UNREADABLE']);
    const r2 = subject.inspect(work, {});
    ok('with no trunk, the base check does not run at all',
        !r2.rows.some((r) => r.findings.some((f) => BASE_KINDS.has(f.kind))),
        'saw=' + JSON.stringify([...new Set(r2.rows.flatMap((r) => r.findings.map((f) => f.kind)))]));

    // ---- 3. INHABITED: commits on no origin ref ------------------------------
    git(rightBase, ['config', 'user.email', 't@example.invalid']);
    git(rightBase, ['config', 'user.name', 'T']);
    write(path.join(rightBase, 'c.txt'), 'someone elses work\n');
    git(rightBase, ['add', '.']);
    git(rightBase, ['commit', '-m', 'unpushed']);
    const r3 = subject.inspect(work, { trunk: 'origin/deploy' });
    ok('a worktree carrying an unpushed commit is INHABITED',
        kinds(rowFor(r3, rightBase)).includes('INHABITED'), kinds(rowFor(r3, rightBase)).join(','));
    ok('  and INHABITED names ancestry rather than claiming lost work',
        (rowFor(r3, rightBase) || { findings: [] }).findings
            .some((f) => f.kind === 'INHABITED' && /ancestry/i.test(f.detail)));
    ok('  control: the same worktree was NOT inhabited a moment earlier',
        !kinds(rowFor(r1, rightBase)).includes('INHABITED'));

    // ---- 4. WRONG REPO -------------------------------------------------------
    // A bogus expected origin rather than a second real repository. The check
    // compares normalised URLs, so a string that cannot match exercises exactly
    // the same branch — and building a second origin cost seven process spawns
    // to prove something a string proves. [measured 2026-09-03] this suite ran
    // 19s against a comparable suite's 3s and timed out the mutation sweep's
    // runner canary; process spawns on Windows were the whole of it.
    const r4 = subject.inspect(work, { trunk: 'origin/deploy', expectOrigin: '/nowhere/that-repo' });
    ok('every worktree is WRONG REPO when the expected origin differs',
        r4.rows.every((r) => r.findings.some((f) => f.kind === 'WRONG REPO')));
    ok('  control: with no expectation, none is WRONG REPO',
        !r3.rows.some((r) => r.findings.some((f) => f.kind === 'WRONG REPO')));

    // ---- 5. no population -> vouches for nothing -----------------------------
    const notRepo = path.join(TMP, 'not-a-repo');
    fs.mkdirSync(notRepo, { recursive: true });
    const r6 = subject.inspect(notRepo, {});
    ok('a non-repository reports no population rather than a clean bill',
        r6.ok === false && /not a git repository/.test(r6.reason), JSON.stringify(r6.reason));

    // ---- 6. an unresolvable trunk is reported, not silently skipped ----------
    const r7 = subject.inspect(work, { trunk: 'origin/does-not-exist' });
    ok('an unresolvable trunk is TRUNK UNREADABLE, never a pass',
        r7.rows.every((r) => r.findings.some((f) => f.kind === 'TRUNK UNREADABLE')));

    // ---- 7. the CLI exits the way its header documents ------------------------
    // A clean checkout for the exit-0 case: ONE clone of the bare origin we
    // already have, rather than a second origin plus clone plus commit plus push.
    const cleanRepo = path.join(TMP, 'clean');
    execFileSync('git', ['clone', '-q', path.join(TMP, 'alpha.git'), cleanRepo],
        { stdio: 'ignore', windowsHide: true });

    const run = (args) => {
        try {
            const out = execFileSync(process.execPath, [SUBJECT, ...args],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            return { code: 0, out };
        } catch (e) { return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
    };
    // Three subprocess runs, not five: each one re-does a full inspect, so the
    // CLI layer is exercised for its EXIT CODES and its printed population, and
    // every finding is asserted against inspect() above where it costs nothing.
    const cli = run([work, '--trunk', 'origin/deploy']);
    ok('CLI exits 1 when a worktree is not ready', cli.code === 1, 'code=' + cli.code);
    ok('  and prints the population on a FAILING run', /population: \d+ worktree/.test(cli.out));
    const cliNone = run([notRepo]);
    ok('CLI exits 2 on no population', cliNone.code === 2, 'code=' + cliNone.code);
    // Clean exit and the no-trunk notice come from the SAME run: the bare
    // fixture has no unpushed commit at this point only because this block
    // runs before the INHABITED mutation would have been asserted against it,
    // so the ordering is load-bearing rather than incidental.
    const cliClean = run([cleanRepo]);
    ok('CLI exits 0 on a clean repo', cliClean.code === 0, 'code=' + cliClean.code + ' ' + cliClean.out.slice(0, 120));
    ok('  and prints the population on a CLEAN run too', /population: \d+ worktree/.test(cliClean.out));
    ok('  and says so when no trunk was given', /NO TRUNK GIVEN/.test(cliClean.out));
    ok('  and says so when no origin expectation was given',
        /NO ORIGIN EXPECTATION GIVEN/.test(cliClean.out));

    // ---- 8. the CLI contract an adversarial review found broken --------------
    // Every assertion here corresponds to a finding: each of these invocations
    // previously returned a confident wrong answer rather than an error, which
    // is the failure mode that gets a gate trusted and then ignored.

    // A serialisation flag must never change a verdict. `--json` exited 0
    // unconditionally, so the machine-readable mode — the one a script branches
    // on — reported success for a repo that was NOT ready, and for a directory
    // that was not a repository at all.
    const cliJson = run([work, '--trunk', 'origin/deploy', '--json']);
    ok('--json carries the SAME exit code as the human form',
        cliJson.code === cli.code, 'json=' + cliJson.code + ' human=' + cli.code);
    ok('  and its body is parseable JSON', (() => {
        try { return typeof JSON.parse(cliJson.out) === 'object'; } catch { return false; }
    })());
    const jsonNoRepo = run([notRepo, '--json']);
    ok('--json on a non-repository still exits 2, never 0',
        jsonNoRepo.code === 2, 'code=' + jsonNoRepo.code);

    // `--trunk=ref` is how half of everyone spells it, and it used to fall
    // through to null: the base check silently did not run and the population
    // line said NO TRUNK GIVEN while the caller believed they had given one.
    const cliEq = run([work, '--trunk=origin/deploy']);
    ok('--trunk=ref is honoured, not silently read as absent',
        /trunk origin\/deploy/.test(cliEq.out) && !/NO TRUNK GIVEN/.test(cliEq.out));

    // A flag's VALUE is not a positional. `--expect-origin <url> <repo>` used to
    // select the URL as the repo and then fail as "not a git repository".
    const cliFlagFirst = run(['--expect-origin', 'https://example.invalid/x', work,
        '--trunk', 'origin/deploy']);
    ok('a flag value before the repo does not become the repo',
        cliFlagFirst.code !== 2, 'code=' + cliFlagFirst.code);
    ok('  and WRONG REPO can actually FIRE from the CLI with an expectation',
        /WRONG REPO/.test(cliFlagFirst.out));

    // Two positionals is a typo. Ignoring the second means checking a directory
    // the caller never named and reporting on that instead.
    const cliTwo = run([work, notRepo]);
    ok('two positionals are refused rather than one being picked',
        cliTwo.code === 2 && /exactly one/.test(cliTwo.out), 'code=' + cliTwo.code);
} catch (err) {
    fail++;
    console.log('FAIL  suite threw: ' + (err && err.message));
} finally {
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows file locks */ }
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
