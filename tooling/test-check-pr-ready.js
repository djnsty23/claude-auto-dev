'use strict';
// Suite for plugins/autodev-core/scripts/check-pr-ready.js.
//
// The subject exists because four traps each produced a WRONG verdict from a
// hand-rolled jq expression on 2026-09-05. Every case below plants one of those
// four and asserts the verdict, so a regression reproduces the original failure
// rather than merely changing a number.
//
// The rollup shapes here are the real ones observed on live PRs that day,
// including the unnamed all-null entry that appears on every PR in every repo.

const path = require('path');
const { present } = require(path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-pr-ready.js'));

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail ? '  (' + detail + ')' : '')); }
}

// ---- trap 1 and 2: an empty string is not a missing value ------------------
//
// jq's `//` falls through on null and false but NOT on "". An in-progress check
// reports conclusion "". A filter written to catch unfinished checks therefore
// matched nothing and a run was declared TERMINAL while everything was running;
// the inverse filter counted the same "" as four FAILURES. Both happened.
check('an empty string is not a value', present('') === false);
check('a whitespace-only string is not a value', present('   ') === false);
check('null is not a value', present(null) === false);
check('undefined is not a value', present(undefined) === false);
check('"SUCCESS" is a value', present('SUCCESS') === true);
check('"FAILURE" is a value', present('FAILURE') === true);
// The one place present() must NOT copy jq: zero is a real value.
check('0 is a value, where jq // would discard it', present(0) === true);
check('false is a value here, where jq // would discard it', present(false) === true);

// ---- the classification sets, read out of the subject ----------------------
//
// Read from the source rather than restated, so the test cannot drift from the
// thing it grades. A hard-coded copy would keep passing against a subject whose
// sets had changed, which is the normaliser-in-two-files defect this repo
// already carries as a bug class.
const fs = require('fs');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-pr-ready.js'), 'utf8');

function setFrom(name) {
    const m = SRC.match(new RegExp('const ' + name + " = new Set\\(\\[([^\\]]*)\\]"));
    if (!m) return null;
    return new Set(m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
}
const GOOD = setFrom('TERMINAL_GOOD');
const BAD = setFrom('TERMINAL_BAD');
const NOT_EV = setFrom('NOT_EVIDENCE');

check('the suite can read TERMINAL_GOOD out of the subject', !!GOOD,
    'without this every case below is vacuous');
check('the suite can read TERMINAL_BAD out of the subject', !!BAD);
check('the suite can read NOT_EVIDENCE out of the subject', !!NOT_EV);

if (GOOD && BAD && NOT_EV) {
    // ---- trap 3: a SKIPPED check is not a passing check --------------------
    //
    // A draft PR whose gate carries `draft == false` reports SKIPPED, and the
    // rollup then looks untroubled while carrying no evidence. Measured: a draft
    // sat MERGEABLE/CLEAN with its main gate never run, and separately one sat
    // fourteen hours that way and FAILED when finally forced to run.
    check('SKIPPED is classified as not-evidence', NOT_EV.has('SKIPPED'));
    check('SKIPPED is NOT counted as good', !GOOD.has('SKIPPED'));
    check('SKIPPED is NOT counted as bad either, it is absence', !BAD.has('SKIPPED'));

    // ---- the terminal vocabularies ----------------------------------------
    check('SUCCESS is terminal-good', GOOD.has('SUCCESS'));
    check('FAILURE is terminal-bad', BAD.has('FAILURE'));
    check('CANCELLED is terminal-bad, not unknown', BAD.has('CANCELLED'));
    check('TIMED_OUT is terminal-bad', BAD.has('TIMED_OUT'));
    // STARTUP_FAILURE renders as an ordinary red X in the UI and means the
    // workflow never compiled, so no job ran. Three PRs once merged through an
    // outage because it was read as a normal failure.
    check('STARTUP_FAILURE is terminal-bad and named explicitly', BAD.has('STARTUP_FAILURE'));

    // ---- the unknown-state rule -------------------------------------------
    //
    // A planted negative must be impossible by construction rather than merely
    // absent from a list someone typed, so this one is derived: take a real
    // conclusion and mutate it until it cannot collide with any vocabulary.
    const real = [...GOOD][0];
    let invented = real + '_NOT_A_REAL_CONCLUSION';
    while (GOOD.has(invented) || BAD.has(invented) || NOT_EV.has(invented)) invented += 'X';
    check('an invented conclusion lands in NO vocabulary, so it counts as unrecognised',
        !GOOD.has(invented) && !BAD.has(invented) && !NOT_EV.has(invented), invented);

    // ---- trap 4: the rollup artifact --------------------------------------
    //
    // Every PR in every repo checked carries one entry with null name, null
    // status and null conclusion. Counting it as unknown makes every PR
    // permanently unmergeable; ignoring anything unnamed would hide real
    // checks, so the subject requires ALL THREE to be absent.
    check('the artifact rule requires all three fields absent, not just the name',
        /name === null && status === null && concl === null/.test(SRC),
        'a name-only test would swallow a real check reporting an unnamed context');
}

// ---- the fail-safe direction ----------------------------------------------
//
// The whole point: anything unclassifiable is NOT ready. This asserts the
// subject says so in its own control flow rather than trusting the comment.
check('unrecognised conclusions increment the unknown bucket',
    /unknown\+\+/.test(SRC));
check('unknown checks are named as a reason for not-ready',
    /unrecognised.*not-ready|counted as not-ready/.test(SRC));
check('a DRAFT is refused regardless of what its rollup says',
    /isDraft\)\s*reasons\.push/.test(SRC.replace(/\s+/g, ' ')));
