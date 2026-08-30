#!/usr/bin/env node
/**
 * test-archive-keeplist-prose — the archive KEEP enumeration must name every
 * state the helper refuses to archive, and it is DERIVED from the helper rather
 * than restated here.
 *
 * WHY THIS EXISTS, AND WHY THE EXISTING COVERAGE DOES NOT ALREADY DO IT.
 *
 * `needs-setup` is well covered as a PREDICATE. test-prd-states.js:77 asserts
 * `!isArchivable(needs-setup)`, test-archive-prd.js asserts it lands in the keep
 * bucket, that the old two-bucket split would have lost it, and that SKILL.md
 * still names `isArchivable()` with PROVE ordered before CREATE. Planting the
 * historical mutant — `isArchivable = isDone(s) || needsSetup(s)` — is KILLED by
 * both suites. That part of the keep-list is not the hole.
 *
 * The hole is that archiving is not a script. It is PROSE an agent follows, and
 * the prose carries its own enumeration beside the helper's name:
 *
 *     - ARCHIVE: isArchivable(story) === true  (passes===true, i.e. isDone)
 *     - KEEP:    everything else — null, false, "deferred", "needs-setup",
 *                a MISSING passes key, any unrecognised value, and type="qa"
 *
 * An agent reading step 2 acts on that ENUMERATION. It can drift from the helper
 * while every existing check still passes. [measured 2026-08-29] deleting
 * `"needs-setup"` from the KEEP line leaves `isArchivable()` still named, the
 * banned two-bucket prose still absent, and PROVE still before CREATE — and
 * test-prd-states, test-archive-prd and test-skill-prd-commands ALL STAY GREEN.
 * That edit is one word, it reads as tidying, and it restores precisely the
 * condition of the original incident: a state missing from the keep-list, whose
 * stories were then written to neither file and silently deleted. What was lost
 * was the record of work waiting on the OPERATOR — the worst thing to lose,
 * because nobody knows to go looking for it.
 *
 * So the property here is not "needs-setup is in the doc" — hardcoding that
 * would leave the SIXTH state exactly as exposed as needs-setup was as the
 * fifth. It is:
 *
 *     for every state the helper will not archive, the prose names it
 *
 * derived from prd-states.VALID and isArchivable(), so a state added to the
 * schema and not documented fails here on the day it is added.
 *
 * Run: node tooling/test-archive-keeplist-prose.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.env.AUTODEV_ROOT || path.resolve(__dirname, '..');
const SKILL = path.join(ROOT, 'plugins/autodev-core/skills/archive-prd/SKILL.md');
const STATES = path.join(ROOT, 'plugins/autodev-core/scripts/prd-states.js');

const { VALID, isArchivable } = require(STATES);

let failures = 0;
const check = (name, ok, detail) => {
    if (ok) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? '\n      ' + detail : ''}`);
};

// --------------------------------------------------------------- the clause

// Everything from the KEEP marker to the next numbered step. Taking only the
// marker's own LINE would miss half the enumeration: it wraps, and the keyless
// and unrecognised cases live on the continuation line.
function keepClause(md) {
    const start = md.indexOf('- KEEP:');
    if (start === -1) return null;
    const rest = md.slice(start);
    const end = rest.search(/\n\s*\d+\.\s/);
    return end === -1 ? rest : rest.slice(0, end);
}

const md = fs.readFileSync(SKILL, 'utf8');
const clause = keepClause(md);

// A missing clause must FAIL, never pass. Every check below asks "is this named
// in the clause", and against a null clause the answer is no for everything —
// which a careless reading turns into "nothing to report". The whole family of
// bugs this file belongs to is a reader that cannot tell "none" from "none in
// the part I looked at".
check('the KEEP clause is present and locatable in SKILL.md', clause !== null,
    'no "- KEEP:" marker found — every check below would be vacuous');
if (clause === null) { console.error(`\n${failures} failure(s)`); process.exit(1); }

// --------------------------------------------------------- state -> wording

// How each state is expected to appear. Only the SEARCH TERM is written here;
// which states must be present is derived, never listed.
const TERM = {
    null: 'null',
    false: 'false',
    deferred: '"deferred"',
    'needs-setup': '"needs-setup"',
};
const named = (term) => clause.includes(term);

// ------------------------------------------------------------------- checks

// THE LOAD-BEARING ONE. Derived from VALID + isArchivable, so it covers a state
// that does not exist yet.
{
    const mustBeNamed = VALID.filter((v) => !isArchivable({ passes: v }));
    check('the derivation found states to check (VALID is not empty)',
        mustBeNamed.length > 0, `VALID=${JSON.stringify(VALID)}`);

    for (const v of mustBeNamed) {
        const key = String(v);
        const term = TERM[key];
        // A state with no wording defined here is NOT skipped. Unknown means
        // undocumented until proven otherwise — the same rule prd-states.js
        // applies to an unrecognised `passes` value.
        if (term === undefined) {
            check(`KEEP names the non-archivable state ${JSON.stringify(v)}`, false,
                `no expected wording is defined for ${JSON.stringify(v)} — it was added to `
                + 'VALID without being documented in the KEEP enumeration, or this test '
                + 'needs a term for it. Either way the prose an agent follows does not '
                + 'mention a state the helper refuses to archive.');
            continue;
        }
        check(`KEEP names the non-archivable state ${JSON.stringify(v)}`, named(term),
            `the prose an agent follows omits ${term}; isArchivable() keeps it, so the two disagree`);
    }
}

// The two non-VALID classes. They are not in VALID because they are not values
// anyone writes on purpose, but isArchivable refuses both and losing them is the
// same data loss.
check('KEEP names the MISSING-passes-key case',
    /MISSING passes key/i.test(clause) || /keyless/i.test(clause),
    'a story authored with no passes key is pending, not absent');
check('KEEP names the unrecognised-value case',
    /unrecognis|unrecogniz|unknown value|any other value/i.test(clause),
    'an unrecognised value must be KEPT — deleting what you do not understand is '
    + 'the one irreversible outcome here');

// Guard against the enumeration being technically present but emptied out.
check('the KEEP clause is substantive, not a stub',
    clause.replace(/\s+/g, ' ').length > 40, JSON.stringify(clause));

// And the direction that must NOT hold: the archivable state must not appear in
// the keep enumeration, or the two buckets overlap and the prose contradicts
// itself. `true` is checked as a word so "everything else" cannot match it.
check('KEEP does not also claim the archivable state',
    !/\btrue\b/.test(clause),
    'passes===true appears in the KEEP clause — the buckets overlap');

if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log('\nkeep-list prose matches the helper — every non-archivable state is named');
