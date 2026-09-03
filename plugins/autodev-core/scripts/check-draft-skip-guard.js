#!/usr/bin/env node
'use strict';

// check-draft-skip-guard.js — two ways a draft-skip policy can be a fiction.
//
// Both findings share one harm: a reader concludes drafts are cheap and pushes
// freely, and the CI runs anyway. They differ in what produced the belief. An
// INERT guard is a control that cannot fire. PARTIAL coverage is a control that
// fires on one workflow while another, unguarded, runs in full.
//
// `[measured 2026-09-03]` the second was added after the first missed a live
// case. A repo scanned CLEAN here — 9 workflows, 1 guarded, 0 inert — while a
// session opened a draft, watched the guarded workflow skip, inferred drafts
// were free, and had to cancel an unguarded windows-runner workflow by hand,
// twice, because the first cancel did not take. Nothing about the clean scan was
// wrong; it answered a narrower question than the one the reader had.
//
// WHAT THIS CANNOT REACH, said out loud so a clean exit is not read as more
// than it is. Both findings are about WORKFLOW FILES. The belief they exist to
// stop, that a draft is free, comes just as often from PROSE: a briefing, a
// README, a skill that says "open it as a draft and push freely". This check
// cannot see that source and never will.
//
// `[measured 2026-09-03]` this repo is currently the prose-shaped case, and it
// scans clean here for a correct reason: its own ci.yml is
// `on: [push, pull_request]` with an OS matrix and no draft condition anywhere,
// so nothing guards and nothing is inconsistent with anything. Meanwhile a
// brief told three sessions that drafts skip CI here. Two of them measured it
// afterwards through `gh api actions/runs`: one drafted pull request fired two
// full runs, another fired four, every one behind the matrix.
//
// So exit 0 means the WORKFLOWS are consistent. It does not mean anyone's
// belief about drafts is true, and the two are easy to confuse precisely
// because this check is the thing that looked. A checker that does not say what
// it fails to govern becomes an instance of the defect it was written for,
// which is the argument below arriving one layer out.
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
        + 'Two ways a draft-skip policy can be a fiction:\n'
        + '  INERT    a guard (github.event.pull_request.draft) in a workflow that ALSO\n'
        + '           triggers on push to the branches drafts live on. The field is null\n'
        + '           on a push event, so the job runs anyway and the draft saves nothing.\n'
        + '  PARTIAL  some draft-reachable workflows carry the guard and others do not, so\n'
        + '           a draft shows one skipping while another runs in full. The visible\n'
        + '           skip is evidence for a policy that does not hold.\n'
        + 'A repo where NO workflow guards is neither: that is a coherent choice.\n'
        + 'Exit 0 clean, 1 a finding of either kind, 2 no workflows to scan.');
    process.exit(0);
}

/**
 * Strip YAML comments, so nothing below reads a mechanism that is switched off.
 *
 * THE DEFECT THIS EXISTS FOR, and it was found in this file rather than
 * imagined. `[measured 2026-09-03]` a workflow carried
 *
 *     # A draft-skip guard (`if: github.event.pull_request.draft == false` plus
 *     # a branches filter) was considered and rejected here.
 *
 * which is a note recording that a guard was DECLINED. Matching against raw
 * source reported that repo as guarded, so a repo that had deliberately chosen
 * not to guard was scored as one that had. A tighter guard regex cannot help:
 * the text it matches is the real expression, verbatim, and only its position
 * inside a comment makes it inert.
 *
 * Applied to every predicate rather than only the guard, but be exact about what
 * that buys, because the first version of this comment was not. The measured
 * defect was in the GUARD alone. `triggerEvents` already skips whole-line
 * comments on its own, and a trailing `# pull_request:` cannot be read as a key
 * either, so mutation-testing this function to a no-op kills the two guard cases
 * and NOT the commented-trigger one. Stripping is defence in depth on the input
 * side, not the thing that currently defends it. Said plainly so the next reader
 * does not delete the other skip believing this covers it.
 *
 * Quote-aware, so a `#` inside a string stays. NOT a YAML parse, consistent with
 * the rest of this file: block scalars are not excepted, so a `#` inside a
 * `run: |` body is stripped too. Safe here only because every construct read
 * below is a KEY — `on:`, `push:`, `branches:`, `if:` — and none can appear
 * inside a block scalar. That is the reason it is safe, not an argument that it
 * is harmless in general, and a predicate reading script bodies could not reuse
 * this.
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
 * The guard expression, in the spellings GitHub actually accepts.
 *
 * Deliberately the FULL property path and not the word `draft`. A workflow can
 * mention drafts in prose: `[measured 2026-09-03]` one carries "Nightly was the
 * first draft and cost ~120 more" inside a cost comment, so `grep -c draft`
 * returns 1 on a file with no guard at all. Anyone scanning by hand hits that
 * before this regex does, and a check reporting it would be the false-positive
 * shape that gets a detector muted and then missed when it is finally right.
 *
 * Specificity is not sufficient on its own, which is the neighbouring lesson:
 * it does nothing about the real expression sitting inside a comment. That is
 * what stripYamlComments above is for, and the two defend different halves.
 */
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

