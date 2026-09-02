#!/usr/bin/env node
'use strict';
// Suite for check-standing-orders.js.
//
// The case the gate cannot demonstrate against the real holder: that it REFUSES
// an order missing the operator's words. The real holder carries zero orders by
// design, so running there only ever exercises the empty branch, which is
// indistinguishable from a parser that read nothing.
//
// Hermetic: CLAUDE_STANDING_ORDERS points the gate at a fixture file, so
// nothing here touches the operator's real holder.
//
// Run: node tooling/test-standing-orders.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GATE = path.join(__dirname, 'check-standing-orders.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'standing-orders-suite-'));
let pass = 0;
let fail = 0;

const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 400) : ''));
  }
};

let n = 0;
function fixture(body) {
  const p = path.join(TMP, `holder-${++n}.md`);
  fs.writeFileSync(p, body, 'utf8');
  return p;
}
function runGate(holder) {
  return spawnSync(process.execPath, [GATE], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_STANDING_ORDERS: holder },
  });
}

const VALID = [
  '## SO-1: publish the audit branch',
  '',
  '- **Verbatim:** "when the gate is green you can push it yourself"',
  '- **Date:** 2026-09-02',
  '- **Condition:** `npm run gate` exits 0 on the audit branch',
  '- **Holding session:** a-session-slug',
  '- **Status:** armed',
  '',
].join('\n');

// 1. A complete order passes, and the population is printed rather than a bare
//    verdict. A verdict alone cannot be told apart from a parser that read
//    nothing, which is the failure this whole gate was written after.
{
  const r = runGate(fixture(VALID));
  ok('a complete order passes', r.status === 0, (r.stdout || '') + (r.stderr || ''));
  ok('prints the population it parsed', /1 order\(s\) parsed/.test(r.stdout || ''), r.stdout);
}

// 2. Q2's clause, the one the whole mechanism exists for: an order with no
//    operator words verbatim is refused.
{
  const noWords = VALID.split('\n').filter((l) => !l.includes('**Verbatim:**')).join('\n');
  const r = runGate(fixture(noWords));
  ok('an order with no Verbatim is refused', r.status === 1, r.stdout);
  ok('and the refusal names Verbatim', /Verbatim/.test(r.stdout || ''), r.stdout);
}

// 3. Quotation is what makes words verbatim. A fluent paraphrase is refused.
{
  const para = VALID.replace(
    '- **Verbatim:** "when the gate is green you can push it yourself"',
    '- **Verbatim:** he said it was fine to push once the gate went green'
  );
  const r = runGate(fixture(para));
  ok('an unquoted paraphrase is refused', r.status === 1, r.stdout);
}

// 4. The defect the gate hit on its own first run. A holder is a DOCUMENT: its
//    prose headings are not orders, and a fenced example inside one must not
//    contribute fields to it. Before the fix this returned 5 orders and 20
//    refusals from a file holding zero.
{
  const doc = [
    '# Standing orders',
    '',
    '## Current orders',
    '',
    '**Zero.** Nothing here authorises a push today.',
    '',
    '## The form',
    '',
    '### Example, not an order',
    '',
    '```markdown',
    VALID,
    '```',
    '',
    '## The gate',
    '',
    'Run it before believing anything.',
    '',
  ].join('\n');
  const r = runGate(fixture(doc));
  ok('a document holding zero orders passes', r.status === 0, r.stdout);
  ok('and reports 0 orders, not a bare PASS', /0 order\(s\) parsed/.test(r.stdout || ''), r.stdout);
  ok(
    'and says plainly that nothing authorises a push',
    /nothing here authorises a push/.test(r.stdout || ''),
    r.stdout
  );
}

// 5. The opposite risk the `SO-` shape rule creates: a real order under a
//    heading that is not an order id must be reported, never silently skipped.
{
  const mistitled = VALID.replace('## SO-1: publish the audit branch', '## Publish the audit branch');
  const r = runGate(fixture(mistitled));
  ok('a mis-titled real order fails the gate', r.status === 1, r.stdout);
  ok(
    'and the failure tells the writer how to fix it',
    /not an order id/.test(r.stdout || ''),
    r.stdout
  );
}

// 6. An absent holder is not a pass. A skip worded as a category converts
//    absent coverage into reported coverage.
{
  const r = runGate(path.join(TMP, 'does-not-exist.md'));
  ok('an absent holder exits 0', r.status === 0, r.stdout);
  ok('but says NO HOLDER, never PASS', /NO HOLDER/.test(r.stdout || ''), r.stdout);
  ok('and does not claim to have verified anything', !/\bPASS\b/.test(r.stdout || ''), r.stdout);
}

// 7. C4's once-only clause. `executed` is the state a second wake reads, so it
//    must carry a timestamp or it cannot answer which wake fired it.
{
  const r1 = runGate(fixture(VALID.replace('**Status:** armed', '**Status:** executed')));
  ok('executed with no timestamp is refused', r1.status === 1, r1.stdout);

  const r2 = runGate(
    fixture(VALID.replace('**Status:** armed', '**Status:** executed 2026-09-02T14:00:00+03:00'))
  );
  ok('executed with a timestamp passes', r2.status === 0, r2.stdout);
  ok('and is counted as executed, not armed', /1 executed/.test(r2.stdout || ''), r2.stdout);
}

// 8. The gate's own selftest, against the real holder, with no override.
{
  const r = spawnSync(process.execPath, [GATE, '--selftest'], { encoding: 'utf8' });
  ok('selftest passes', r.status === 0, (r.stdout || '') + (r.stderr || ''));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log((fail ? 'FAIL' : 'PASS') + ` standing-orders: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
