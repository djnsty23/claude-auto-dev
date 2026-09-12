#!/usr/bin/env node
'use strict';
// Tests for tooling/suite-verdict-summary.js — the cause split that decides what
// check-suites-can-fail.js's summary line SAYS about a suite it did not verify.
//
// WHY THIS SUITE EXISTS. `[measured 2026-09-10]` the sweep counted every
// UNCHECKED row with one filter and labelled the total `(N with no derivable
// subject)`. Five of its producers are the sweep failing to measure — a killed
// baseline, a canary it could not install, a stub run that hit the budget — and a
// sweep produced four such rows, all timeouts, all with subjects that derived
// perfectly well. The line reported a transient contention failure as a static
// property of the suite and sent the reader to fix four suites that were fine.
//
// SO EVERY ASSERTION BELOW USES BOTH KINDS OF ROW AT ONCE, with DIFFERENT counts.
// A suite that exercised only the derivation case would pass on the broken code:
// one bucket of four satisfies "the derivation deficiency is named" perfectly
// well. The numbers are chosen so a single bucket cannot satisfy two assertions.
//
// AND IT GRADES THE PRODUCERS STATICALLY. The runtime half cannot see a sixth
// producer added tomorrow with no cause on it; the static half reads every
// `status: 'UNCHECKED'` literal in the sweep and requires a cause in the same
// object. That is the regression this split can actually suffer.
//
// AND IT PLANTS ITS OWN MUTANTS. Everything above says the split HOLDS. The last
// block says this suite NOTICES when it stops holding: four collapses are written
// into a scratch copy of the subject and each is watched going red, with an
// unmutated control run first so a broken scratch copy cannot report four kills
// while catching nothing. See the tail of this file, and
// docs/evidence-suite-verdict-mutants-2026-09-11.md.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sv = require('./suite-verdict-summary.js');

const TOOLING = __dirname;
const SUBJECT = path.join(TOOLING, 'suite-verdict-summary.js');
const SWEEP = path.join(TOOLING, 'check-suites-can-fail.js');
// Set on the children this suite spawns of ITSELF, so the mutant harness at the
// bottom does not recurse. Absent in an ordinary run, which is why the harness
// runs as part of `npm test` rather than as a mode nobody remembers to invoke.
const CHILD = 'AUTODEV_SVS_MUTANT_CHILD';