/**
 * Can a DRAFT pull request trigger this workflow at all?
 *
 * This is the population filter for the partial-coverage check below, and the
 * choice of filter is the load-bearing decision in it. A draft-skip guard can
 * only ever govern a `pull_request` event, because that is the only event whose
 * payload carries a `draft` field. A workflow with no such trigger is not part
 * of the repo's draft policy, correctly carries no guard, and must never be
 * reported as a gap.
 *
 * `[measured 2026-09-03]` on the repo that produced this defect: 9 workflows,
 * of which 7 trigger only on `workflow_dispatch`, `schedule`, or a bare `push`.
 * Filtering on reachability alone cuts the population from 9 to 2 without
 * guessing anything, which is why this check does NOT filter on "expensive".
 * Cost cannot be read off a workflow file without a model of runner minutes,
 * and the harm here does not depend on cost: it is a MISLEADING SIGNAL, and a
 * reader who watches one workflow skip and infers drafts are free is wrong by
 * the same amount whether the workflow that ran was cheap or not. Cost decides
 * how much the mistake costs, not whether it is one, so it annotates the row
 * rather than gating it.
 *
 * Same line-scanning discipline as pushReachesDraftBranches, and for the same
 * reason: `\s` spans newlines, so a multiline regex over indentation-scoped
 * YAML matches the wrong block. Comment lines are skipped explicitly here,
 * which that function does not do — a `#` at column zero inside an `on:` block
 * would end its scan early. Legal YAML, not observed in the wild, and left
 * alone rather than fixed in a commit about something else.
 */
function triggerEvents(src) {
    const out = new Set();

    // `on: [push, pull_request]`
    const inline = /^on:[ \t]*\[([^\]]*)\]/m.exec(src);
    if (inline) {
        for (const n of inline[1].split(',')) {
            const t = n.trim().replace(/^['"]|['"]$/g, '');
            if (t) out.add(t);
        }
        return out;
    }

    // `on: workflow_dispatch` — a single event as a scalar.
    const scalar = /^on:[ \t]+([A-Za-z_]+)[ \t]*$/m.exec(src);
    if (scalar) { out.add(scalar[1]); return out; }

    // Mapping form. Only DIRECT children of `on:` are events; `branches:` and
    // `paths:` sit deeper and must not be collected as event names.
    const lines = src.split('\n');
    const indent = (l) => l.length - l.replace(/^[ \t]*/, '').length;
    const start = lines.findIndex((l) => /^on:[ \t]*$/.test(l));
    if (start < 0) return out;

    let childIndent = -1;
    for (let j = start + 1; j < lines.length; j++) {
        const line = lines[j];
        if (!line.trim()) continue;
        if (line.trim().startsWith('#')) continue;
        if (indent(line) === 0) break;                 // next top-level key
        const key = /^[ \t]+([A-Za-z_]+):/.exec(line);
        if (!key) continue;
        if (childIndent < 0) childIndent = indent(line);
        if (indent(line) === childIndent) out.add(key[1]);
    }
    return out;
}

/** Reachable by a draft PR: the events whose payload has a `draft` field. */
function draftReachable(src) {
    const ev = triggerEvents(src);
    return ev.has('pull_request') || ev.has('pull_request_target');
}

/**
 * Signals that a workflow is expensive, reported as evidence rather than as a
 * verdict. Each is a fact readable off the file. None is a minute count, and
 * this deliberately does not add up to one: billing depends on runner class,
 * matrix size, job count and duration, and a confident wrong number here would
 * be worse than no number. A reader who sees `windows-latest` knows it bills at
 * 2x without this script asserting a total.
 */
function costSignals(src) {
    const out = [];
    if (/^\s*runs-on:\s*.*\bmacos[-a-z0-9]*\b/mi.test(src)) out.push('macos runner (10x minutes)');
    if (/^\s*runs-on:\s*.*\bwindows[-a-z0-9]*\b/mi.test(src)) out.push('windows runner (2x minutes)');
    if (/^\s*strategy:/m.test(src) && /^\s*matrix:/m.test(src)) out.push('matrix (multiplies jobs)');
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
        // Every predicate reads the COMMENT-STRIPPED source. A guard or a
        // trigger that is commented out governs nothing, and reading it as live
        // scores a repo for a mechanism it switched off.
        const src = stripYamlComments(raw);
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
            // For the partial-coverage check. Kept separate from `inert`: a
            // workflow can be draft-reachable and perfectly correct, and most
            // are.
            draftReachable: draftReachable(src),
            cost: costSignals(src),
        });
    }
    return rows;
}

