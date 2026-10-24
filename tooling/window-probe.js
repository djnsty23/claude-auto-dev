#!/usr/bin/env node
'use strict';
// window-probe.js: the operational probes behind the scorecard's "<x>-window" criteria.
//
// Every aspect in docs/scorecard-criteria.json has one operational criterion worth 2
// whose `needs` asks for real use over 14 days. A fixture proves the code can do the
// right thing. A window proves the installed harness did it, every day, on real work.
// This engine reads the records the harness already writes and grades one window.
//
//   node tooling/window-probe.js <criterion> [--home DIR] [--repo DIR] [--now ISO] [--json]
//
// --home is the profile's config dir (default: claude-paths.js configDir()), --repo the
// checkout whose git history a spec may read, --now pins the clock for tests.
//
// THE WINDOW is the 14 complete UTC days before today. Today never counts: a day that
// has not ended cannot be complete. Each spec turns its source into records
// { at, ok, why } and, per day, says whether that day carries evidence. The verdict is
//   PASS  every one of the 14 days is covered, no record in the window failed, and the
//         spec's own totals (a rate, a floor, a drill) hold.
//   FAIL  a gap day, a failed record, or a total short of the needs. Each is printed.
//   exit 2, COULD NOT READ  the source is missing or unreadable. Never a zero.
//
// A day counts only from a spec's `admissibleFrom`: the first day its writer recorded
// the same kind of evidence completely. Days before it are gaps, never backfilled.
// The 14 days and the needs are frozen with the policy of 2026-10-14. A spec may add
// evidence it requires; it may never shorten the window or drop a condition.
//
// The last line is the one the manifest's expect reads:
//   window=<id> covered=<k>/14 violations=<v> records=<n>
// and the line before it projects the earliest day the window can turn green:
//   earliest_green=<YYYY-MM-DD> (from the last gap or violation, plus 14 days)

const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 14;

function dayOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
function dayStart(day) { return Date.parse(`${day}T00:00:00Z`); }
function addDays(day, n) { return dayOf(dayStart(day) + n * DAY_MS); }

/** The 14 complete UTC days before `now`, oldest first. */
function windowDays(now) {
    const today = dayOf(now);
    const out = [];
    for (let i = WINDOW_DAYS; i >= 1; i--) out.push(addDays(today, -i));
    return out;
}

/** Reads a JSONL file. Returns null when the file cannot be read, so the caller says COULD NOT READ. */
function readJsonl(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
    const rows = [];
    let bad = 0;
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { bad++; }
    }
    rows.unparsed = bad;
    return rows;
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Grades one spec against its loaded source.
 * loaded = { records: [{ at, ok, why }], coveredDays?: Set<day>, totals?: [{ ok, why }] , unreadable?: string }
 * Coverage: a day is covered when the spec's coveredDays has it, or, without one, when
 * at least one record falls on it. A spec whose quiet day is legitimate supplies
 * coveredDays from an independent heartbeat, never from the absence of records.
 */
function grade(spec, loaded, now) {
    const days = windowDays(now);
    const from = dayStart(days[0]);
    const to = dayStart(days[days.length - 1]) + DAY_MS;
    if (loaded.unreadable) return { id: spec.id, readable: false, why: loaded.unreadable, days };
    const admissible = spec.admissibleFrom || days[0];
    const inWindow = loaded.records.filter((r) => Number.isFinite(Date.parse(r.at)) && Date.parse(r.at) >= from && Date.parse(r.at) < to);
    const counted = inWindow.filter((r) => dayOf(Date.parse(r.at)) >= admissible);
    const covered = loaded.coveredDays || new Set(counted.map((r) => dayOf(Date.parse(r.at))));
    const gaps = days.filter((d) => d < admissible || !covered.has(d));
    const violations = counted.filter((r) => !r.ok);
    const totals = (loaded.totals || []).filter((t) => !t.ok);
    // The window on day T is T-14..T-1, so T is green only when T-14 is after the last bad
    // day and not before the admissible start. A violation spoils the day it happened on.
    // This assumes every day from now on is clean: it is a floor, not a forecast.
    const badDays = [...gaps, ...violations.map((r) => dayOf(Date.parse(r.at)))].sort();
    const lastBad = badDays.length ? badDays[badDays.length - 1] : null;
    let earliest = addDays(admissible, WINDOW_DAYS);
    if (lastBad) { const e = addDays(lastBad, WINDOW_DAYS + 1); if (e > earliest) earliest = e; }
    const pass = gaps.length === 0 && violations.length === 0 && totals.length === 0 && counted.length > 0;
    if (pass) earliest = dayOf(now);
    // A short total (a rate, a floor, a drill not run, a writer that does not exist) has
    // no date: clean days alone do not fix it. The day floor is still printed beside it.
    else if (totals.length) earliest = `unknown (a total is short; no earlier than ${earliest > dayOf(now) ? earliest : addDays(dayOf(now), 1)})`;
    else if (earliest <= dayOf(now)) earliest = 'unknown';
    return {
        id: spec.id, readable: true, days, admissibleFrom: admissible,
        covered: days.length - gaps.length, gaps, violations, totals,
        records: counted.length, earliestGreen: earliest,
        pass,
    };
}

