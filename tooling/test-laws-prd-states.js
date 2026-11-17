#!/usr/bin/env node
'use strict';
// LAWS for prd-states.js: statements over EVERY input in a finite space, not
// examples. tooling/test-prd-states.js pins named cases; this file enumerates.
//
// Why a separate file. A law is a statement about the schema, and the schema is
// the `passes` table in CLAUDE.md. Its expectations below are written out by
// hand from that table and import NOTHING from the subject (no VALID, no
// constants, no predicates), so an edit that weakens prd-states.js cannot also
// weaken the oracle in the same motion. Changing a law means changing the
// table first, and a diff to this file is a diff to the schema's contract.
//
// The space. Every story set of length 0..MAX_LEN drawn, with order and
// repetition, from ALPHABET: the five table values, the absent key, and a set of
// unrecognised values chosen to break loose equality and truthiness (1, 0, '',
// 'true', 'false', 'null', near-miss spellings, an array, an object, NaN).
// The count is pinned to a literal, so shrinking the alphabet goes red.
//
// Scope, stated so it is not mistaken for coverage. Every story here is a
// well-formed object with no `blockedBy`. Dependency graphs and the sprint
// container are covered by test-prd-states.js and the prd-container suites.
// A NON-OBJECT entry (null, false) is out of scope on purpose: summarise() reads
// `s && s.passes` and counts a null entry as pending while isOutstanding(null)
// is false. That disagreement is a finding to settle in prd-states.js, not a
// law to encode here.
//
// Run: node tooling/test-laws-prd-states.js

const path = require('path');
const S = require(path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'prd-states.js'));

// ------------------------------------------------ the oracle, from CLAUDE.md
//
// | value         | remaining work? | an agent can act on it? |
// | null          | yes, pending    | yes                     |
// | true          | no, done        | n/a                     |
// | false         | yes, failed     | yes, retry              |
// | "deferred"    | no              | no                      |
// | "needs-setup" | yes             | no                      |
//
// ABSENT (no `passes` key) reading as pending is NOT in the table. It is the
// contract documented in prd-states.js isActionable() and pinned by
// test-prd-states.js ("a story with no passes key counts as pending"), so it is
// encoded here as that contract and named as such.
const ABSENT = Symbol('absent passes key');
const KNOWN = [
    { value: null, bucket: 'pending', remaining: true, actionable: true, done: false },
    { value: true, bucket: 'done', remaining: false, actionable: false, done: true },
    { value: false, bucket: 'failed', remaining: true, actionable: true, done: false },
    { value: 'deferred', bucket: 'deferred', remaining: false, actionable: false, done: false },
    { value: 'needs-setup', bucket: 'needsSetup', remaining: true, actionable: false, done: false },
    { value: ABSENT, bucket: 'pending', remaining: true, actionable: true, done: false },
];
// Unrecognised: counted in `unrecognised`, never done, never acted on, and never
// lets a sprint read as complete. Whether a human still owes it is not settled
// by the table, so no law here asserts `remaining` for these.
const UNRECOGNISED = [1, 0, '', 'true', 'false', 'null', 'done', 'pending',
    'Deferred', 'needs_setup', 'needs-setup ', [], {}, NaN];
const ALPHABET = [
    ...KNOWN,
    ...UNRECOGNISED.map((value) => ({ value, bucket: 'unrecognised', remaining: null, actionable: false, done: false })),
];
const BUCKETS = ['done', 'pending', 'failed', 'deferred', 'needsSetup', 'unrecognised'];
const MAX_LEN = 3;
// 20 letters: 1 + 20 + 400 + 8000 sequences. A literal, not a formula over
// ALPHABET, so dropping a letter fails the floor instead of shrinking it.
const EXPECTED_POPULATION = 8421;
const EXPECTED_ALPHABET = 20;

const show = (v) => v === ABSENT ? '<absent>' : Number.isNaN(v) ? 'NaN' : JSON.stringify(v);
const story = (letter) => letter.value === ABSENT ? {} : { passes: letter.value };

// --------------------------------------------------------------- the laws

const laws = new Map();
function law(name) {
    if (!laws.has(name)) laws.set(name, { held: 0, broken: 0, first: null });
    return laws.get(name);
}
function check(name, cond, counterexample) {
    const l = law(name);
    if (cond) { l.held++; return; }
    l.broken++;
    if (!l.first) l.first = counterexample();
}

function* sequences(len) {
    if (len === 0) { yield []; return; }
    for (const head of sequences(len - 1)) for (const letter of ALPHABET) yield [...head, letter];
}

