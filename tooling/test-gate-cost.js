#!/usr/bin/env node
// Suite for plugins/autodev-core/scripts/gate-cost.js.
//
// gate-cost reads the release records the full-gate queue leaves beside its
// lock and says how many lane hours each project's gates held. The numbers
// that matter are the ones a wrong parser gets wrong quietly: a hold that
// crosses midnight UTC, a hand-off that lasts seconds and must not count as a
// gate, a second run of a head already gated, a record outside the window,
// and a harness record whose meta carries no repo. Each fixture below plants
// one of those with a known answer, and the subject runs as a subprocess on
// AUTODEV_GATE_LOCK_PATH so nothing reads the machine's real locks.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'gate-cost.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cost-'));
const locks = path.join(tmp, 'locks');
fs.mkdirSync(locks);
let pass = 0, fail = 0;

const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' : ' + detail : '')); }
};

const hhmm = (ms) => { const d = new Date(ms); return String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0'); };
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
// Whole minutes, so a release name (minute resolution) is exact.
const now = Math.floor(Date.now() / MIN) * MIN;

// One record as the queue writes it: legacy lines, then `meta {json}`.
const record = (name, { what, arrival, cls, admitted, origin }) => {
  const meta = { schema: 1, runId: 'r-' + name, cls, admittedUtc: admitted ? new Date(admitted).toISOString() : undefined, repo: origin ? { origin } : null };
  const lines = ['4242', what];
  if (arrival) lines.push(new Date(arrival).toISOString());
  lines.push('class ' + cls);
  if (admitted || origin) lines.push('meta ' + JSON.stringify(meta));
  fs.writeFileSync(path.join(locks, name), lines.join('\n') + '\n', 'utf8');
};
const released = (lane, endMs, suffix = '') => `full-gate${lane > 1 ? '-' + lane : ''}.lock.released-${hhmm(endMs)}${suffix}`;

fs.writeFileSync(path.join(locks, 'full-gate.lanes'), '2\n', 'utf8');

// H1 and H2: two harness gates on ONE head, 70 and 60 minutes. Harness meta has repo null.
const h1 = now - 5 * HOUR;
record(released(1, h1 + 70 * MIN), { what: 'npm run gate (gate-lock.js), branch claude/x, head abc1234, worktree x', cls: 'harness', admitted: h1 });
const h2 = now - 3 * HOUR;
record(released(2, h2 + 60 * MIN), { what: 'npm run gate (gate-lock.js), branch claude/x, head abc1234, worktree x', cls: 'harness', admitted: h2 });
// P1: a product gate of 10 minutes, attributed by meta.repo.origin.
const p1 = now - 2 * HOUR - 7 * MIN;
record(released(1, p1 + 10 * MIN), { what: 'npm run gate, branch claude/y, head def5678, worktree y', cls: 'product', admitted: p1, origin: 'github.com/example-org/app-a' });
// P2: a one-minute hand-off on the same project. A record, not a gate.
const p2 = now - 90 * MIN - 3 * MIN;
record(released(2, p2 + 1 * MIN), { what: 'npm run gate, branch claude/z, head 9999999, worktree z', cls: 'product', admitted: p2, origin: 'github.com/example-org/app-a' });
// M1: crosses midnight UTC, 23:50 to 00:20, so 30 minutes and not -1410.
let m1 = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate(), 23, 50);
while (m1 + 30 * MIN > now - 30 * MIN) m1 -= DAY;
record(released(1, m1 + 30 * MIN, '-2'), { what: 'npm run gate, branch claude/m, head 1111111, worktree m', cls: 'product', admitted: m1, origin: 'github.com/example-org/app-b' });
// L1: a legacy record with no meta line. Its start is the ISO arrival line, its project the word before " gate".
const l1 = now - 4 * HOUR - 11 * MIN;
record(released(2, l1 + 12 * MIN), { what: 'shop gate 292 0bebac7, lock taken', cls: 'product', arrival: l1 });
// OLD: ten days ago, outside a 7-day window.
const o1 = now - 10 * DAY;
record(released(1, o1 + 40 * MIN, '-old'), { what: 'npm run gate (gate-lock.js), head 7777777', cls: 'harness', admitted: o1 });
// Files that are not release records are ignored.
fs.writeFileSync(path.join(locks, 'full-gate.lock'), '1\nlive holder\n', 'utf8');
fs.writeFileSync(path.join(locks, 'merge-a__b.lock.released-1200'), '1\nmerge\n', 'utf8');