/**
 * PARTIAL COVERAGE: some draft-reachable workflows guard, others do not.
 *
 * THE DEFECT. A repo where workflow A carries the guard and workflow B does not
 * shows a draft pull request with one workflow skipping and another running in
 * full. The skip is visible and reads as the policy holding, so a reader infers
 * drafts are cheap and pushes freely. They are not: B ran every time.
 *
 * This is the header's own argument, one level up. An absent guard prompts the
 * question. An inert guard reads as a control somebody thought about. A PARTIAL
 * guard is worse than either, because the workflow that does skip is visible
 * evidence for a policy that does not exist, and the evidence is genuine — that
 * workflow really did skip.
 *
 * `[measured 2026-09-03]` the shape is not hypothetical. One repo carries the
 * guard on its preflight workflow and documents it at length, while its browser
 * gates workflow triggers on both push and pull_request with no draft condition
 * at either level and runs partly on a windows runner. A session opened a draft,
 * watched preflight skip, concluded drafts were free, and cancelled a
 * browser-gates run by hand — twice, because the first cancel did not take.
 * Before this check, that repo scanned CLEAN: 9 workflows, 1 guarded, 0 inert.
 *
 * NOT A FINDING when NO draft-reachable workflow carries a guard. That is a
 * coherent choice — the repo has no draft policy and nothing pretends it does,
 * so there is no misleading signal to report. The same reasoning as the
 * "NOT an endorsement" line below: this check grades CONSISTENCY, never whether
 * a guard ought to exist.
 *
 * KNOWN LIMIT. Guard detection is file-wide, so a workflow guarding some jobs
 * and not others reads as guarded. That is a third shape and it is not caught
 * here; it is named so the next reader knows the boundary rather than inferring
 * coverage this does not have.
 */
