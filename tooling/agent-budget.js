#!/usr/bin/env node
// agent-budget.js — decide how many agents to spawn, from MEASURED state rather than a fixed cap.
//
// `rule-agent-concurrency` already answers "what is the ceiling" (5-6 ultra, 3-4 normal) and
// "which model" (Opus 5 xhigh on the one agent whose judgement decides it, high on the rest).
// Those are good and this does not replace them. It answers the two questions the rule cannot,
// because both depend on state only measurable at spawn time:
//
//   1. HOW MUCH OF THE WINDOW IS ALREADY GONE. A 5-hour usage window burned in thirty minutes
//      is not a concurrency problem, it is a pacing problem, and a fixed cap cannot see it. Six
//      agents is right at the start of a window and wrong with twenty minutes of budget left.
//   2. WHO ELSE IS RUNNING. Sessions share one account quota. A fan-out that is polite in
//      isolation starves a sibling session doing real work — and this is not hypothetical: an
//      A/B run in this project had to record a third session as an uncontrolled confound
//      because nobody checked.
//
// MEASURED INPUTS, from `analyze-agent-cost.js` over real transcripts:
//   subagent      ~104,759 prompt tokens/call · $0.1213/call · 93.9% cache read
//   main thread   ~423,855 prompt tokens/call · $0.2926/call · 99.1% cache read
//   a subagent averages ~41 calls, so ONE AGENT ≈ $5 and a six-agent wave ≈ $30.
// Re-derive with `npm run check:agent-cost` when usage shifts; a pacing rule written against
// stale figures is worse than none.
//
//   node tooling/agent-budget.js --lenses 4 --verify adversarial
//   node tooling/agent-budget.js --selftest
'use strict';

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE;
const ROOT = process.env.AGENT_BUDGET_ROOT || path.join(HOME, '.claude', 'projects');

const WINDOW_HOURS = 5;          // the rolling usage window
const AGENT_CALLS = 41;          // measured mean calls per subagent
const AGENT_USD = 4.95;          // measured mean cost per subagent
const ACTIVE_MIN = 20;           // a session touched within this many minutes is "live"

/* The ceiling from rule-agent-concurrency. This tool only ever spends BELOW it. */
const CEIL_ULTRA = 6;
const CEIL_NORMAL = 4;

/* ---------------------------------------------------------------- measure */
function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/* Live sessions, by transcript mtime. Deliberately NOT a process scan: a session on another
 * machine sharing the account writes no local process, and the quota is per account. */
function liveSessions(now, selfSession) {
  const cutoff = now - ACTIVE_MIN * 60000;
  const seen = new Set();
  for (const f of walk(ROOT)) {
    if (f.includes('/subagents/')) continue;          // subagent files are not sessions
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < cutoff) continue;
    const id = path.basename(f, '.jsonl');
    if (selfSession && id === selfSession) continue;
    seen.add(id);
  }
  return seen.size;
}

/* Calls already spent inside the window, across every session on this account. Counts records
 * rather than parsing them: a line is a request, which is the unit the window meters. */
function windowSpend(now) {
  const cutoff = now - WINDOW_HOURS * 3600000;
  let calls = 0, files = 0;
  for (const f of walk(ROOT)) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < cutoff) continue;               // untouched this window
    files++;
    try {
      /* COUNT RECORDS INSIDE THE WINDOW, not lines in a touched file. The first version
       * counted every line of any file modified this window and called the over-count
       * "failing safe" — it reported 7,825 calls against a 4,000 budget on a machine that
       * had plainly not spent that, saturating the check into always returning zero. An
       * over-count that saturates is not conservative, it is broken: it makes the tool
       * answer the same thing regardless of input, which is the "verdict without a
       * measurement" failure in one more costume.
       * Regex over the timestamp rather than JSON.parse per line: same answer, and these
       * files run to hundreds of thousands of records. */
      const txt = fs.readFileSync(f, 'utf8');
      for (const m of txt.matchAll(/"timestamp"\s*:\s*"([^"]+)"/g)) {
        const t = Date.parse(m[1]);
        if (t >= cutoff) calls++;
      }
    } catch { /* unreadable transcript is not a reason to spend more */ }
  }
  return { calls, files };
}

