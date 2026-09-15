#!/usr/bin/env node
'use strict';

// check-dispatch-readiness.js — three ways a dispatched worker starts in the
// wrong place, all of them silent, all of them catchable before its first commit.
//
// THE WINDOW THIS EXISTS FOR. A coordinator spawns a task chip. The harness
// creates the worktree, from its own defaults rather than from the brief. The
// session then reads a repo it was not sent to, or forks from a branch the brief
// warned it about, or commits on top of somebody else's unpushed work. Every one
// of those is obvious from git and invisible from the chip's own output, and the
// cost is paid later — at merge, when the pull request is a revert, or carries a
// stranger's commits, or was never in the right repo at all.
//
// `[measured 2026-09-03]` across four chips dispatched in one afternoon:
//   WRONG REPO      2 of 3   the cwd argument was dropped and fell back to the
//                            coordinator's own project; the spawn reported success
//   WRONG BASE      3 of 3   worktrees cut from the repo's DEFAULT branch while
//                            the trunk was a different ref, 11 commits ahead
//   INHABITED       1 of 1   a reused worktree carrying 8 unpushed commits from a
//                            previous session, none of them on any origin ref
// All three were found by reading worktrees by hand. Nothing reported them.
//
// WHY THE BASE CHECK IS NOT "IS IT MAIN". A repo's default branch and its trunk
// are different questions and this fleet has a repo where they disagree by design:
// `origin/HEAD` resolves to one ref while development lands on another. So the
// intended trunk is an ARGUMENT, not an inference. Guessing it is how a checker
// starts reporting correct worktrees as wrong, which is worse than silence.
//
// WHY "INHABITED" IS NOT "DIRTY". Uncommitted files are the session's own work in
// progress and are none of this script's business. What matters is COMMITS that no
// origin ref holds, because those predate the session and will ride into its pull
// request. Ancestry is the test; a squash-merged commit is content-identical
// upstream under a different sha, so this reports a count and says so rather than
// calling it lost work.
//
// Usage:
//   check-dispatch-readiness.js <repo> [--trunk <ref>] [--expect-origin <url>] [--json]
//
// WHY A FINDING CARRIES A CLASS. Two different things end up in `findings` and
// they must never share a count: a VERDICT about the worktree, which the reader
// fixes by fixing the worktree, and an UNMEASURED axis, where this script could
// not look at all. `TRUNK UNREADABLE` used to be counted among the verdicts and
// reported as `N of M worktree(s) NOT READY`, so a mistyped or unfetched
// `--trunk` made EVERY worktree read as defective — the cause was the
// invocation, and the headline blamed the worktrees. That is the same failure
// tooling/suite-verdict-summary.js was written for, one directory over: a
// condition external to the subject presented as a static property of it, which
// does not merely fail to inform, it directs work.
//
// The other three unmeasured axes used to VANISH, which is worse. An
// unresolvable origin, an unreadable HEAD and an unavailable unpushed-commit
// count each skipped their check and left no row, so the worktree read clean on
// an axis nobody had examined — absent coverage reported as coverage. They are
// findings now, classed UNMEASURED, and they are the reason the exit contract
// below has a third outcome.
//
// Exit: 0 nothing to report · 1 at least one worktree NOT READY (a verdict) ·
//       2 no population (not a git repo, or no worktrees), OR nothing but
//         unmeasured axes — this run reached no verdict, so it vouches for
//         nothing either way

const { execFileSync } = require('child_process');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
// Accepts BOTH `--flag value` and `--flag=value`. The second form used to fall
// through to null, so `--trunk=origin/main` silently skipped the base check and
// reported a clean bill. A flag spelled a normal way must not disable a check.
const valOf = (f) => {
    const eq = argv.find((a) => a.startsWith(f + '='));
    if (eq) return eq.slice(f.length + 1) || null;
    const i = argv.indexOf(f);
    if (i < 0) return null;
    const v = argv[i + 1];
    return v === undefined || v.startsWith('--') ? null : v;
};

function git(repo, args) {
    try {
        return execFileSync('git', ['-C', repo, ...args], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
        }).trim();
    } catch { return null; }
}

/** Every worktree of a repo, as absolute paths. The main checkout is included:
 *  it is where a session that ignored the worktree instruction ends up. */
function worktrees(repo) {
    const out = git(repo, ['worktree', 'list', '--porcelain']);
    if (out === null) return null;
    return out.split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length).trim())
        .filter(Boolean);
}

/** The remote this worktree actually points at, normalised so that a trailing
 *  `.git` and an scp-style host do not read as a different repo. */
