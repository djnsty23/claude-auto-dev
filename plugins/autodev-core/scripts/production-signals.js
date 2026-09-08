#!/usr/bin/env node
'use strict';
/**
 * production-signals.js — production signals become CANDIDATE stories.
 *
 * WHY THIS EXISTS. `[measured 2026-09-08]` across the live product's prd.json
 * history, 121 stories were filed in the 90 days to 2026-09-08. 22 of them cite
 * a production observation at filing time; 0 came from Sentry, 0 from a monitor
 * alert, and every one of the 22 was a person reading a table or a dashboard by
 * hand and typing a story. No skill or hook in this plugin read a production
 * signal. This script is the collector for that missing stage; the
 * `production-radar` skill runs it and reads what it produces.
 *
 * WHAT IT DOES, in order:
 *   1. reads the repo-local config (`.claude/production-signals.json`), which
 *      names each source and the ENV VARIABLE NAMES that hold its credentials;
 *   2. reads every source it can reach — a Sentry issues list, a PostgREST error
 *      table, a heartbeat key-value table, the Vercel deployment list — or, with
 *      `--fixture-dir`, a JSON file per source and no network at all;
 *   3. normalises each to {source, id, first_seen, last_seen, count, title,
 *      evidence} and applies a per-kind minimum count and minimum age;
 *   4. diffs against a ledger under `.claude/reports/` so a signal is proposed
 *      once, not every run;
 *   5. writes `.claude/reports/production-candidates-<date>.md` (+ `.json`), one
 *      candidate story per new signal in prd.json story shape, `passes: null`;
 *   6. with `--apply`, writes those stories into prd.json — ONLY when the repo's
 *      origin `owner/repo` digest is on the allowlist below. Everything else is
 *      refused with the reason. A live product never gets a direct write.
 *
 * WHAT IT NEVER DOES. It never prints or stores a credential VALUE: every value
 * it read from the environment is scrubbed from every byte it writes, on every
 * stream. It never mutates a production API — every request is a GET or a
 * read-only CLI listing. It never proposes one story per EVENT: the unit is the
 * Sentry issue, the (function, error_code) group, the heartbeat key, the
 * deployment. It emits zero bytes on stdout and stderr when every source was
 * checked and nothing new crossed a threshold — a quiet run is recorded in the
 * ledger's `runs` array, where it is auditable without costing context.
 *
 * THRESHOLDS ARE DATED DECISIONS, not constants. See DEFAULT_THRESHOLDS.
 *
 * Usage:
 *   node production-signals.js [--config PATH] [--fixture-dir DIR] [--now ISO]
 *        [--days N] [--reports-dir DIR] [--ledger PATH] [--sprint PREFIX]
 *        [--apply] [--prd PATH] [--summary] [--help]
 *
 * Exit codes: 0 ran, every source checked; 2 a source could not be checked, the
 * config was missing, or --apply was refused (the reason is on stderr).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const prdStates = require('./prd-states');

const SCHEMA_VERSION = 1;
const CONFIG_DEFAULT = path.join('.claude', 'production-signals.json');
const REPORTS_DEFAULT = path.join('.claude', 'reports');
const LEDGER_NAME = 'production-signals-ledger.json';
const USER_AGENT = 'autodev-production-signals/1.0';
const FETCH_TIMEOUT_MS = 20000;
const PAGE_SIZE = 1000; // PostgREST clamps at 1000 rows server-side; paginate, never trust one page.
const MAX_PAGES = 20;

/**
 * DEFAULT THRESHOLDS — each one is a decision with a date and a measurement.
 *
 * min_count 5 / min_age_hours 24 for error groups. `[measured 2026-09-08]` on
 * the live product's server_errors table over 14 days: see the evidence doc
 * (docs/evidence-production-signals-2026-09-08.md) for the distribution that
 * chose these. 24 h of age exists because a deploy in progress produces a burst
 * of errors in its first minutes that is gone by the next run; a group that has
 * been present for a day is not a deploy. 5 events exists because a single
 * occurrence in two weeks is a flake by any reading, and the live product's own
 * critical-error gate (scripts/monitor-critical-errors.mjs there) uses 10 per
 * 30 minutes for its blocking threshold — this is a backlog proposal, so it is
 * deliberately looser on rate and stricter on persistence.
 *
 * Heartbeats: stale_hours 48. A cron the repo declares daily that has not
 * written its heartbeat in two days is dead, not late; the live product's own
 * freshness code uses 2.5x the declared interval, which for a daily job is 60 h.
 * 48 h is chosen because this collector does not read each job's interval — it
 * would have to parse a TypeScript registry to do so — and a coarse "two days
 * silent" catches the four-night backup outage of 2026-08-27..30 on night two.
 *
 * Deploys: min_count 1, min_age 0. A production deployment in ERROR state is
 * news the first time; there is nothing to wait for.
 *
 * Sentry issues: min_count 5, min_age 24 h, for the same reasons as error groups.
 *
 * min_span_hours 24 for error groups and Sentry issues. `[measured 2026-09-08]`
 * the first real run proposed 8 server-error groups; two of them were BURSTS —
 * 60 rows of "invalid input syntax for type json" inside 9 minutes on 2026-09-02,
 * and 5 rate-limit rows inside 45 minutes on 2026-08-30 — neither seen again.
 * A burst is an incident, and the live product's critical-error monitor owns
 * incidents at 10 rows per 30 minutes. A backlog story is for a CHRONIC defect,
 * so an error group must span at least a day between its first and last row.
 * Both bursts are held with that reason; the six chronic groups still propose.
 *
 * Heartbeat intervals are PER KEY, from the config's `intervals` map (hours,
 * exact key or `prefix*`). `[measured 2026-09-08]` the same run proposed
 * `weekly_mix_send_last_run` as dead at 86 h: it is a WEEKLY job. The 48 h
 * default is right for the 31 other heartbeats that run hourly or daily (all
 * were under 20 h old) and wrong for any weekly one, so a repo declares its
 * slow jobs rather than the default growing to 8 days and losing every daily
 * job's signal.
 *
 * Re-proposal: requiet_days 30, escalation_factor 10. A signal already in the
 * ledger is re-proposed only if it went quiet for 30 days and came back (it is a
 * regression, and the story that closed it was wrong), or if its count has grown
 * tenfold since it was proposed (a background error has become an outage).
 */
