#!/usr/bin/env node
'use strict';
// A recorded standing order authorises its own push. This gate decides whether
// a given order is recorded well enough to carry that authority.
//
// WHY A NEW GATE, and not an extension of check-push-authorisation.js:
// `[measured 2026-09-02]` the harness audit plan's L2 acceptance names
// check-push-authorisation.js as the thing that must "refuse an order with no
// operator words verbatim". It cannot. Run it and read what it prints:
//
//     [push-auth] 63 shipped SKILL.md scanned, 5 push instruction(s), ...
//
// It scans `plugins/*/skills/*/SKILL.md` and asks whether a SHIPPED SKILL tells
// a session to push without naming its authorisation. That is a different
// question from whether an ORDER is well formed, over a different corpus, and
// no amount of extension makes one script answer both. Four executed lanes have
// now each found their own acceptance test naming a probe by the question they
// wanted answered rather than by what the probe reports.
//
// THE FORM, from Q2 `[stated 2026-09-02]` by the operator, choosing "Yes, a
// recorded order authorises its push": his words verbatim, the date, the
// condition, the holding session. An order missing any of those is refused.
//
// STATUS IS A FIFTH FIELD AND IS NOT FROM Q2. C4 requires that a standing order
// execute ONCE: "Y happens within one wake interval, once, with the order's
// origin logged". Once is unenforceable without state a second wake can read,
// so the holder carries it. Kept in the holder rather than in a scratch marker
// file deliberately: a marker under a temp dir disappears on a reinstall while
// the order stays armed, and the order then re-fires. The holder is in a git
// repo, so the transition is versioned, which is also what "origin logged"
// wants.
//
// WHAT THIS GATE CANNOT SEE, said out loud so a green is not read as more than
// it is: it checks that a verbatim field EXISTS and carries a quoted span. It
// cannot tell a real quote from a fluent paraphrase wearing quote marks. That
// is a semantic property and no regex reaches it. The gate refuses an order
// with no operator words; it does not certify that the words are his.
const fs = require('fs');
const os = require('os');
const path = require('path');

// No silent default that passes over a file nobody looked at. The path is
// printed with every verdict for the same reason check-push-authorisation.js
// prints its corpus size: a bare PASS is indistinguishable from a parser that
// read nothing.
const HOLDER =
  process.env.CLAUDE_STANDING_ORDERS ||
  process.argv.slice(2).find((a) => !a.startsWith('--')) ||
  path.join(os.homedir(), 'claude-memory', 'STANDING-ORDERS.md');

// Q2's four, then C4's one. Order matters only for the report.
const REQUIRED = ['Verbatim', 'Date', 'Condition', 'Holding session', 'Status'];

const STATUSES = ['armed', 'executed', 'expired', 'revoked'];

// A field left as a placeholder is absent wearing a value's clothes. These are
// the forms that have actually appeared in this repo's own draft documents.
const PLACEHOLDER = /^(tbd|todo|tk|xxx|n\/a|na|\.\.\.|-+|\?+)$/i;

const MIN_VERBATIM = 8;

// An order heading is `## SO-<id>`, never any `## ` heading.
//
// `[measured 2026-09-02]` the first version treated every `## ` heading as an
// order, and its first run against the real holder returned FIVE orders and 20
// refusals from a file holding ZERO orders. Every prose heading in the document
// parsed as an order, and one of them reported status `armed`, picked up from
// the fenced example inside it. The document had a paragraph explaining this
// exact trap, and the guard written for it covered only the example heading.
//
// So the shape carries the meaning: a writer declares an order by naming it,
// and prose headings are structurally not orders rather than incidentally
// spared. The risk this creates is the opposite one, a real order mis-titled
// and therefore never validated, which `suspects()` below reports rather than
// passing over in silence.
const ORDER_HEADING = /^##\s+(SO-\S+.*?)\s*$/;
const ANY_HEADING = /^##\s+(.+?)\s*$/;

