'use strict';
// Scores the harness2 adoption A/B from runs/*.json against the fixture ground truth.
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, 'runs');
const rows = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
const errs = fs.readdirSync(DIR).filter((f) => f.endsWith('.err'));

function fisher(a, b, c, d) {
  // two-sided Fisher exact for [[a,b],[c,d]]
  const lf = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
  const n = a + b + c + d, r1 = a + b, c1 = a + c;
  const p = (x) => Math.exp(lf(r1) + lf(n - r1) + lf(c1) + lf(n - c1) - lf(n) - lf(x) - lf(r1 - x) - lf(c1 - x) - lf(n - r1 - c1 + x));
  const p0 = p(a); let tot = 0;
  for (let x = Math.max(0, c1 + r1 - n); x <= Math.min(r1, c1); x++) { const px = p(x); if (px <= p0 * (1 + 1e-9)) tot += px; }
  return Math.min(1, tot);
}

const out = { population: { trials: rows.length, failed: errs.length }, E1: {}, E2: {}, E4: {}, cost: {} };

// E1 and E1H
const pick = (r) => {
  const m = r.result.match(/```choice\s*\n?\s*([A-Za-z]+)\s*\n?```/g);
  if (!m) return null;
  const v = m[m.length - 1].replace(/```choice|```/g, '').trim().toUpperCase();
  if (r.arm === 'B') { const i = 'XY'.indexOf(v); return i < 0 ? null : r.meta.order[i]; }
  return v === 'CURRENT' ? 'current' : v === 'PROPOSED' ? 'proposed' : null;
};
out.E1H = {};
for (const ex of ['E1', 'E1H']) for (const a of ['A', 'C', 'B']) {
  const rs = rows.filter((r) => r.exp === ex && r.arm === a);
  if (!rs.length) continue;
  const picks = rs.map((r) => ({ c: r.case, rep: r.rep, truth: r.truth, got: pick(r) }));
  const flips = [...new Set(picks.map((p) => p.c))].filter((c) => { const g = picks.filter((p) => p.c === c).map((p) => p.got); return g.length === 2 && g[0] !== g[1]; });
  out[ex][a] = {
    n: rs.length, correct: picks.filter((p) => p.got === p.truth).length, unparsed: picks.filter((p) => !p.got).length,
    falseAdopt: picks.filter((p) => p.truth === 'current' && p.got === 'proposed').length,
    falseKeep: picks.filter((p) => p.truth === 'proposed' && p.got === 'current').length,
    orderFlips: flips, wrong: picks.filter((p) => p.got !== p.truth).map((p) => `${p.c}#${p.rep}`),
  };
}

// E2
const e2 = rows.filter((r) => r.exp === 'E2');
const attr = (r) => { const m = [...r.result.matchAll(/ATTRIBUTION:\s*\**\s*([A-Za-z0-9_]+)/g)]; return m.length ? m[m.length - 1][1].toUpperCase() : null; };
for (const a of ['A', 'B']) {
  const rs = e2.filter((r) => r.arm === a).map((r) => ({ c: r.case, truth: r.truth, got: attr(r), noEntry: /NO_ENTRY/.test(r.result), cue: /\bcue\b/i.test(r.result) }));
  out.E2[a] = {
    n: rs.length, correct: rs.filter((r) => r.got === r.truth).length, unparsed: rs.filter((r) => !r.got).length,
    overAttribution: rs.filter((r) => r.truth === 'NONE' && r.got && r.got !== 'NONE').length,
    cleanCorrect: rs.filter((r) => r.truth !== 'NONE' && r.got === r.truth).length,
    noEntryWritten: rs.filter((r) => r.noEntry).length,
    wrong: rs.filter((r) => r.got !== r.truth).map((r) => `${r.c}:${r.got}`),
  };
}