const DEFAULT_THRESHOLDS = {
  'sentry-issues': { min_count: 5, min_age_hours: 24, min_span_hours: 24 },
  'postgrest-errors': { min_count: 5, min_age_hours: 24, min_span_hours: 24 },
  'postgrest-heartbeats': { stale_hours: 48 },
  'vercel-deploys': { min_count: 1, min_age_hours: 0 },
  requiet_days: 30,
  escalation_factor: 10,
};

/**
 * DIRECT-WRITE ALLOWLIST. sha256 of the origin remote's `owner/repo`, lower-cased.
 * Stored as digests for the same reason the private-name denylist is: a
 * plaintext list in a public repo discloses which repos take unattended writes.
 * Add one with `node production-signals.js --digest owner/repo`.
 *
 * `[decided 2026-09-08]` exactly one entry: the QR product, which has no users.
 * The live product is NOT here and must not be added while it has users; its
 * candidates go through the proposal file and a person or the Brain moves them.
 */
const APPLY_ALLOWLIST = [
  'ecc4d2aa88ccbbd22f98148c95d4d98c8f0a3b82a2cb5f043fb3a952bd8ecd9f',
  // The suite's fixture remote, `example.invalid/production-signals-apply-fixture`.
  // A repo matches it only by deliberately setting its origin to that string,
  // which is the same act as editing this list. It exists so the apply path is
  // exercised without naming the real allowlisted repo in a public test file.
  'cb3b67944eb67124f0add6732c463f2196f99f6c502efca5193212abafd027b2',
];

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
function hasFlag(flag) { return process.argv.includes(flag); }

function usage() {
  return [
    'production-signals — production signals become candidate prd.json stories.',
    '',
    '  --config PATH        source config (default .claude/production-signals.json)',
    '  --fixture-dir DIR    read DIR/<source-id>.json instead of the network (tests)',
    '  --now ISO            clock override (tests)',
    '  --days N             lookback window in days (default 14)',
    '  --reports-dir DIR    where candidates and the ledger live (default .claude/reports)',
    '  --ledger PATH        ledger path override',
    '  --sprint PREFIX      story id prefix (default: derived from prd.json, else PROD)',
    '  --apply              write candidates into prd.json — allowlisted repos only',
    '  --prd PATH           prd.json path (default ./prd.json)',
    '  --summary            print population counts even when nothing is new',
    '  --digest owner/repo  print the allowlist digest for a repo and exit',
    '  --help',
    '',
    'Exit 0: ran, every source checked. Exit 2: a source failed, no config, or --apply refused.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function iso(ms) { return new Date(ms).toISOString(); }
function hoursBetween(a, b) { return Math.abs(a - b) / 3600000; }
function clip(s, n) { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n - 1) + '…'; }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e && e.code === 'ENOENT') return fallback;
    throw new Error(`${file}: ${e.message}`);
  }
}

/**
 * Redaction. Every environment value the config named is a secret by
 * construction — the config only names variables because a source needs them to
 * authenticate. Anything shorter than 8 characters is skipped: "1", "true" and
 * "prd" would otherwise be scrubbed out of ordinary prose.
 */
class Redactor {
  constructor() { this.values = new Set(); }
  add(value) {
    if (typeof value !== 'string' || value.length < 8) return;
    this.values.add(value);
    // `[measured 2026-09-08]` review of the first cut: scrubbing SERIALISED JSON
    // missed any secret containing a quote, a backslash or a control character,
    // because JSON.stringify had already escaped it. Register the escaped form
    // too, so a scrub over serialised text catches it either way.
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) this.values.add(escaped);
  }
  scrub(text) {
    let out = String(text);
    for (const v of this.values) out = out.split(v).join('[REDACTED]');
    return out;
  }
  /** Scrub every string leaf of a parsed object, keys included. */
  scrubDeep(value) {
    if (typeof value === 'string') return this.scrub(value);
    if (Array.isArray(value)) return value.map((v) => this.scrubDeep(v));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[this.scrub(k)] = this.scrubDeep(v);
      return out;
    }
    return value;
  }
}

function env(name, redactor) {
  const v = process.env[name];
  if (v) redactor.add(v);
  return v || '';
}

// ---------------------------------------------------------------------------
// fetching — every request is a GET; fixtures replace the network entirely
// ---------------------------------------------------------------------------

