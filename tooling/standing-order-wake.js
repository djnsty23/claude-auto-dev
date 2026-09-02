#!/usr/bin/env node
'use strict';
// One wake over the standing-order holder: which armed orders are ready, and
// the once-only transition that stops the next wake re-firing them.
//
// C4 asks that a conditional order "happens within one wake interval, once,
// with the order's origin logged". Once is the hard clause. It needs state a
// LATER wake can read, and the holder carries it in `Status`. A marker file
// under a temp dir would vanish on a reinstall while the order stayed armed,
// and the order would then re-fire.
//
// WRITE BEFORE ACT, deliberately. `arm()` sets `Status: executed <ts>` and
// returns the order for the caller to act on. A session that dies between the
// write and the action leaves an order that never fired, so the operator finds
// a stale `executed` rather than a doubled push. For an authorisation to
// publish, the skipped action is recoverable by asking and the duplicated one
// is not.
//
// TWO KINDS OF CONDITION, because an order is written in English and only some
// English is machine-checkable:
//   - `Check:` carries a shell command. Exit 0 means the condition holds, and
//     a wake can evaluate it with nobody watching.
//   - Without `Check:`, the `Condition` is prose and the wake reports the order
//     as needing judgement. It never guesses.
// A wake that treated an unevaluable condition as false would silently hold an
// order forever; one that treated it as true would fire on a condition nobody
// checked. Neither is acceptable, so it is a third outcome rather than a
// boolean.
//
// Usage: standing-order-wake.js [holder.md] [--commit] [--selftest]
// Reports only unless --commit is given: a wake run casually must not mutate
// the operator's holder as a side effect.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const gate = require('./check-standing-orders.js');

const DEFAULT_HOLDER = path.join(os.homedir(), 'claude-memory', 'STANDING-ORDERS.md');

// Evaluate one order. Returns 'holds', 'pending' or 'needs-judgement'.
function evaluate(order, runner) {
  const check = order.fields.check;
  if (!check) return 'needs-judgement';
  const r = runner(check);
  return r === 0 ? 'holds' : 'pending';
}

const shell = (cmd) => {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: 60000 });
  return r.status === null ? 1 : r.status;
};

// Rewrite one order's Status line in the ORIGINAL text. The parser strips
// fenced blocks to decide what an order is; the rewrite must not, or it would
// write back a holder with its examples deleted.
function setStatus(text, title, value) {
  const lines = text.split(/\r?\n/);
  let inOrder = false;
  let inFence = false;
  let done = false;
  const out = lines.map((l) => {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    if (!inFence && /^##\s+/.test(l)) inOrder = l.includes(title);
    if (inOrder && !inFence && !done && /^([-*]?\s*)\*\*Status:\*\*/.test(l)) {
      done = true;
      return l.replace(/(\*\*Status:\*\*).*$/, `$1 ${value}`);
    }
    return l;
  });
  if (!done) throw new Error(`no Status line found for order ${title}`);
  return out.join('\n');
}

function wake(holder, opts = {}) {
  const commit = Boolean(opts.commit);
  const runner = opts.runner || shell;
  const now = opts.now || new Date().toISOString();

  if (!fs.existsSync(holder)) {
    return { holder, orders: 0, armed: 0, fired: [], pending: [], judgement: [], missing: true };
  }
  let text = fs.readFileSync(holder, 'utf8');
  const orders = gate.parse(text);
  const armed = orders.filter((o) => gate.statusWord(o) === 'armed');

  const fired = [];
  const pending = [];
  const judgement = [];

  for (const o of armed) {
    const verdict = evaluate(o, runner);
    if (verdict === 'holds') {
      // Write first. See the header: at-most-once beats at-least-once here.
      text = setStatus(text, o.title, `executed ${now}`);
      if (commit) fs.writeFileSync(holder, text, 'utf8');
      fired.push(o);
    } else if (verdict === 'pending') pending.push(o);
    else judgement.push(o);
  }

  return { holder, orders: orders.length, armed: armed.length, fired, pending, judgement, missing: false };
}

function report(r) {
  if (r.missing) {
    console.log(`[wake] NO HOLDER at ${r.holder}: 0 orders, nothing evaluated`);
    return 0;
  }
  console.log(
    `[wake] ${r.holder}: ${r.orders} order(s), ${r.armed} armed, ` +
      `${r.fired.length} fired, ${r.pending.length} pending, ${r.judgement.length} needing judgement`
  );
  // The origin log C4 asks for: which order, whose words, when it was given.
  for (const o of r.fired) {
    console.log(`[wake] FIRED "${o.title}" | order given ${o.fields.date} | held by ${o.fields['holding session']}`);
    console.log(`[wake]   verbatim: ${o.fields.verbatim}`);
  }
  for (const o of r.pending) console.log(`[wake] pending "${o.title}": ${o.fields.check}`);
  for (const o of r.judgement) {
    console.log(`[wake] needs judgement "${o.title}": ${o.fields.condition}`);
  }
  return 0;
}

module.exports = { wake, evaluate, setStatus };

if (require.main === module) {
  if (process.argv.includes('--help')) {
    console.log('Usage: standing-order-wake.js [holder.md] [--commit]');
    console.log('Reports which armed orders are ready. Writes Status only with --commit.');
    console.log(`Default holder: ${DEFAULT_HOLDER}`);
    process.exit(0);
  }
  const holder = process.argv.slice(2).find((a) => !a.startsWith('--')) || DEFAULT_HOLDER;
  process.exit(report(wake(holder, { commit: process.argv.includes('--commit') })));
}
