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
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const val = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const repo = val('repo', null);
const branch = val('branch', null);
const files = (val('files', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const expects = (val('expect', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const base = val('base', null);

function git(args, opts) {
    try {
        return execFileSync('git', ['-C', repo].concat(args),
            Object.assign({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }, opts || {}));
    } catch { return null; }
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
const ref = ['refs/heads/' + branch, 'refs/remotes/origin/' + branch]
    .find((r) => git(['rev-parse', '--verify', '--quiet', r]) !== null);
if (!ref) {
    console.error(`COULD NOT CHECK: branch ${branch} not found locally or on origin — NOT "clear to assign".`);
    console.error('  Looked for refs/heads/ and refs/remotes/origin/. Fetch, or check the name.');
    process.exit(2);
}

const trunk = base
    || (git(['rev-parse', '--abbrev-ref', 'origin/HEAD']) || '').trim()
    || 'origin/main';
const mergeBase = (git(['merge-base', trunk, ref]) || '').trim();

console.log(`ASSIGNMENT CHECK  ${path.basename(repo)}  ${branch}`);
console.log(`  ref        : ${ref}`);
console.log(`  compared to: ${trunk}${mergeBase ? ' (merge-base ' + mergeBase.slice(0, 8) + ')' : ' — NO MERGE BASE'}`);

let stale = 0, touched = 0, checked = 0;

// ---- 1. Has the branch already modified the files the brief names? ----
if (files.length) {
    const changed = new Set(
        ((mergeBase ? git(['diff', '--name-only', mergeBase, ref]) : git(['diff', '--name-only', trunk, ref])) || '')
            .split('\n').map((s) => s.trim()).filter(Boolean),
    );
    console.log(`\n  FILES (${files.length} named, ${changed.size} changed on the branch)`);
    for (const f of files) {
        checked++;
        if (changed.has(f)) {
            touched++;
            const stat = (git(['diff', '--numstat', mergeBase || trunk, ref, '--', f]) || '').trim();
            console.log(`    ALREADY TOUCHED  ${f}${stat ? '   (+' + stat.split(/\s+/)[0] + ' -' + stat.split(/\s+/)[1] + ')' : ''}`);
        } else {
            console.log(`    untouched        ${f}`);
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
        const hit = git(['grep', '-l', '--fixed-strings', '-e', sym, ref]);
        if (hit === null || !hit.trim()) {
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
if (stale) {
    console.log(`LIKELY STALE: ${stale} of your brief's premises no longer hold on that branch.`);
    console.log('  The audit was probably right about the base you took it from and wrong');
    console.log('  about the target. Re-read the branch before assigning.');
    process.exit(3);
}
if (files.length && touched === files.length) {
    console.log('LIKELY REDUNDANT: the branch has already modified every file you named.');
    console.log('  That is not proof the work is done, but it is a reason to read the diff');
    console.log('  before spending a session\'s turn on it.');
    process.exit(3);
}
console.log('CLEAR: no premise falsified' + (files.length ? `, ${files.length - touched} of ${files.length} named file(s) untouched` : '') + '.');
console.log('  Scoped to what you asked about. A clear result here is not a claim that');
console.log('  nobody is working on it — for that, ask the session.');
process.exit(0);