async function httpGet(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', headers: Object.assign({ 'user-agent': USER_AGENT, accept: 'application/json' }, headers), signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}${new URL(url).pathname}`);
    return { body: JSON.parse(text), headers: res.headers };
  } finally { clearTimeout(timer); }
}
async function httpGetJson(url, headers) { return (await httpGet(url, headers)).body; }

/**
 * Hosts a Sentry source may be pointed at. `[measured 2026-09-08]` review of the
 * first cut: `region` came straight from the repo-local config and `token_env`
 * named any variable, so a cloned repo carrying a config could send any secret
 * in the environment to any host, exit 0, zero bytes. The config is DATA from a
 * repo; it does not get to choose where credentials go.
 */
const SENTRY_HOST = /^([a-z0-9-]+\.)*sentry\.io$/;
function sentryRegion(source) {
  const raw = source.region || 'https://sentry.io';
  let u;
  try { u = new URL(raw); } catch { throw new Error(`sentry region is not a URL: ${raw}`); }
  if (u.protocol !== 'https:' || !SENTRY_HOST.test(u.hostname)) throw new Error(`sentry region ${u.host} is not a sentry.io host; refusing to send a credential there`);
  return u.origin;
}

function fixturePayload(fixtureDir, source) {
  const file = path.join(fixtureDir, `${source.id}.json`);
  if (!fs.existsSync(file)) throw new Error(`fixture missing: ${file}`);
  return readJson(file);
}

// --- sentry ------------------------------------------------------------------

async function rawSentry(source, ctx) {
  if (ctx.fixtureDir) return fixturePayload(ctx.fixtureDir, source);
  sentryRegion(source); // refuse the host BEFORE touching the credential
  const token = env(source.token_env || 'SENTRY_AUTH_TOKEN', ctx.redactor);
  if (!token) throw new Error(`env ${source.token_env || 'SENTRY_AUTH_TOKEN'} is not set`);
  if (!source.org || !source.project) throw new Error('sentry source needs org and project');
  const region = sentryRegion(source);
  const period = source.stats_period || `${ctx.days}d`;
  const url = `${region}/api/0/projects/${encodeURIComponent(source.org)}/${encodeURIComponent(source.project)}/issues/?query=${encodeURIComponent(source.query || 'is:unresolved')}&statsPeriod=${encodeURIComponent(period)}&limit=100`;
  return httpGetJson(url, { authorization: `Bearer ${token}` });
}

function normaliseSentry(source, issues) {
  if (!Array.isArray(issues)) throw new Error('sentry payload is not an array');
  return issues.map((it) => ({
    source: source.id,
    kind: 'sentry-issues',
    id: String(it.id),
    first_seen: it.firstSeen || null,
    last_seen: it.lastSeen || null,
    count: Number(it.count || 0),
    title: clip(it.title || it.culprit || `issue ${it.id}`, 140),
    evidence: it.permalink || `${source.region || 'https://sentry.io'}/organizations/${source.org}/issues/${it.id}/`,
    detail: clip([it.culprit, it.metadata && it.metadata.value].filter(Boolean).join(' — '), 200),
  }));
}

// --- postgrest error table ---------------------------------------------------

function postgrestHeaders(source, ctx) {
  const url = env(source.url_env || 'SUPABASE_URL', ctx.redactor);
  const key = env(source.key_env || 'SUPABASE_SERVICE_ROLE_KEY', ctx.redactor);
  if (!url) throw new Error(`env ${source.url_env || 'SUPABASE_URL'} is not set`);
  if (!key) throw new Error(`env ${source.key_env || 'SUPABASE_SERVICE_ROLE_KEY'} is not set`);
  return { base: url.replace(/\/$/, ''), headers: { apikey: key, authorization: `Bearer ${key}` } };
}

/**
 * Pages until the server's Content-Range says the range is exhausted. The
 * server's max-rows setting is per deployment and configurable, so a page
 * shorter than PAGE_SIZE is NOT proof of the last page; the header is. A table
 * larger than MAX_PAGES pages is a named failure, never a silent undercount.
 */
async function postgrestPaged(base, headers, query) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = rows.length;
    const { body: batch, headers: h } = await httpGet(`${base}/rest/v1/${query}`, Object.assign({ range: `${from}-${from + PAGE_SIZE - 1}`, 'range-unit': 'items', prefer: 'count=exact' }, headers));
    if (!Array.isArray(batch)) throw new Error('postgrest payload is not an array');
    rows.push(...batch);
    if (batch.length === 0) return rows;
    const cr = /^(\d+)-(\d+)\/(\d+|\*)$/.exec(String(h.get('content-range') || ''));
    if (cr) {
      const end = Number(cr[2]); const total = cr[3] === '*' ? null : Number(cr[3]);
      if (total !== null && end + 1 >= total) return rows;
    } else if (batch.length < PAGE_SIZE) {
      return rows; // no header at all: fall back to the length heuristic
    }
  }
  throw new Error(`more than ${MAX_PAGES * PAGE_SIZE} rows in the window; narrow --days or add a filter rather than read a truncated table`);
}

async function rawPostgrestErrors(source, ctx) {
  if (ctx.fixtureDir) return fixturePayload(ctx.fixtureDir, source);
  const { base, headers } = postgrestHeaders(source, ctx);
  const timeCol = source.time_column || 'created_at';
  const cols = [timeCol].concat(source.group_by || ['function_name', 'error_code'], source.title_column ? [source.title_column] : []);
  const filter = source.filter ? `&${source.filter}` : '';
  const q = `${source.table}?select=${encodeURIComponent([...new Set(cols)].join(','))}&${timeCol}=gte.${encodeURIComponent(iso(ctx.cutoffMs))}&order=${timeCol}.desc${filter}`;
  return postgrestPaged(base, headers, q);
}

