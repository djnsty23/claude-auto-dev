#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * subject-evidence.js — which derived subject to stub FIRST, and when to stop.
 *
 * WHY THIS EXISTS. `[measured 2026-09-10]` check-suites-can-fail.js performs 350
 * suite PROCESS RUNS for 123 suites, because it stubs every derived subject in
 * turn and a suite's subjects are derived from PATH LITERALS. A literal is not
 * evidence of use: test-fleet-overlap.js derives 12 subjects, of which 7
 * (tooling/validate.js, tooling/test-pre-tool-filter.js,
 * tooling/test-rendered-layout-gate.js, tooling/find-untested-hooks.js,
 * tooling/spawn-budget.js, tooling/test-quota-tripwire.js and
 * plugins/autodev-core/scripts/rendered-layout-gate.js) are entries in its
 * PLUGIN_SEED and SUITES arrays — names it writes into throwaway git repos, never
 * the repo's own copies. Its real subject, fleet-overlap.js, sits NINTH in the
 * derived order, so eight pointless runs of the heaviest fixture-building suite
 * in the tree happen before the one that proves anything.
 *
 * THE RULE THAT SHAPES THIS FILE. The obvious fix is to stop deriving the
 * spurious ones, and check-suites-can-fail.js's own header argues at length
 * against exactly that: every attempt to tell a subject from a mention is a guess
 * about a file, and a wrong guess DROPS a real subject, turning a verified suite
 * into an unverified one or an `ok` into a VACUOUS accusation. So nothing here
 * excludes anything.
 *
 *   A heuristic that ORDERS candidates cannot produce a wrong verdict, only a
 *   slower run. A heuristic that SELECTS candidates can produce a wrong verdict.
 *
 * That asymmetry is the whole design. The candidate SET is untouched, so every
 * verdict is reachable exactly as before; the order is ranked by cheap signals;
 * and the traversal stops at the first subject that proves the property, which is
 * sound because the property is "this suite CAN fail" and one killed subject
 * establishes it. A suite that is genuinely vacuous still costs every run,
 * because proving a negative still requires all of them.
 *
 *   node tooling/subject-evidence.js --help
 *   node tooling/subject-evidence.js --selftest
 */

/**
 * How a reference was WRITTEN, ranked by how strongly it implies the suite
 * resolves that path at runtime. This is a fact about the syntax, not a
 * similarity judgement about the file — the same footing check-suites-can-fail's
 * rules 2b and 3b stand on ("a fact about where the file sits, not a similarity
 * heuristic").
 *
 *   require    the suite LOADS it. Nothing else is as strong.
 *   pathjoin   the suite CONSTRUCTS the path, which is what you do to use one.
 *   literal    a bare slash path in a string. Could be a subject; could be an
 *              element of a fixture array. Indistinguishable without guessing,
 *              which is why it is ranked rather than dropped.
 *   basename   matched by unique basename under plugins/. The one derivation rule
 *              that admits to guessing, so it sorts last.
 */
const RULE_STRENGTH = { require: 0, pathjoin: 1, literal: 2, basename: 3 };
const UNKNOWN_STRENGTH = RULE_STRENGTH.literal;

/**
 * Does this candidate's basename match the suite's own name? `test-foo.js` and
 * `foo.js`.
 *
 * This IS a resemblance heuristic, and it is used deliberately, in the one place
 * where being wrong is free: it moves a candidate earlier in a list that is
 * traversed until something kills the suite. If the resemblance misleads, the
 * next candidate is tried and the verdict is identical.
 */
function namesakeOf(suiteBasename) {
    const stem = String(suiteBasename).replace(/^test-/, '').replace(/\.js$/, '');
    return stem.length ? stem + '.js' : null;
}

/**
 * Order candidates most-likely-to-be-the-subject first. STABLE, and a pure
 * permutation: the returned array holds exactly the input elements.
 *
 * `provenance` is a Map of candidate -> rule name, as produced by the derivation
 * in check-suites-can-fail.js. A candidate missing from it (a hand-pinned
 * SUBJECT_OVERRIDES entry, say) is ranked as a plain literal rather than last, so
 * a missing map degrades to "keep the authored order" instead of to "worst".
 */
