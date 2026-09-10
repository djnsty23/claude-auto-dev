#!/usr/bin/env node
'use strict';
/**
 * suite-verdict-summary.js — what a NOT-verified row of check-suites-can-fail.js
 * MEANS, and the words its summary line is allowed to use for it.
 *
 * WHY THIS IS A MODULE RATHER THAN TWO LINES IN THE SWEEP. `UNCHECKED` has
 * several distinct producers in that file and they do not mean the same thing.
 * One of them — `subject not derived` — is a deficiency in the suite: a reader
 * fixes it by naming the subject where derivation can read it. The rest are the
 * SWEEP failing to measure: a baseline that did not complete, a canary that
 * could not be installed, a stub run killed at the budget. Those are conflicts
 * and timeouts under fleet load. They are re-runnable, and they say nothing
 * whatever about the suite.
 *
 * `[measured 2026-09-10]` the summary counted all of them with one filter and
 * labelled the total `(N with no derivable subject)`. A sweep produced four such
 * rows, every one of them a baseline/canary timeout, every one with a subject
 * that derived perfectly well — and the line sent the reader to fix four suites
 * that had nothing wrong with them. The sweep's own comment, a few dozen lines
 * above that filter, reads:
 *
 *     A gate that skips silently and labels the skip reassuringly converts
 *     ABSENT coverage into REPORTED coverage, which is strictly worse than
 *     having no opinion.
 *
 * That is this failure, in the file written to prevent it. A reassuring label is
 * one way to mislabel a skip; a CONFIDENT WRONG label is the other, and it costs
 * more, because it does not merely fail to inform — it directs work.
 *
 * THE CAUSE IS CARRIED, NEVER SNIFFED. Every producer tags its row with a
 * `cause` from `CAUSE` below. Nothing here reads `note` text to decide what a row
 * means: this repo's whole history of hand-rolled state filters is a history of
 * collapsing one state into the one next to it, and a regex over prose is that
 * mistake with an extra failure mode. A row in the unverified family that
 * carries NO cause is counted and NAMED as such — `uncategorised` — so a sixth
 * producer added tomorrow surfaces as a defect in the SWEEP instead of being
 * folded into a neighbour.
 *
 *   node tooling/suite-verdict-summary.js --selftest
 *   node tooling/suite-verdict-summary.js --help
 */

// The statuses for which a cause is required. These are the two the sweep uses
// when it did NOT reach a verdict. VACUOUS and RED are verdicts about the suite
// and need no cause; 'ok' and NOT-JS are not deficiencies at all.
const UNVERIFIED_FAMILY = Object.freeze(['UNCHECKED', 'NO-SUBJECT']);

// Each cause carries its own wording, and the wording is the point of the split.
// `aboutTheSuite` records which side of the line it falls on: true means a reader
// should go and change something in the repo, false means re-run the sweep. A
// phrase for a false one must never read as a finding — that is the whole bug.
const CAUSE = Object.freeze({
    NO_SUBJECT: Object.freeze({
        key: 'NO_SUBJECT',
        aboutTheSuite: true,
        say: (n) => `${n} with no derivable subject`,
    }),
    EXEMPTION_REFUSED: Object.freeze({
        key: 'EXEMPTION_REFUSED',
        aboutTheSuite: true,
        say: (n) => `${n} with a REFUSED non-JavaScript exemption`,
    }),
    RUN_INCOMPLETE: Object.freeze({
        key: 'RUN_INCOMPLETE',
        aboutTheSuite: false,
        // Deliberately verbose. A short phrase here ("N indeterminate") is read
        // as a verdict by exactly the reader this exists for, and the measured
        // cost of that reading was four suites investigated for nothing.
        say: (n) => `${n} the sweep could not measure this run — indeterminate and `
            + `re-runnable, NOT a finding about the suite${n === 1 ? '' : 's'}`,
    }),
});

// Not a CAUSE: nothing produces it deliberately. It is what the summary says
// when a row in the unverified family arrives without one.
const UNCATEGORISED = Object.freeze({
    key: 'UNCATEGORISED',
    aboutTheSuite: false,
    say: (n) => `${n} with no cause recorded — a producer in the sweep set a status `
        + `without one, which is a defect in the SWEEP, not in the suite${n === 1 ? '' : 's'}`,
});

