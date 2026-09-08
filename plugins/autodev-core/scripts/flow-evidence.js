#!/usr/bin/env node
// flow-evidence.js — validate the record a runtime flow check leaves behind, and
// refuse one that carries no assertion.
//
// WHY THIS EXISTS. `[measured 2026-08-16]` docs/failure-evidence.md: across
// three production repos, 112 first-pass defects were incomplete flows or dead
// paths against 20 runtime crashes. Typecheck, build and a clean console catch
// the 20. The `auto` skill already screenshots public UI, and a screenshot is
// exactly the artefact that cannot tell "the handler nested where it never runs"
// from "the handler ran": both produce one green picture. So a story that
// claims a user-visible outcome has to leave a record with an ASSERTION ABOUT
// STATE — a row appeared, a number matches across the two surfaces that show
// it, the network call happened with the right shape — and an OBSERVED value
// the assertion can be checked against. This script is the thing that refuses
// the record when either is missing, so a story cannot be marked done on a
// screenshot alone.
//
// It validates; it does not drive the browser. The driving is the `auto`
// skill's job (see "Runtime flow check" in skills/auto/SKILL.md), through the
// in-app browser tools, and the record it writes lands beside `prove`'s
// captures in `.claude/evidence/<slug>/flow.json`.
//
// THE VERDICT IS COMPUTED HERE, NOT READ FROM THE RECORD. A `passed: true`
// field would be a claim; `expected` against `observed` is a check. A record
// whose author wrote the wrong `observed` still fails, which is the point.
//
// Usage:
//   node flow-evidence.js <record.json>      validate; exit 0 PASS, 1 FAIL, 2 REFUSED
//   node flow-evidence.js --template         print a skeleton record to fill in
//
// Exit codes are three, not two, because "the assertion failed" and "there was
// no assertion" are different findings: the first is a defect in the product,
// the second a defect in the verification. Collapsing them is how a missing
// check reads as a failing one and gets "fixed" by deleting it.
//
// Pure Node, no dependencies. Reads the record and stats the screenshot paths;
// writes nothing.

'use strict';

const fs = require('fs');
const path = require('path');

// The subjects an assertion may be about. Each names a thing that has a value
// the check can read back: a DOM count or text, the URL, a request that was or
// was not issued, a console line, a storage key, a row, an API response body.
// "visual" is deliberately absent — a picture is evidence for a human, not an
// observed value, and `screenshots` is where it belongs.
const STATE_SUBJECTS = ['dom', 'text', 'url', 'network', 'console', 'storage', 'db', 'api'];

// Claims that name no outcome. "The page looked fine" is the sentence this
// script exists to refuse; the pattern is kept narrow so that a real claim
// containing the word "right" ("the right-hand total matches") still passes.
const VACUOUS_CLAIM = /^\s*(?:the\s+)?(?:(?:it|page|ui|screen|everything|all)\s+)?(?:look(?:s|ed)?|seem(?:s|ed)?|render(?:s|ed)?|work(?:s|ed)?|is|was)?\s*(?:fine|ok|okay|good|correct|right|as expected|normal)\s*[.!]?\s*$/i;

const FUTURE_SLACK_MS = 5 * 60 * 1000;

function template() {
    return {
        story: 'S00-000',
        flow: [
            'navigate /generate',
            'form_input #url = https://example.com',
            'computer left_click "Generate"',
        ],
        assertion: {
            subject: 'dom',
            claim: 'exactly one QR image is rendered with a data: URL source',
            expected: 1,
        },
        observed: null,
        observedBefore: null,
        screenshots: ['.claude/evidence/S00-000/after.png'],
        consoleErrors: 0,
        consoleErrorsBaseline: 0,
        timestamp: new Date().toISOString(),
    };
}