function normalisePostgrestErrors(source, rows, ctx) {
  if (!Array.isArray(rows)) throw new Error('error-table payload is not an array');
  const timeCol = source.time_column || 'created_at';
  const groupBy = source.group_by || ['function_name', 'error_code'];
  const titleCol = source.title_column || null;
  const groups = new Map();
  for (const row of rows) {
    const keyParts = groupBy.map((c) => String(row[c] == null ? '∅' : row[c]));
    const key = keyParts.join(':');
    const t = Date.parse(row[timeCol]);
    let g = groups.get(key);
    if (!g) { g = { keyParts, first: Infinity, last: -Infinity, count: 0, titles: new Map() }; groups.set(key, g); }
    g.count += 1;
    if (Number.isFinite(t)) { g.first = Math.min(g.first, t); g.last = Math.max(g.last, t); }
    if (titleCol && row[titleCol] != null) {
      const tt = clip(row[titleCol], 120);
      g.titles.set(tt, (g.titles.get(tt) || 0) + 1);
    }
  }
  const out = [];
  for (const [key, g] of groups) {
    const topTitle = [...g.titles.entries()].sort((a, b) => b[1] - a[1])[0];
    const where = groupBy.map((c, i) => `${c} ${g.keyParts[i] === '∅' ? 'is null' : `= '${g.keyParts[i].replace(/'/g, "''")}'`}`).join(' and ');
    out.push({
      source: source.id,
      kind: 'postgrest-errors',
      id: key,
      first_seen: Number.isFinite(g.first) ? iso(g.first) : null,
      last_seen: Number.isFinite(g.last) ? iso(g.last) : null,
      count: g.count,
      title: `${source.table}: ${g.keyParts.join(' / ')}${topTitle ? ` — ${topTitle[0]}` : ''}`,
      evidence: `select count(*), min(${timeCol}), max(${timeCol}) from ${source.table} where ${where} and ${timeCol} >= '${iso(ctx.cutoffMs)}'`,
      detail: topTitle ? `${topTitle[1]} of ${g.count} rows share the message: ${topTitle[0]}` : '',
    });
  }
  return out;
}

// --- postgrest heartbeats ----------------------------------------------------

async function rawPostgrestHeartbeats(source, ctx) {
  if (ctx.fixtureDir) return fixturePayload(ctx.fixtureDir, source);
  const { base, headers } = postgrestHeaders(source, ctx);
  const keyCol = source.key_column || 'key';
  const like = source.key_like || '%_last_run';
  const q = `${source.table}?select=${keyCol},${source.value_column || 'value'},${source.updated_column || 'updated_at'}&${keyCol}=like.${encodeURIComponent(like)}&order=${keyCol}.asc`;
  return postgrestPaged(base, headers, q);
}

function normaliseHeartbeats(source, rows, ctx) {
  if (!Array.isArray(rows)) throw new Error('heartbeat payload is not an array');
  const keyCol = source.key_column || 'key';
  const valCol = source.value_column || 'value';
  const updCol = source.updated_column || 'updated_at';
  const atPath = source.at_path || 'at';
  const out = [];
  for (const row of rows) {
    const value = row[valCol];
    // Read value->>'at' AND updated_at and take the later: the live product's
    // upsert quirk froze updated_at for 25 days on three rows, and its own
    // freshness code takes GREATEST of the two for the same reason.
    const fromValue = value && typeof value === 'object' ? Date.parse(value[atPath]) : NaN;
    const fromCol = Date.parse(row[updCol]);
    const at = Math.max(Number.isFinite(fromValue) ? fromValue : -Infinity, Number.isFinite(fromCol) ? fromCol : -Infinity);
    const seen = Number.isFinite(at) ? iso(at) : null;
    out.push({
      source: source.id,
      kind: 'postgrest-heartbeats',
      id: String(row[keyCol]),
      first_seen: seen,
      last_seen: seen,
      count: 1,
      title: `heartbeat ${row[keyCol]} last wrote ${seen ? `${hoursBetween(at, ctx.nowMs).toFixed(0)} h ago` : 'never'}`,
      evidence: `select ${keyCol}, ${valCol}->>'${atPath}', ${updCol} from ${source.table} where ${keyCol} = '${String(row[keyCol]).replace(/'/g, "''")}'`,
      detail: seen ? `last heartbeat ${seen}` : 'no parseable timestamp',
      _stale_hours: seen ? hoursBetween(at, ctx.nowMs) : Infinity,
    });
  }
  return out;
}

// --- vercel deployments (read-only CLI listing) -------------------------------

