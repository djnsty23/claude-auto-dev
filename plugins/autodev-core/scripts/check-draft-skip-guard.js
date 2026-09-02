#!/usr/bin/env node
'use strict';

// check-draft-skip-guard.js — a draft-skip guard that a `push:` trigger makes inert.
//
// THE DEFECT THIS EXISTS FOR. A workflow can carry
// `if: github.event.pull_request.draft == false` and still run on every push,
// because that expression reads a field which exists only on a `pull_request`
// event. On a `push` event it is null, the comparison is false against nothing,
// the job runs, and the draft bought exactly nothing.
//
// That is worse than having no guard. An absent guard prompts the question; an
// inert one reads as a control somebody already thought about, so nobody asks
// again. Same shape as the reassuring-skip entry in verification-traps: a
// mechanism that reports honestly and is read as an all-clear.
//
// `[measured 2026-09-02]` across six repos: one had the guard on a
// pull_request-only workflow and it worked, one had the guard beside a `push:`
// trigger and was inert, one added the guard and withdrew it after measuring,
// and three had no guard. So the failing shape is not hypothetical and it is not
// rare: it was half the repos that had tried the pattern at all.
//
// WHY IT SHIPS RATHER THAN LIVING IN tooling/. The advice that produces this
// defect ships too, in brain/SKILL.md, and gets applied to repos this checker
// will never see. A check that only ever runs here would guard the one repo that
// does not currently follow the advice. Point it at a root and it answers for
// that root.
//
// Usage:
//   check-draft-skip-guard.js [root] [--json] [--selftest] [--help]
//
// Exit: 0 no inert guard found, 1 at least one inert guard, 2 no population
// (no workflow directory, so this run vouches for nothing).

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

if (has('--help') || has('-h')) {
    console.log('usage: check-draft-skip-guard.js [root] [--json] [--selftest]\n'
        + 'Finds a draft-skip guard (github.event.pull_request.draft) in a workflow that\n'
        + 'ALSO triggers on push, which makes the guard inert: the field is null on a push\n'
        + 'event, so the job runs anyway and the draft saves nothing.\n'
        + 'Exit 0 clean, 1 inert guard found, 2 no workflows to scan.');
    process.exit(0);
}

/** The guard expression, in the spellings GitHub actually accepts. */
const GUARD = /github\.event\.pull_request\.draft/;

/**
 * Does a push to a DRAFT PR's branch fire this workflow?
 *
 * THE QUESTION THIS ASKS IS NOT "does it trigger on push", AND THE FIRST VERSION
 * OF THIS FILE ASKED THE NARROWER ONE. `[measured 2026-09-02]` on its first run
 * against a repo that was not this one, it reported a correct workflow as INERT
 * and I relayed that to a peer as an instruction. The workflow triggers on push
 * AND filters it:
 *
 *     on:
 *       push:
 *         branches: [main]
 *       pull_request:
 *
 * Every draft PR lives on a feature branch, so that push trigger never fires
 * where drafts are, and the guard governs the event that remains. The guard is
 * correct. The probe was answering a narrower question than the one asked, which
 * is the failure this repo's own rules name, arriving in a tool written to catch
 * a different instance of it.
 *
 * So a push trigger defeats a draft-skip only when it MATCHES THE BRANCHES
 * DRAFTS LIVE ON. Unfiltered, it matches everything and defeats the guard. With
 * `branches:` naming only trunk, it does not.
 *
 * `branches-ignore` INVERTS `branches` and is graded rather than deferred, which
 * is the whole reason it is worth handling. Both read as restrictive at a glance
 * and mean opposite things: `branches: [main]` keeps a push OFF feature branches,
 * `branches-ignore: [master]` keeps it ON all of them. That inversion is what
 * made a peer's fleet survey wrong about one repo, and deferring it would have
 * left the single repo shaped to need the answer without one.
 *
 * Conservative where it genuinely cannot tell. A glob in either list, an empty
 * list, or a non-trunk name in `branches-ignore` returns UNKNOWN rather than a
 * guess in either direction, because a wrong confident answer here sends
 * somebody to change working CI. Unknown is a result a reader can act on; a
 * guess is not.
 *
 * Deliberately NOT a YAML parse, so a shipped script gains no dependency. The
 * forms below are the whole surface the selftest plants. A third form belongs in
 * this comment, not in a silently widened regex.
 */
