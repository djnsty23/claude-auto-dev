'use strict';
/**
 * Will git actually keep this archive? Ask git, before writing it.
 *
 * `[measured 2026-08-29]` a project archived 159 completed stories out of a
 * tracked prd.json and into `.claude/archives/prd-archive-2026-08.json`. That
 * path is gitignored, so `git add -A` skipped it in silence; the commit carried
 * only the DELETION. The archive and the backup taken beside it existed on one
 * machine's disk and nowhere else. No Time Machine, empty Trash. Both gone.
 *
 * THE PART THAT MATTERS IS WHY NOTHING CAUGHT IT. archive-prd's one integrity
 * check is `archived + remaining === before`, counted across the two files ON
 * DISK, and it PASSED — correctly. Both files existed at that moment. It
 * measures COMPLETENESS; the failure mode is DURABILITY. A check that reports
 * green about a property it never examines is this project's signature failure
 * (see skills/rule-gate-integrity), and it repeated inside the skill whose whole
 * job is not losing data. The skill's recovery line pointed at
 * `.claude/archives/` too — the file that cannot exist under the conditions that
 * lose it.
 *
 * So this module examines the property that actually fails. It does not parse
 * .gitignore: pattern semantics (negations, `**` crossings, precedence, nested
 * ignore files, core.excludesFile) are exactly what humans get wrong, and the
 * project that lost the archive HAD negations — `!.claude/skills/` twice, plus a
 * comment about `git add -f`-ing launch.json, and twelve tracked files under
 * `.claude/`. The exception list existed and had a hole in it. Reimplementing
 * that matcher would be a second place to put the same hole, so we shell out to
 * `git check-ignore` and let git answer for itself.
 *
 * NOT-A-REPO IS NOT THE SAME AS NOT-DURABLE-BUT-ALLOWED. The three outcomes are
 * kept distinct on purpose; folding them is how a warning becomes a pass.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const OK = 'ok';                 // inside a repo, not ignored — git will keep it
const IGNORED = 'ignored';       // inside a repo, gitignored — REFUSE
const NO_REPO = 'no-repo';       // no git repo — allowed, but say it is unbacked
const UNKNOWN = 'unknown';       // git could not answer — never treat as ok

/** Suggested destination: repo-root-relative, needing no ignore negation. */
const RECOMMENDED_DIR = 'prd-archives';

function git(args, cwd) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/** Is `cwd` inside a git work tree? */
function insideRepo(cwd) {
    try {
        return git(['rev-parse', '--is-inside-work-tree'], cwd).trim() === 'true';
    } catch {
        return false;
    }
}

/**
 * Does git ignore `target`?
 *
 * `git check-ignore -q` exits 0 when the path IS ignored, 1 when it is not, and
 * 128 on error. The path need not exist — matching is by pattern, which is what
 * lets this run BEFORE the write instead of after.
 *
 * It also reports an INDEXED path as not-ignored, which is the answer we want:
 * a tracked file is durable no matter what patterns match it. That is the real
 * exception mechanism inside an ignored tree — `git add -f`, not a `!` negation,
 * because git cannot re-include a file whose parent DIRECTORY is excluded. The
 * .gitignore that lost the archive carried `!.claude/skills/` twice and it was
 * inert; the twelve files that survived under `.claude/` did so by being in the
 * index. Suggesting a negation as the remedy would therefore be advice that
 * silently does nothing, which is why the remedy below is a different directory.
 *
 * An error is reported as UNKNOWN, never as "not ignored". Mapping a failure to
 * the permissive answer is how a gate passes on emptiness.
 */
function ignoreStatus(target, cwd) {
    try {
        git(['check-ignore', '-q', '--', target], cwd);
        return IGNORED;                       // exit 0
    } catch (e) {
        if (e.status === 1) return OK;        // definitively not ignored
        return UNKNOWN;                       // 128, git missing, anything else
    }
}

/**
 * Decide whether an archive written to `target` would survive a commit.
 *
 * Returns { status, durable, target, reason, remedy }. `durable` is true ONLY
 * for OK — the caller should never have to interpret the status string to get
 * the safety answer right.
 */
function checkArchivePath(target, cwd = process.cwd()) {
    const abs = path.isAbsolute(target) ? target : path.resolve(cwd, target);
    const rel = path.relative(cwd, abs) || path.basename(abs);

    if (!insideRepo(cwd)) {
        return {
            status: NO_REPO, durable: false, target: rel,
            reason: 'not inside a git work tree, so nothing written here is backed by version control',
            remedy: 'Allowed, but say plainly in the run report that the archive is machine-local and unbacked.',
        };
    }

    const status = ignoreStatus(abs, cwd);

    if (status === IGNORED) {
        return {
            status, durable: false, target: rel,
            reason: `git ignores ${rel}, so \`git add\` will skip the archive in silence and the commit will carry only the deletion`,
            remedy: `Write the archive to ${RECOMMENDED_DIR}/ at the repo root instead. `
                + 'A directory outside any ignore rule cannot be re-broken by a later .gitignore edit, '
                + 'which a negation inside an ignored tree can.',
        };
    }

    if (status === UNKNOWN) {
        return {
            status, durable: false, target: rel,
            reason: 'git could not answer whether this path is ignored',
            remedy: 'Do not write yet. Resolve the git error and re-run — an unanswerable check is not a passing one.',
        };
    }

    return {
        status: OK, durable: true, target: rel,
        reason: `git tracks ${rel}; the archive will be committed alongside the prd.json it was taken from`,
        remedy: null,
    };
}

/**
 * The recovery instruction that actually works.
 *
 * Told to restore from the archive file, an operator hitting this failure finds
 * nothing: the file that would have saved them is the file the bug deleted. But
 * archiving REMOVES stories from a tracked prd.json, so the commit before the
 * archive commit holds the complete pre-archive state — every story, with its
 * full `verified` record. That is the real backup, and it is one command.
 */
function recoveryHint(archiveCommit = '<archive-commit>') {
    return `git show ${archiveCommit}^:prd.json`;
}

module.exports = {
    OK, IGNORED, NO_REPO, UNKNOWN, RECOMMENDED_DIR,
    checkArchivePath, ignoreStatus, insideRepo, recoveryHint,
};

if (require.main === module) {
    const target = process.argv[2] || `${RECOMMENDED_DIR}/prd-archive.json`;
    const r = checkArchivePath(target);
    if (r.durable) {
        console.log(`[archive-path] ok — ${r.reason}`);
        process.exit(0);
    }
    console.error(`[archive-path] ${r.status.toUpperCase()} — ${r.reason}`);
    console.error(`[archive-path] ${r.remedy}`);
    if (r.status === NO_REPO) process.exit(0);   // warn, do not block
    console.error(`[archive-path] if an archive was already lost this way: ${recoveryHint()}`);
    process.exit(1);
}