/**
 * One normaliser, used on BOTH sides. An expectation normalised differently
 * from the observed value makes two spellings of one repository compare
 * unequal, which is the same defect class as comparing two spellings of one
 * directory: `git@github.com:o/r.git` and `https://github.com/o/r` are the
 * same repo and must not be a finding.
 */
function normaliseOrigin(url) {
    if (!url) return null;
    return String(url)
        .trim()
        .replace(/^git\+/, '')
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')   // any scheme: https, ssh, git
        .replace(/^[^@/]+@/, '')                     // user@, however it arrived
        .replace(/^([^/:]+):/, '$1/')                // scp colon -> path separator
        .replace(/\.git$/, '')
        .replace(/\/+$/, '')
        .toLowerCase();
}

function originUrl(wt) {
    const u = git(wt, ['remote', 'get-url', 'origin']);
    if (!u) return null;
    // Through the SAME normaliser as the expectation. This previously had its
    // own, which rewrote the scp form to `https://host/path` while the
    // expectation side rewrote it to `host/path`, so an operator passing the
    // exact URL git reports got WRONG REPO.
    return normaliseOrigin(u);
}

function isAncestor(wt, a, b) {
    try {
        execFileSync('git', ['-C', wt, 'merge-base', '--is-ancestor', a, b], {
            stdio: 'ignore', windowsHide: true,
        });
        return true;
    } catch { return false; }
}

// A finding is one of exactly two things, and the wording of every count below
// depends on which. VERDICT: a property of this worktree — fix the worktree.
// UNMEASURED: this script could not perform the check — fix the invocation, or
// fetch, or re-run. Nothing here infers the class from a kind name or a detail
// string; each producer states it, because a regex over prose is the same
// mistake with an extra failure mode.
const VERDICT = 'verdict';
const UNMEASURED = 'unmeasured';

const verdictsOf = (row) => row.findings.filter((f) => f.class === VERDICT);
const unmeasuredOf = (row) => row.findings.filter((f) => f.class !== VERDICT);

/**
 * @param {string} repo
 * @param {{trunk?:string, expectOrigin?:string}} opts
 */
