#!/usr/bin/env node
'use strict';

// check-path-filter-deadlock.js — a path-filtered PR check never reports, and a
// required one that never reports blocks the merge forever.
//
// THE DEFECT. GitHub does not run a workflow whose `paths:` or `paths-ignore:`
// filter excludes every file a pull request touched. It does not mark that
// workflow's checks SKIPPED either. They stay PENDING, indefinitely, because
// there is no run to report a conclusion. A pull request that REQUIRES one of
// those checks can then never merge, and nothing in the interface says why: the
// check sits there looking like CI that has not finished.
//
// This is a different severity class from everything in check-draft-skip-guard.
// That file is about a control that costs more than a reader thinks. This is
// about a repository that can reach a state where a correct pull request cannot
// land at all, and the two should not share an exit code or a report.
//
// WHY IT IS ADVISORY BY DEFAULT, and this is the honest limit. Whether a check
// is REQUIRED lives in branch-protection settings, not in the workflow file. So
// this can prove the first half — these checks will not report on some pull
// requests — and cannot prove the second. Exiting 1 on that would fail every
// repository that path-filters deliberately and requires none of the results,
// which is most of them, and a check that cries wolf gets muted and then missed
// when it is finally right. `--strict` is there for a repository that has done
// the branch-protection lookup and wants the pairing gated from then on.
//
// The one lookup that settles it is named in the output rather than guessed at,
// the same way the sibling check names visibility instead of calling `gh`.
//
// THE OTHER PATH-FILTER TRAP, WHICH THIS DOES NOT CATCH. A path filter has two
// distinct failure surfaces and they are opposites, so a check covering one has
// to say it is not covering the other, or a reader takes the exit code for more
// than it is.
//
//   MERGING, this file: a skipped workflow reports no conclusion, a required
//   check sits PENDING, and the pull request cannot land. Loud, and terminal.
//
//   COVERAGE, not this file: `paths-ignore` skips only when EVERY changed path
//   matches, so a commit touching ignored files AND code still runs. That reads
//   as safe, and it is what makes the inverse dangerous: put a directory in the
//   list that also holds shipped code, and every commit touching ONLY that
//   directory is never gated. Silent, and it produces no signal at all.
//
// `[measured 2026-09-03, reported by a peer from two different repositories]`
// both are real. One repo's gate forbids `paths-ignore` outright and gives the
// PENDING reason. Another USES it, and its own comment records the coverage
// failure: a docs directory was in the list and IS the shipped application, so
// 41 of 200 commits changed shipped code and received no verdict until somebody
// looked.
//
// Detecting the coverage trap needs to know which paths hold code, which is a
// fact about the repository rather than about the workflow, so it is not a
// widening of this check. Named here so the next reader knows the boundary
// rather than inferring coverage this does not have.
//
// `[measured 2026-09-03]` over one repository's 9 workflows: 2 carry a path
// filter on a `pull_request` trigger and are reported, 1 carries `paths:` on
// `push` only and is not, and 6 have no filter. So the discriminator is not
// "uses path filters", which would have flagged 3 of 9 including one that cannot
// affect a pull request at all.
//
// Usage:
//   check-path-filter-deadlock.js [root] [--json] [--strict] [--selftest] [--help]
//
// Exit: 0 clean, or reported-but-advisory. 1 only under --strict with a finding,
// or on a real error. 2 no population (no workflow directory, so this run
// vouches for nothing).

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

if (has('--help') || has('-h')) {
    console.log('usage: check-path-filter-deadlock.js [root] [--json] [--strict] [--selftest]\n'
        + 'Finds a `paths:` or `paths-ignore:` filter on a pull_request trigger. A pull\n'
        + 'request touching none of those paths does not run the workflow, and its checks\n'
        + 'stay PENDING rather than SKIPPED. If any is a REQUIRED status check, that pull\n'
        + 'request can never merge.\n'
        + 'Advisory by default, because whether a check is required lives in branch\n'
        + 'protection and not in the file. --strict exits 1 on a finding.\n'
        + 'Exit 0 clean or advisory, 1 under --strict with a finding, 2 no workflows.');
    process.exit(0);
}

/**
 * Strip YAML comments so a commented-out filter is not read as live.
 *
 * DUPLICATED from check-draft-skip-guard.js rather than imported, and the reason
 * is mechanical: that file performs its live run at module scope, so requiring
 * it would execute a scan and exit. Refactoring it to export would change a
 * file whose suite was just merged, for one function of eleven lines. The
 * duplication is deliberate and both copies are covered by their own selftest.
 */
