#!/usr/bin/env node
'use strict';
/**
 * Is this assignment already done, or is its premise stale?
 *
 * WHY. `[measured 2026-08-28]` a coordinating session audited `origin/main`,
 * found that a price was rendered from a field named `priceUsd` while the live
 * charge was in EUR, and assigned the fix to a session. That session had already
 * fixed it — renamed the field, added a currency formatter, and additionally
 * caught a JSON-LD mismatch the audit missed. It correctly refused the work.
 *
 * The audit was not wrong. It was stale RELATIVE TO THE TARGET: true of the base
 * it was taken from, false on the branch that would have done the work. That is
 * a different failure from a collision between two sessions, and the decision
 * log does not catch it — the target had never recorded anything.
 *
 * The cheap mechanical question nobody asked: **does the brief's premise still
 * hold on the branch being assigned?**
 *
 *   node check-assignment.js --repo ~/Code/qr \
 *     --branch claude/some-branch \
 *     --files src/lib/plans.ts,src/components/plan-card.tsx \
 *     --expect priceUsd
 *
 * Exit 0 = the assignment looks clear. Exit 3 = likely redundant or stale, with
 * the reason. Exit 2 = could not check, which is NEVER reported as "clear".
 *
 * A FAILED GIT CALL IS NOT AN ANSWER. `git grep` exits 1 for "no match" and 128
 * for an error, and only the first means absent, and only when stderr is empty:
 * it also exits 1 when it could not read an object. A premise or a file list
 * git did not answer for is UNCHECKED, named with git's own error, and counts
 * toward exit 2. It is never STALE, never "untouched", never CLEAR.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const val = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const repo = val('repo', null);
const branch = val('branch', null);
const files = (val('files', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const expects = (val('expect', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const base = val('base', null);

/**
 * Run git and keep everything it reported: status, signal, spawn error, stderr.
 *
 * This was `catch { return null; }` until 2026-09-27, and the premise check read
 * null as "git printed nothing": a `git grep` that died printed
 * `STALE "<sym>" is NOT on that branch` and exited 3, "likely redundant or
 * stale". A `git diff` that died read as "no file changed", so every named
 * file was "untouched" and the run exited 0, CLEAR. Same wrapper, and the
 * shape check-queue-freshness.js had until #328.
 *
 * Only the caller knows which status means "no", so this returns the facts and
 * never a verdict.
 */
