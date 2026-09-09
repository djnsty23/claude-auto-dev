#!/usr/bin/env node
'use strict';
// Suite for prd-states.js — the one reader of prd.json's `passes` field.
//
// The case it exists for: `needs-setup`. [measured 2026-08-28] auto/SKILL.md
// instructs sessions to write it for work blocked on an API key or a console
// nobody has opened, and NOTHING ELSE IN THE PLUGIN KNEW THE STATE EXISTED. Five
// readers each guessed differently — one re-attempted it forever, one hid it from
// the count, one DELETED it on archive, and the Stop hook counted it as pending
// and so could not end a turn.
//
// The distinction the whole file turns on: "remaining work" is two questions, not
// one. Can an agent pick it up? Is a human still on the hook? `needs-setup`
// answers no to the first and yes to the second, and every bug came from a reader
// that had only one predicate.
//
// Run: node tooling/test-prd-states.js

const path = require('path');
const S = require(path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'prd-states.js'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail !== undefined ? '\n      -> ' + JSON.stringify(detail) : ''));
}

const st = (p) => ({ passes: p });

// ---------------------------------------------------- the two questions

// An agent can pick these up right now.
check('actionable: pending (null)', S.isActionable(st(null)), S.isActionable(st(null)));
check('actionable: failed (false)', S.isActionable(st(false)));
check('NOT actionable: done', !S.isActionable(st(true)));
check('NOT actionable: deferred', !S.isActionable(st('deferred')));
// THE ONE THAT CAUSED THE BUG. An agent cannot conjure a credential; selecting it
// is how a blocked story burns a turn on every run, forever.
check('NOT actionable: needs-setup', !S.isActionable(st('needs-setup')),
    S.isActionable(st('needs-setup')));

// A human is still on the hook for these.
check('outstanding: pending', S.isOutstanding(st(null)));
check('outstanding: failed', S.isOutstanding(st(false)));
// THE OTHER HALF. Omitting it here tells the operator a sprint is finished when
// it is waiting on him.
check('outstanding: needs-setup', S.isOutstanding(st('needs-setup')),
    S.isOutstanding(st('needs-setup')));
check('NOT outstanding: done', !S.isOutstanding(st(true)));
check('NOT outstanding: deferred', !S.isOutstanding(st('deferred')));

// The two predicates must actually DIFFER on needs-setup, or the split is
// decorative and the bug comes straight back.
check('the two predicates disagree on needs-setup exactly',
    S.isActionable(st('needs-setup')) === false && S.isOutstanding(st('needs-setup')) === true);
// ...and agree everywhere else, or callers cannot reason about which to use.
for (const p of [null, false, true, 'deferred']) {
    check(`actionable and outstanding agree on ${JSON.stringify(p)}`,
        S.isActionable(st(p)) === S.isOutstanding(st(p)));
}

// A story with NO passes key is pending work, not invisible. [measured
// 2026-08-28] upstream's selector dropped undefined, so a keyless story was
// selected by nothing and counted by nothing — gone rather than late.
check('actionable: missing passes key', S.isActionable({}));
check('outstanding: missing passes key', S.isOutstanding({}));

// ------------------------------------------------------------- archiving

check('archivable: done', S.isArchivable(st(true)));
check('NOT archivable: pending', !S.isArchivable(st(null)));
check('NOT archivable: failed', !S.isArchivable(st(false)));
check('NOT archivable: deferred', !S.isArchivable(st('deferred')));
// auto's archive keep-list was null/false/deferred, so this state was DELETED —
// losing the record of what the operator still owed.
check('NOT archivable: needs-setup', !S.isArchivable(st('needs-setup')),
    S.isArchivable(st('needs-setup')));
// An unrecognised value is kept, never dropped. This runs against files written
// by later schema versions, and deleting what you do not understand is the one
// irreversible outcome available here.
check('NOT archivable: an unrecognised state is KEPT', !S.isArchivable(st('some-future-state')));

// ------------------------------------------------------------ the summary

{
    const stories = {
        a: st(true), b: st(true), c: st(null), d: st(false),
        e: st('deferred'), f: st('needs-setup'), g: st('needs-setup'),
    };
    const c = S.summarise(stories);
    check('summarise counts done', c.done === 2, c);
    check('summarise counts pending', c.pending === 1, c);
    check('summarise counts failed', c.failed === 1, c);
    check('summarise counts deferred', c.deferred === 1, c);
    // It was invisible in auto's status line; the whole point is that it shows.
    check('summarise counts needs-setup separately', c.needsSetup === 2, c);
    check('summarise total covers every story', c.total === 7, c);
    check('actionable excludes needs-setup and deferred', c.actionable === 2, c);
    check('outstanding includes needs-setup but not deferred', c.outstanding === 4, c);
    // Every story lands in exactly one bucket, so nothing can go missing between
    // them — the failure mode that hid this state in the first place.
    check('the buckets sum to the total',
        c.done + c.pending + c.failed + c.deferred + c.needsSetup + c.unrecognised === c.total, c);
}