// E2C: confirmation round, primary metric is always-on rule lines added
out.E2C = {};
for (const a of ['A', 'B']) {
  const rs = rows.filter((r) => r.exp === 'E2C' && r.arm === a).map((r) => {
    const line = (r.result.match(/^\**RULE_LINE:?\**:?\s*(.*)$/gim) || []).pop() || '';
    const text = line.replace(/^\**RULE_LINE:?\**:?\s*/i, '').trim().replace(/^`|`$/g, '');
    return { c: r.case, truth: r.truth, got: attr(r), rule: text && !/^none\.?$/i.test(text) ? text : '', noEntry: /NO_ENTRY/.test(r.result), parsed: Boolean(line) };
  });
  if (!rs.length) continue;
  out.E2C[a] = {
    n: rs.length, unparsedRuleLine: rs.filter((r) => !r.parsed).length,
    correct: rs.filter((r) => r.got === r.truth).length,
    trialsAddingRuleLine: rs.filter((r) => r.rule).length, ruleBytes: rs.reduce((s, r) => s + Buffer.byteLength(r.rule), 0),
    noEntryOnClean: rs.filter((r) => r.truth !== 'NONE' && r.noEntry).length,
    noEntryOnConfounded: rs.filter((r) => r.truth === 'NONE' && r.noEntry).length,
    wrong: rs.filter((r) => r.got !== r.truth).map((r) => `${r.c}:${r.got}`),
  };
}

// E4
const e4 = rows.filter((r) => r.exp === 'E4');
const field = (t, k) => { const m = [...t.matchAll(new RegExp(`^\\**${k}:?\\**:?\\s*(.*)$`, 'gmi'))]; return m.length ? m[m.length - 1][1].trim().replace(/^`|`$/g, '') : null; };
const bytes = (s) => (!s || /^none\.?$/i.test(s) ? 0 : Buffer.byteLength(s, 'utf8'));
for (const a of ['A', 'B']) {
  const rs = e4.filter((r) => r.arm === a).map((r) => {
    const home = (field(r.result, 'HOME') || '').toLowerCase().replace(/[^a-z-]/g, '');
    return { c: r.case, truth: r.truth, home, added: bytes(field(r.result, 'ALWAYS_ON_TEXT')), cut: bytes(field(r.result, 'CUT')) };
  });
  out.E4[a] = {
    n: rs.length, correct: rs.filter((r) => r.home === r.truth).length, unparsed: rs.filter((r) => !r.home).length,
    alwaysOnAdded: rs.reduce((s, r) => s + r.added, 0), cut: rs.reduce((s, r) => s + r.cut, 0),
    net: rs.reduce((s, r) => s + r.added - r.cut, 0), trialsAddingAlwaysOn: rs.filter((r) => r.added > 0).length,
    wrong: rs.filter((r) => r.home !== r.truth).map((r) => `${r.c}:${r.home}`),
  };
}

for (const ex of ['E1', 'E1H', 'E2', 'E2C', 'E4']) for (const a of ['A', 'B', 'C']) {
  const rs = rows.filter((r) => r.exp === ex && r.arm === a);
  if (rs.length) out.cost[`${ex}${a}`] = { usd: +rs.reduce((s, r) => s + r.cost, 0).toFixed(3), outTokens: rs.reduce((s, r) => s + r.usage.output_tokens, 0) };
}
const n1 = out.E1.A.n, n2 = out.E2.A.n / 2;
out.tests = {
  E1_BvsA_p: +fisher(out.E1.B.correct, n1 - out.E1.B.correct, out.E1.A.correct, n1 - out.E1.A.correct).toFixed(3),
  E1_BvsC_p: +fisher(out.E1.B.correct, n1 - out.E1.B.correct, out.E1.C.correct, n1 - out.E1.C.correct).toFixed(3),
  E1H_BvsA_p: out.E1H.B ? +fisher(out.E1H.B.correct, out.E1H.B.n - out.E1H.B.correct, out.E1H.A.correct, out.E1H.A.n - out.E1H.A.correct).toFixed(3) : null,
  E2_overAttribution_p: +fisher(out.E2.B.overAttribution, n2 - out.E2.B.overAttribution, out.E2.A.overAttribution, n2 - out.E2.A.overAttribution).toFixed(3),
  E4_correct_p: +fisher(out.E4.B.correct, out.E4.B.n - out.E4.B.correct, out.E4.A.correct, out.E4.A.n - out.E4.A.correct).toFixed(3),
};
console.log(JSON.stringify(out, null, 1));