check('an EMPTY rollup is refused, since it looks identical to a clean one',
    /rollup\.length === 0/.test(SRC));
check('every-check-skipped is refused even with no failures',
    /good === 0 && skipped > 0/.test(SRC));

// ---- PENDING is pending, not unknown -----------------------------------------
//
// Legacy commit statuses (Vercel and most bots) carry `state: PENDING` while
// running. `[measured 2026-09-05]` on a live PR that read as UNRECOGNISED: the
// safe direction, but the wrong kind, since pending is a state the script
// knows and waits on rather than one it has never heard of.
const RUNNING = setFrom('STILL_RUNNING');
check('the suite can read STILL_RUNNING out of the subject', !!RUNNING);
if (RUNNING && GOOD && BAD && NOT_EV) {
    check('PENDING is classified as still running', RUNNING.has('PENDING'));
    check('EXPECTED (a required check not yet reported) is still running', RUNNING.has('EXPECTED'));
    for (const s of RUNNING) {
        check('running state ' + s + ' is in no terminal vocabulary', !GOOD.has(s) && !BAD.has(s) && !NOT_EV.has(s));
    }
    check('a running state is counted as PENDING in the loop, before the skip test',
        SRC.indexOf('STILL_RUNNING.has(concl)') !== -1
        && SRC.indexOf('STILL_RUNNING.has(concl)') < SRC.indexOf('NOT_EVIDENCE.has(concl)'));
}

// ---- an empty rollup is explained, not merely refused ----------------------
//
// Two causes, opposite meanings. Every PR-firing workflow path-filtered the
// change out: fine, nothing could ever go red. A gate was due and never
// started: the outage shape. The subject asks the workflow files at the trunk
// which one it is, and only the first is allowed through as READY.
check('the subject asks the path-filter helper about an empty rollup',
    /explainEmptyRollup\(cwd,/.test(SRC), 'without this an empty rollup can never be explained');
check('a benign empty rollup is worded as the filter WORKING',
    /the rollup is EMPTY and that is the path filter working/.test(SRC));
check('a due-but-missing run is worded as DUE, and names the workflow',
    /a run was DUE and none exists/.test(SRC));
check('only the benign wording is excluded from the blocking reasons',
    /!r\.startsWith\('the rollup is EMPTY and that is the path filter working'\)/.test(SRC)
    && !/!r\.startsWith\('the rollup is EMPTY but a run was DUE/.test(SRC),
    'the DUE case must stay blocking or an outage reads as a clean docs PR');
check('the changed-file list is requested from gh, or the helper has nothing to judge',
    /headRefName,files'/.test(SRC));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