function stripYamlComments(src) {
    return src.split('\n').map((line) => {
        let inSingle = false;
        let inDouble = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (c === "'" && !inDouble) inSingle = !inSingle;
            else if (c === '"' && !inSingle) inDouble = !inDouble;
            else if (c === '#' && !inSingle && !inDouble) return line.slice(0, i);
        }
        return line;
    }).join('\n');
}

/**
 * The path filters attached to each pull_request trigger, or an empty list.
 *
 * THE DISCRIMINATOR IS WHICH TRIGGER CARRIES THE FILTER, not whether the file
 * uses one. A `paths:` under `push:` cannot affect a pull request check at all,
 * so reporting it would be a false positive on a shape that has nothing to do
 * with merging. `[measured 2026-09-03]` one repository has exactly that: a cron
 * workflow with `push: paths:` and no pull_request trigger, which this must
 * stay silent about.
 *
 * A line scanner rather than multiline regexes, for the reason its sibling
 * documents: `\s` spans newlines, so an indent capture matches the wrong block.
 * Every branch below is checkable by eye.
 */
function pullRequestPathFilters(src) {
    const lines = stripYamlComments(src).split('\n');
    const indent = (l) => l.length - l.replace(/^[ \t]*/, '').length;
    const out = [];

    // The inline form `on: [push, pull_request]` cannot express a filter at all.
    if (/^on:[ \t]*\[/m.test(src)) return out;

    const start = lines.findIndex((l) => /^on:[ \t]*$/.test(l));
    if (start < 0) return out;

    let childIndent = -1;
    for (let j = start + 1; j < lines.length; j++) {
        const line = lines[j];
        if (!line.trim()) continue;
        if (indent(line) === 0) break;                    // next top-level key
        const key = /^[ \t]+(pull_request|pull_request_target):/.exec(line);
        if (childIndent < 0 && /^[ \t]+[A-Za-z_]+:/.test(line)) childIndent = indent(line);
        if (!key || indent(line) !== childIndent) continue;

        // Everything indented deeper than this event key belongs to it.
        for (let k = j + 1; k < lines.length; k++) {
            if (!lines[k].trim()) continue;
            if (indent(lines[k]) <= childIndent) break;
            const f = /^[ \t]+(paths|paths-ignore):/.exec(lines[k]);
            if (f) out.push({ event: key[1], filter: f[1] });
        }
    }
    return out;
}

function scan(root) {
    const dir = path.join(root, '.github', 'workflows');
    let names;
    try {
        names = fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f));
    } catch {
        return null;   // no population; the caller decides what that means
    }

    const rows = [];
    for (const name of names) {
        let raw;
        try { raw = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
        const filters = pullRequestPathFilters(raw);
        rows.push({
            file: path.join('.github', 'workflows', name),
            filters,
            atRisk: filters.length > 0,
        });
    }
    return rows;
}