function format(g, spec) {
    const lines = [];
    lines.push(`source: ${spec.source}`);
    if (!g.readable) { lines.push(`COULD NOT READ ${g.why}`); return lines.join('\n'); }
    lines.push(`days ${g.days[0]}..${g.days[g.days.length - 1]}, admissible from ${g.admissibleFrom}`);
    for (const d of g.gaps) lines.push(`gap ${d}${d < g.admissibleFrom ? ' (before the writer recorded this evidence)' : ''}`);
    for (const v of g.violations.slice(0, 20)) lines.push(`violation ${v.at} ${v.why || ''}`.trim());
    if (g.violations.length > 20) lines.push(`... ${g.violations.length - 20} more violations`);
    for (const t of g.totals) lines.push(`short ${t.why}`);
    if (!g.records) lines.push('no admissible record in the window, so nothing was checked');
    lines.push(`earliest_green=${g.earliestGreen}`);
    lines.push(`window=${g.id} covered=${g.covered}/${g.days.length} violations=${g.violations.length + g.totals.length} records=${g.records}`);
    return lines.join('\n');
}

function parseArgs(argv) {
    const a = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k.startsWith('--')) { const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; a[k.slice(2)] = v; } else a._.push(k);
    }
    return a;
}

function defaultHome(env = process.env) {
    try { return require('../plugins/autodev-core/scripts/claude-paths.js').configDir(env); } catch { return null; }
}

/** git in `repo`: stdout trimmed, or null when git failed, with the cause in `.lastError`. */
function gitIn(repo) {
    const git = (args) => {
        const r = require('child_process').spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
        if (!r.error && r.status === 0) return r.stdout.trim();
        const said = String(r.stderr || '').trim().split(/\r?\n/).pop() || 'no stderr';
        git.lastError = `git ${args[0]} in ${repo}: ${r.error ? (r.error.code || r.error.message) : `exit ${r.status}${r.signal ? ` ${r.signal}` : ''}`}, ${said}`;
        return null;
    };
    return git;
}

function run(id, { home, repo, now, git }) {
    const specs = require('./window-specs.js');
    const spec = specs.SPECS.find((s) => s.id === id);
    if (!spec) return { error: `no window spec ${id}; known: ${specs.SPECS.map((s) => s.id).join(', ')}` };
    let loaded;
    const ctx = { home, repo, now, readJsonl, readJson, windowDays: windowDays(now), dayOf, git: git || gitIn(repo) };
    try { loaded = spec.load(ctx); } catch (e) { loaded = { unreadable: `${spec.source}: ${e.message}` }; }
    const g = grade(spec, loaded, now);
    return { spec, g };
}

function main(argv = process.argv.slice(2), io = { log: console.log, err: console.error }) {
    const a = parseArgs(argv);
    const id = a._[0];
    if (!id || a.help) { io.err('usage: window-probe.js <criterion> [--home DIR] [--repo DIR] [--now ISO] [--json]'); return 2; }
    const home = typeof a.home === 'string' ? a.home : defaultHome();
    if (!home) { io.err('COULD NOT READ: no config dir resolved'); return 2; }
    const now = typeof a.now === 'string' ? Date.parse(a.now) : Date.now();
    if (!Number.isFinite(now)) { io.err(`--now ${a.now} is not a time`); return 2; }
    const repo = typeof a.repo === 'string' ? a.repo : path.join(__dirname, '..');
    const r = run(id, { home, repo, now });
    if (r.error) { io.err(r.error); return 2; }
    io.log(a.json ? JSON.stringify(r.g, null, 2) : format(r.g, r.spec));
    if (!r.g.readable) return 2;
    return r.g.pass ? 0 : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { grade, format, windowDays, readJsonl, readJson, dayOf, addDays, dayStart, run, main, WINDOW_DAYS, DAY_MS };