const run = (args, env = {}) => spawnSync(process.execPath, [SUBJECT, ...args], {
  encoding: 'utf8',
  env: { ...process.env, AUTODEV_GATE_LOCK_PATH: path.join(locks, 'full-gate.lock'), ...env },
});
const listing = () => fs.readdirSync(locks).sort().map((n) => n + ':' + fs.statSync(path.join(locks, n)).mtimeMs).join('|');

const before = listing();
const r = run(['--days', '7', '--json']);
check('--json exits 0', r.status === 0, `status ${r.status} stderr ${r.stderr}`);
let j = null;
try { j = JSON.parse(r.stdout); } catch (e) { check('--json prints JSON', false, e.message + ' :: ' + r.stdout.slice(0, 200)); }
if (j) {
  const by = Object.fromEntries(j.byProject.map((p) => [p.project, p]));
  check('population: 6 records in the window, the 10-day-old one and non-records excluded', j.records === 6, `records ${j.records}`);
  check('gates are holds of 3+ minutes: 5 of the 6', j.gates === 5, `gates ${j.gates}`);
  const h = by['claude-auto-dev (harness)'];
  check('harness attributed from class with a null repo', !!h, Object.keys(by).join(','));
  if (h) {
    check('harness: 2 gates, 130 minutes, 2.17 lane hours', h.gates === 2 && Math.abs(h.laneHours - 130 / 60) < 0.01, JSON.stringify(h));
    check('harness: the second run of head abc1234 is one re-run', h.reruns === 1, `reruns ${h.reruns}`);
    check('harness: median of [60, 70] reported as 60 or 70', h.medianMin === 60 || h.medianMin === 70, `median ${h.medianMin}`);
  }
  const a = by['example-org/app-a'];
  check('product attributed from meta.repo.origin', !!a, Object.keys(by).join(','));
  if (a) check('app-a: 1 gate of 10 minutes and 1 short hand-off', a.gates === 1 && a.medianMin === 10 && a.short === 1, JSON.stringify(a));
  const b = by['example-org/app-b'];
  check('a hold across midnight UTC is 30 minutes', !!b && b.medianMin === 30, JSON.stringify(b));
  const s = by['shop'];
  check('legacy record: start from the ISO line, project from the word before " gate"', !!s && s.medianMin === 12, JSON.stringify(s));
  check('lanes read from full-gate.lanes', j.lanes === 2, `lanes ${j.lanes}`);
  const want = (70 + 60 + 10 + 30 + 12) / 60;
  check('total lane hours sum the gates only', Math.abs(j.totals.laneHours - want) < 0.01, `${j.totals.laneHours} vs ${want}`);
  check('available lane hours are days x 24 x lanes', j.totals.availableLaneHours === 7 * 24 * 2, String(j.totals.availableLaneHours));
}
check('reads only: the locks directory is unchanged', listing() === before);

const t = run(['--days', '7']);
check('human report exits 0', t.status === 0, t.stderr);
check('human report prints its population first', /^6 release records in 7 day\(s\), 5 gate\(s\) held a lane 3\+ min, 1 shorter hold\(s\)/m.test(t.stdout), t.stdout.slice(0, 300));
check('human report names the harness row', /claude-auto-dev \(harness\)\s*\|\s*2\s*\|/.test(t.stdout), t.stdout);

const w = run(['--days', '30', '--json']);
let jw = null; try { jw = JSON.parse(w.stdout); } catch { /* checked below */ }
check('--days 30 includes the 10-day-old record', !!jw && jw.records === 7, w.stdout.slice(0, 200));

const m = run(['--days', '7', '--min-hold', '0.5', '--json']);
let jm = null; try { jm = JSON.parse(m.stdout); } catch { /* checked below */ }
check('--min-hold 0.5 counts the one-minute hand-off as a gate', !!jm && jm.gates === 6, m.stdout.slice(0, 200));

const gone = run(['--json'], { AUTODEV_GATE_LOCK_PATH: path.join(tmp, 'nope', 'full-gate.lock') });
check('a missing locks directory is INDETERMINATE (exit 2), not an empty report', gone.status === 2 && /nope/.test(gone.stderr), `status ${gone.status} ${gone.stderr}`);
check('...and prints nothing on stdout', gone.stdout === '', gone.stdout);

const bad = run(['--frobnicate']);
check('an unknown flag is refused with exit 2', bad.status === 2 && /--frobnicate/.test(bad.stderr), `status ${bad.status} ${bad.stderr}`);
const badDays = run(['--days', 'x']);
check('a non-numeric --days is refused with exit 2', badDays.status === 2, `status ${badDays.status}`);

const help = run(['--help']);
check('--help exits 0 with usage', help.status === 0 && /usage: node gate-cost\.js/.test(help.stdout), help.stdout.slice(0, 200));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