/* ---------------------------------------------------------------- allocate */
/* Exported for the self-test: the arithmetic must be checkable without a filesystem. */
function allocate({ lenses, verify, live, windowCalls, windowBudgetCalls, ultra }) {
  const reasons = [];
  const ceiling = ultra ? CEIL_ULTRA : CEIL_NORMAL;

  /* 1 · what the TASK justifies. Independent lenses, plus one judge when a wrong answer is
   *     more expensive than a slow one, plus one synthesiser when there is anything to merge. */
  let want = Math.max(1, lenses | 0);
  if (verify === 'adversarial') { want += 1; reasons.push('adversarial verify: +1 judge'); }
  if (want > 1) { want += 1; reasons.push('multiple lenses: +1 synthesis'); }
  reasons.unshift(`${lenses} independent lens(es)`);

  /* 2 · the ceiling from rule-agent-concurrency. A plan needing more needs a SECOND WAVE,
   *     narrowed by the first — which is usually the better result anyway. */
  let n = Math.min(want, ceiling);
  if (want > ceiling) reasons.push(`capped at ${ceiling} (${ultra ? 'ultra' : 'normal'}) — run a second wave instead of a bigger one`);

  /* 3 · the window. A wave may take at most a FIFTH of what remains, so roughly five more
   *     waves fit before the window is gone. This is the part a fixed cap cannot do. */
  const remaining = Math.max(0, windowBudgetCalls - windowCalls);
  const affordable = Math.floor((remaining / 5) / AGENT_CALLS);
  if (affordable < n) {
    reasons.push(`window: ${remaining} call(s) left of ${windowBudgetCalls}, a wave may take a fifth → ${affordable} agent(s)`);
    n = affordable;
  }

  /* 4 · other sessions share the quota. Divide, do not just warn — a warning nobody reads is
   *     how the A/B round-one confound happened. */
  /* The floor of 1 is so a shared window still lets SOME work happen — but it must not
   * resurrect a hard zero from the window check above. The first live run printed
   * "0 agent(s)" from the window and then spawned 1 anyway, because Math.max(1, 0/3) is 1.
   * A guard that fires when it should not is the defect this whole harness keeps finding. */
  if (live > 0 && n > 0) {
    const shared = Math.max(1, Math.floor(n / (live + 1)));
    if (shared < n) reasons.push(`${live} other live session(s): share the window → ${shared}`);
    n = shared;
  } else if (live > 0) {
    reasons.push(`${live} other live session(s), but the window is already spent — zero stands`);
  }

  n = Math.max(0, n);
  const roles = [];
  if (n > 0) {
    const judge = verify === 'adversarial' && n >= 3;
    const synth = n >= 3;
    const probes = n - (judge ? 1 : 0) - (synth ? 1 : 0);
    for (let i = 0; i < probes; i++) roles.push({ role: 'probe', model: 'opus-5', effort: 'high' });
    if (judge) roles.push({ role: 'judge', model: 'opus-5', effort: 'xhigh' });
    if (synth) roles.push({ role: 'synthesis', model: 'opus-5', effort: 'xhigh' });
  }
  return { n, roles, reasons, estUsd: Math.round(n * AGENT_USD * 100) / 100, estCalls: n * AGENT_CALLS };
}

/* -------------------------------------------------------------------- cli */
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};

function main() {
  const now = Date.now();
  const lenses = Number(arg('lenses', '3'));
  const verify = arg('verify', 'none');
  const ultra = process.argv.includes('--ultra') || verify === 'adversarial';
  const budget = Number(arg('window-calls', '4000'));   // calls assumed available per window
  const live = liveSessions(now, arg('self', ''));
  const spend = windowSpend(now);

  const r = allocate({ lenses, verify, live, windowCalls: spend.calls, windowBudgetCalls: budget, ultra });

  console.log('\nagent-budget — measured, not assumed\n');
  console.log('  window        ' + spend.calls + ' call(s) across ' + spend.files
    + ' transcript(s) touched in the last ' + WINDOW_HOURS + 'h (of ~' + budget + ')');
  console.log('  other live    ' + live + ' session(s) active in the last ' + ACTIVE_MIN + ' min');
  console.log('  unit cost     ~' + AGENT_CALLS + ' calls · ~$' + AGENT_USD + ' per agent (measured)');
  console.log('\n  → SPAWN ' + r.n + ' agent(s)   ≈ ' + r.estCalls + ' calls · ≈ $' + r.estUsd + '\n');
  for (const x of r.reasons) console.log('      · ' + x);
  if (r.n === 0) {
    console.log('\n  Zero is a real answer: the window cannot afford a wave. Do it on the main thread,');
    console.log('  or wait. A fan-out that exhausts the window costs more than the time it saves.');
  } else {
    console.log('');
    for (const x of r.roles) console.log('      ' + x.role.padEnd(10) + x.model + ' · ' + x.effort);
  }
  console.log('\n  Re-derive the unit cost with `npm run check:agent-cost` when usage shifts.\n');
}

/* --------------------------------------------------------------- selftest */
function selftest() {
  const B = { lenses: 4, verify: 'adversarial', live: 0, windowCalls: 0, windowBudgetCalls: 4000, ultra: true };
  const cases = [
    ['4 lenses + adversarial verify wants 6 and gets 6', allocate(B).n, 6],
    ['the ultra ceiling holds at 6 even for 20 lenses', allocate({ ...B, lenses: 20 }).n, 6],
    ['normal mode caps at 4', allocate({ ...B, lenses: 20, verify: 'none', ultra: false }).n, 4],
    ['a nearly spent window shrinks the wave',
      allocate({ ...B, windowCalls: 3600 }).n, Math.floor((400 / 5) / AGENT_CALLS)],
    ['an exhausted window returns ZERO, not one',
      allocate({ ...B, windowCalls: 4000 }).n, 0],
    ['one other live session halves the wave', allocate({ ...B, live: 1 }).n, 3],
    ['three other sessions cut it to a quarter', allocate({ ...B, live: 3 }).n, 1],
    ['sharing never returns zero while budget remains', allocate({ ...B, live: 99 }).n, 1],
    ['but sharing must NOT resurrect a zero from an exhausted window',
      allocate({ ...B, windowCalls: 4000, live: 3 }).n, 0],
    ['a single lens is one agent, no judge, no synthesis',
      allocate({ ...B, lenses: 1, verify: 'none' }).n, 1],
    ['the judge and synthesis get xhigh, probes get high',
      allocate(B).roles.filter((r) => r.effort === 'xhigh').length, 2],
  ];
  let pass = 0, fail = 0;
  for (const [label, got, want] of cases) {
    const ok = got === want;
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : `   got ${got}, want ${want}`));
    ok ? pass++ : fail++;
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();
else main();

module.exports = { allocate, liveSessions, windowSpend };