function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (typeof a !== 'object') return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Returns { refusals: string[], failures: string[] }. A refusal is a defect in
// the record; a failure is a defect in the product the record observed.
function validate(rec, opts = {}) {
    const cwd = opts.cwd || process.cwd();
    const now = opts.now || Date.now();
    const refusals = [];
    const failures = [];

    if (!isPlainObject(rec)) return { refusals: ['record: not a JSON object'], failures };

    if (typeof rec.story !== 'string' || !rec.story.trim()) refusals.push('story: missing or empty');

    if (!Array.isArray(rec.flow) || rec.flow.length === 0) {
        refusals.push('flow: must be a non-empty array of steps');
    } else if (rec.flow.some((s) => typeof s !== 'string' || !s.trim())) {
        refusals.push('flow: every step must be a non-empty string');
    }

    const a = rec.assertion;
    if (!isPlainObject(a)) {
        refusals.push('assertion: missing — a screenshot alone does not close a story');
    } else {
        if (!STATE_SUBJECTS.includes(a.subject)) {
            refusals.push(`assertion.subject: "${a.subject}" is not a state subject (one of ${STATE_SUBJECTS.join(', ')})`);
        }
        if (typeof a.claim !== 'string' || !a.claim.trim()) {
            refusals.push('assertion.claim: missing or empty');
        } else if (VACUOUS_CLAIM.test(a.claim)) {
            refusals.push(`assertion.claim: "${a.claim.trim()}" names no outcome`);
        }
        if (!('expected' in a) || a.expected === null || a.expected === undefined) {
            refusals.push('assertion.expected: missing — an assertion without an expected value cannot fail');
        }
    }

    if (!('observed' in rec) || rec.observed === null || rec.observed === undefined) {
        refusals.push('observed: missing — nothing was read back from the page');
    }

    if (!Array.isArray(rec.screenshots)) {
        refusals.push('screenshots: must be an array (empty is allowed)');
    } else {
        for (const p of rec.screenshots) {
            if (typeof p !== 'string' || !p.trim()) { refusals.push('screenshots: every entry must be a path'); break; }
            if (!fs.existsSync(path.resolve(cwd, p))) refusals.push(`screenshots: ${p} does not exist`);
        }
    }

    if (!Number.isInteger(rec.consoleErrors) || rec.consoleErrors < 0) {
        refusals.push('consoleErrors: must be a non-negative integer (the count from read_console_messages)');
    }
    if ('consoleErrorsBaseline' in rec && rec.consoleErrorsBaseline !== null
        && (!Number.isInteger(rec.consoleErrorsBaseline) || rec.consoleErrorsBaseline < 0)) {
        refusals.push('consoleErrorsBaseline: must be a non-negative integer (the count on the same page before the flow)');
    }

    if (typeof rec.timestamp !== 'string' || Number.isNaN(Date.parse(rec.timestamp))) {
        refusals.push('timestamp: must be an ISO-8601 string');
    } else if (Date.parse(rec.timestamp) > now + FUTURE_SLACK_MS) {
        refusals.push('timestamp: is in the future');
    }

    if (refusals.length) return { refusals, failures };

    // Structure is sound; now the verdict.
    if (!deepEqual(a.expected, rec.observed)) {
        failures.push(`assertion: expected ${JSON.stringify(a.expected)}, observed ${JSON.stringify(rec.observed)}`);
    }
    // `[measured 2026-09-08]` two dev servers driven from the in-app browser
    // pane carried console errors before any flow ran: a Next dev tree logged a
    // CSP complaint about React's eval and a blocked analytics script, a Vite
    // tree logged blocked script fetches. A rule that fails on ANY error fails
    // every record in those repos, and a check that always fails is one that
    // gets skipped. So the strict rule stays the default, and a record may carry
    // the count measured on the same page BEFORE the flow; the flow then fails
    // only on errors it added. The baseline is in the record, so a reviewer
    // sees "2 before, 2 after" rather than a silent allowance.
    const baseline = Number.isInteger(rec.consoleErrorsBaseline) ? rec.consoleErrorsBaseline : 0;
    if (rec.consoleErrors > baseline) {
        failures.push(baseline
            ? `console: ${rec.consoleErrors} error(s) during the flow against a baseline of ${baseline}`
            : `console: ${rec.consoleErrors} error(s) during the flow`);
    }
    // prove: "Two byte-identical captures mean the probe was blind, not that the
    // change was subtle." Same rule for a read-back value: a fix whose before
    // and after observe the same thing has not observed the fix.
    if ('observedBefore' in rec && rec.observedBefore !== null && rec.observedBefore !== undefined
        && deepEqual(rec.observedBefore, rec.observed)) {
        failures.push('observedBefore equals observed: the probe did not see the change');
    }
    return { refusals, failures };
}

function main(argv) {
    if (argv.includes('--template')) {
        process.stdout.write(JSON.stringify(template(), null, 2) + '\n');
        return 0;
    }
    const file = argv.find((x) => !x.startsWith('--'));
    if (!file) {
        process.stdout.write('usage: flow-evidence.js <record.json> | --template\n');
        return 2;
    }
    let rec;
    try {
        rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        process.stdout.write(`flow-evidence: REFUSED ${file} — ${e.code === 'ENOENT' ? 'no such file' : 'not valid JSON'}\n`);
        return 2;
    }
    const { refusals, failures } = validate(rec, { cwd: path.dirname(path.resolve(file)) });
    const story = isPlainObject(rec) && typeof rec.story === 'string' ? rec.story : '(no story)';
    if (refusals.length) {
        for (const r of refusals) process.stdout.write(`  ${r}\n`);
        process.stdout.write(`flow-evidence: REFUSED ${story} — ${refusals.length} defect(s) in the record\n`);
        return 2;
    }
    if (failures.length) {
        for (const f of failures) process.stdout.write(`  ${f}\n`);
        process.stdout.write(`flow-evidence: FAIL ${story} — ${failures.length} finding(s)\n`);
        return 1;
    }
    process.stdout.write(`flow-evidence: PASS ${story} — ${rec.assertion.subject}: ${rec.assertion.claim}\n`);
    return 0;
}

if (require.main === module) {
    process.exit(main(process.argv.slice(2)));
}

module.exports = { validate, template, STATE_SUBJECTS };