function partialCoverage(rows) {
    const reachable = rows.filter((r) => r.draftReachable);
    const guarded = reachable.filter((r) => r.guard);
    const unguarded = reachable.filter((r) => !r.guard);
    // Both arms must be non-empty. All-guarded is consistent; none-guarded is a
    // legitimate choice, not a gap.
    if (!guarded.length || !unguarded.length) return null;
    return { reachable, guarded, unguarded };
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

    // --- comments are not mechanisms ----------------------------------------
    // A permanent fixture rather than a case we happened to catch. Found by a
    // peer against a real repo AFTER this file had been mutation-tested on both
    // new paths and run against a live known positive, which is the point: a
    // mutant proves a path is load-bearing and a known positive proves the check
    // can fire, and NEITHER enumerates the shapes the probe cannot see.
    // Its own root, deliberately. Adding these to the shared one above would
    // sit AFTER that root's `rows.length === 9` population assertion, which
    // would still pass only because `rows` was captured before these files
    // existed. Correct today and broken by the first person to move a line.
    const cmt = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-cmt-'));
    const cwf = path.join(cmt, '.github', 'workflows');
    fs.mkdirSync(cwf, { recursive: true });
    fs.writeFileSync(path.join(cwf, 'commented-guard.yml'),
        'name: Gate\non:\n  pull_request:\njobs:\n  x:\n'
        + '    # A draft-skip guard (`if: github.event.pull_request.draft == false` plus\n'
        + '    # a branches filter) was considered and rejected here.\n'
        + '    runs-on: ubuntu-latest\n');
    fs.writeFileSync(path.join(cwf, 'guard-trailing-comment.yml'),
        'name: Gate\non:\n  pull_request:\njobs:\n  x:\n'
        + '    if: github.event.pull_request.draft == false  # keep drafts cheap\n');
    fs.writeFileSync(path.join(cwf, 'commented-trigger.yml'),
        'name: Gate\non:\n  push:\n'
        + '  # pull_request:\njobs:\n  x:\n    runs-on: ubuntu-latest\n');

    const commented = scan(cmt);
    const cby = (n) => commented.find((r) => r.file.endsWith(n));
    t('a guard that exists ONLY inside a comment is NOT a guard',
        cby('commented-guard.yml').guard === false);
    t('  a repo declining a guard in prose is not scored as having one',
        cby('commented-guard.yml').draftReachable === true
        && cby('commented-guard.yml').guard === false);
    t('a real guard with a TRAILING comment is still a guard',
        cby('guard-trailing-comment.yml').guard === true);
    t('a commented-out trigger does not make a workflow draft-reachable',
        cby('commented-trigger.yml').draftReachable === false);
    t('a `#` inside a quoted string is not treated as a comment',
        stripYamlComments('    run: echo "a # b"').includes('a # b'));

    // --- draft-reachability, the population filter for partial coverage -----
    // Asserted directly rather than only through the finding, because if this
    // predicate is wrong every coverage verdict is wrong in the same direction
    // and the finding would still look reasonable.
    t('`on: [push, pull_request]` is draft-reachable',
        draftReachable('on: [push, pull_request]\n') === true);
    t('`on: [push]` alone is NOT draft-reachable',
        draftReachable('on: [push]\n') === false);
    t('the mapping form `on:` / `  pull_request:` is draft-reachable',
        draftReachable('on:\n  pull_request:\n    paths:\n      - x\n') === true);
    t('a schedule/dispatch-only workflow is NOT draft-reachable',
        draftReachable('on:\n  schedule:\n    - cron: "0 3 * * *"\n  workflow_dispatch:\n') === false);
    t('`on: workflow_dispatch` as a scalar is NOT draft-reachable',
        draftReachable('on: workflow_dispatch\npermissions:\n') === false);
    t('pull_request_target counts, since its payload carries draft too',
        draftReachable('on:\n  pull_request_target:\n') === true);
    t('a nested `paths:` key is never mistaken for an event',
        !triggerEvents('on:\n  push:\n    paths:\n      - x\n').has('paths'));
    t('a comment at column zero inside on: does not truncate the scan',
        draftReachable('on:\n  push:\n# a comment\n  pull_request:\n') === true);

    // --- partial coverage ---------------------------------------------------
    // A repo where one draft-reachable workflow guards and another does not.
    const mixed = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-mixed-'));
    const mwf = path.join(mixed, '.github', 'workflows');
    fs.mkdirSync(mwf, { recursive: true });
    fs.writeFileSync(path.join(mwf, 'guarded.yml'),
        'name: Preflight\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  test:\n' + GUARD_LINE);
    fs.writeFileSync(path.join(mwf, 'unguarded.yml'),
        'name: Browser\non:\n  push:\n    paths:\n      - docs/**\n  pull_request:\n    paths:\n      - docs/**\njobs:\n'
        + '  gate:\n    runs-on: windows-latest\n');
    // Must NOT be counted in the coverage population: a draft PR cannot fire it.
    fs.writeFileSync(path.join(mwf, 'cron-only.yml'),
        'name: Nightly\non:\n  schedule:\n    - cron: "0 3 * * *"\n  workflow_dispatch:\njobs:\n  x:\n    runs-on: ubuntu-latest\n');

    const mixedRows = scan(mixed);
    const mixedPartial = partialCoverage(mixedRows);
    t('a repo guarding one draft-reachable workflow and not another is PARTIAL',
        mixedPartial !== null);
    t('  the unguarded one is named', mixedPartial.unguarded.length === 1
        && mixedPartial.unguarded[0].file.endsWith('unguarded.yml'));
    t('  the guarded one is named and NOT reported as the gap', mixedPartial.guarded.length === 1
        && mixedPartial.guarded[0].file.endsWith('guarded.yml'));
    t('  a cron/dispatch-only workflow is excluded from the population',
        mixedPartial.reachable.length === 2
        && !mixedPartial.reachable.some((r) => r.file.endsWith('cron-only.yml')));
    t('  the windows runner is reported as a cost signal, not as a minute count',
        mixedPartial.unguarded[0].cost.some((c) => /windows/.test(c)));
    t('  and the guarded workflow is not reported INERT, since its push is trunk-only',
        mixedRows.find((r) => r.file.endsWith('guarded.yml')).inert === false);

    // THE NEGATIVE THE CHECK MUST NOT FIRE ON. No guard anywhere is a coherent
    // choice, not a gap. Without this case the check would report every repo
    // that has never adopted the pattern, which is most of them.
    const none = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-none-'));
    const nwf = path.join(none, '.github', 'workflows');
    fs.mkdirSync(nwf, { recursive: true });
    fs.writeFileSync(path.join(nwf, 'a.yml'), 'name: A\non: [push, pull_request]\njobs:\n  x:\n    runs-on: ubuntu-latest\n');
    fs.writeFileSync(path.join(nwf, 'b.yml'), 'name: B\non: [push, pull_request]\njobs:\n  y:\n    runs-on: ubuntu-latest\n');
    t('a repo where NOTHING carries a guard is not a finding', partialCoverage(scan(none)) === null);

    // And the other consistent state.
    const all = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-all-'));
    const awf = path.join(all, '.github', 'workflows');
    fs.mkdirSync(awf, { recursive: true });
    fs.writeFileSync(path.join(awf, 'a.yml'), 'name: A\non:\n  pull_request:\njobs:\n  x:\n' + GUARD_LINE);
    fs.writeFileSync(path.join(awf, 'b.yml'), 'name: B\non:\n  pull_request:\njobs:\n  y:\n' + GUARD_LINE);
    t('a repo where EVERY draft-reachable workflow guards is not a finding',
        partialCoverage(scan(all)) === null);

    // No workflow directory at all must be distinguishable from a clean scan.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-empty-'));
    t('a root with no .github/workflows returns null, never an empty pass', scan(empty) === null);

    for (const d of [root, empty, mixed, none, all, cmt]) fs.rmSync(d, { recursive: true, force: true });

    console.log(`\n${pass} passed, ${fail} failed  (${pass + fail} cases: all four guard/trigger `
        + 'combinations, the no-population case, draft-reachability in every trigger form, '
        + 'partial coverage with BOTH consistent states as negatives, and a guard that '
        + 'exists only inside a comment)');
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
const partial = partialCoverage(rows);

if (has('--json')) {
    console.log(JSON.stringify({
        root,
        scanned: rows.length,
        inert: inert.length,
        partial: partial ? { guarded: partial.guarded.map((r) => r.file), unguarded: partial.unguarded.map((r) => r.file) } : null,
        rows,
    }, null, 2));
    process.exit(inert.length || partial ? 1 : 0);
}

// Population before the verdict: a bare "none found" cannot be told apart from a
// scan that read no files. Both denominators are printed, because the two checks
// grade different populations — every workflow for inertness, only the
// draft-reachable ones for coverage.
const guarded = rows.filter((r) => r.guard).length;
const reachable = rows.filter((r) => r.draftReachable);
console.log(`${rows.length} workflow(s) in ${root}, ${guarded} carrying a draft-skip guard`);
console.log(`${reachable.length} reachable by a draft pull request `
    + `(${reachable.filter((r) => r.guard).length} guarded, ${reachable.filter((r) => !r.guard).length} not)`);

for (const r of inert) {
    console.log(`\n  INERT  ${r.file}`);
    console.log('         carries `github.event.pull_request.draft` AND triggers on push.');
    console.log('         That field is null on a push event, so the job runs anyway and');
    console.log('         drafts save nothing. Remove the push trigger, or drop the guard');
    console.log('         and stop describing this workflow as draft-aware.');
}

if (partial) {
    console.log('\n  PARTIAL  this repo guards some draft-reachable workflows and not others.');
    console.log('           A draft pull request shows the guarded one skipping, which reads');
    console.log('           as the policy holding, while every workflow below runs in full.');
    console.log('           The skip is real, which is what makes it misleading.');
    console.log('\n           guarded:');
    for (const r of partial.guarded) console.log(`             ${r.file}`);
    console.log('           NOT guarded:');
    for (const r of partial.unguarded) {
        const c = r.cost.length ? `   [${r.cost.join('; ')}]` : '';
        console.log(`             ${r.file}${c}`);
    }
    console.log('\n           Guard them too, or drop the guard from the one that has it and');
    console.log('           stop describing this repo as draft-aware. Either is coherent;');
    console.log('           the present state is what is not.');
    const withCost = partial.unguarded.filter((r) => r.cost.length);
    if (withCost.length) {
        console.log(`\n           ${withCost.length} of the unguarded `
            + `${withCost.length === 1 ? 'carries' : 'carry'} a cost signal, shown above.`);
        console.log('           Those are facts read off the file, not a minute estimate.');
    }
}

if (!inert.length && !partial) {
    console.log('\n0 inert guards, and draft-skip coverage is consistent.');
    if (!guarded) {
        console.log('NOT an endorsement: no workflow here uses a draft-skip guard at all, so');
        console.log('there is nothing for a push trigger to defeat and nothing to be');
        console.log('inconsistent with. This says nothing about whether one SHOULD be added.');
    }
    process.exit(0);
}

const findings = [];
if (inert.length) findings.push(`${inert.length} of ${rows.length} workflow(s) carry a guard a push trigger makes inert`);
if (partial) findings.push(`${partial.unguarded.length} of ${partial.reachable.length} draft-reachable workflow(s) unguarded beside ${partial.guarded.length} guarded`);
console.log(`\n${findings.join('; ')}.`);
process.exit(1);