function rawVercelDeploys(source, ctx) {
  if (ctx.fixtureDir) return fixturePayload(ctx.fixtureDir, source);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(String(source.project || ''))) throw new Error('vercel project must be a plain project name');
  // The binary is fixed. A config-chosen command would let a repo run anything
  // under the collector's name; `[measured 2026-09-08]` review of the first cut.
  const args = ['ls', source.project, '--json', '--yes'];
  const r = spawnSync('vercel', args, { encoding: 'utf8', timeout: 60000 });
  if (r.error) throw new Error(`vercel CLI: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`vercel ls exited ${r.status}: ${clip(r.stderr, 160)}`);
  const start = r.stdout.indexOf('{');
  if (start < 0) throw new Error('vercel ls printed no JSON');
  return JSON.parse(r.stdout.slice(start));
}

function normaliseVercel(source, payload, ctx) {
  const deps = payload && Array.isArray(payload.deployments) ? payload.deployments : null;
  if (!deps) throw new Error('vercel payload has no deployments array');
  const out = [];
  for (const d of deps) {
    const created = Number(d.createdAt || d.created || 0);
    if (!created || created < ctx.cutoffMs) continue; // an undated deployment cannot be placed in the window
    const isProd = d.target === 'production';
    const state = String(d.state || d.readyState || '').toUpperCase();
    if (!isProd || state !== 'ERROR') continue;
    out.push({
      source: source.id,
      kind: 'vercel-deploys',
      id: String(d.uid || d.url),
      first_seen: created ? iso(created) : null,
      last_seen: created ? iso(created) : null,
      count: 1,
      title: `production deployment failed: ${d.url || d.uid}`,
      evidence: `https://${d.url}`,
      detail: clip([d.meta && d.meta.githubCommitRef, d.meta && d.meta.githubCommitMessage].filter(Boolean).join(' — '), 160),
    });
  }
  return out;
}

const KINDS = {
  'sentry-issues': { raw: rawSentry, normalise: normaliseSentry },
  'postgrest-errors': { raw: rawPostgrestErrors, normalise: normalisePostgrestErrors },
  'postgrest-heartbeats': { raw: rawPostgrestHeartbeats, normalise: normaliseHeartbeats },
  'vercel-deploys': { raw: rawVercelDeploys, normalise: normaliseVercel },
};

// ---------------------------------------------------------------------------
// thresholds, ignore list, ledger diff
// ---------------------------------------------------------------------------

function thresholdsFor(kind, config) {
  return Object.assign({}, DEFAULT_THRESHOLDS[kind] || {}, (config.thresholds && config.thresholds[kind]) || {});
}

/** Returns {pass:boolean, reason:string}. Every held-back signal says why. */
/** Hours a heartbeat key may stay silent: the config's `intervals` map (exact key or `prefix*`), else the kind default. */
function staleHoursFor(key, config, t) {
  const map = (config.intervals && typeof config.intervals === 'object') ? config.intervals : {};
  const num = (v, name) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw new Error(`intervals.${name} must be a positive number of hours`); return n; };
  if (Object.prototype.hasOwnProperty.call(map, key)) return num(map[key], key);
  for (const [pattern, hours] of Object.entries(map)) {
    if (pattern.endsWith('*') && key.startsWith(pattern.slice(0, -1))) return num(hours, pattern);
  }
  return t.stale_hours ?? 48;
}

function crossesThreshold(signal, config, ctx) {
  const t = thresholdsFor(signal.kind, config);
  if (signal.kind === 'postgrest-heartbeats') {
    const limit = staleHoursFor(signal.id, config, t);
    if (signal._stale_hours >= limit) return { pass: true, reason: `stale ${signal._stale_hours === Infinity ? '∞' : signal._stale_hours.toFixed(0)} h ≥ ${limit} h` };
    return { pass: false, reason: `fresh (${signal._stale_hours.toFixed(0)} h < ${limit} h)` };
  }
  if (signal.count < (t.min_count ?? 1)) return { pass: false, reason: `count ${signal.count} < min_count ${t.min_count}` };
  const first = Date.parse(signal.first_seen);
  const last = Date.parse(signal.last_seen);
  const age = Number.isFinite(first) ? hoursBetween(first, ctx.nowMs) : Infinity;
  if (age < (t.min_age_hours ?? 0)) return { pass: false, reason: `age ${age.toFixed(1)} h < min_age_hours ${t.min_age_hours} (deploy in progress?)` };
  const span = Number.isFinite(first) && Number.isFinite(last) ? hoursBetween(first, last) : Infinity;
  if (t.min_span_hours && span < t.min_span_hours) return { pass: false, reason: `burst: spanned ${span.toFixed(1)} h < min_span_hours ${t.min_span_hours} (an incident, not a chronic defect)` };
  return { pass: true, reason: `count ${signal.count} ≥ ${t.min_count ?? 1}, age ${age === Infinity ? '?' : age.toFixed(0)} h ≥ ${t.min_age_hours ?? 0}, span ${span === Infinity ? '?' : span.toFixed(0)} h` };
}

function isIgnored(signal, config) {
  const patterns = Array.isArray(config.ignore) ? config.ignore : [];
  const key = `${signal.source}:${signal.id}`;
  return patterns.some((p) => {
    if (typeof p !== 'string') return false;
    if (p.endsWith('*')) return key.startsWith(p.slice(0, -1));
    return key === p;
  });
}

function ledgerKey(signal) { return `${signal.source}:${signal.id}`; }