// A fenced block is invisible to a reader as data and fully visible to a line
// scanner. Blank the fence contents so an example cannot contribute fields to
// the section that documents it.
function stripFences(text) {
  let inFence = false;
  return text
    .split(/\r?\n/)
    .map((l) => {
      if (/^\s*(```|~~~)/.test(l)) {
        inFence = !inFence;
        return '';
      }
      return inFence ? '' : l;
    })
    .join('\n');
}

function sections(text) {
  const out = [];
  const lines = stripFences(text).split(/\r?\n/);
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const any = ANY_HEADING.exec(lines[i]);
    if (any) {
      if (current) out.push(current);
      const order = ORDER_HEADING.exec(lines[i]);
      current = { title: any[1], line: i + 1, isOrder: Boolean(order), body: [] };
      continue;
    }
    if (current) current.body.push(lines[i]);
  }
  if (current) out.push(current);
  for (const s of out) s.fields = fields(s.body.join('\n'));
  return out;
}

function parse(text) {
  return sections(text).filter((s) => s.isOrder);
}

// A section carrying order fields under a heading that is not an order id is
// most likely a real order somebody mis-titled. Reporting it is the whole point:
// the alternative is a genuine order the gate silently never validates.
function suspects(text) {
  return sections(text).filter(
    (s) => !s.isOrder && REQUIRED.filter((r) => s.fields[r.toLowerCase()] !== undefined).length >= 2
  );
}

// Fields wrap. A value can run onto the next line, so a line-oriented read of
// this file reports absence with total confidence for a field that is present.
// Collect each field from its label to the next label or the end of the block,
// then normalise whitespace.
function fields(body) {
  const out = {};
  const labelAt = [];
  const re = /^[-*]?\s*\*\*([^*:]+):\*\*/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    labelAt.push({ name: m[1].trim(), start: m.index + m[0].length });
  }
  for (let i = 0; i < labelAt.length; i++) {
    const end = i + 1 < labelAt.length ? body.lastIndexOf('\n', labelAt[i + 1].start) : body.length;
    const raw = body.slice(labelAt[i].start, end === -1 ? body.length : end);
    out[labelAt[i].name.toLowerCase()] = raw.replace(/\s+/g, ' ').trim();
  }
  return out;
}

function quotedSpan(value) {
  // A straight-quoted span, a curly-quoted span, or a markdown blockquote that
  // survived whitespace normalisation as a leading '>'.
  const straight = /"([^"]{1,})"/.exec(value);
  if (straight) return straight[1].trim();
  const curly = /“([^”]{1,})”/.exec(value);
  if (curly) return curly[1].trim();
  const block = /^>\s*(.+)$/.exec(value);
  if (block) return block[1].trim();
  return null;
}

function validate(order, today) {
  const bad = [];
  const f = order.fields;

  for (const name of REQUIRED) {
    const v = f[name.toLowerCase()];
    if (v === undefined) {
      bad.push(`missing field: ${name}`);
      continue;
    }
    if (v === '' || PLACEHOLDER.test(v)) bad.push(`empty or placeholder field: ${name} (${v || 'blank'})`);
  }

  const verbatim = f.verbatim;
  if (verbatim && !PLACEHOLDER.test(verbatim)) {
    const span = quotedSpan(verbatim);
    if (!span) {
      bad.push('Verbatim carries no quoted span, so no operator words are recorded');
    } else if (span.length < MIN_VERBATIM) {
      bad.push(`Verbatim quote is ${span.length} chars, under the ${MIN_VERBATIM} minimum`);
    }
  }

  const date = f.date;
  if (date && !PLACEHOLDER.test(date)) {
    const d = /(\d{4}-\d{2}-\d{2})/.exec(date);
    if (!d) {
      bad.push(`Date is not an ISO YYYY-MM-DD date: ${date}`);
    } else {
      const parsed = new Date(d[1] + 'T00:00:00Z');
      if (Number.isNaN(parsed.getTime())) bad.push(`Date does not parse: ${d[1]}`);
      // An order cannot have been given tomorrow. A future date is the tell for
      // a template that was filled in from a plan rather than from a turn.
      else if (d[1] > today) bad.push(`Date is in the future: ${d[1]} (today is ${today})`);
    }
  }

  const status = f.status;
  if (status && !PLACEHOLDER.test(status)) {
    const word = status.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
    if (!STATUSES.includes(word)) {
      bad.push(`Status is not one of ${STATUSES.join(', ')}: ${status}`);
    } else if (word === 'executed' && !/\d{4}-\d{2}-\d{2}/.test(status)) {
      // Executed with no timestamp cannot answer "was this the wake that fired
      // it", which is the whole of C4's once-only clause.
      bad.push(`Status executed carries no date: ${status}`);
    }
  }

  return bad;
}

function statusWord(order) {
  const s = order.fields.status;
  if (!s) return 'unknown';
  return s.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '') || 'unknown';
}

function run(holder, today) {
  if (!fs.existsSync(holder)) {
    // NOT a pass. A skip worded as a category reads as a considered exemption
    // and converts absent coverage into reported coverage.
    console.log(`[standing-orders] NO HOLDER at ${holder}: 0 orders checked, nothing verified`);
    return 0;
  }

  const text = fs.readFileSync(holder, 'utf8');
  const orders = parse(text);
  const mistitled = suspects(text);
  const findings = [];
  const counts = {};

  for (const o of orders) {
    const bad = validate(o, today);
    const w = statusWord(o);
    counts[w] = (counts[w] || 0) + 1;
    for (const reason of bad) findings.push({ order: o, reason });
  }

  const tally = Object.keys(counts).sort().map((k) => `${counts[k]} ${k}`).join(', ') || 'none';
  console.log(
    `[standing-orders] ${holder}: ${sections(text).length} section(s), ${orders.length} order(s) parsed, ` +
      `${tally}, ${findings.length} refusal(s)`
  );

  for (const s of mistitled) {
    console.log(
      `[standing-orders] FAIL ${holder}:${s.line} "${s.title}" carries order fields under a heading that is ` +
        `not an order id. Rename it '## SO-<id>: ...' or remove the fields.`
    );
  }

  if (findings.length) {
    for (const f of findings) {
      console.log(`[standing-orders] REFUSED ${holder}:${f.order.line} "${f.order.title}": ${f.reason}`);
    }
    console.log(
      `[standing-orders] An order authorises its own push only with all of: ${REQUIRED.join(', ')}.`
    );
    return 1;
  }
  if (mistitled.length) return 1;

  // Zero orders is a legitimate and common state: it means nothing here
  // authorises a push. Say so rather than printing a bare PASS, which reads as
  // "orders checked and found good".
  if (orders.length === 0) {
    console.log('[standing-orders] PASS, 0 orders: nothing here authorises a push');
    return 0;
  }
  console.log('[standing-orders] PASS');
  return 0;
}

// The gate must prove it can fire, and fire on the SPECIFIC part that is
// missing. A selftest asserting only "some finding appeared" passes for a gate
// that refuses everything.
function selftest() {
  let bad = 0;
  const check = (label, got, want, ok) => {
    console.log(`[selftest] ${label} -> ${got} (want ${want})`);
    if (!ok) {
      bad++;
      console.log('[selftest] FAIL ' + label);
    }
  };

  const TODAY = '2026-09-02';
  const VALID = [
    '## SO-EXAMPLE: publish the audit branch',
    '',
    '- **Verbatim:** "when the gate is green you can push it yourself"',
    '- **Date:** 2026-09-02',
    '- **Condition:** `npm run gate` exits 0 on the audit branch',
    '- **Holding session:** a-session-slug',
    '- **Status:** armed',
    '',
  ].join('\n');

  const one = (text) => {
    const orders = parse(text);
    return { orders, bad: orders.length ? validate(orders[0], TODAY) : ['no order parsed'] };
  };

  const base = one(VALID);
  check('a complete order', base.bad.length, '0', base.bad.length === 0);

  // Each required part, removed on its own, must be named by the refusal. Drop
  // the whole line so the field is genuinely absent rather than blank.
  for (const field of REQUIRED) {
    const stripped = VALID.split('\n')
      .filter((l) => !l.includes(`**${field}:**`))
      .join('\n');
    const r = one(stripped);
    const named = r.bad.some((b) => b.toLowerCase().includes(field.toLowerCase()));
    check(`${field} removed is refused BY NAME`, r.bad.join(' | ') || 'clean', `mentions ${field}`, named);
  }

  // Q2's clause, spelled out: words with no quotation are not verbatim words.
  const PARAPHRASE = VALID.replace(
    '- **Verbatim:** "when the gate is green you can push it yourself"',
    '- **Verbatim:** he said it was fine to push once the gate went green'
  );
  const p = one(PARAPHRASE);
  check(
    'an unquoted paraphrase is refused',
    p.bad.join(' | ') || 'clean',
    'mentions quoted span',
    p.bad.some((b) => b.includes('quoted span'))
  );

  // A wrapped field must still be read. A line-oriented parser reports this
  // present-and-correct field as missing.
  const WRAPPED = VALID.replace(
    '- **Condition:** `npm run gate` exits 0 on the audit branch',
    '- **Condition:** `npm run gate` exits 0 on the audit branch and the\n  working tree is clean'
  );
  const w = one(WRAPPED);
  check('a field wrapped across two lines still reads', w.bad.length, '0', w.bad.length === 0);

  const FUTURE = VALID.replace('**Date:** 2026-09-02', '**Date:** 2099-01-01');
  const fu = one(FUTURE);
  check(
    'a future date is refused',
    fu.bad.join(' | ') || 'clean',
    'mentions future',
    fu.bad.some((b) => b.includes('future'))
  );

  const PLACEHOLDER_COND = VALID.replace(
    '- **Condition:** `npm run gate` exits 0 on the audit branch',
    '- **Condition:** TBD'
  );
  const pc = one(PLACEHOLDER_COND);
  check(
    'a placeholder condition is refused',
    pc.bad.join(' | ') || 'clean',
    'mentions Condition',
    pc.bad.some((b) => b.includes('Condition'))
  );

  const EXEC_NO_DATE = VALID.replace('**Status:** armed', '**Status:** executed');
  const en = one(EXEC_NO_DATE);
  check(
    'executed with no date is refused',
    en.bad.join(' | ') || 'clean',
    'mentions no date',
    en.bad.some((b) => b.includes('no date'))
  );

  const EXEC_DATED = VALID.replace('**Status:** armed', '**Status:** executed 2026-09-02T14:00:00+03:00');
  const ed = one(EXEC_DATED);
  check('executed with a timestamp is accepted', ed.bad.length, '0', ed.bad.length === 0);

  // Two orders in one holder must both be seen. A parser that stops at the
  // first heading passes every single-order test above.
  const TWO = VALID + '\n' + VALID.replace('SO-EXAMPLE', 'SO-SECOND').replace('**Status:** armed', '**Status:** revoked');
  const two = parse(TWO);
  check('two orders in one holder', two.length, '2', two.length === 2);

  // ---- the defect this gate hit on its own first run, kept as controls ----
  //
  // The real holder is a DOCUMENT. Its prose headings must not parse as orders,
  // and a fenced example inside one must not contribute fields to it. Before
  // the fix, this exact shape returned 5 orders and 20 refusals from a file
  // holding zero.
  const DOCUMENT = [
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
    '## SO-1: publish the audit branch',
    '',
    '- **Verbatim:** "when the gate is green you can push it yourself"',
    '- **Date:** 2026-09-02',
    '- **Condition:** the gate exits 0',
    '- **Holding session:** a-session-slug',
    '- **Status:** armed',
    '```',
    '',
    '## The gate',
    '',
    'Run it before believing anything.',
    '',
  ].join('\n');
  const docOrders = parse(DOCUMENT);
  check('prose headings in a document are not orders', docOrders.length, '0', docOrders.length === 0);
  check('a fenced example contributes no suspects', suspects(DOCUMENT).length, '0', suspects(DOCUMENT).length === 0);

  // The opposite risk the shape rule creates: a REAL order under a heading that
  // is not an order id would otherwise be silently skipped.
  const MISTITLED = VALID.replace('## SO-EXAMPLE: publish the audit branch', '## Publish the audit branch');
  check('a mis-titled real order is not parsed as one', parse(MISTITLED).length, '0', parse(MISTITLED).length === 0);
  check('a mis-titled real order IS reported as a suspect', suspects(MISTITLED).length, '1', suspects(MISTITLED).length === 1);

  const scratch = path.join(os.tmpdir(), `standing-orders-selftest-${process.pid}.md`);
  fs.writeFileSync(scratch, MISTITLED, 'utf8');
  const rc = run(scratch, TODAY);
  check('a holder with a mis-titled order exits 1', rc, '1', rc === 1);

  fs.writeFileSync(scratch, DOCUMENT, 'utf8');
  const rcDoc = run(scratch, TODAY);
  check('a document holding zero orders exits 0', rcDoc, '0', rcDoc === 0);
  fs.unlinkSync(scratch);

  // The real holder, if the operator has one, must be clean.
  const real = run(HOLDER, new Date().toISOString().slice(0, 10));
  if (real !== 0) {
    bad++;
    console.log('[selftest] FAIL the real holder has a refused order');
  }

  console.log(bad ? `[selftest] ${bad} failure(s)` : '[selftest] PASS');
  return bad ? 1 : 0;
}

// Exported so standing-order-wake.js reads orders through THIS parser rather
// than a second copy of it. A wake that parsed the holder its own way could
// fire an order the gate refuses, which is the one combination that must not
// exist.
module.exports = { parse, suspects, sections, fields, validate, statusWord, REQUIRED };

if (require.main === module) {
  if (process.argv.includes('--help')) {
    console.log('Usage: check-standing-orders.js [holder.md] [--selftest]');
    console.log('Validates that each standing order carries the four parts Q2 requires, plus Status.');
    console.log(`Default holder: ${HOLDER}`);
    process.exit(0);
  }
  process.exit(
    process.argv.includes('--selftest') ? selftest() : run(HOLDER, new Date().toISOString().slice(0, 10))
  );
}