function rankSubjects(suiteBasename, subjects, provenance) {
    const namesake = namesakeOf(suiteBasename);
    const basename = (p) => String(p).split('/').pop();
    const strength = (p) => {
        const rule = provenance && provenance.get ? provenance.get(p) : undefined;
        const s = RULE_STRENGTH[rule];
        return s === undefined ? UNKNOWN_STRENGTH : s;
    };
    return subjects
        .map((rel, i) => ({ rel, i }))
        .sort((a, b) => {
            const an = namesake && basename(a.rel) === namesake ? 0 : 1;
            const bn = namesake && basename(b.rel) === namesake ? 0 : 1;
            if (an !== bn) return an - bn;
            const as = strength(a.rel), bs = strength(b.rel);
            if (as !== bs) return as - bs;
            return a.i - b.i;              // stable: derivation order breaks ties
        })
        .map((x) => x.rel);
}

/**
 * Traverse candidates until one proves the suite can fail.
 *
 * `runOnce(rel)` is called with one candidate at a time and must return
 * 'killed' (the suite went red with it stubbed), 'green' (it did not) or
 * 'incomplete' (the run produced no verdict — a timeout, a signal, a refusal, or
 * a stub that could not be installed).
 *
 * Returns { verdict, killed, tried, incomplete }, where verdict is:
 *   'ok'        some candidate killed the suite
 *   'vacuous'   every candidate ran to completion and none killed it
 *   'unchecked' nobody killed it and at least one run produced no verdict
 *   'none'      there were no candidates
 *
 * EQUIVALENCE IS THE POINT, and it is asserted over every kill pattern in the
 * selftest rather than argued here: for any candidate list and any runOnce, this
 * returns the same VERDICT as running all of them would. 'ok' needs one killer
 * and stops there; 'vacuous' and 'unchecked' are negatives and still pay for
 * every candidate, because that is what deciding them costs.
 */
function firstKiller(subjects, runOnce) {
    if (!subjects.length) return { verdict: 'none', killed: null, tried: 0, incomplete: false };
    let incomplete = false;
    let tried = 0;
    for (const rel of subjects) {
        tried++;
        const outcome = runOnce(rel);
        if (outcome === 'killed') return { verdict: 'ok', killed: rel, tried, incomplete };
        if (outcome === 'incomplete') incomplete = true;
        else if (outcome !== 'green') {
            throw new Error(`runOnce must return 'killed', 'green' or 'incomplete', got ${JSON.stringify(outcome)}`);
        }
    }
    return {
        verdict: incomplete ? 'unchecked' : 'vacuous',
        killed: null, tried, incomplete,
    };
}

/**
 * DERIVATION, moved here from check-suites-can-fail.js on 2026-09-10 so that a
 * suite can reach it. It had no seam before: that file resolves a HEAD, creates a
 * git worktree and refuses a dirty tree at module load, so requiring it to test
 * its derivation is impossible, and the first draft of test-subject-evidence.js
 * reimplemented rule 1 alone instead — which found 0 of the namesake cases the
 * change is about, and said so only because the suite carried a population floor.
 * A narrower reimplementation tests a different derivation than the one that
 * ships; this is the one that ships.
 *
 * Reparameterised on `root` rather than a module-level SWEEP_ROOT, because two
 * callers now reach it against two different trees.
 */
