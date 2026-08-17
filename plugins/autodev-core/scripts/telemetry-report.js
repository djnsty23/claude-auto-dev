#!/usr/bin/env node
// Summarise .claude/reports/telemetry-*.jsonl.
//
// A script rather than the inline `node -e` the 7.x skill used: this repo's
// conventions warn against nested quoting in -e, the shell mangles it
// differently on Windows, and a file can be tested. This one is.
//
// Usage: node telemetry-report.js [--days=N] [--dir=path]
//   --days=1 (default) today only; --days=7 the last week; --days=0 everything.

const fs = require('fs');
const path = require('path');

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const dir = arg('dir', path.join(process.cwd(), '.claude', 'reports'));
const days = Number(arg('days', '1'));

if (!fs.existsSync(dir)) {
  console.log(`No telemetry directory at ${dir}. The hook writes one on the first tool call.`);
  process.exit(0);
}

let files = fs.readdirSync(dir).filter((f) => /^telemetry-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
if (!files.length) { console.log(`No telemetry files in ${dir}.`); process.exit(0); }
if (days > 0) files = files.slice(-days);

const byTool = {};
const byDay = {};
let events = 0, malformed = 0, failures = 0;

for (const f of files) {
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { malformed++; continue; }
    events++;
    if (e.ok === false) failures++;
    const day = String(e.ts || '').slice(0, 10) || f.slice(10, 20);
    byDay[day] = (byDay[day] || 0) + 1;
    const t = (byTool[e.tool] ||= { calls: 0, bytes: 0, failed: 0 });
    t.calls++;
    t.bytes += (e.input_size || 0) + (e.output_size || 0);
    if (e.ok === false) t.failed++;
  }
}

// Population first: "Read is your top tool" means something different over 40
// events than over 4,000, and a zero here must be legible as a real zero.
console.log(`${events} events across ${files.length} file(s), ${Object.keys(byTool).length} distinct tools`
  + (malformed ? `, ${malformed} unparseable line(s)` : '')
  + (failures ? `, ${failures} failed call(s)` : ''));

if (!events) { console.log('Nothing recorded yet.'); process.exit(0); }

console.log('\nBy day:');
for (const [d, n] of Object.entries(byDay).sort()) console.log(`  ${d}  ${String(n).padStart(6)} events`);

console.log('\nBy tool:');
const rows = Object.entries(byTool).sort((a, b) => b[1].calls - a[1].calls).slice(0, 15);
for (const [tool, t] of rows) {
  console.log(`  ${tool.padEnd(16)} ${String(t.calls).padStart(6)} calls  ${String(Math.round(t.bytes / 1024)).padStart(7)} KB`
    + (t.failed ? `  ${t.failed} failed` : ''));
}

const totalKb = Math.round(Object.values(byTool).reduce((a, t) => a + t.bytes, 0) / 1024);
console.log(`\nTotal payload: ${totalKb} KB. Sizes only — no tool content is ever logged.`);
