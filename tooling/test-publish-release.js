#!/usr/bin/env node
// Tests for tooling/publish-release.js: the judgement that decides whether
// stable may move, graded against hand-written facts. Every refusal has a case
// that trips it alone, so a check that stopped firing shows as a FAIL here
// rather than as a release that changed after the fact.
//
// The live push is not exercised: it needs the deploy key and writes to
// GitHub. The live path is proved by the release itself and its read-back.
//
// Run: node tooling/test-publish-release.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { judge, parseArgs, releaseReceiptProblem } = require('./publish-release.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
    if (ok) { passed++; console.log(`ok ${name}`); } else { failed++; console.log(`FAIL ${name}${detail ? ' | ' + detail : ''}`); }
}

const C = 'c'.repeat(40);
const good = {
    version: '9.1.0', tagType: 'tag', tagObject: 't'.repeat(40), commit: C, commitTree: 'e'.repeat(40),
    versionAtCommit: '9.1.0', onMain: true, stable: 'b'.repeat(40), stableIsAncestor: true,
    remoteTag: undefined, head: 'h'.repeat(40), headTree: 'e'.repeat(40), receiptProblem: null,
};
const refusedFor = (patch, re) => {
    const v = judge({ ...good, ...patch });
    return v.refusals.length === 1 && re.test(v.refusals[0]) && !v.already;
};

const ok = judge(good);
check('a gated, forward, on-main release publishes', ok.refusals.length === 0 && ok.already === false, JSON.stringify(ok));

check('no tag refuses', judge({ version: '9.1.0', tagType: null }).refusals.some((r) => /not a tag/.test(r)));
check('a lightweight tag refuses', refusedFor({ tagType: 'commit' }, /not an annotated tag/));
check('a VERSION mismatch refuses', refusedFor({ versionAtCommit: '9.0.0' }, /VERSION/));
check('a commit not on main refuses', refusedFor({ onMain: false }, /not on origin\/main/));
check('a stable rewind refuses', refusedFor({ stableIsAncestor: false }, /only moves forward/));
check('a failing receipt refuses', refusedFor({ receiptProblem: 'receipt ends with FAIL' }, /receipt ends with FAIL/));
check('a receipt for another tree refuses', refusedFor({ headTree: 'f'.repeat(40) }, /tree/));
check('an unknown head tree refuses', refusedFor({ headTree: null }, /unknown/));
check('a different remote tag refuses', refusedFor({ remoteTag: 'x'.repeat(40) }, /never replaced/));

const done = judge({ ...good, remoteTag: good.tagObject, stable: C });
check('the same tag and stable already published is idempotent', done.refusals.length === 0 && done.already === true);
check('the same tag with stable behind still publishes', judge({ ...good, remoteTag: good.tagObject }).already === false);

const a = parseArgs(['--version', '9.1.0', '--gate-receipt', 'r.log', '--head', C, '--dry-run']);
check('arguments parse', a.version === '9.1.0' && a.gateReceipt === 'r.log' && a.head === C && a.dryRun === true);
check('an unknown argument is caught', parseArgs(['--force']).unknown === '--force');

// The wiring gather() uses: the release bar is the full gate, never a wrapped gate:fast run.
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubrel-'));
    const H = 'a'.repeat(40);
    const write = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
    const fast = write('fast.log', `${H}\ngate-fast: 9 of 13 steps ran, PARTIAL\ngate-receipt: exit 0\n`);
    const full = write('full.log', `gate-lock: head ${H}\nnpm test\ngate-lock: head ${H}\ngate-lock: verdict PASS (exit 0), the chain finished: ok\n`);
    check('a wrapped gate:fast receipt cannot publish', /is not the full gate/.test(releaseReceiptProblem(fast, H) || ''));
    check('a full gate receipt publishes', releaseReceiptProblem(full, H) === null);
    check('a non-sha head is refused before the receipt is read', /not a 40-hex sha/.test(releaseReceiptProblem(full, 'HEAD') || ''));
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
