#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/flow-evidence.js — the record a
// runtime flow check leaves behind, and the refusals that keep a screenshot
// from closing a story on its own.
// Run: node tooling/test-flow-evidence.js
// Exits 1 on any failure; 0 if all pass.
//
// Driven as a subprocess, following tooling/test-pre-tool-filter.js: the exit
// code and the stdout line are the contract `auto` reads, so that is what is
// asserted. The three exit codes are asserted separately on purpose — a
// REFUSED record (no assertion) and a FAILED one (assertion did not hold) are
// different findings and a suite that only checked "non-zero" could not tell
// a validator that lost its verdict from one that lost its schema.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'flow-evidence.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-evidence-'));
const shot = path.join(tmp, 'after.png');
fs.writeFileSync(shot, 'not really a png, existence is what is checked');

function valid(overrides = {}) {
    return Object.assign({
        story: 'S99-001',
        flow: ['navigate /generate', 'form_input #url = https://example.com', 'click Generate'],
        assertion: { subject: 'dom', claim: 'exactly one QR image with a data: src is rendered', expected: 1 },
        observed: 1,
        screenshots: ['after.png'],
        consoleErrors: 0,
        timestamp: new Date().toISOString(),
    }, overrides);
}

let n = 0;
function run(record, label) {
    const file = path.join(tmp, `rec-${++n}.json`);
    fs.writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record));
    const r = spawnSync('node', [SCRIPT, file], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '', label };
}

const cases = [
    // [label, record, expectedExit, stdout must contain]
    ['a sound record with a held assertion passes', valid(), 0, 'PASS'],
    ['a held assertion on an object value passes', valid({
        assertion: { subject: 'api', claim: 'the row came back with the account id', expected: { id: 7, account: 'a1' } },
        observed: { account: 'a1', id: 7 },
    }), 0, 'PASS'],
    ['no screenshots is allowed when the assertion holds', valid({ screenshots: [] }), 0, 'PASS'],

    // ---- REFUSED: defects in the record. Exit 2. ----
    ['no assertion is refused, screenshots or not', valid({ assertion: undefined }), 2, 'assertion: missing'],
    ['a visual subject is refused', valid({ assertion: { subject: 'visual', claim: 'the page renders', expected: true } }), 2, 'not a state subject'],
    ['a screenshot subject is refused', valid({ assertion: { subject: 'screenshot', claim: 'after.png matches', expected: true } }), 2, 'not a state subject'],
    ['"looked fine" is refused', valid({ assertion: { subject: 'dom', claim: 'looked fine', expected: true } }), 2, 'names no outcome'],
    ['"the page looks ok." is refused', valid({ assertion: { subject: 'dom', claim: 'the page looks ok.', expected: true } }), 2, 'names no outcome'],
    ['"works as expected" is refused', valid({ assertion: { subject: 'dom', claim: 'works as expected', expected: true } }), 2, 'names no outcome'],
    ['a real claim containing "right" is not refused', valid({
        assertion: { subject: 'text', claim: 'the right-hand total reads the same as the header total', expected: '12' }, observed: '12',
    }), 0, 'PASS'],
    ['an empty claim is refused', valid({ assertion: { subject: 'dom', claim: '', expected: 1 } }), 2, 'assertion.claim'],
    ['no expected value is refused', valid({ assertion: { subject: 'dom', claim: 'one QR image rendered' } }), 2, 'assertion.expected'],
    ['a null expected value is refused', valid({ assertion: { subject: 'dom', claim: 'one QR image rendered', expected: null } }), 2, 'assertion.expected'],
    ['no observed value is refused', valid({ observed: undefined }), 2, 'observed: missing'],
    ['a null observed value is refused', valid({ observed: null }), 2, 'observed: missing'],
    ['an empty flow is refused', valid({ flow: [] }), 2, 'flow:'],
    ['a flow that is not an array is refused', valid({ flow: 'navigate /generate' }), 2, 'flow:'],
    ['a blank flow step is refused', valid({ flow: ['navigate /generate', '  '] }), 2, 'flow:'],
    ['a missing story id is refused', valid({ story: '' }), 2, 'story:'],
    ['a screenshot path that does not exist is refused', valid({ screenshots: ['missing.png'] }), 2, 'does not exist'],
    ['screenshots as a string is refused', valid({ screenshots: 'after.png' }), 2, 'screenshots:'],
    ['a string console count is refused', valid({ consoleErrors: '0' }), 2, 'consoleErrors'],
    ['a negative console count is refused', valid({ consoleErrors: -1 }), 2, 'consoleErrors'],
    ['a missing console count is refused', valid({ consoleErrors: undefined }), 2, 'consoleErrors'],
    ['an unparseable timestamp is refused', valid({ timestamp: 'yesterday' }), 2, 'timestamp'],
    ['a future timestamp is refused', valid({ timestamp: new Date(Date.now() + 3600 * 1000).toISOString() }), 2, 'in the future'],
    ['a record that is a bare array is refused', '[1,2]', 2, 'not a JSON object'],
    ['invalid JSON is refused', '{ not json', 2, 'not valid JSON'],
    ['the --template output is refused as-is, because observed is null', null, 2, 'observed: missing'],

    // ---- FAIL: the record is sound and the product is wrong. Exit 1. ----
    ['an assertion that does not hold fails', valid({ observed: 2 }), 1, 'expected 1, observed 2'],
    ['a type mismatch fails rather than coercing', valid({ observed: '1' }), 1, 'expected 1, observed "1"'],
    ['an object assertion that does not hold fails', valid({
        assertion: { subject: 'api', claim: 'row carries the account', expected: { id: 7, account: 'a1' } },
        observed: { id: 7 },
    }), 1, 'assertion: expected'],
    ['console errors fail a held assertion', valid({ consoleErrors: 3 }), 1, '3 error(s)'],
    ['console errors at the recorded baseline pass', valid({ consoleErrors: 2, consoleErrorsBaseline: 2 }), 0, 'PASS'],
    ['console errors above the recorded baseline fail', valid({ consoleErrors: 3, consoleErrorsBaseline: 2 }), 1, 'against a baseline of 2'],
    ['a string baseline is refused', valid({ consoleErrors: 2, consoleErrorsBaseline: '2' }), 2, 'consoleErrorsBaseline'],
    ['a null baseline means strict', valid({ consoleErrors: 1, consoleErrorsBaseline: null }), 1, '1 error(s)'],
    ['a before value equal to the after value fails as a blind probe', valid({ observedBefore: 1 }), 1, 'did not see the change'],
    ['a before value that differs is fine', valid({ observedBefore: 0 }), 0, 'PASS'],
];