{
    // An unknown value is COUNTED and NAMED, not folded into a neighbour. Silently
    // bucketing it is exactly how needs-setup stayed invisible.
    const c = S.summarise([st('who-knows'), st(true)]);
    check('an unrecognised state is counted', c.unrecognised === 1, c);
    check('and not folded into pending', c.pending === 0, c);
    check('and not folded into done', c.done === 1, c);
}

{
    // A missing `passes` key reads as pending — that is what an absent field means
    // in this schema, and treating it as unrecognised would cry wolf on every
    // freshly written story.
    const c = S.summarise([{}]);
    check('a story with no passes key counts as pending', c.pending === 1, c);
}

{
    const c = S.summarise([]);
    check('an empty sprint summarises to zeros without throwing', c.total === 0, c);
}

check('VALID lists all five states', S.VALID.length === 5, S.VALID);
check('and includes needs-setup', S.VALID.includes('needs-setup'), S.VALID);

// ------------------------------------------------------- the CONTAINER, storiesOf
//
// The second per-reader guess in this file's subject, and the same defect as
// `passes` one level up. prd.json has two shapes — flat `{ stories }` and nested
// `{ sprints: [{ stories }] }` — and six readers each decided privately, so a
// reader could be wrong alone without disagreeing with anything.
//
// [measured 2026-08-29] against a nested file the Stop hook counted ZERO stories,
// printed "Sprint complete" over a full sprint and approved the stop on the next
// turn, deleting .claude/auto-active with every story still pending.
//
// The assertions below are UNIT assertions about the helper. The separate
// question — whether all six readers agree on one nested fixture — is a
// cross-reader test written by a different session on purpose: a test written by
// whoever wrote the fix agrees with the fix rather than with reality.

{
    const flat = { stories: { 'S1-001': st(null) } };
    check('a flat file still reads', Object.keys(S.storiesOf(flat)).length === 1);

    const nested = { sprints: [{ id: 1, stories: { 'S1-001': st(null), 'S1-002': st(true) } }] };
    check('a nested file reads its sprint', Object.keys(S.storiesOf(nested)).length === 2);
    check('...and the nested stories are the real objects, not a shape-alike',
        S.storiesOf(nested)['S1-002'].passes === true);
}

{
    // THE DECISION, asserted. Taking the newest sprint only — which
    // check-spec-output.js and core/SKILL.md both did — makes a story still
    // pending in sprint 1 invisible, so the Stop hook counts zero outstanding and
    // approves the stop exactly as it did on the nested shape. The same silent
    // approval, wearing a narrower trigger. Mutating storiesOf() back to
    // `sprints[sprints.length - 1]` turns both of these red.
    const multi = {
        sprints: [
            { id: 1, stories: { 'S1-001': st(null), 'S1-002': st(true) } },
            { id: 2, stories: { 'S2-001': st(true) } },
        ],
    };
    const all = S.storiesOf(multi);
    check('every sprint contributes, not just the newest',
        Object.keys(all).sort().join(',') === 'S1-001,S1-002,S2-001', Object.keys(all));
    check('so work pending in an EARLIER sprint is still counted outstanding',
        S.summarise(all).actionable === 1, S.summarise(all));
}

{
    // Defined rather than left to Object.assign ordering, so that if ids ever do
    // collide across sprints the result is a rule somebody chose.
    const dup = {
        sprints: [
            { id: 1, stories: { 'S1-001': { title: 'first', passes: null } } },
            { id: 2, stories: { 'S1-001': { title: 'carried forward', passes: true } } },
        ],
    };
    check('on a repeated id the LATER sprint wins',
        S.storiesOf(dup)['S1-001'].title === 'carried forward', S.storiesOf(dup));
}

{
    // An existing sprint with no stories has no work in it. Falling through to
    // the root here would resurrect a previous sprint's backlog as current.
    const emptySprint = { stories: { 'OLD-1': st(null) }, sprints: [{ id: 2, stories: {} }] };
    check('an empty newest sprint does NOT fall through to root stories',
        Object.keys(S.storiesOf(emptySprint)).length === 0, S.storiesOf(emptySprint));

    // ...but a sprint that never declared stories at all is a purely flat file.
    const noKey = { stories: { 'OLD-1': st(null) }, sprints: [{ id: 2 }] };
    check('a sprint with no stories key DOES fall through to root',
        Object.keys(S.storiesOf(noKey)).length === 1, S.storiesOf(noKey));
}

{
    // Always an object, so no caller needs its own `|| {}` — the guard whose
    // absence is how one of these reads went wrong in the first place.
    for (const junk of [null, undefined, 42, 'nope', [], { sprints: 'not-an-array' }, { stories: null }]) {
        check('storiesOf(' + JSON.stringify(junk) + ') returns an empty object rather than throwing',
            JSON.stringify(S.storiesOf(junk)) === '{}');
    }
}

// -------------------------------------------------------------------- report

const total = passed + failures.length;
if (failures.length) {
    console.error(`prd-states: ${passed}/${total} passed, ${failures.length} FAILED\n`);
    for (const f of failures) console.error('  x ' + f);
    process.exit(1);
}
console.log(`prd-states: ${passed}/${total} passed — five states, two questions, and nothing dropped on archive`);