// The same derivation, keeping HOW each candidate was found. Nothing about WHICH
// candidates are returned changed when this became a Map: the rule names are read
// only by subject-evidence.js's ranking, which is a permutation and never a
// filter. See that file's header for why the spurious candidates are ORDERED
// rather than dropped.
function deriveCandidates(suiteFile, root) {
    const src = fs.readFileSync(suiteFile, 'utf8');
    const found = new Map();
    const add = (rel, rule) => { if (!found.has(rel)) found.set(rel, rule); };

    // The suite's OWN directory, relative to the repo, as a posix path. Rules 2b
    // and 3b resolve against it, so they state a fact about where this file sits
    // rather than matching on resemblance. Read from the path rather than
    // hardcoded, so a suite that ever moves resolves correctly.
    const suiteDir = path.relative(root, path.dirname(suiteFile)).split(path.sep).join('/');

    // 1. A slash-separated path literal inside the repo: 'plugins/…/foo.js'
    //    The alternation is written out rather than assembled from a variable: a
    //    RegExp built through a template literal loses `\w` and `\.` to escape
    //    collapsing, and the result is a silent false-empty rather than an error.
    //    That cost a wrong reading while measuring this very change.
    for (const m of src.matchAll(/['"`]((?:\.\.\/)*(?:plugins|templates|tooling)\/[\w./-]+\.js)['"`]/g)) {
        add(m[1].replace(/^(\.\.\/)+/, ''), 'literal');
    }
    // 2. path.join / path.resolve segment lists: 'plugins', 'autodev-core', 'hooks', 'x.js'
    for (const m of src.matchAll(/path\.(?:join|resolve)\(([^)]*)\)/g)) {
        const call = m[1];
        const parts = [...call.matchAll(/['"`]([\w.-]+)['"`]/g)].map((x) => x[1]);
        if (!parts.length || !parts[parts.length - 1].endsWith('.js')) continue;
        for (const top of ['plugins', 'tooling']) {
            const i = parts.indexOf(top);
            if (i >= 0) add(parts.slice(i).join('/'), 'pathjoin');
        }
        // 2b. __dirname-anchored with no '..' climb. The suite lives in
        //     suiteDir, so path.resolve(__dirname, 'check-foo.js') IS
        //     suiteDir/check-foo.js. A '..' among the segments means the call
        //     leaves that directory and this reading does not hold, so it is
        //     skipped and rules 1-3 handle it.
        if (/\b__dirname\b/.test(call) && !/['"`]\.\.['"`]/.test(call)) {
            add(suiteDir + '/' + parts.join('/'), 'pathjoin');
        }
    }
    // 3. A bare require of a repo-relative module, with or without .js
    for (const m of src.matchAll(/require\(['"`]((?:\.\.\/)+[\w./-]+)['"`]\)/g)) {
        const p = m[1].replace(/^(\.\.\/)+/, '');
        if (/^(plugins|templates|tooling)\//.test(p)) add(p.endsWith('.js') ? p : p + '.js', 'require');
    }
    // 3b. A './' require resolves against the suite's own directory, the same
    //     fact as 2b. test-standing-order-wake.js names its subject exactly this
    //     way — `require('./standing-order-wake.js')` — and derived nothing.
    for (const m of src.matchAll(/require\(['"`]\.\/([\w./-]+)['"`]\)/g)) {
        const p = m[1];
        add(suiteDir + '/' + (p.endsWith('.js') ? p : p + '.js'), 'require');
    }

    // 4. A bare BASENAME, for suites that build the path in two steps:
    //      const PLUGIN_ROOT = path.resolve(__dirname, '..', 'plugins', 'autodev-core');
    //      const HOOK        = path.join(PLUGIN_ROOT, 'hooks', 'stop-auto-check.js');
    //    Rules 1-3 see neither half. Four of twelve suites are written this way,
    //    and without this they derive nothing and get waved through as
    //    NO-SUBJECT — the silent-skip failure this whole script is about.
    //
    //    Safe because it demands a UNIQUE match: a basename resolving to two
    //    files under plugins/ is ambiguous and ignored rather than guessed.
    //
    //    The character class allows DOTS, and that is not cosmetic. It was
    //    `[\w-]+\.js`, which cannot match a basename carrying a second dot, so
    //    every `*.workflow.js`, `*.config.js` and `*.test.js` in the tree was
    //    invisible to this rule. `[measured 2026-08-29]` that is exactly how
    //    test-workflow-isolation.js came back NO-SUBJECT while naming
    //    `heal-sweep.workflow.js` on one line — reported as a suite with nothing
    //    to check, which is the silent-skip signature this rule exists to close,
    //    reappearing inside the rule itself.
    //    NOT widened to tooling/ when rules 1-3 were, on 2026-09-03. This is the
    //    one rule that guesses — it infers a subject from a name that resembles
    //    a file — and `[measured 2026-09-03]` widening its pool covered exactly
    //    ONE extra suite, test-all.js, which is checked as the runner and never
    //    consults its own subjects, while adding three more fuzzy matches
    //    elsewhere. Zero gain for more guessing, so it stays scoped to plugins/.
    for (const m of src.matchAll(/['"`]([\w.-]+\.js)['"`]/g)) {
        const hits = allPluginFiles(root).filter((p) => path.basename(p) === m[1]);
        if (hits.length === 1) add(hits[0], 'basename');
    }

    for (const rel of [...found.keys()]) {
        if (!fs.existsSync(path.join(root, rel))) found.delete(rel);
    }
    return found;
}

// Cached PER ROOT. A single module-level cache was safe while only the sweep
// called this, against one worktree; a shared module two callers can reach must
// not serve one root's file list for another's.
const _pluginFiles = new Map();
function allPluginFiles(root) {
    if (_pluginFiles.has(root)) return _pluginFiles.get(root);
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const rel = dir + '/' + e.name;
            if (e.isDirectory()) walk(rel);
            else if (e.name.endsWith('.js')) out.push(rel);
        }
    };
    for (const top of ['plugins']) {
        if (fs.existsSync(path.join(root, top))) walk(top);
    }
    _pluginFiles.set(root, out);
    return out;
}

module.exports = { deriveCandidates, rankSubjects, firstKiller, namesakeOf, RULE_STRENGTH };

// --- CLI -------------------------------------------------------------------
// This file lives in tooling/ and is not a test-*.js, so check-entrypoints probes
// it with --help and requires it to RETURN, and to do nothing destructive when run
// bare. For a pure module that means printing usage.
if (require.main === module) {
    const argv = process.argv.slice(2);
    if (argv.includes('--selftest')) {
        const cases = [];
        const t = (label, ok, detail) => cases.push([label, ok, detail]);

        // --- the equivalence property, which is the whole safety argument ----
        // The reference implementation is the traversal this replaces, written
        // out here so the comparison is against CODE and not against a summary
        // of it: stub every candidate, collect the kills, decide at the end.
        const exhaustive = (subjects, runOnce) => {
            const killed = [];
            let incomplete = false;
            for (const rel of subjects) {
                const o = runOnce(rel);
                if (o === 'killed') killed.push(rel);
                else if (o === 'incomplete') incomplete = true;
            }
            return killed.length ? 'ok' : (incomplete ? 'unchecked' : 'vacuous');
        };
        const OUTCOMES = ['killed', 'green', 'incomplete'];
        let compared = 0, mismatched = [], savedRuns = 0, totalRuns = 0;
        for (let n = 1; n <= 5; n++) {
            const subjects = Array.from({ length: n }, (_, i) => `s${i}.js`);
            for (let code = 0; code < Math.pow(3, n); code++) {
                const plan = [];
                let c = code;
                for (let i = 0; i < n; i++) { plan.push(OUTCOMES[c % 3]); c = Math.floor(c / 3); }
                const at = (rel) => plan[subjects.indexOf(rel)];
                let exRuns = 0, fkRuns = 0;
                const ex = exhaustive(subjects, (r) => { exRuns++; return at(r); });
                const fk = firstKiller(subjects, (r) => { fkRuns++; return at(r); });
                compared++;
                totalRuns += exRuns; savedRuns += exRuns - fkRuns;
                if (ex !== fk.verdict) mismatched.push(`${plan.join(',')}: exhaustive=${ex} firstKiller=${fk.verdict}`);
                // and the run count it claims must be the runs it actually made
                if (fk.tried !== fkRuns) mismatched.push(`${plan.join(',')}: tried=${fk.tried} but called runOnce ${fkRuns}x`);
            }
        }
        t(`the verdict is identical to running every candidate, over all ${compared} `
            + 'outcome patterns for 1-5 candidates', mismatched.length === 0,
            mismatched.slice(0, 3).join(' | '));
        t('  and the population is non-trivial, so the line above is not passing on nothing',
            compared === 363, String(compared));
        t(`  while making ${savedRuns} of ${totalRuns} runs unnecessary across that same population`,
            savedRuns > 0, `saved=${savedRuns} of ${totalRuns}`);

        // Stopping is asserted positionally, not just by a total: a killer at
        // index i must cost exactly i+1 runs and not one more.
        {
            const subjects = ['a.js', 'b.js', 'c.js', 'd.js'];
            let wrong = [];
            for (let i = 0; i < subjects.length; i++) {
                let n = 0;
                const r = firstKiller(subjects, (rel) => { n++; return rel === subjects[i] ? 'killed' : 'green'; });
                if (r.tried !== i + 1 || n !== i + 1 || r.killed !== subjects[i]) {
                    wrong.push(`killer at ${i}: tried=${r.tried} calls=${n} killed=${r.killed}`);
                }
            }
            t('a killer at index i costs exactly i+1 runs, at every i', wrong.length === 0, wrong.join(' | '));
        }
        t('a vacuous suite still pays for every candidate — proving a negative costs all of them',
            (() => { let n = 0; const r = firstKiller(['a.js', 'b.js', 'c.js'], () => { n++; return 'green'; });
                     return n === 3 && r.verdict === 'vacuous'; })());
        t('  and one incomplete run among the greens is UNCHECKED, never VACUOUS, so an '
            + 'accusation is never made on a run that produced no verdict',
            firstKiller(['a.js', 'b.js'], (r) => (r === 'a.js' ? 'incomplete' : 'green')).verdict === 'unchecked');
        t('  but an incomplete run BEFORE a killer does not stop the ok verdict',
            firstKiller(['a.js', 'b.js'], (r) => (r === 'a.js' ? 'incomplete' : 'killed')).verdict === 'ok');
        t('no candidates is its own answer, not a vacuous accusation',
            firstKiller([], () => 'green').verdict === 'none');
        t('an unexpected runOnce return THROWS rather than being read as green, which '
            + 'would silently convert a broken caller into a VACUOUS accusation',
            (() => { try { firstKiller(['a.js'], () => undefined); return false; } catch { return true; } })());

        // --- ranking: a permutation, never a filter -------------------------
        const PROV = new Map([
            ['tooling/validate.js', 'literal'],
            ['plugins/autodev-core/scripts/fleet-overlap.js', 'literal'],
            ['plugins/autodev-core/scripts/claude-paths.js', 'basename'],
            ['tooling/spawn-budget.js', 'require'],
        ]);
        const IN = ['tooling/validate.js', 'plugins/autodev-core/scripts/fleet-overlap.js',
                    'plugins/autodev-core/scripts/claude-paths.js', 'tooling/spawn-budget.js'];
        const out = rankSubjects('test-fleet-overlap.js', IN, PROV);
        t('ranking returns exactly the input candidates — a permutation, never a filter, '
            + 'which is what makes every verdict still reachable',
            out.length === IN.length && IN.every((x) => out.includes(x)), out.join(','));
        t("  and the suite's namesake comes first even though it was only a literal, "
            + 'ahead of a require — this is the real test-fleet-overlap case, where '
            + 'fleet-overlap.js sat ninth of eleven',
            out[0] === 'plugins/autodev-core/scripts/fleet-overlap.js', out.join(','));
        t('  and a require outranks a bare literal when neither is the namesake',
            out.indexOf('tooling/spawn-budget.js') < out.indexOf('tooling/validate.js'), out.join(','));
        t('  and the admitted guess (unique basename) sorts last',
            out[out.length - 1] === 'plugins/autodev-core/scripts/claude-paths.js', out.join(','));
        t('with no provenance at all the authored order is preserved, so a hand-pinned '
            + 'SUBJECT_OVERRIDES list is not reshuffled into a worse one',
            rankSubjects('test-nothing.js', ['z.js', 'y.js', 'x.js'], undefined).join(',') === 'z.js,y.js,x.js',
            rankSubjects('test-nothing.js', ['z.js', 'y.js', 'x.js'], undefined).join(','));
        t('  and ranking is stable within a strength class, so two literals keep their '
            + 'derivation order', rankSubjects('test-q.js', ['a/one.js', 'a/two.js'],
                new Map([['a/one.js', 'literal'], ['a/two.js', 'literal']])).join(',') === 'a/one.js,a/two.js');
        t('an empty candidate list ranks to an empty list rather than throwing',
            rankSubjects('test-x.js', [], new Map()).length === 0);
        t('namesakeOf strips the test- prefix and nothing else',
            namesakeOf('test-fleet-overlap.js') === 'fleet-overlap.js', namesakeOf('test-fleet-overlap.js'));
        t('  and a suite whose name is only the prefix yields no namesake rather than ".js"',
            namesakeOf('test-.js') === null, JSON.stringify(namesakeOf('test-.js')));

        let p = 0, fl = 0;
        for (const [label, ok, detail] of cases) {
            console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : '  (' + detail + ')'}`);
            ok ? p++ : fl++;
        }
        console.log(`\npopulation: ${cases.length} assertions run, ${p} passed, ${fl} failed`);
        process.exitCode = fl ? 1 : 0;
        return;
    }
    console.log('usage: node tooling/subject-evidence.js [--selftest]');
    console.log('  Ordering and traversal for check-suites-can-fail.js: rank derived subject');
    console.log('  candidates most-likely-first, then stop at the first one that proves the');
    console.log('  suite can fail. The candidate SET is never filtered — only ordered — so');
    console.log('  every verdict stays reachable. Rationale and measurements in the header.');
}