/** {propose:boolean, reason:string} against the ledger's prior proposal. */
function ledgerDecision(signal, ledger, config, ctx) {
  const prior = ledger.proposed[ledgerKey(signal)];
  if (!prior) return { propose: true, reason: 'new' };
  const requietDays = (config.thresholds && config.thresholds.requiet_days) || DEFAULT_THRESHOLDS.requiet_days;
  const factor = (config.thresholds && config.thresholds.escalation_factor) || DEFAULT_THRESHOLDS.escalation_factor;
  const priorLast = Date.parse(prior.last_seen);
  const nowLast = Date.parse(signal.last_seen);
  if (Number.isFinite(priorLast) && Number.isFinite(nowLast) && signal.first_seen && Date.parse(signal.first_seen) - priorLast > requietDays * 86400000) {
    return { propose: true, reason: `returned after ${((Date.parse(signal.first_seen) - priorLast) / 86400000).toFixed(0)} quiet days (regression of ${prior.story_id || prior.report})` };
  }
  if (prior.count && signal.count >= prior.count * factor) {
    return { propose: true, reason: `escalated ${prior.count} → ${signal.count} (≥ ${factor}x since ${(prior.last_proposed || prior.first_proposed).slice(0, 10)})` };
  }
  return { propose: false, reason: `already proposed ${(prior.last_proposed || prior.first_proposed).slice(0, 10)}${prior.story_id ? ` as ${prior.story_id}` : ''}` };
}

// ---------------------------------------------------------------------------
// prd.json shape, story ids, candidate stories
// ---------------------------------------------------------------------------

function loadPrd(prdPath) {
  const prd = readJson(prdPath, null);
  return prd && typeof prd === 'object' ? prd : null;
}

