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

// -------------------------------------------------------------------- report

const total = passed + failures.length;
if (failures.length) {
    console.error(`prd-states: ${passed}/${total} passed, ${failures.length} FAILED\n`);
    for (const f of failures) console.error('  x ' + f);
    process.exit(1);
}
console.log(`prd-states: ${passed}/${total} passed — five states, two questions, and nothing dropped on archive`);