function inspect(repo, opts = {}) {
    const list = worktrees(repo);
    if (list === null) return { ok: false, reason: 'not a git repository', rows: [] };
    if (!list.length) return { ok: false, reason: 'no worktrees', rows: [] };

    // NULL, not "the repo's own origin". Linked worktrees share one config, so
    // comparing each worktree's origin against the repo's compares a string with
    // itself and WRONG REPO could never fire — a check that runs, passes, and
    // examines nothing. With no expectation there is nothing to check, and the
    // population line says so rather than counting silence as a clean bill.
    const wantOrigin = opts.expectOrigin
        ? normaliseOrigin(opts.expectOrigin)
        : null;

    const rows = list.map((wt) => {
        const head = git(wt, ['rev-parse', '--short', 'HEAD']);
        const branch = git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const origin = originUrl(wt);
        const findings = [];

        if (wantOrigin && origin && origin !== wantOrigin) {
            findings.push({ kind: 'WRONG REPO', class: VERDICT, detail: `origin is ${origin}` });
        } else if (wantOrigin && !origin) {
            // An expectation WAS given and the comparison could not be made. This
            // branch did not exist: the check skipped and the row came back clean,
            // so silence on the axis read as a pass on it.
            findings.push({
                kind: 'ORIGIN UNREADABLE',
                class: UNMEASURED,
                detail: 'an origin expectation was given but `git remote get-url origin` '
                    + 'returned nothing here, so WRONG REPO could not be checked',
            });
        }

        // A worktree is on the right base when the trunk is REACHABLE FROM its
        // HEAD — that is, the trunk's commits are already in this history. A
        // worktree that merely shares an ancestor with the trunk has forked from
        // before it, which is the reported failure.
        if (opts.trunk) {
            const trunkSha = git(wt, ['rev-parse', opts.trunk]);
            if (!trunkSha) {
                // UNMEASURED, not a verdict. The commonest cause is the ref this
                // run was given — a typo, or a clone that has never fetched it —
                // and in that case every row carries this and not one of them is
                // defective.
                findings.push({
                    kind: 'TRUNK UNREADABLE',
                    class: UNMEASURED,
                    detail: `cannot resolve ${opts.trunk} here, so WRONG BASE could not be checked`
                        + ' — check the ref spelling and whether this clone has fetched it',
                });
            } else if (!head) {
                // The trunk resolved and HEAD did not, so ancestry is unanswerable.
                // Previously the `head &&` guard made this branch return silently.
                findings.push({
                    kind: 'HEAD UNREADABLE',
                    class: UNMEASURED,
                    detail: '`git rev-parse HEAD` returned nothing here, so WRONG BASE could not be checked',
                });
            } else if (!isAncestor(wt, opts.trunk, 'HEAD')) {
                const behind = git(wt, ['rev-list', '--count', `HEAD..${opts.trunk}`]);
                findings.push({
                    kind: 'WRONG BASE',
                    class: VERDICT,
                    detail: `${opts.trunk} is not in this history` + (behind ? ` (${behind} commit(s) missing)` : ''),
                });
            }
        }

        // ⚠️ THIS FINDING IS ONLY MEANINGFUL BEFORE THE SESSION STARTS WORKING.
        // At dispatch time an unpushed commit belongs to somebody else and will
        // ride into the new session's pull request, which is the incident. An hour
        // later the same count is that session's own work in progress and flagging
        // it is noise. The script cannot tell those apart from git, so it reports
        // the count and names the window rather than guessing — and running this
        // check late is what produces the false positive, not a defect in it.
        const unreachable = git(wt, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']);
        const n = unreachable === null ? null : Number(unreachable);
        if (!Number.isFinite(n)) {
            // `if (n)` swallowed BOTH null and NaN, so a failed or unparseable
            // rev-list left the worktree looking uninhabited rather than
            // unexamined. This is the axis where a silent skip costs most: it is
            // the one that catches a stranger's unpushed commits.
            findings.push({
                kind: 'UNPUSHED COUNT UNAVAILABLE',
                class: UNMEASURED,
                detail: '`git rev-list --count HEAD --not --remotes=origin` returned '
                    + (unreachable === null ? 'nothing' : JSON.stringify(String(unreachable)))
                    + ', so INHABITED could not be checked',
            });
        } else if (n) {
            findings.push({
                kind: 'INHABITED',
                class: VERDICT,
                detail: `${n} commit(s) on no LOCAL origin ref — a finding only if this is BEFORE the session started; `
                    + 'afterwards it is that session\'s own work. Ancestry, not content: a squash leaves the same diffs upstream under new shas. '
                    + 'Computed against remote-tracking refs, which this script never fetches: a branch deleted upstream whose local tracking ref survives still reads as pushed',
            });
        }

        return { worktree: wt, name: path.basename(wt), branch, head, origin, findings };
    });

    return { ok: true, rows };
}

/**
 * The single exit contract. `--json` used to exit 0 unconditionally, so the
 * machine-readable mode — the one a script would branch on — reported success
 * for a repo that was not ready, and for one that was not a repo at all.
 * A serialisation flag must never change a verdict.
 */
function exitCodeFor(res) {
    if (!res || !res.ok) return 2;
    if (res.rows.some((r) => verdictsOf(r).length)) return 1;
    // No verdict, but an axis this run could not examine. Exit 2 is this repo's
    // indeterminate convention and the only honest answer: 0 would claim the
    // worktrees were checked and found ready, and 1 would blame them for a
    // question nobody answered. Three of these four cases used to exit 0.
    if (res.rows.some((r) => unmeasuredOf(r).length)) return 2;
    return 0;
}

function report(repo, opts) {
    const res = inspect(repo, opts);
    if (!res.ok) {
        process.stderr.write(`dispatch-readiness: ${res.reason} at ${repo}\n`
            + 'This run vouches for nothing.\n');
        return 2;
    }
    // SPLIT BY CLASS. One filter over `findings.length` was one number with two
    // meanings, and it was printed under the word NOT READY.
    const notReady = res.rows.filter((r) => verdictsOf(r).length);
    const withUnmeasured = res.rows.filter((r) => unmeasuredOf(r).length);
    // AXES, not rows: a worktree can be NOT READY on one axis and unexamined on
    // another, and counting rows would let the verdict hide the gap. The headline
    // counts worktrees because that is what a reader acts on; this counts checks
    // that never ran, because that is what the reader cannot otherwise know.
    const unmeasuredAxes = res.rows.reduce((n, r) => n + unmeasuredOf(r).length, 0);
    const unexamined = res.rows.filter((r) => !verdictsOf(r).length && unmeasuredOf(r).length);
    const lines = [];
    for (const r of [...notReady, ...unexamined]) {
        lines.push(`  ${r.name}  [${r.branch} @ ${r.head}]`);
        // The class is on the line, not inferable from the kind: a reader
        // skimming for what to do next needs it beside what was found.
        for (const f of r.findings) {
            lines.push(`      ${f.class === VERDICT ? '[not ready]  ' : '[unmeasured] '}${f.kind}: ${f.detail}`);
        }
    }
    // The population is printed on every run, clean or not: a bare verdict is
    // indistinguishable from a checker that found nothing to look at.
    // Both disclosures, not one. WRONG REPO cannot fire without an expectation
    // (linked worktrees share a config, so the default comparison was a string
    // against itself), and a reader given only the trunk notice would take the
    // silence on origin for a pass.
    const pop = `population: ${res.rows.length} worktree(s) of ${repo}`
        + (opts.trunk ? `, trunk ${opts.trunk}` : ', NO TRUNK GIVEN so no base check ran')
        + (opts.expectOrigin ? `, expecting origin ${opts.expectOrigin}`
            : ', NO ORIGIN EXPECTATION GIVEN so no repo check ran');
    // Each clause carries its own count and its own noun. An unmeasured row is
    // never described as not ready, and never folded into that number.
    const unexaminedClause = unmeasuredAxes
        ? ` · ${unmeasuredAxes} check(s) on ${withUnmeasured.length} worktree(s) could not be run`
          + ' — indeterminate and re-runnable, NOT a finding about the worktree(s)'
        : '';
    if (!notReady.length && !unmeasuredAxes) {
        process.stdout.write(`dispatch-readiness: 0 of ${res.rows.length} worktree(s) need attention\n${pop}\n`);
        return 0;
    }
    process.stdout.write(`dispatch-readiness: ${notReady.length} of ${res.rows.length} worktree(s) NOT READY`
        + `${unexaminedClause}\n`
        + lines.join('\n') + `\n${pop}\n`);
    return exitCodeFor(res);
}

module.exports = {
    inspect, worktrees, originUrl, normaliseOrigin, exitCodeFor,
    VERDICT, UNMEASURED, verdictsOf, unmeasuredOf,
};

const USAGE = 'usage: check-dispatch-readiness.js <repo> '
    + '[--trunk <ref>] [--expect-origin <url>] [--json]\n'
    + '  --trunk          the ref work should be based on. Without it, no base check runs.\n'
    + '  --expect-origin  the repository these worktrees should belong to. Without it, no\n'
    + '                   repo check runs: linked worktrees share one config, so there is\n'
    + '                   nothing to compare a worktree origin against.\n'
    + 'exit: 0 nothing to report - 1 at least one worktree NOT READY - 2 no population,\n'
    + '      or nothing but axes this run could not measure, which is no verdict either way\n';

/**
 * Positionals, skipping the VALUE of every value-taking flag rather than of
 * `--trunk` alone. `--expect-origin <url> <repo>` used to select the URL as the
 * repo, which then failed as "not a git repository" - a wrong answer produced
 * by a correct-looking invocation.
 */
function positionalsOf(args) {
    const VALUE_FLAGS = new Set(['--trunk', '--expect-origin']);
    const out = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (VALUE_FLAGS.has(a)) { i++; continue; }       // consume its value
        if (a.startsWith('--')) continue;
        out.push(a);
    }
    return out;
}