function pushReachesDraftBranches(src) {
    // Inline list form: `on: [push, pull_request]`. No filters are expressible
    // here at all, so a push in this form always matches every branch.
    const inline = /^on:\s*\[([^\]]*)\]/m.exec(src);
    if (inline) return /\bpush\b/.test(inline[1]) ? 'yes' : 'no';

    // Mapping form: `on:` then an indented `push:` before the next top-level key.
    // A LINE SCANNER, not multiline regexes. The regex version cost two defects
    // in one function: `\s` spans newlines, so an indent capture matched the
    // wrong block; and `\Z` is not a JavaScript anchor at all, so a lookahead
    // written to mean "or end of input" quietly required a literal Z and failed
    // on the last block in a file. Indentation-scoped YAML reads more honestly
    // as lines, and every branch below is checkable by eye.
    const lines = src.split('\n');
    const indent = (l) => l.length - l.replace(/^[ \t]*/, '').length;

    let i = lines.findIndex((l) => /^on:[ \t]*$/.test(l));
    if (i < 0) return 'no';

    // The `push:` key inside the on: block.
    let pushAt = -1;
    let pushIndent = 0;
    for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        if (indent(lines[j]) === 0) break;              // next top-level key
        if (/^[ \t]+push:[ \t]*$/.test(lines[j])) { pushAt = j; pushIndent = indent(lines[j]); break; }
        if (/^[ \t]+push:[ \t]*\S/.test(lines[j])) return 'yes';   // `push: something` inline
    }
    if (pushAt < 0) return 'no';

    // Everything indented deeper than `push:` belongs to it.
    const body = [];
    for (let j = pushAt + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        if (indent(lines[j]) <= pushIndent) break;
        body.push(lines[j]);
    }
    if (!body.length) return 'yes';                     // `push:` with no filters

    /** The branch names under `key:`, inline or block form, or null if absent. */
    const listUnder = (key) => {
        const at = body.findIndex((l) => new RegExp(`^[ \\t]*${key}:`).test(l));
        if (at < 0) return null;
        const inlineForm = new RegExp(`^[ \\t]*${key}:[ \\t]*\\[([^\\]]*)\\]`).exec(body[at]);
        if (inlineForm) {
            return inlineForm[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
        }
        const out = [];
        const keyIndent = indent(body[at]);
        for (let j = at + 1; j < body.length; j++) {
            if (indent(body[j]) <= keyIndent) break;
            const item = /^[ \t]*-[ \t]*['"]?([^'"]+?)['"]?[ \t]*$/.exec(body[j]);
            if (item) out.push(item[1].trim());
        }
        return out;
    };

    const isTrunk = (b) => b === 'main' || b === 'master';
    const hasGlob = (names) => names.some((b) => /[*?[\]!+]/.test(b));

    // `branches-ignore` INVERTS `branches`, and that inversion is the whole
    // reason it is worth grading rather than deferring. Both read as restrictive
    // at a glance and they mean opposite things: `branches: [main]` keeps a push
    // OFF feature branches, `branches-ignore: [master]` keeps it ON all of them.
    // A peer's fleet survey got a row wrong on exactly that, and returning
    // UNKNOWN here would have left the one repo shaped to need the answer without
    // one the moment somebody added a guard to it.
    const ignored = listUnder('branches-ignore');
    if (ignored) {
        if (!ignored.length || hasGlob(ignored)) return 'unknown';
        // Ignoring only trunk means every FEATURE branch still fires, and a
        // draft PR lives on a feature branch. So the push reaches drafts.
        if (ignored.every(isTrunk)) return 'yes';
        // Any other explicit name is a branch somebody might draft on, and
        // whether they do is not knowable from the workflow.
        return 'unknown';
    }

    const listed = listUnder('branches');
    if (listed === null) return 'yes';                  // paths filters only
    if (!listed.length) return 'unknown';
    // A glob could match a feature branch; refuse to guess.
    if (hasGlob(listed)) return 'unknown';
    // Only trunk-ish names listed means drafts, which live on feature branches,
    // are not reached. Any other explicit name is a branch a draft could use.
    return listed.every(isTrunk) ? 'no' : 'unknown';
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
        let src;
        try { src = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
        const guard = GUARD.test(src);
        const reach = pushReachesDraftBranches(src);   // 'yes' | 'no' | 'unknown'
        rows.push({
            file: path.join('.github', 'workflows', name),
            guard,
            pushReachesDrafts: reach,
            // INERT only when a push genuinely reaches the branches drafts use.
            // 'unknown' is reported separately rather than folded into either
            // answer: a wrong confident verdict here sends somebody to change
            // working CI, which is worse than saying it could not tell.
            inert: guard && reach === 'yes',
            unclear: guard && reach === 'unknown',
        });
    }
    return rows;
}