function derivePrefix(prd, explicit) {
  if (explicit) return explicit;
  const stories = prdStates.storiesOf(prd);
  const counts = new Map();
  for (const id of Object.keys(stories)) {
    const m = /^([A-Za-z]+\d+)-/.exec(id);
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : 'PROD';
}

function nextStoryNumber(prefix, prd, ledger) {
  let max = 0;
  const lane = prefix === 'PROD' ? 'PROD' : `${prefix}-PROD`;
  const re = new RegExp(`^${lane.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  for (const id of Object.keys(prdStates.storiesOf(prd))) { const m = re.exec(id); if (m) max = Math.max(max, Number(m[1])); }
  for (const p of Object.values(ledger.proposed)) { const m = p.story_id && re.exec(p.story_id); if (m) max = Math.max(max, Number(m[1])); }
  return max + 1;
}

function priorityFor(signal) {
  if (signal.kind === 'vercel-deploys') return 1;
  if (signal.kind === 'postgrest-heartbeats') return 2;
  if (signal.count >= 100) return 1;
  if (signal.count >= 20) return 2;
  return 3;
}

function candidateStory(signal, id, ctx, why) {
  const quiet = signal.kind === 'postgrest-heartbeats'
    ? `the heartbeat ${signal.id} has written within its interval on 3 consecutive days after the fix`
    : signal.kind === 'vercel-deploys'
      ? 'the next production deployment reaches READY and no production deployment has failed in the following 7 days'
      : `the signal is quiet: the evidence query below returns 0 rows for 7 consecutive days after the fix ships`;
  return {
    id,
    title: clip(signal.title, 140),
    type: 'fix',
    category: 'production',
    priority: priorityFor(signal),
    passes: null,
    createdAt: ctx.nowIso.slice(0, 10),
    source: {
      collector: 'production-signals',
      source: signal.source,
      kind: signal.kind,
      id: signal.id,
      count: signal.count,
      first_seen: signal.first_seen,
      last_seen: signal.last_seen,
      window_days: ctx.days,
      evidence: signal.evidence,
      proposed_because: why,
    },
    notes: [
      `PRODUCTION SIGNAL, collected ${ctx.nowIso} by production-signals (${signal.source}).`,
      `Observed ${signal.count} over ${ctx.days} days, first ${signal.first_seen || '?'}, last ${signal.last_seen || '?'}.`,
      signal.detail ? `Detail: ${signal.detail}` : null,
      `Evidence: ${signal.evidence}`,
      'This is a CANDIDATE. Read the evidence before accepting it; a count is a hypothesis, not a defect.',
    ].filter(Boolean).join(' '),
    acceptance: [
      `Root cause named in the resolution, with the evidence query re-run and its number quoted.`,
      `Fix verified where the signal originates, not only in tests: ${quiet}.`,
      signal.kind === 'postgrest-errors' ? 'If the rows were noise rather than a defect, the fix is to stop writing them, and this story says so.' : null,
    ].filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// report writing
// ---------------------------------------------------------------------------

function renderMarkdown(candidates, held, failures, ctx, config) {
  const lines = [];
  lines.push(`# Production candidates — ${ctx.nowIso.slice(0, 10)}`);
  lines.push('');
  lines.push(`Collected ${ctx.nowIso} over a ${ctx.days}-day window from ${config.sources.length} configured source(s).`);
  lines.push('These are CANDIDATES in prd.json story shape. Nothing here has been written into prd.json.');
  lines.push('Read each evidence line before accepting a story; a count alone is a hypothesis.');
  lines.push('');
  if (failures.length) {
    lines.push('## Could not check');
    lines.push('');
    for (const f of failures) lines.push(`- **${f.source}** — ${f.reason}`);
    lines.push('');
  }
  lines.push(`## Candidates (${candidates.length})`);
  lines.push('');
  for (const c of candidates) {
    lines.push(`### ${c.id} — ${c.title}`);
    lines.push('');
    lines.push(`- source: \`${c.source.source}\` (${c.source.kind}), id \`${c.source.id}\``);
    lines.push(`- count: ${c.source.count} over ${c.source.window_days} d; first ${c.source.first_seen || '?'}, last ${c.source.last_seen || '?'}`);
    lines.push(`- proposed because: ${c.source.proposed_because}`);
    lines.push(`- evidence: \`${c.source.evidence}\``);
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(c, null, 2));
    lines.push('```');
    lines.push('');
  }
  if (held.length) {
    lines.push(`## Seen but not proposed (${held.length})`);
    lines.push('');
    lines.push('| source | id | count | reason |');
    lines.push('|---|---|---|---|');
    for (const h of held) lines.push(`| ${h.source} | ${clip(h.id, 60)} | ${h.count} | ${h.reason} |`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// --apply
// ---------------------------------------------------------------------------

function originOwnerRepo(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const url = r.stdout.trim();
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** {ok:boolean, reason:string, ownerRepo} — every refusal names why. */
function applyPermitted(cwd, prd, prdPath) {
  const ownerRepo = originOwnerRepo(cwd);
  if (!ownerRepo) return { ok: false, reason: 'no origin remote — cannot identify the repo, so it cannot be on the allowlist', ownerRepo };
  if (!APPLY_ALLOWLIST.includes(sha256(ownerRepo))) {
    return { ok: false, reason: `${ownerRepo} is not on the direct-write allowlist (${APPLY_ALLOWLIST.length} digest entries). Candidates stay in the proposal file; a person or the Brain moves them into prd.json.`, ownerRepo };
  }
  if (!prd) return { ok: false, reason: `${prdPath} is missing or unparseable — nothing to apply into. Create the backlog first; this script does not invent a prd.json.`, ownerRepo };
  return { ok: true, reason: `${ownerRepo} is allowlisted`, ownerRepo };
}

function applyToPrd(prd, prdPath, candidates) {
  const sprints = Array.isArray(prd.sprints) ? prd.sprints.filter((s) => s && s.stories && typeof s.stories === 'object') : [];
  const target = sprints.length ? sprints[sprints.length - 1].stories : (prd.stories && typeof prd.stories === 'object' ? prd.stories : (prd.stories = {}));
  for (const c of candidates) target[c.id] = c;
  fs.writeFileSync(prdPath, JSON.stringify(prd, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) { process.stdout.write(usage() + '\n'); return 0; }
  if (hasFlag('--digest')) { process.stdout.write(sha256(String(argValue('--digest', '')).toLowerCase()) + '\n'); return 0; }

  const cwd = process.cwd();
  const redactor = new Redactor();
  const configPath = path.resolve(cwd, argValue('--config', CONFIG_DEFAULT));
  const config = readJson(configPath, null);
  if (!config || !Array.isArray(config.sources) || !config.sources.length) {
    process.stderr.write(`production-signals: no sources configured at ${path.relative(cwd, configPath) || configPath}. The production-radar skill documents the shape.\n`);
    return 2;
  }
  const nowRaw = argValue('--now', null);
  const nowMs = nowRaw === null ? Date.now() : Date.parse(nowRaw);
  if (!Number.isFinite(nowMs)) throw new Error(`--now is not a parseable timestamp: ${nowRaw}`);
  const days = Number(argValue('--days', config.days || 14));
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('--days must be an integer from 1 to 365');
  const ctx = { cwd, nowMs, nowIso: iso(nowMs), days, cutoffMs: nowMs - days * 86400000, fixtureDir: argValue('--fixture-dir', null) && path.resolve(cwd, argValue('--fixture-dir')), redactor };
  const reportsDir = path.resolve(cwd, argValue('--reports-dir', config.reports_dir || REPORTS_DEFAULT));
  const ledgerPath = path.resolve(cwd, argValue('--ledger', path.join(reportsDir, LEDGER_NAME)));
  const prdPath = path.resolve(cwd, argValue('--prd', 'prd.json'));
  const summary = hasFlag('--summary');
  const apply = hasFlag('--apply');

  const ledger = readJson(ledgerPath, { schema: SCHEMA_VERSION, proposed: {}, runs: [] });
  if (!ledger.proposed) ledger.proposed = {};
  if (!Array.isArray(ledger.runs)) ledger.runs = [];

  // Register every credential the config names for redaction BEFORE any source
  // runs — including in fixture mode, where no adapter reads the environment.
  // A payload can echo a key (an upstream 401 body often does), and the scrub
  // must know the value whether or not this run used it to authenticate.
  for (const source of config.sources) {
    for (const [k, v] of Object.entries(source || {})) if (k.endsWith('_env') && typeof v === 'string') env(v, redactor);
  }

  // Collect.
  const signals = [];
  const failures = [];
  const checked = [];
  for (const source of config.sources) {
    const kind = KINDS[source.kind];
    if (!source.id || !kind) { failures.push({ source: source.id || '(unnamed)', reason: `unknown kind ${JSON.stringify(source.kind)}` }); continue; }
    try {
      const raw = await kind.raw(source, ctx);
      signals.push(...kind.normalise(source, raw, ctx));
      checked.push(source.id);
    } catch (e) {
      failures.push({ source: source.id, reason: redactor.scrub(e && e.message ? e.message : String(e)) });
    }
  }

  // Threshold, ignore list, ledger.
  const prd = loadPrd(prdPath);
  const prefix = derivePrefix(prd, argValue('--sprint', config.sprint));
  let nextNo = nextStoryNumber(prefix, prd, ledger);
  const candidates = [];
  const held = [];
  for (const s of signals) {
    if (isIgnored(s, config)) { held.push({ source: s.source, id: s.id, count: s.count, reason: 'on the config ignore list' }); continue; }
    const th = crossesThreshold(s, config, ctx);
    if (!th.pass) { held.push({ source: s.source, id: s.id, count: s.count, reason: th.reason }); continue; }
    const ld = ledgerDecision(s, ledger, config, ctx);
    if (!ld.propose) { held.push({ source: s.source, id: s.id, count: s.count, reason: ld.reason }); continue; }
    const id = `${prefix === 'PROD' ? 'PROD' : `${prefix}-PROD`}-${String(nextNo).padStart(3, '0')}`;
    nextNo += 1;
    candidates.push(candidateStory(s, id, ctx, `${th.reason}; ${ld.reason}`));
  }

  // Scrub the CANDIDATES THEMSELVES, not only the rendered outputs: a story title
  // built from an error message can carry a key the upstream echoed, and --apply
  // writes the object into prd.json. `[measured 2026-09-08]` the first suite run
  // planted a canary in a fixture message and found it in the applied prd.json.
  candidates.splice(0, candidates.length, ...redactor.scrubDeep(candidates));
  held.splice(0, held.length, ...redactor.scrubDeep(held));

  // --apply is decided BEFORE anything is written, so a refusal leaves the tree exactly as found
  // apart from the proposal file, which is the safe output.
  let applied = false;
  let applyVerdict = null;
  if (apply) applyVerdict = applyPermitted(cwd, prd, prdPath);

  const date = ctx.nowIso.slice(0, 10);
  let reportPath = null;
  if (candidates.length || failures.length) {
    fs.mkdirSync(reportsDir, { recursive: true });
    reportPath = path.join(reportsDir, `production-candidates-${date}.md`);
    fs.writeFileSync(reportPath, redactor.scrub(renderMarkdown(candidates, held, failures, ctx, config)));
    fs.writeFileSync(reportPath.replace(/\.md$/, '.json'), JSON.stringify(redactor.scrubDeep({ schema: SCHEMA_VERSION, collected_at: ctx.nowIso, candidates, held, failures }), null, 2) + '\n');
  }

  if (apply && applyVerdict.ok && candidates.length) {
    applyToPrd(prd, prdPath, candidates);
    applied = true;
  }

  // Every signal SEEN refreshes its ledger entry's last_seen, not only the ones
  // proposed. `[measured 2026-09-08]` review of the first cut: with last_seen
  // frozen at proposal time, a chronic signal that never went quiet was re-filed
  // as a "regression" every ~38 days, forever — the rule manufactured the thing
  // it exists to detect. `count` stays the count AT PROPOSAL, because escalation
  // compares against it.
  for (const s of signals) {
    const prior = ledger.proposed[ledgerKey(s)];
    if (prior && s.last_seen && (!prior.last_seen || Date.parse(s.last_seen) > Date.parse(prior.last_seen))) prior.last_seen = s.last_seen;
  }
  for (const c of candidates) {
    const key = `${c.source.source}:${c.source.id}`;
    const prior = ledger.proposed[key];
    ledger.proposed[key] = {
      first_proposed: prior && prior.first_proposed ? prior.first_proposed : ctx.nowIso,
      last_proposed: ctx.nowIso,
      last_seen: c.source.last_seen, count: c.source.count, title: c.title,
      report: reportPath ? path.basename(reportPath) : null, story_id: c.id, applied,
    };
  }
  ledger.runs.push({ at: ctx.nowIso, days, sources_checked: checked, sources_failed: failures.map((f) => f.source), signals: signals.length, held: held.length, candidates: candidates.length, applied });
  if (ledger.runs.length > 200) ledger.runs = ledger.runs.slice(-200);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(redactor.scrubDeep(ledger), null, 2) + '\n');

  // Output. Zero bytes when everything was checked and nothing is new.
  const out = [];
  if (failures.length) for (const f of failures) out.push(`COULD NOT CHECK ${f.source}: ${f.reason}`);
  if (candidates.length || summary || failures.length) {
    out.push(`production-signals: ${checked.length}/${config.sources.length} sources checked, ${signals.length} signals, ${held.length} held back, ${candidates.length} new candidate(s)`);
    if (reportPath) out.push(`candidates: ${reportPath}`);
    for (const c of candidates) out.push(`  ${c.id}  ${c.title}  [${c.source.count} over ${days} d]`);
  }
  if (apply) {
    if (applyVerdict.ok) out.push(applied ? `applied ${candidates.length} stor${candidates.length === 1 ? 'y' : 'ies'} into ${path.relative(cwd, prdPath)}` : 'apply: nothing new to apply');
    else out.push(`APPLY REFUSED: ${applyVerdict.reason}`);
  }
  if (out.length) (failures.length || (apply && !applyVerdict.ok) ? process.stderr : process.stdout).write(redactor.scrub(out.join('\n')) + '\n');
  return failures.length || (apply && !applyVerdict.ok) ? 2 : 0;
}

if (require.main === module) {
  // Never process.exit() after writing to stdout: a piped stdout is truncated at
  // 64 KB on macOS when the process exits before the write drains. Set exitCode
  // and let the event loop drain.
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    process.stderr.write(`production-signals: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  DEFAULT_THRESHOLDS, APPLY_ALLOWLIST, Redactor, sha256,
  normaliseSentry, normalisePostgrestErrors, normaliseHeartbeats, normaliseVercel,
  crossesThreshold, staleHoursFor, isIgnored, ledgerDecision, sentryRegion, postgrestPaged, derivePrefix, nextStoryNumber, candidateStory, applyPermitted, originOwnerRepo,
};