let failed = 0;
for (const [label, record, expectedExit, needle] of cases) {
    let r;
    if (record === null) {
        const t = spawnSync('node', [SCRIPT, '--template'], { encoding: 'utf8' });
        if (t.status !== 0) { console.log(`FAIL  ${label}: --template exited ${t.status}`); failed++; continue; }
        r = run(t.stdout, label);
    } else {
        r = run(record, label);
    }
    const ok = r.code === expectedExit && r.out.includes(needle) && r.err === '';
    if (!ok) {
        failed++;
        console.log(`FAIL  ${label}\n      expected exit ${expectedExit} containing ${JSON.stringify(needle)}\n      got exit ${r.code}, stdout ${JSON.stringify(r.out.trim())}, stderr ${JSON.stringify(r.err.trim())}`);
    } else {
        console.log(`ok    ${label}`);
    }
}

// The three exits must be distinct for the same file across the three states,
// or `auto` cannot tell a missing check from a failing one.
{
    const passing = run(valid(), 'exit-triple');
    const failing = run(valid({ observed: 0 }), 'exit-triple');
    const refused = run(valid({ assertion: undefined }), 'exit-triple');
    const distinct = new Set([passing.code, failing.code, refused.code]).size === 3;
    if (!distinct) { failed++; console.log(`FAIL  exit codes are not three distinct values: ${passing.code}/${failing.code}/${refused.code}`); }
    else console.log('ok    PASS, FAIL and REFUSED exit with three distinct codes');
}

// Missing file and no argument are refusals too, not crashes.
{
    const r = spawnSync('node', [SCRIPT, path.join(tmp, 'nope.json')], { encoding: 'utf8' });
    if (r.status !== 2 || !/no such file/.test(r.stdout) || r.stderr) { failed++; console.log(`FAIL  missing file: exit ${r.status} ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)}`); }
    else console.log('ok    a missing record file is refused, not thrown');
    const u = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
    if (u.status !== 2 || !/usage/.test(u.stdout)) { failed++; console.log(`FAIL  no argument: exit ${u.status} ${JSON.stringify(u.stdout)}`); }
    else console.log('ok    no argument prints usage and exits 2');
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failed ? `\n${failed} failure(s)` : `\nAll ${cases.length + 3} checks passed`);
process.exit(failed ? 1 : 0);