const inFamily = (row) => UNVERIFIED_FAMILY.includes(row && row.status);

/**
 * Bucket the rows of one sweep. Returns the counts the summary line needs, with
 * the unverified family split BY CAUSE and never totalled into one number.
 */
function summarise(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const counts = Object.create(null);
    for (const k of Object.keys(CAUSE)) counts[k] = 0;
    counts[UNCATEGORISED.key] = 0;

    let family = 0;
    for (const row of list) {
        if (!inFamily(row)) continue;
        family++;
        const key = row.cause && row.cause.key;
        if (key && Object.prototype.hasOwnProperty.call(CAUSE, key)) counts[key]++;
        else counts[UNCATEGORISED.key]++;
    }

    const notJs = list.filter((r) => r && r.status === 'NOT-JS').length;
    const bad = list.filter((r) => r && r.status !== 'ok' && r.status !== 'NOT-JS').length;
    return {
        total: list.length,
        notJs,
        bad,
        verified: list.length - bad - notJs,
        family,
        counts,
    };
}

/**
 * The parenthetical after "N NOT verified", one clause per cause that actually
 * occurred. Empty string when the family is empty, so the caller can omit the
 * parentheses entirely.
 */
function renderCauses(sum) {
    const counts = (sum && sum.counts) || {};
    const parts = [];
    for (const c of [...Object.values(CAUSE), UNCATEGORISED]) {
        const n = counts[c.key] || 0;
        if (n) parts.push(c.say(n));
    }
    return parts.join('; ');
}

module.exports = { CAUSE, UNCATEGORISED, UNVERIFIED_FAMILY, inFamily, summarise, renderCauses };

if (require.main === module) {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        console.log('usage: node tooling/suite-verdict-summary.js [--selftest]');
        console.log('  A module: check-suites-can-fail.js routes its summary counts through it.');
        console.log('  --selftest  assert the cause split over a mixed set of rows');
        process.exit(0);
    }
    if (!process.argv.includes('--selftest')) {
        console.log('nothing to do — this is a module. --help for usage, --selftest to check it.');
        process.exit(0);
    }
    let pass = 0, fail = 0;
    const t = (label, ok, detail) => {
        if (ok) pass++; else fail++;
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : '  (' + detail + ')'}`);
    };

    // The measured case, as a fixture: one real deficiency beside three sweep
    // failures. The counts are DIFFERENT numbers on purpose — a single bucket of
    // four cannot satisfy an assertion for 1 and an assertion for 3.
    const rows = [
        { suite: 'a.js', status: 'ok' },
        { suite: 'b.js', status: 'NOT-JS' },
        { suite: 'c.js', status: 'UNCHECKED', cause: CAUSE.NO_SUBJECT },
        { suite: 'd.js', status: 'UNCHECKED', cause: CAUSE.RUN_INCOMPLETE },
        { suite: 'e.js', status: 'UNCHECKED', cause: CAUSE.RUN_INCOMPLETE },
        { suite: 'f.js', status: 'NO-SUBJECT', cause: CAUSE.RUN_INCOMPLETE },
        { suite: 'g.js', status: 'VACUOUS' },
    ];
    const s = summarise(rows);
    t('the derivation deficiency is counted alone', s.counts.NO_SUBJECT === 1, String(s.counts.NO_SUBJECT));
    t('the sweep failures are counted alone', s.counts.RUN_INCOMPLETE === 3, String(s.counts.RUN_INCOMPLETE));
    t('and the two are never added together', s.counts.NO_SUBJECT !== s.family);
    const line = renderCauses(s);
    t('the rendered line names the deficiency count', /1 with no derivable subject/.test(line), line);
    t('  and does not describe the 3 sweep failures as a missing subject',
        !/3 with no derivable subject/.test(line), line);
    t('  and says the sweep failures are not a verdict', /NOT a finding about the suites/.test(line), line);
    t('a row with no cause is named, not absorbed', (() => {
        const u = summarise([{ suite: 'h.js', status: 'UNCHECKED' }]);
        return u.counts.UNCATEGORISED === 1 && /defect in the SWEEP/.test(renderCauses(u));
    })());
    t('verdict rows stay out of the family', summarise([{ suite: 'i.js', status: 'VACUOUS' }]).family === 0);
    console.log(`\npopulation: ${pass + fail} assertions run, ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
}