function main() {
    if (has('--help') || !argv.length) {
        process.stdout.write(USAGE);
        return argv.length ? 0 : 2;
    }
    const positionals = positionalsOf(argv);
    // A second positional is a typo, not a repo. Silently ignoring it means
    // checking a directory the caller did not name and reporting on that.
    if (positionals.length !== 1) {
        process.stderr.write('dispatch-readiness: expected exactly one <repo>, got '
            + positionals.length + (positionals.length ? ' (' + positionals.join(', ') + ')' : '')
            + '\n' + USAGE + 'This run vouches for nothing.\n');
        return 2;
    }
    const opts = { trunk: valOf('--trunk'), expectOrigin: valOf('--expect-origin') };
    if (has('--json')) {
        const res = inspect(positionals[0], opts);
        process.stdout.write(JSON.stringify(res, null, 2) + '\n');
        return exitCodeFor(res);                         // the SAME verdict as the human form
    }
    return report(positionals[0], opts);
}

// process.exit() TRUNCATES output, and only on some platforms.
//
// node's process.stdout is ASYNCHRONOUS when it is a PIPE on darwin, and
// synchronous when it is a pipe on linux and win32; it is synchronous for a
// FILE and a TTY everywhere. process.exit() terminates without draining a
// pending async write, so a run that prints more than the 64KiB OS pipe buffer
// and then exits delivers exactly 65536 bytes — under exit status 0, because
// the write never failed. A silent wrong answer, not a visible failure. The
// three things that hide it: a file redirect is synchronous so the output looks
// whole, Linux CI is synchronous so CI is green, and the status is 0.
//
// Setting process.exitCode instead lets the event loop drain the stream and
// exit on its own with the same status. Nothing here holds the loop open.
// See rendered-layout-gate.js for the case that cost this, and CLAUDE.md under
// conventions that have actually cost something.
if (require.main === module) process.exitCode = main();