let pass = 0, fail = 0;
const failures = [];
function check(label, ok, detail) {
    if (ok) pass++; else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : '  (' + detail + ')'}`);
}

// The fixture is the measured incident: ONE real deficiency beside THREE sweep
// failures. 1 and 3 are not interchangeable, and neither is 4.
const MIXED = [
    { suite: 'a.js', status: 'ok', note: 'reports failure when x fails' },
    { suite: 'b.js', status: 'NOT-JS', note: 'canaried elsewhere' },
    { suite: 'c.js', status: 'UNCHECKED', cause: sv.CAUSE.NO_SUBJECT, note: 'subject not derived' },
    { suite: 'd.js', status: 'UNCHECKED', cause: sv.CAUSE.RUN_INCOMPLETE, note: 'baseline did not complete' },
    { suite: 'e.js', status: 'UNCHECKED', cause: sv.CAUSE.RUN_INCOMPLETE, note: 'stub run(s) did not complete' },
    { suite: 'f.js', status: 'UNCHECKED', cause: sv.CAUSE.RUN_INCOMPLETE, note: 'canary run did not complete' },
    { suite: 'g.js', status: 'VACUOUS', note: 'stays GREEN while x exits 1' },
];

// --- the split itself, over both kinds at once --------------------------------
{
    const s = sv.summarise(MIXED);
    // 'bad' counts VERDICTS (VACUOUS here) as well as the unverified family, and
    // the split must not disturb it: the exit code hangs off this number.
    check('the five not-verified rows are still all counted as not verified', s.bad === 5, String(s.bad));
    check('  and the unverified FAMILY is the 4 without a verdict, so nothing is lost '
        + 'by splitting it and nothing extra is swept in', s.family === 4, String(s.family));
    check('the derivation deficiency is counted on its own: 1', s.counts.NO_SUBJECT === 1, String(s.counts.NO_SUBJECT));
    check('the sweep failures are counted on their own: 3', s.counts.RUN_INCOMPLETE === 3, String(s.counts.RUN_INCOMPLETE));
    // The collapse, stated as its own assertion rather than left implied: the
    // broken code produced ONE number equal to the family size.
    check('  and neither bucket equals the family size, which is what the one '
        + 'collapsed filter reported', s.counts.NO_SUBJECT !== s.family && s.counts.RUN_INCOMPLETE !== s.family,
        `noSubject=${s.counts.NO_SUBJECT} incomplete=${s.counts.RUN_INCOMPLETE} family=${s.family}`);

    const line = sv.renderCauses(s);
    check('the rendered line names the real deficiency with its own count',
        /\b1 with no derivable subject\b/.test(line), line);
    check('  and never attributes the 3 sweep failures to a missing subject — '
        + 'the exact sentence the incident produced', !/\b[34] with no derivable subject\b/.test(line), line);
    check('  and gives the sweep failures a count of their own', /\b3\b/.test(line)
        && new RegExp('3 ' + sv.CAUSE.RUN_INCOMPLETE.say(3).replace(/^3 /, '').slice(0, 20)).test(line), line);
    check('  and says in words that they are not a finding about the suite',
        /NOT a finding about the suites?/.test(line), line);
    check('  and the sweep-failure wording says it is re-runnable', /re-runnable/.test(line), line);
    // Wording invariant, because the clause is the deliverable. "subject" inside
    // the sweep-failure phrase is how the two collapse back together in prose
    // while the counts stay apart.
    check('  and the sweep-failure wording does not mention a subject at all',
        !/subject/i.test(sv.CAUSE.RUN_INCOMPLETE.say(3)), sv.CAUSE.RUN_INCOMPLETE.say(3));
    check('the two causes disagree about whether the reader should change the repo',
        sv.CAUSE.NO_SUBJECT.aboutTheSuite === true && sv.CAUSE.RUN_INCOMPLETE.aboutTheSuite === false);
}

// --- a cause nobody declared must SURFACE, not join a neighbour ---------------
{
    const s = sv.summarise([
        { suite: 'c.js', status: 'UNCHECKED', cause: sv.CAUSE.NO_SUBJECT },
        { suite: 'x.js', status: 'UNCHECKED' },
        { suite: 'y.js', status: 'UNCHECKED', cause: { key: 'INVENTED' } },
    ]);
    check('an UNCHECKED row with no cause is counted apart', s.counts.UNCATEGORISED === 2,
        String(s.counts.UNCATEGORISED));
    check('  and does not inflate the derivation count', s.counts.NO_SUBJECT === 1, String(s.counts.NO_SUBJECT));
    check('  and is named as a defect in the SWEEP rather than in the suite',
        /defect in the SWEEP/.test(sv.renderCauses(s)), sv.renderCauses(s));
}

// --- empty and verdict-only sets say nothing rather than something -----------
{
    check('a clean sweep renders no parenthetical at all', sv.renderCauses(sv.summarise([
        { suite: 'a.js', status: 'ok' }, { suite: 'g.js', status: 'VACUOUS' },
    ])) === '');
    check('  and VACUOUS/RED stay out of the family, being verdicts about the suite',
        sv.summarise([{ suite: 'g.js', status: 'VACUOUS' }, { suite: 'r.js', status: 'RED' }]).family === 0);
    check('summarise tolerates being handed nothing', sv.summarise().total === 0 && sv.summarise(null).family === 0);
}

// --- the CLI contract, which only a subprocess sees --------------------------
{
    const st = spawnSync(process.execPath, [SUBJECT, '--selftest'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const m = /population: (\d+) assertions run, (\d+) passed, (\d+) failed/.exec(st.stdout || '');
    // Exit 0 alone proves nothing: stubbed with `module.exports = {}` this file
    // has no CLI, so --selftest exits 0 having asserted nothing.
    check("the module's own --selftest is RUN here and actually asserts something",
        st.status === 0 && /^PASS /m.test(st.stdout || ''), `status=${st.status} signal=${st.signal}`);
    check('  and reports the population it ran', !!m && m[3] === '0', JSON.stringify((st.stdout || '').slice(-160)));
    const h = spawnSync(process.execPath, [SUBJECT, '--help'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    check('--help RETURNS rather than doing anything, which check-entrypoints requires '
        + 'of every tooling/*.js', h.status === 0 && /usage:/.test(h.stdout || ''), `status=${h.status}`);
}

// --- the producers in the sweep, read statically -----------------------------
// The runtime half above cannot see a producer added tomorrow with no cause on
// it. This half can: every UNCHECKED/NO-SUBJECT object literal in the sweep must
// carry a cause, and the population is printed so a scan that found nothing is
// distinguishable from a sweep with nothing to find.
{
    const src = fs.readFileSync(SWEEP, 'utf8');
    const re = /status: '(UNCHECKED|NO-SUBJECT)'/g;
    const found = [];
    let m;
    while ((m = re.exec(src))) {
        // Walk back to the enclosing object's `{`, then forward to its match.
        // Producers are `{ suite, status: 'X', cause, note }` — no brace between
        // the opener and `status:` — and brace counting forward is safe because
        // the `${}` of a template note is balanced.
        const open = src.lastIndexOf('{', m.index);
        let depth = 0, end = open;
        for (let i = open; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } }
        }
        const literal = src.slice(open, end + 1);
        found.push({
            status: m[1],
            line: src.slice(0, m.index).split('\n').length,
            cause: (/\bcause: sv\.CAUSE\.([A-Z_]+)/.exec(literal) || [])[1] || null,
        });
    }
    console.log(`  population: ${found.length} UNCHECKED/NO-SUBJECT producer(s) in check-suites-can-fail.js`);
    check('the sweep still has the several producers this split exists for',
        found.length >= 8, String(found.length));
    const uncaused = found.filter((f) => !f.cause);
    check('  and every one of them carries a cause, so none can be mislabelled by default',
        uncaused.length === 0, uncaused.map((f) => `line ${f.line}`).join(', '));
    const kinds = new Set(found.map((f) => f.cause));
    check('  and they do NOT all carry the same cause, which is the collapse this fixes',
        kinds.size >= 2, [...kinds].join(', '));
    check('  with at least one real deficiency among them', kinds.has('NO_SUBJECT'), [...kinds].join(', '));
    check('  and at least one sweep failure, so both wordings are reachable in a real run',
        kinds.has('RUN_INCOMPLETE'), [...kinds].join(', '));
    const unknown = [...kinds].filter((k) => k && !Object.prototype.hasOwnProperty.call(sv.CAUSE, k));
    check('  and every cause named in the sweep is one the module knows', unknown.length === 0, unknown.join(', '));

    // Wiring: the policy must be the one the sweep actually uses.
    check('the sweep requires the module', /require\('\.\/suite-verdict-summary\.js'\)/.test(src));
    check('  and renders its summary parenthetical through renderCauses', /sv\.renderCauses\(/.test(src));
    check('  and takes its counts from summarise', /sv\.summarise\(rows\)/.test(src));
    // The bug, as a grep. A hand-rolled filter over both statuses is the line
    // that produced one number with two meanings.
    check('  and no longer hand-rolls a filter over both unverified statuses',
        !/status === 'UNCHECKED'\s*\|\|\s*r?\.?status === 'NO-SUBJECT'/.test(src));
    // The wording has exactly one home: the module. The sweep may still NAME the
    // old label in a comment — that is the historical record of the incident, and
    // deleting it is how the lesson gets relearned — but it must not be able to
    // PRINT it. So: every line in the sweep mentioning the phrase is a comment.
    const phraseLines = src.split('\n')
        .map((l, i) => ({ l, n: i + 1 }))
        .filter(({ l }) => /with no derivable subject/.test(l));
    check("  and every mention of 'with no derivable subject' left in the sweep is a "
        + 'comment, never something it can print',
        phraseLines.length > 0 && phraseLines.every(({ l }) => l.trim().startsWith('//')),
        phraseLines.map(({ n, l }) => n + ': ' + l.trim().slice(0, 40)).join(' | ') || 'no mention at all');
}

// --- THE FOUR COLLAPSES, PLANTED AND WATCHED ---------------------------------
//
// WHY THIS EXISTS. The assertions above prove the split HOLDS.
// check-suites-can-fail.js proves this suite can fail AT ALL — it plants one
// canary and requires a red. Neither proves this suite fails in the specific
// ways the split exists to catch, and that is the claim a reader actually
// needs: a suite can be green, canary-verified, and still blind to the one
// regression it was written for.
//
// PROVENANCE, STATED PLAINLY. The mutants run when the split first landed were
// scratch copies and were NOT preserved; a live sweep receipt from that day
// survives outside this repo. These four are NOT a recovery of those. They are
// the four collapses this module can actually suffer, each read off its own
// design — four things the file says in prose that it must not do — and each is
// planted here and watched going red, rather than asserted to be caught.
//
// THE CONTROL RUNS FIRST AND IS NOT OPTIONAL. A harness whose scratch copy is
// broken (a file it forgot to carry, a bad path) reports every mutant "caught"
// while catching nothing. So the UNMUTATED copy must go green in exactly the
// same scratch directory before any mutant verdict is believed — and each
// mutant must be killed BY THE ASSERTION THAT NAMES IT, not by whatever red
// happens to appear first.
if (!process.env[CHILD]) {
    const SRC = fs.readFileSync(SUBJECT, 'utf8');
    const lines = (...l) => l.join('\n');

    // Each mutant: a source anchor that must match EXACTLY ONCE, the collapse it
    // restores, and the assertion labels that must be among the child's reds.
    const MUTANTS = [
        {
            name: 'the measured incident: one clause for the whole family',
            why: 'renderCauses totals every unverified row under the derivation wording — '
                + 'the exact line that sent a reader to fix four suites that were fine',
            from: lines('function renderCauses(sum) {',
                        '    const counts = (sum && sum.counts) || {};'),
            to: lines('function renderCauses(sum) {',
                      '    const n = (sum && sum.family) || 0;',
                      "    return n ? CAUSE.NO_SUBJECT.say(n) : '';",
                      '    // eslint-disable-next-line no-unreachable',
                      '    const counts = (sum && sum.counts) || {};'),
            kills: [/names the real deficiency with its own count/, /never attributes the 3 sweep failures/],
        },
        {
            name: 'the reassuring short phrase',
            why: "RUN_INCOMPLETE says 'N indeterminate' — which the module's own comment says "
                + 'is read as a verdict by exactly the reader this exists for',
            from: lines("        say: (n) => `${n} the sweep could not measure this run — indeterminate and `",
                        "            + `re-runnable, NOT a finding about the suite${n === 1 ? '' : 's'}`,"),
            to: "        say: (n) => `${n} indeterminate`,",
            kills: [/they are not a finding about the suite/, /re-runnable/],
        },
        {
            name: 'the uncategorised fold',
            why: 'a row whose producer set no cause joins the derivation bucket instead of '
                + 'surfacing — how a sixth producer added tomorrow becomes invisible',
            from: '        else counts[UNCATEGORISED.key]++;',
            to: '        else counts[CAUSE.NO_SUBJECT.key]++;',
            kills: [/no cause is counted apart/, /does not inflate the derivation count/],
        },
        {
            name: 'the family boundary',
            why: 'VACUOUS and RED join the unverified family, so verdicts ABOUT a suite are '
                + 'counted as things the sweep could not measure',
            from: "const UNVERIFIED_FAMILY = Object.freeze(['UNCHECKED', 'NO-SUBJECT']);",
            to: "const UNVERIFIED_FAMILY = Object.freeze(['UNCHECKED', 'NO-SUBJECT', 'VACUOUS', 'RED']);",
            kills: [/stay out of the family/, /unverified FAMILY is the 4 without a verdict/],
        },
    ];

    /**
     * Run this suite against one version of the subject, in a scratch directory.
     * Three files travel: the subject (possibly mutated), this suite, and the
     * sweep — which the static half only ever READS as text, never runs.
     */
    function runAgainst(subjectSrc) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svs-mutants-'));
        try {
            fs.writeFileSync(path.join(dir, 'suite-verdict-summary.js'), subjectSrc);
            fs.copyFileSync(__filename, path.join(dir, path.basename(__filename)));
            fs.copyFileSync(SWEEP, path.join(dir, path.basename(SWEEP)));
            const r = spawnSync(process.execPath, [path.join(dir, path.basename(__filename))], {
                encoding: 'utf8', windowsHide: true, timeout: 120000,
                env: { ...process.env, [CHILD]: '1' },
            });
            const out = (r.stdout || '') + (r.stderr || '');
            return { status: r.status, error: r.error, out, reds: out.split('\n').filter((l) => l.startsWith('FAIL')) };
        } finally {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    }

    const control = runAgainst(SRC);
    check('CONTROL: the unmutated subject is GREEN in the same scratch copy',
        control.status === 0 && control.reds.length === 0,
        control.error ? String(control.error.code || control.error.message) : control.reds.join(' | ').slice(0, 200));

    for (const m of MUTANTS) {
        const hits = SRC.split(m.from).length - 1;
        if (hits !== 1) {
            // A drifted anchor is a HARNESS defect and must never read as a kill.
            check(`mutant anchor "${m.name}" still matches the subject exactly once`, false,
                `matched ${hits} time(s) — the subject was refactored; re-point this mutant`);
            continue;
        }
        const got = runAgainst(SRC.replace(m.from, m.to));
        check(`mutant: ${m.name} — turns this suite RED`,
            got.status === 1 && got.reds.length > 0,
            got.error ? String(got.error.code || got.error.message) : `status=${got.status} reds=${got.reds.length}`);
        const missed = m.kills.filter((re) => !got.reds.some((l) => re.test(l)));
        check('  and is caught by the assertions written for it, not by an unrelated red',
            missed.length === 0, missed.length ? 'these did not go red: ' + missed.join(', ') : '');
        console.log(`        collapse restored: ${m.why}`);
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log('subject: tooling/suite-verdict-summary.js; asserted over a row set containing BOTH a '
    + 'derivation deficiency and sweep failures with different counts, so a single collapsed bucket '
    + 'cannot satisfy it, and the producers in check-suites-can-fail.js are read statically so a new '
    + 'one without a cause fails here.');
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exit(fail ? 1 : 0);