function git(args) {
    const r = spawnSync('git', ['-C', repo].concat(args),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    return {
        command: 'git ' + args[0],
        status: r.status,
        signal: r.signal,
        error: r.error ? (r.error.code || r.error.message) : null,
        stdout: r.stdout || '',
        stderr: (r.stderr || '').trim(),
    };
}

/**
 * Did git run to the end, exit with one of `statuses`, and report no error?
 *
 * STDERR COUNTS. `[measured 2026-09-26, git 2.54]` `git grep` over a tree with
 * an unreadable object prints "unable to read <sha>" and still exits 1 when
 * nothing it DID read matched, and 0 when something did.
 */
function answered(r, statuses) {
    return !r.error && !r.signal && statuses.includes(r.status) && r.stderr === '';
}

/** One line naming the failure: `git grep exited 128: fatal: ...`. */
function describeFailure(r) {
    const how = r.error ? `failed (${r.error})`
        : r.signal ? `was killed by ${r.signal}`
            : `exited ${r.status}`;
    return r.command + ' ' + how + (r.stderr ? ': ' + r.stderr.split('\n')[0] : '');
}

if (!repo || !branch) {
    console.error('REFUSING: --repo and --branch are required.');
    console.error('  usage: check-assignment.js --repo <path> --branch <name>');
    console.error('         [--files a,b] [--expect symbol1,symbol2] [--base ref]');
    console.error('');
    console.error('  --expect is the load-bearing one: it is the PREMISE of your brief.');
    console.error('  A brief that names a symbol the target branch no longer has is');
    console.error('  describing a state that branch has already moved past.');
    process.exit(2);
}
if (!fs.existsSync(path.join(repo, '.git'))) {
    console.error(`COULD NOT CHECK: no git repository at ${repo} — this is NOT "clear to assign".`);
    process.exit(2);
}
// Local branch first, then the remote-tracking copy: a session's branch is
// frequently unpushed, and refusing to look at it locally is how this check
// would have missed the very case it was built for.
//
// `rev-parse --verify --quiet` exits 1 and prints nothing for a ref that does
// not exist. Anything else is git failing, and saying "not found" about it
// would send the reader to fetch a branch that is already there.
let ref = null;
for (const r of ['refs/heads/' + branch, 'refs/remotes/origin/' + branch]) {
    const found = git(['rev-parse', '--verify', '--quiet', r]);
    if (answered(found, [0])) { ref = r; break; }
    if (!answered(found, [1])) {
        console.error(`COULD NOT CHECK: ${describeFailure(found)} — NOT "clear to assign".`);
        console.error(`  That is git failing to look up ${r}, not the branch being absent.`);
        process.exit(2);
    }
}
if (!ref) {
    console.error(`COULD NOT CHECK: branch ${branch} not found locally or on origin — NOT "clear to assign".`);
    console.error('  Looked for refs/heads/ and refs/remotes/origin/. Fetch, or check the name.');
    process.exit(2);
}

// origin/HEAD is unset on many clones, and the 128 it exits with there is
// expected, so a failure here falls back rather than stopping. A bad fallback
// surfaces at merge-base, which names it.
const head = base ? null : git(['rev-parse', '--abbrev-ref', 'origin/HEAD']);
const trunk = base || (head && answered(head, [0]) && head.stdout.trim()) || 'origin/main';
// merge-base exits 1 with nothing on stderr when the histories share no commit.
// Any other failure (a trunk that does not resolve, an unreadable commit) means
// no comparison can be made, and the file check below says so per file.
const mb = git(['merge-base', trunk, ref]);
const mergeBase = answered(mb, [0]) ? mb.stdout.trim() : '';
const mergeBaseFailure = answered(mb, [0, 1]) ? null : describeFailure(mb);

console.log(`ASSIGNMENT CHECK  ${path.basename(repo)}  ${branch}`);
console.log(`  ref        : ${ref}`);
console.log(`  compared to: ${trunk}${mergeBase ? ' (merge-base ' + mergeBase.slice(0, 8) + ')'
    : mergeBaseFailure ? ' — ' + mergeBaseFailure : ' — NO MERGE BASE'}`);

let stale = 0, touched = 0, checked = 0, unchecked = 0;

// ---- 1. Has the branch already modified the files the brief names? ----
if (files.length) {
    // A diff that did not run is not a diff with nothing in it. Read as empty,
    // it made every named file "untouched" and the verdict CLEAR.
    const diff = mergeBaseFailure ? null
        : git(['diff', '--name-only', mergeBase || trunk, ref]);
    const failure = mergeBaseFailure || (answered(diff, [0]) ? null : describeFailure(diff));
    if (failure) {
        console.log(`\n  FILES (${files.length} named) — COULD NOT CHECK: ${failure}`);
        for (const f of files) {
            checked++;
            unchecked++;
            console.log(`    UNCHECKED        ${f}`);
        }
    } else {
        const changed = new Set(diff.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
        console.log(`\n  FILES (${files.length} named, ${changed.size} changed on the branch)`);
        for (const f of files) {
            checked++;
            if (changed.has(f)) {
                touched++;
                // Decoration only: without it the line still says ALREADY TOUCHED.
                const numstat = git(['diff', '--numstat', mergeBase || trunk, ref, '--', f]);
                const stat = answered(numstat, [0]) ? numstat.stdout.trim() : '';
                console.log(`    ALREADY TOUCHED  ${f}${stat ? '   (+' + stat.split(/\s+/)[0] + ' -' + stat.split(/\s+/)[1] + ')' : ''}`);
            } else {
                console.log(`    untouched        ${f}`);
            }
        }
    }
}

// ---- 2. THE PREMISE. Does the symbol your brief asserts still exist there? ----
if (expects.length) {
    console.log(`\n  PREMISE (${expects.length} symbol(s) your brief asserts)`);
    for (const sym of expects) {
        checked++;
        // Searched in the branch's TREE, not the working copy: the working copy
        // may be another session's in-flight state, and the question is about the
        // committed branch.
        //
        // git grep exits 0 on a match and 1 on none. Any other outcome, or any
        // stderr, is a search that did not happen, and reading it as "no match"
        // is how a crashed grep reported a live premise as stale.
        const found = git(['grep', '-l', '--fixed-strings', '-e', sym, ref]);
        const hit = found.stdout;
        if (!answered(found, [0, 1])) {
            unchecked++;
            console.log(`    UNCHECKED "${sym}": ${describeFailure(found)}`);
            console.log('              That is git failing to search, NOT the symbol being absent.');
        } else if (!hit.trim()) {
            stale++;
            console.log(`    STALE   "${sym}" is NOT on that branch`);
        } else {
            // WHERE it matched, not just that it did. [measured 2026-08-28] the
            // first version reported "holds" for a symbol whose only occurrence
            // was a doc comment explaining that the field had been RENAMED away
            // from it. A grep cannot tell code from a note about the code, so it
            // prints the files and lets a reader see that for themselves rather
            // than turning a weak signal into a verdict.
            const hits = hit.trim().split('\n').map((l) => l.replace(ref + ':', ''));
            console.log(`    present "${sym}" appears in ${hits.length} file(s):`);
            for (const h of hits.slice(0, 6)) console.log(`              ${h}`);
            if (hits.length > 6) console.log(`              ...and ${hits.length - 6} more`);
            console.log('              (a match inside a comment describing its REMOVAL still');
            console.log('               counts here — read the hits before trusting the premise)');
        }
    }
}

if (!checked) {
    console.log('\n  Nothing to check — pass --files and/or --expect.');
    console.log('  An assignment check with no premise checks nothing, and reporting');
    console.log('  that as "clear" is how this failure happened in the first place.');
    process.exit(2);
}

console.log('');
// Said beside every verdict, so a stale or redundant finding is never read as
// covering what git could not look at.
const alsoUnchecked = unchecked
    ? `  And ${unchecked} of the ${checked} could NOT be checked: git failed on them, named above.` : null;
if (stale) {
    console.log(`LIKELY STALE: ${stale} of your brief's premises no longer hold on that branch.`);
    console.log('  The audit was probably right about the base you took it from and wrong');
    console.log('  about the target. Re-read the branch before assigning.');
    if (alsoUnchecked) console.log(alsoUnchecked);
    process.exit(3);
}
if (files.length && touched === files.length) {
    console.log('LIKELY REDUNDANT: the branch has already modified every file you named.');
    console.log('  That is not proof the work is done, but it is a reason to read the diff');
    console.log('  before spending a session\'s turn on it.');
    if (alsoUnchecked) console.log(alsoUnchecked);
    process.exit(3);
}
if (unchecked) {
    console.log(`COULD NOT CHECK: git failed on ${unchecked} of the ${checked} thing(s) you asked about.`);
    console.log('  Nothing that was checked is falsified, but that is NOT "clear to assign":');
    console.log('  fix git (the errors are named above) and run this again.');
    process.exit(2);
}
console.log('CLEAR: no premise falsified' + (files.length ? `, ${files.length - touched} of ${files.length} named file(s) untouched` : '') + '.');
console.log('  Scoped to what you asked about. A clear result here is not a claim that');
console.log('  nobody is working on it — for that, ask the session.');
process.exit(0);
