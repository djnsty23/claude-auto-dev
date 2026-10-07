#!/usr/bin/env node
'use strict';
/**
 * gate-cost.js - how many lane hours the machine's full gates held, per project.
 *
 * WHY THIS EXISTS. The full-gate queue (full-gate-queue.js) serves a few lanes
 * to every product and harness gate on the machine. When a harness gate waits
 * four hours for a lane, the question is where the lane hours went, and the
 * answer is already on disk: every holder's lock file is renamed to
 * `full-gate[-N].lock.released-HHMM` (or `.stale-HHMM`) when it lets go. This
 * reads those records and prints, per project: gates run, median and p90 hold,
 * lane hours, and how many runs re-gated a head already gated in the window.
 * It reads only. It deletes, renames and writes nothing.
 *
 * WHAT ONE RECORD SAYS
 *   start  `meta {json}` admittedUtc, else the ISO arrival line a ticket and a
 *          lock carry on line 3. A record with neither is skipped and counted.
 *   end    the HHMM (UTC) in the file name, on the first day at or after the
 *          start. The file's own times are not the release: a hand-over
 *          rewrites the lock in place, so its ctime is the last write.
 *   who    meta.repo.origin, else class harness or a gate-lock.js command line
 *          (harness meta carries repo null), else the word before " gate" on
 *          line 2 in a hand-written record, else "unattributed".
 *   head   "head <sha>" on line 2, else "<name> gate <n> <sha>".
 * A hold shorter than --min-hold minutes (default 3) is a hand-off or a
 * refusal, not a gate: it is counted under "short" and not in lane hours.
 *
 * LIMITS. A release name has minute resolution, so a hold is exact to a
 * minute. One name per HHMM per lane: a second release in the same minute
 * takes a suffix on Windows and may replace the first on POSIX, so the count
 * is a floor there. Holds over 24 hours read as their remainder.
 *
 *   node gate-cost.js                  last 7 days, one row per project
 *   node gate-cost.js --days 30 --json
 *   node gate-cost.js --min-hold 1     count holds of 1+ minutes as gates
 *
 * The locks directory is the one beside AUTODEV_GATE_LOCK_PATH, else
 * ~/.claude/autodev/locks, as full-gate-queue.js resolves it.
 *
 * Exit 0 measured (an empty window prints its zero population). Exit 2 when
 * the locks directory cannot be read, or on a flag it does not know.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const USAGE = 'usage: node gate-cost.js [--days N] [--min-hold MINUTES] [--json]\n'
  + 'Lane hours the full-gate queue served per project, from the .released-HHMM and\n'
  + '.stale-HHMM records beside the lock. Reads only. Exit 2 when the locks directory\n'
  + 'cannot be read.';
const MIN = 60e3;
const RECORD = /^full-gate(?:-(\d+))?\.lock\.(released|stale)-(\d{2})(\d{2})(?:[-.].*)?$/;
const HARNESS = 'claude-auto-dev (harness)';

function parseArgs(argv) {
  const opts = { days: 7, minHold: 3, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--days' || a === '--min-hold') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) return { error: `${a} needs a number, got ${argv[i] === undefined ? 'nothing' : JSON.stringify(argv[i])}` };
      if (a === '--days') opts.days = n; else opts.minHold = n;
    } else return { error: `unknown argument ${a}` };
  }
  return { opts };
}

// One release record, or null when it carries no start time.
function readRecord(dir, name, m) {
  const text = fs.readFileSync(path.join(dir, name), 'utf8');
  const lines = text.split(/\r?\n/);
  let meta = null;
  const metaLine = lines.find((l) => l.startsWith('meta '));
  try { meta = metaLine ? JSON.parse(metaLine.slice(5)) : null; } catch { meta = null; }
  const iso = lines.find((l) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(l.trim()));
  const start = meta && meta.admittedUtc ? Date.parse(meta.admittedUtc) : (iso ? Date.parse(iso.trim()) : NaN);
  if (!Number.isFinite(start)) return null;
  const d = new Date(start);
  let end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(m[3]), Number(m[4]));
  if (end < start - MIN) end += 24 * 60 * MIN;
  const what = lines[1] || '';
  const cls = (meta && meta.cls) || (text.match(/^class (\w+)/m) || [])[1] || null;
  let project = meta && meta.repo && meta.repo.origin ? String(meta.repo.origin).replace(/^github\.com\//, '') : null;
  if (!project && (cls === 'harness' || /gate-lock\.js/.test(what))) project = HARNESS;
  if (!project) project = (what.match(/^([A-Za-z][\w.-]*) gate\b/) || [])[1] || 'unattributed';
  const head = (what.match(/\bhead ([0-9a-f]{7,40})\b/) || what.match(/^\S+ gate \S+ ([0-9a-f]{7,40})\b/) || [])[1] || null;
  return { name, lane: Number(m[1] || 1), kind: m[2], project, head: head && head.slice(0, 7), start, holdMin: (end - start) / MIN };
}

function quantile(sorted, q) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null;
}

function summarise(records, opts, lanes) {
  const by = new Map();
  let gates = 0, laneMin = 0;
  for (const r of records) {
    const p = by.get(r.project) || { project: r.project, holds: [], short: 0, heads: new Map() };
    by.set(r.project, p);
    if (r.holdMin < opts.minHold) { p.short++; continue; }
    gates++; laneMin += r.holdMin;
    p.holds.push(r.holdMin);
    if (r.head) p.heads.set(r.head, (p.heads.get(r.head) || 0) + 1);
  }
  const byProject = [...by.values()].map((p) => {
    const s = p.holds.slice().sort((a, b) => a - b);
    const sum = s.reduce((a, b) => a + b, 0);
    return {
      project: p.project, gates: s.length, short: p.short,
      medianMin: s.length ? Math.round(quantile(s, 0.5) * 10) / 10 : null,
      p90Min: s.length ? Math.round(quantile(s, 0.9) * 10) / 10 : null,
      laneHours: Math.round((sum / 60) * 100) / 100,
      reruns: [...p.heads.values()].reduce((a, n) => a + n - 1, 0),
    };
  }).sort((a, b) => b.laneHours - a.laneHours || a.project.localeCompare(b.project));
  const available = opts.days * 24 * lanes;
  return {
    days: opts.days, minHoldMin: opts.minHold, lanes, records: records.length, gates,
    byProject,
    totals: { laneHours: Math.round((laneMin / 60) * 100) / 100, availableLaneHours: available, utilisation: available ? Math.round((laneMin / 60 / available) * 1000) / 1000 : null },
  };
}

function render(s, skipped) {
  const out = [];
  out.push(`${s.records} release records in ${s.days} day(s), ${s.gates} gate(s) held a lane ${s.minHoldMin}+ min, ${s.records - s.gates} shorter hold(s)` + (skipped ? `, ${skipped} record(s) with no start time skipped` : ''));
  out.push('');
  out.push('project | gates | median min | p90 min | lane hours | re-runs of one head | short holds');
  for (const p of s.byProject) out.push(`${p.project} | ${p.gates} | ${p.medianMin ?? '-'} | ${p.p90Min ?? '-'} | ${p.laneHours} | ${p.reruns} | ${p.short}`);
  out.push('');
  out.push(`lane hours ${s.totals.laneHours} of ${s.totals.availableLaneHours} available at ${s.lanes} lane(s)` + (s.totals.utilisation != null ? ` (${(s.totals.utilisation * 100).toFixed(1)}%)` : ''));
  return out.join('\n') + '\n';
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) { process.stderr.write(`gate-cost: ${parsed.error}\n${USAGE}\n`); process.exitCode = 2; return; }
  const opts = parsed.opts;
  if (opts.help) { process.stdout.write(USAGE + '\n'); return; }
  const lockPath = path.resolve(process.env.AUTODEV_GATE_LOCK_PATH || path.join(os.homedir(), '.claude', 'autodev', 'locks', 'full-gate.lock'));
  const dir = path.dirname(lockPath);
  let names;
  try { names = fs.readdirSync(dir); } catch (e) {
    process.stderr.write(`gate-cost: INDETERMINATE, cannot read the locks directory ${dir}: ${e.code || e.message}\n`);
    process.exitCode = 2; return;
  }
  let lanes = 1;
  try { const n = Number(fs.readFileSync(path.join(dir, 'full-gate.lanes'), 'utf8').trim()); if (Number.isInteger(n) && n > 0) lanes = n; } catch { /* one lane, the queue's own default */ }
  const since = Date.now() - opts.days * 24 * 60 * MIN;
  const records = [];
  let skipped = 0;
  for (const name of names) {
    const m = name.match(RECORD);
    if (!m) continue;
    let r = null;
    try { r = readRecord(dir, name, m); } catch { r = null; }
    if (!r) { skipped++; continue; }
    if (r.start >= since) records.push(r);
  }
  const s = summarise(records, opts, lanes);
  s.skipped = skipped;
  process.stdout.write(opts.json ? JSON.stringify(s, null, 2) + '\n' : render(s, skipped));
}

main();