let population = 0;
const lettersSeen = new Set();
for (let len = 0; len <= MAX_LEN; len++) {
    for (const seq of sequences(len)) {
        population++;
        seq.forEach((l) => lettersSeen.add(l));
        const tag = () => '[' + seq.map((l) => show(l.value)).join(', ') + ']';
        const ids = seq.map((_, i) => `S${i}`);
        const stories = Object.fromEntries(seq.map((l, i) => [ids[i], story(l)]));
        const c = S.summarise(stories);
        const cArr = S.summarise(seq.map(story));

        // L1 every story lands in exactly one bucket: each bucket's count equals
        // the number of stories the TABLE puts there.
        for (const b of BUCKETS) {
            const want = seq.filter((l) => l.bucket === b).length;
            check(`L1 each story lands in the bucket the table names (${b})`, c[b] === want,
                () => `${tag()} ${b}=${c[b]}, table says ${want}`);
        }
        // L2 the buckets sum to the story count.
        const sum = BUCKETS.reduce((n, b) => n + c[b], 0);
        check('L2 the buckets sum to the story count', sum === seq.length && c.total === seq.length,
            () => `${tag()} sum=${sum} total=${c.total} stories=${seq.length}`);
        // L3 the container shape (object vs array) never changes a count.
        check('L3 an array and an object of the same stories summarise alike',
            JSON.stringify(c) === JSON.stringify(cArr), () => `${tag()} ${JSON.stringify(c)} vs ${JSON.stringify(cArr)}`);
        // L4 actionable counts exactly the stories the table says an agent can act on.
        const wantAct = seq.filter((l) => l.actionable).length;
        check('L4 actionable counts exactly what an agent can act on', c.actionable === wantAct,
            () => `${tag()} actionable=${c.actionable}, table says ${wantAct}`);
        // L5 outstanding counts exactly the known remaining work, plus nothing
        // from deferred and nothing from done.
        const wantOut = seq.filter((l) => l.remaining === true).length;
        const unknown = seq.filter((l) => l.remaining === null).length;
        check('L5 outstanding counts the remaining work and never deferred or done',
            c.outstanding >= wantOut && c.outstanding <= wantOut + unknown,
            () => `${tag()} outstanding=${c.outstanding}, table says ${wantOut} (+${unknown} unsettled)`);

        const plan = S.workPlan({ stories });
        const ready = new Set(plan.ready.map(([id]) => id));
        const blocked = new Set(plan.blocked.map((b) => b.id));
        const invalid = new Set(plan.invalid.map((b) => b.id));
        seq.forEach((l, i) => {
            const id = ids[i];
            const where = () => `${tag()} ${id}=${show(l.value)} ready=${ready.has(id)} blocked=${blocked.has(id)} invalid=${invalid.has(id)}`;
            // L6 per-story: the predicates agree with the table.
            const s = story(l);
            check('L6 isActionable agrees with the table', S.isActionable(s) === l.actionable, where);
            if (l.remaining !== null) check('L6 isOutstanding agrees with the table', S.isOutstanding(s) === l.remaining, where);
            check('L6 isDone and isArchivable only for done', S.isDone(s) === l.done && S.isArchivable(s) === l.done, where);
            // L7 deferred is never remaining work, in any reader.
            if (l.value === 'deferred') {
                check('L7 deferred is never remaining work',
                    !S.isActionable(s) && !S.isOutstanding(s) && !ready.has(id) && !blocked.has(id) && !invalid.has(id), where);
            }
            // L8 needs-setup is remaining but never actionable: blocked, never ready.
            if (l.value === 'needs-setup') {
                check('L8 needs-setup is remaining but never actionable',
                    S.isOutstanding(s) && !S.isActionable(s) && blocked.has(id) && !ready.has(id), where);
            }
            // L9 an unrecognised value is never done and never picked up: the plan
            // names it invalid.
            if (l.bucket === 'unrecognised') {
                check('L9 an unrecognised value is never done and never picked up',
                    !S.isDone(s) && !S.isArchivable(s) && !ready.has(id) && invalid.has(id), where);
            }
            // L10 the plan partitions: ready is exactly the actionable stories (no
            // dependencies in this space), and no story sits in two lists.
            const lists = [ready.has(id), blocked.has(id), invalid.has(id)].filter(Boolean).length;
            check('L10 ready is exactly the actionable stories, and no story is in two lists',
                ready.has(id) === l.actionable && lists <= 1, where);
        });
        // L11 complete only when non-empty and every story is done or deferred.
        const wantComplete = seq.length > 0 && seq.every((l) => l.value === true || l.value === 'deferred');
        check('L11 complete only when non-empty and every story is done or deferred',
            plan.complete === wantComplete, () => `${tag()} complete=${plan.complete}, table says ${wantComplete}`);
    }
}

// ------------------------------------------------------------------ report

const floorOk = population === EXPECTED_POPULATION && ALPHABET.length === EXPECTED_ALPHABET
    && lettersSeen.size === EXPECTED_ALPHABET;
const broken = [...laws].filter(([, l]) => l.broken);
const evaluations = [...laws.values()].reduce((n, l) => n + l.held + l.broken, 0);
console.log(`prd-states laws: ${population} story sets of length 0..${MAX_LEN} over ${ALPHABET.length} values `
    + `(${KNOWN.length} known incl. absent, ${UNRECOGNISED.length} unrecognised), ${laws.size} laws, ${evaluations} evaluations`);
if (!floorOk) {
    console.error(`POPULATION FLOOR: enumerated ${population} sets over ${lettersSeen.size} values, `
        + `expected ${EXPECTED_POPULATION} over ${EXPECTED_ALPHABET}`);
}
for (const [name, l] of broken) console.error(`  x ${name}: broken in ${l.broken} of ${l.held + l.broken}, first ${l.first}`);
if (broken.length || !floorOk) {
    console.error(`prd-states laws: ${broken.length} of ${laws.size} laws broken${floorOk ? '' : ', population floor missed'}`);
    process.exitCode = 1;
} else {
    console.log(`prd-states laws: all ${laws.size} laws hold over every enumerated set`);
}