// --- selftest -------------------------------------------------------------
if (has('--selftest')) {
    const os = require('os');
    let pass = 0;
    let fail = 0;
    const t = (label, ok) => { if (ok) pass++; else fail++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`); };

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pfd-'));
    const wf = path.join(root, '.github', 'workflows');
    fs.mkdirSync(wf, { recursive: true });

    fs.writeFileSync(path.join(wf, 'pr-paths.yml'),
        'name: A\non:\n  pull_request:\n    paths:\n      - src/**\njobs:\n  x:\n    runs-on: ubuntu-latest\n');
    fs.writeFileSync(path.join(wf, 'pr-paths-ignore.yml'),
        'name: B\non:\n  pull_request:\n    types: [opened]\n    paths-ignore:\n      - docs/**\njobs:\n  x:\n    runs-on: ubuntu-latest\n');
    // THE NEGATIVE THAT MATTERS MOST. A filter on push cannot affect a PR check,
    // so reporting it would flag a shape with nothing to do with merging.
    fs.writeFileSync(path.join(wf, 'push-paths-only.yml'),
        'name: C\non:\n  push:\n    paths:\n      - state/**\n  workflow_dispatch:\njobs:\n  x:\n    runs-on: ubuntu-latest\n');
    fs.writeFileSync(path.join(wf, 'no-filter.yml'),
        'name: D\non:\n  pull_request:\njobs:\n  x:\n    runs-on: ubuntu-latest\n');
    fs.writeFileSync(path.join(wf, 'inline.yml'),
        'name: E\non: [push, pull_request]\njobs:\n  x:\n    runs-on: ubuntu-latest\n');
    // A filter on push AND on pull_request. Only the pull_request one counts,
    // and it must not be double-reported because push also carries one.
    fs.writeFileSync(path.join(wf, 'both.yml'),
        'name: F\non:\n  push:\n    paths:\n      - src/**\n  pull_request:\n    paths:\n      - src/**\njobs:\n  x:\n    runs-on: ubuntu-latest\n');
    // A commented-out filter governs nothing.
    fs.writeFileSync(path.join(wf, 'commented.yml'),
        'name: G\non:\n  pull_request:\n    # paths:\n    #   - src/**\njobs:\n  x:\n    runs-on: ubuntu-latest\n');

    const rows = scan(root);
    const by = (n) => rows.find((r) => r.file.endsWith(n));

    t('`paths:` on a pull_request trigger is reported', by('pr-paths.yml').atRisk === true);
    t('`paths-ignore:` on a pull_request trigger is reported', by('pr-paths-ignore.yml').atRisk === true);
    t('  and the filter kind is named, not just the fact of one',
        by('pr-paths-ignore.yml').filters[0].filter === 'paths-ignore');
    t('a filter on PUSH only is NOT reported', by('push-paths-only.yml').atRisk === false);
    t('a pull_request trigger with no filter is NOT reported', by('no-filter.yml').atRisk === false);
    t('the inline `on: [..]` form cannot express a filter and is NOT reported',
        by('inline.yml').atRisk === false);
    t('a filter on both triggers is reported ONCE, for the pull_request one',
        by('both.yml').atRisk === true && by('both.yml').filters.length === 1
        && by('both.yml').filters[0].event === 'pull_request');
    t('a commented-out filter governs nothing and is NOT reported',
        by('commented.yml').atRisk === false);
    t('the population counts every workflow, not only the findings', rows.length === 7);

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pfd-empty-'));
    t('a root with no .github/workflows returns null, never an empty pass', scan(empty) === null);

    for (const d of [root, empty]) fs.rmSync(d, { recursive: true, force: true });

    console.log(`\n${pass} passed, ${fail} failed  (${pass + fail} cases: both filter kinds on a `
        + 'pull_request trigger, a push-only filter and three other negatives, and the '
        + 'no-population case)');
    process.exit(fail ? 1 : 0);
}

// --- live run -------------------------------------------------------------
const root = path.resolve(argv.find((a) => !a.startsWith('-')) || '.');
const rows = scan(root);

if (rows === null) {
    console.error(`no .github/workflows under ${root}.`);
    console.error('No population, so this run vouches for NOTHING, not even an all-clear.');
    process.exit(2);
}

const atRisk = rows.filter((r) => r.atRisk);

if (has('--json')) {
    console.log(JSON.stringify({ root, scanned: rows.length, atRisk: atRisk.length, strict: has('--strict'), rows }, null, 2));
    process.exit(has('--strict') && atRisk.length ? 1 : 0);
}

console.log(`${rows.length} workflow(s) in ${root}, `
    + `${atRisk.length} with a path filter on a pull_request trigger`);

if (!atRisk.length) {
    console.log('\nNo pull_request trigger here carries a path filter, so no check of this');
    console.log('kind can be withheld from a pull request.');
    process.exit(0);
}

for (const r of atRisk) {
    const kinds = [...new Set(r.filters.map((f) => f.filter))].join(' and ');
    console.log(`\n  AT RISK  ${r.file}`);
    console.log(`           ${kinds} on its ${[...new Set(r.filters.map((f) => f.event))].join('/')} trigger.`);
}

console.log('\nWhat this means, and the half it cannot answer:');
console.log('  A pull request touching none of those paths does not run the workflow.');
console.log('  Its checks are then not SKIPPED, they stay PENDING, because no run ever');
console.log('  reports a conclusion. If any of them is a REQUIRED status check, that');
console.log('  pull request can NEVER merge, and the interface shows CI still running');
console.log('  rather than anything explaining why.');
console.log('');
console.log('  Whether any IS required lives in branch protection, not in these files,');
console.log('  so this is a pairing to check rather than a defect to fix. One lookup');
console.log('  settles it, per branch:');
console.log('');
console.log('    gh api repos/{owner}/{repo}/branches/{branch}/protection \\');
console.log('      --jq .required_status_checks.contexts');
console.log('');
console.log('  If a required context belongs to a workflow above, GitHub\'s own remedy is');
console.log('  a second workflow of the SAME NAME with the inverse filter and a job that');
console.log('  does nothing, so the check always reports. Removing the filter also works');
console.log('  and costs the runs the filter was saving.');

if (has('--strict')) {
    console.log(`\n--strict: ${atRisk.length} of ${rows.length} workflow(s) can withhold a pull request check.`);
    process.exit(1);
}
console.log('\nAdvisory: exit 0. Re-run with --strict to gate on this once you have');
console.log('checked branch protection and want the pairing kept out from now on.');
process.exit(0);
