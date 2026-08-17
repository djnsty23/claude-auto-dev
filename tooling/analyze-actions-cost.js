#!/usr/bin/env node
// analyze-actions-cost.js — what GitHub Actions actually costs, from GitHub's own
// usage export.
//
// Run: node tooling/analyze-actions-cost.js <usageReport.csv>
// Export it from Settings → Billing → Usage → "Get usage report" (emailed to you).
//
// WHY A CSV AND NOT THE API
//
// This started as an API reconstruction and was wrong three different ways on
// 2026-08-17, each one producing a confident false conclusion:
//
//   1. It summed run_duration_ms, but billing counts each JOB. A matrix run bills
//      the sum of its jobs while the run's wall-clock counts the span once. That
//      undercounted one day by 4.7x.
//   2. It skipped public repos as "free", which is true of what you PAY and false
//      of what the usage chart SHOWS. A public repo's minutes appear in full in the
//      gross column. $12 of a $16 day was a public repo, and the audit went looking
//      for it in Codespaces and LFS.
//   3. No Actions endpoint exposes billed-vs-gross at all, so the whole discount
//      was invisible. Measured: $52.73 gross against $20.15 actually billed — a
//      report keyed on gross overstates the bill by 2.6x.
//
// The CSV carries workflow_path and net_amount, which settles all three. The
// billable.* fields on /actions/runs/{id}/timing read 0 for every repo on this
// account, so that endpoint cannot substitute even for the per-job half.
//
// GROSS vs BILLED: gross is list price for everything that ran. billed (net) is
// what you owe after included minutes and free-tier repos. Always lead with billed
// — gross is what makes a usage chart look alarming when nothing is wrong.

const fs = require('fs');

const file = process.argv[2];
if (!file) {
    console.error('Usage: node tooling/analyze-actions-cost.js <usageReport.csv>');
    console.error('Export from: Settings → Billing → Usage → Get usage report');
    process.exit(2);
}
if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(2);
}

// Strip the BOM GitHub prefixes, or the first header name carries it and every
// lookup on `date` silently returns undefined.
const txt = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
const lines = txt.trim().split(/\r?\n/);
if (lines.length < 2) { console.error('CSV has no data rows'); process.exit(2); }

const parse = (l) => l.split('","').map((s) => s.replace(/^"|"$/g, ''));
const hdr = parse(lines[0]);
const REQUIRED = ['date', 'sku', 'quantity', 'gross_amount', 'net_amount', 'repository', 'workflow_path'];
const missing = REQUIRED.filter((h) => !hdr.includes(h));
if (missing.length) {
    console.error('CSV is missing expected column(s): ' + missing.join(', '));
    console.error('Header seen: ' + hdr.join(', '));
    process.exit(2);
}

const rows = lines.slice(1).map((l) => {
    const c = parse(l);
    const o = {};
    hdr.forEach((h, i) => { o[h] = c[i]; });
    return o;
});
const num = (v) => Number(v || 0);

const days = [...new Set(rows.map((r) => r.date))].sort();
const gross = rows.reduce((a, r) => a + num(r.gross_amount), 0);
const net = rows.reduce((a, r) => a + num(r.net_amount), 0);

console.log(`population: ${rows.length} row(s), ${days.length} day(s) ${days[0]} → ${days[days.length - 1]}, `
    + `${new Set(rows.map((r) => r.repository)).size} repo(s), ${new Set(rows.map((r) => r.sku)).size} SKU(s)\n`);
console.log(`BILLED  $${net.toFixed(2)}        (gross $${gross.toFixed(2)}, discount $${(gross - net).toFixed(2)})`);
if (gross > 0) {
    console.log(`Reading the gross figure as your bill overstates it by ${(gross / Math.max(net, 0.01)).toFixed(1)}x.\n`);
}

// Daily run rate → month projection, based on the days actually covered.
const perDay = net / Math.max(days.length, 1);
console.log(`pace: $${perDay.toFixed(2)}/day billed → ~$${(perDay * 30).toFixed(2)}/month at this rate\n`);

function agg(keyFn, filter = () => true) {
    const m = new Map();
    for (const r of rows) {
        if (!filter(r)) continue;
        const k = keyFn(r);
        const e = m.get(k) || { q: 0, gross: 0, net: 0 };
        e.q += num(r.quantity);
        e.gross += num(r.gross_amount);
        e.net += num(r.net_amount);
        m.set(k, e);
    }
    return [...m].sort((a, b) => b[1].net - a[1].net || b[1].gross - a[1].gross);
}

const line = (label, v, w = 34) =>
    `  ${label.slice(0, w).padEnd(w + 1)}${v.q.toFixed(0).padStart(7)} u  billed $${v.net.toFixed(2).padStart(6)}  gross $${v.gross.toFixed(2).padStart(7)}`;

console.log('--- by SKU ---');
for (const [k, v] of agg((r) => r.sku)) console.log(line(k, v, 20));

console.log('\n--- by repository ---');
for (const [k, v] of agg((r) => r.repository || '(none)')) {
    const free = v.net === 0 && v.gross > 0 ? '   ← free (public), gross only' : '';
    console.log(line(k || '(none)', v, 22) + free);
}

console.log('\n--- workflows, by ACTUAL BILLED ---');
for (const [k, v] of agg((r) => `${r.repository} · ${(r.workflow_path || '(none)').replace('.github/workflows/', '')}`).slice(0, 15)) {
    console.log(line(k, v));
}

// A workflow whose gross is high but net is zero is free — worth separating so it
// is never mistaken for spend, which is exactly the error this tool exists to stop.
const freeOnly = agg((r) => r.repository).filter(([, v]) => v.net === 0 && v.gross > 1);
if (freeOnly.length) {
    console.log('\n--- FREE but loud in the usage chart (gross > $1, billed $0) ---');
    for (const [k, v] of freeOnly) {
        console.log(`  ${k.padEnd(24)} gross $${v.gross.toFixed(2)} — public repo, contributes $0 to the bill`);
    }
}

console.log('\n--- most expensive single day (billed) ---');
for (const [k, v] of agg((r) => r.date).slice(0, 3)) {
    console.log(`  ${k}  billed $${v.net.toFixed(2)}  (gross $${v.gross.toFixed(2)})`);
}