// --- selftest -------------------------------------------------------------
// Plants all four combinations, because the risk here is a checker that cannot
// fire. Three of the four must NOT be reported, and each is a different reason.
if (has('--selftest')) {
    const os = require('os');
    let pass = 0;
    let fail = 0;
    const t = (label, ok) => { if (ok) pass++; else fail++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`); };

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-'));
    const wf = path.join(root, '.github', 'workflows');
    fs.mkdirSync(wf, { recursive: true });

    const GUARD_LINE = '    if: github.event.pull_request.draft == false\n';
    fs.writeFileSync(path.join(wf, 'inert-inline.yml'),
        'name: CI\non: [push, pull_request]\njobs:\n  test:\n' + GUARD_LINE);
    // UNFILTERED push in the mapping form. This fixture said `branches: [main]`
    // when it was written, which made it a CORRECT workflow asserted as inert.
    // The expectation was wrong, not the code, and it survived because the code
    // was wrong in the same direction. A fixture and an assertion that share an
    // error agree with each other perfectly.
    fs.writeFileSync(path.join(wf, 'inert-mapping.yml'),
        'name: CI\non:\n  push:\n    paths-ignore:\n      - docs/**\n  pull_request:\njobs:\n  test:\n' + GUARD_LINE);
    fs.writeFileSync(path.join(wf, 'working.yml'),
        'name: CI\non:\n  pull_request:\n    types: [opened, ready_for_review, synchronize]\njobs:\n  test:\n' + GUARD_LINE);
    fs.writeFileSync(path.join(wf, 'no-guard.yml'),
        'name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n');

    // THE CASE THAT CAUGHT THE FIRST VERSION. A push filtered to main never fires
    // on a feature branch, so it cannot defeat a draft-skip. This shape was
    // reported INERT and it is correct.
    fs.writeFileSync(path.join(wf, 'filtered.yml'),
        'name: CI\non:\n  push:\n    branches:\n      - main\n  pull_request:\njobs:\n  test:\n' + GUARD_LINE);
    fs.writeFileSync(path.join(wf, 'filtered-inline.yml'),
        'name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  test:\n' + GUARD_LINE);
    fs.writeFileSync(path.join(wf, 'glob.yml'),
        'name: CI\non:\n  push:\n    branches: [release/*]\n  pull_request:\njobs:\n  test:\n' + GUARD_LINE);
    // branches-ignore inverts branches. Ignoring only trunk means every FEATURE
    // branch still fires, so a guard beside it IS inert.
    fs.writeFileSync(path.join(wf, 'ignore-trunk.yml'),
        'name: CI\non:\n  push:\n    branches-ignore:\n      - master\n  pull_request:\njobs:\n  test:\n' + GUARD_LINE);
    fs.writeFileSync(path.join(wf, 'ignore-other.yml'),
        'name: CI\non:\n  push:\n    branches-ignore: [docs-only]\n  pull_request:\njobs:\n  test:\n' + GUARD_LINE);

    const rows = scan(root);
    const by = (n) => rows.find((r) => r.file.endsWith(n));

    t('the inline `on: [push, pull_request]` form with a guard is INERT', by('inert-inline.yml').inert === true);
    t('the mapping `on:` / `  push:` form with a guard is INERT', by('inert-mapping.yml').inert === true);
    t('a push filtered to main does NOT defeat the guard (block form)', by('filtered.yml').inert === false);
    t('  nor in the inline `branches: [main]` form', by('filtered-inline.yml').inert === false);
    t('  and neither is reported as unclear, since main is unambiguous',
        by('filtered.yml').unclear === false && by('filtered-inline.yml').unclear === false);
    t('a GLOB branch filter is UNKNOWN, never guessed either way',
        by('glob.yml').inert === false && by('glob.yml').unclear === true);
    t('branches-ignore listing only trunk means feature pushes fire, so INERT',
        by('ignore-trunk.yml').inert === true);
    t('  and it is not reported as unclear, since master is unambiguous',
        by('ignore-trunk.yml').unclear === false);
    t('branches-ignore naming a NON-trunk branch is UNKNOWN, not guessed',
        by('ignore-other.yml').inert === false && by('ignore-other.yml').unclear === true);
    t('a pull_request-only workflow with a guard is NOT reported', by('working.yml').inert === false);
    t('  and it is still recognised as carrying a guard', by('working.yml').guard === true);
    t('a workflow with no guard is NOT reported', by('no-guard.yml').inert === false);
    t('  and its push is still seen as reaching every branch', by('no-guard.yml').pushReachesDrafts === 'yes');
    t('the population counts every workflow, not only the findings', rows.length === 9);

    // No workflow directory at all must be distinguishable from a clean scan.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-empty-'));
    t('a root with no .github/workflows returns null, never an empty pass', scan(empty) === null);

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });

    console.log(`\n${pass} passed, ${fail} failed  (${pass + fail} cases: all four guard/trigger `
        + 'combinations, plus the no-population case)');
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

const inert = rows.filter((r) => r.inert);

if (has('--json')) {
    console.log(JSON.stringify({ root, scanned: rows.length, inert: inert.length, rows }, null, 2));
    process.exit(inert.length ? 1 : 0);
}

// Population before the verdict: a bare "none found" cannot be told apart from a
// scan that read no files.
const guarded = rows.filter((r) => r.guard).length;
console.log(`${rows.length} workflow(s) in ${root}, ${guarded} carrying a draft-skip guard`);

if (!inert.length) {
    console.log('0 inert guards.');
    if (!guarded) {
        console.log('NOT an endorsement: no workflow here uses a draft-skip guard at all, so');
        console.log('there is nothing for a push trigger to defeat. This says nothing about');
        console.log('whether one SHOULD be added.');
    }
    process.exit(0);
}

for (const r of inert) {
    console.log(`\n  INERT  ${r.file}`);
    console.log('         carries `github.event.pull_request.draft` AND triggers on push.');
    console.log('         That field is null on a push event, so the job runs anyway and');
    console.log('         drafts save nothing. Remove the push trigger, or drop the guard');
    console.log('         and stop describing this workflow as draft-aware.');
}
console.log(`\n${inert.length} of ${rows.length} workflow(s) carry a guard a push trigger makes inert.`);
process.exit(1);
