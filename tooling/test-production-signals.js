#!/usr/bin/env node
'use strict';
// test-production-signals.js — the collector is driven as a SUBPROCESS against
// fixture sources (one JSON file per source, no network), the way the
// production-radar skill runs it. Every failure mode the design was built
// against has a case here, and a control proves a fresh signal IS proposed, so
// a green run cannot mean "nothing was ever proposed".
//
// A canary secret is planted in the ENVIRONMENT and inside a fixture PAYLOAD, and
// every byte the collector writes — stdout, stderr, the report, the ledger, the
// applied prd.json — is asserted free of it. Both streams, not one: mutants have
// survived here because a test checked stdout alone.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'production-signals.js');
const SKILL = path.join(__dirname, '..', 'plugins', 'autodev-core', 'skills', 'production-radar', 'SKILL.md');
const subject = require(SCRIPT);
const prdStates = require(path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'prd-states.js'));

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass += 1; console.log('  ok   ' + label); }
  else { fail += 1; console.log('  FAIL ' + label + (detail ? ' - ' + String(detail).slice(0, 400) : '')); }
};

const NOW = '2026-09-08T12:00:00.000Z';
const nowMs = Date.parse(NOW);
const ago = (hours) => new Date(nowMs - hours * 3600000).toISOString();
// The canary carries a quote and a backslash ON PURPOSE: the first cut scrubbed
// serialised JSON, where both are escaped, and a plain canary could not fail it.
const CANARY = 'sk-live-CANARY-7Qz9\\pX"2mLr41';
const CANARY_URL = 'https://canary-project-ref.supabase.co';

function mkRepo(name, { remote, prd, config, fixtures } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `prodsig-${name}-`));
  spawnSync('git', ['init', '-q', dir]);
  if (remote) spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
  if (prd !== undefined) fs.writeFileSync(path.join(dir, 'prd.json'), JSON.stringify(prd, null, 2) + '\n');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  if (config) fs.writeFileSync(path.join(dir, '.claude', 'production-signals.json'), JSON.stringify(config, null, 2));
  const fx = path.join(dir, 'fixtures');
  fs.mkdirSync(fx);
  for (const [id, payload] of Object.entries(fixtures || {})) fs.writeFileSync(path.join(fx, `${id}.json`), JSON.stringify(payload));
  return dir;
}

function run(dir, extra = [], envExtra = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, '--fixture-dir', 'fixtures', '--now', NOW].concat(extra), {
    cwd: dir, encoding: 'utf8',
    env: Object.assign({}, process.env, { SUPABASE_SERVICE_ROLE_KEY: CANARY, SUPABASE_URL: CANARY_URL, SENTRY_AUTH_TOKEN: CANARY }, envExtra),
  });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}

const reportsOf = (dir) => fs.existsSync(path.join(dir, '.claude', 'reports')) ? fs.readdirSync(path.join(dir, '.claude', 'reports')) : [];
const readLedger = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'reports', 'production-signals-ledger.json'), 'utf8'));
const readReport = (dir) => fs.readFileSync(path.join(dir, '.claude', 'reports', 'production-candidates-2026-09-08.md'), 'utf8');
const readReportJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'reports', 'production-candidates-2026-09-08.json'), 'utf8'));
const everyByteWritten = (dir) => {
  const parts = [];
  for (const f of reportsOf(dir)) parts.push(fs.readFileSync(path.join(dir, '.claude', 'reports', f), 'utf8'));
  if (fs.existsSync(path.join(dir, 'prd.json'))) parts.push(fs.readFileSync(path.join(dir, 'prd.json'), 'utf8'));
  return parts.join('\n');
};

const errorRows = (fn, code, n, firstHoursAgo, message) => Array.from({ length: n }, (_, i) => ({
  created_at: ago(firstHoursAgo - (i * firstHoursAgo) / Math.max(n, 1)), function_name: fn, error_code: code, message: message || `${fn} failed with ${code}`,
}));

const CONFIG = {
  sources: [
    { id: 'server-errors', kind: 'postgrest-errors', url_env: 'SUPABASE_URL', key_env: 'SUPABASE_SERVICE_ROLE_KEY', table: 'server_errors', group_by: ['function_name', 'error_code'], title_column: 'message' },
    { id: 'heartbeats', kind: 'postgrest-heartbeats', url_env: 'SUPABASE_URL', key_env: 'SUPABASE_SERVICE_ROLE_KEY', table: 'app_settings' },
    { id: 'deploys', kind: 'vercel-deploys', project: 'example-app' },
    { id: 'sentry', kind: 'sentry-issues', org: 'example-org', project: 'example-web', region: 'https://de.sentry.io', token_env: 'SENTRY_AUTH_TOKEN' },
  ],
  intervals: { 'weekly_*': 192 },
};
const PRD = { stories: { 'S16-AUD-001': { title: 'existing', passes: true }, 'S16-AUD-002': { title: 'pending', passes: null } } };
const LIVE_REMOTE = 'https://github.com/example-org/live-product.git';
const ALLOWED_REMOTE = 'https://example.invalid/production-signals-apply-fixture.git';

const QUIET_FIXTURES = {
  'server-errors': errorRows('save-thing', 'HTTP_429', 1, 100),
  heartbeats: [{ key: 'nightly_backup_last_run', value: { at: ago(3) }, updated_at: ago(3) }],
  deploys: { deployments: [{ uid: 'dpl_ok', url: 'app-ok.vercel.app', state: 'READY', target: 'production', createdAt: nowMs - 3600000 }] },
  sentry: [],
};

const NOISY_FIXTURES = {
  // one group of 12 events over 3 days -> ONE candidate, not 12
  // one group of 3 events -> held (min_count)
  // one group of 40 events all within the last 2 hours -> held (min_age: deploy in progress)
  // one group whose message ECHOES the canary secret -> must come out redacted
  'server-errors': [].concat(
    errorRows('research-tracks', 'TIMEOUT', 12, 72),
    errorRows('minor-thing', 'HTTP_500', 3, 48),
    errorRows('just-deployed', 'CHUNK_404', 40, 2),
    errorRows('leaky-fn', 'AUTH', 9, 60, `upstream rejected key ${CANARY} for ${CANARY_URL}`),
    // 60 rows inside 9 minutes, six days ago, never again -> held as a burst (min_span_hours)
    Array.from({ length: 60 }, (_, i) => ({ created_at: new Date(nowMs - 6 * 86400000 + i * 9000).toISOString(), function_name: 'json-burst', error_code: null, message: 'invalid input syntax for type json' })),
  ),
  heartbeats: [
    { key: 'nightly_backup_last_run', value: { at: ago(72) }, updated_at: ago(72) },          // stale -> proposed
    { key: 'hourly_probe_last_run', value: { at: ago(1) }, updated_at: ago(1) },              // fresh -> held
    { key: 'frozen_updated_at_last_run', value: { at: ago(2) }, updated_at: ago(600) },       // value.at fresh, column frozen -> GREATEST -> fresh
    { key: 'weekly_mix_send_last_run', value: { at: ago(86) }, updated_at: ago(86) },         // 86 h, but declared weekly (192 h) -> fresh
    { key: 'weekly_digest_last_run', value: { at: ago(200) }, updated_at: ago(200) },        // 200 h > 192 h via the weekly_* glob -> stale
  ],
  deploys: { deployments: [
    { uid: 'dpl_err', url: 'app-err.vercel.app', state: 'ERROR', target: 'production', createdAt: nowMs - 2 * 3600000, meta: { githubCommitRef: 'main', githubCommitMessage: 'ship it' } },
    { uid: 'dpl_prev', url: 'app-prev.vercel.app', state: 'ERROR', target: null, createdAt: nowMs - 3600000 },
    { uid: 'dpl_ok', url: 'app-ok.vercel.app', state: 'READY', target: 'production', createdAt: nowMs - 3600000 },
  ] },
  sentry: [
    { id: '4001', title: `TypeError: cannot read x (token ${CANARY})`, count: '37', firstSeen: ago(120), lastSeen: ago(1), permalink: 'https://de.sentry.io/organizations/example-org/issues/4001/' },
    { id: '4002', title: 'Flake once', count: '1', firstSeen: ago(30), lastSeen: ago(30), permalink: 'https://de.sentry.io/organizations/example-org/issues/4002/' },
  ],
};

// ---------------------------------------------------------------------------
console.log('control: a fresh signal IS proposed, once per issue, in story shape');
// Expected candidates from NOISY_FIXTURES: research-tracks (12 over 3 d), leaky-fn (9 over 2.5 d),
// the stale heartbeat, the weekly digest 200 h silent, the failed production deploy, sentry 4001 (37). Six.
// Held: minor-thing (3), just-deployed (age), json-burst (span), hourly_probe, frozen_updated_at and
// weekly_mix_send (fresh), sentry 4002 (1). Seven.
{
  const dir = mkRepo('control', { remote: LIVE_REMOTE, prd: PRD, config: CONFIG, fixtures: NOISY_FIXTURES });
  const r = run(dir);
  check('exit 0 when every source was checked', r.code === 0, r.all);
  check('stdout names the candidate count', /6 new candidate/.test(r.out), r.out);
  const report = readReport(dir);
  const json = readReportJson(dir);
  const ids = json.candidates.map((c) => c.id);
  check('12 events of one group produced ONE candidate, not twelve', json.candidates.filter((c) => c.source.id === 'research-tracks:TIMEOUT').length === 1, ids.join(','));
  check('candidate ids take the prd.json prefix and a PROD lane', ids.every((id) => /^S16-PROD-\d{3}$/.test(id)), ids.join(','));
  check('candidate ids are sequential from 001', ids.join(',') === 'S16-PROD-001,S16-PROD-002,S16-PROD-003,S16-PROD-004,S16-PROD-005,S16-PROD-006', ids.join(','));
  check('every candidate is passes: null', json.candidates.every((c) => c.passes === null));
  check('summarise() reads them as pending, not as anything else', (() => { const s = prdStates.summarise(json.candidates); return s.pending === 6 && s.unrecognised === 0 && s.done === 0; })());
  check('acceptance names the signal going quiet', json.candidates.every((c) => c.acceptance.some((a) => /quiet|READY|heartbeat .* written/.test(a))));
  check('evidence is attached as a runnable query or URL', json.candidates.every((c) => /^(select |https:\/\/)/.test(c.source.evidence)), json.candidates.map((c) => c.source.evidence).join(' | '));
  check('the report carries the story JSON block', /```json/.test(report) && /"passes": null/.test(report));
  check('stale heartbeat proposed, fresh one held', json.candidates.some((c) => c.source.id === 'nightly_backup_last_run') && json.held.some((h) => h.id === 'hourly_probe_last_run' && /fresh/.test(h.reason)), JSON.stringify(json.held));
  check('frozen updated_at does not make a fresh heartbeat look dead (GREATEST)', json.held.some((h) => h.id === 'frozen_updated_at_last_run' && /fresh/.test(h.reason)), JSON.stringify(json.held));
  check('failed PRODUCTION deploy proposed at count 1; failed PREVIEW is not a signal', json.candidates.some((c) => c.source.id === 'dpl_err' && c.priority === 1) && !json.candidates.concat(json.held).some((x) => (x.source ? x.source.id : x.id) === 'dpl_prev'));
  check('sentry issue with 37 events proposed; the 1-event issue held by min_count', json.candidates.some((c) => c.source.id === '4001') && json.held.some((h) => h.id === '4002' && /min_count/.test(h.reason)));
  check('ledger records each proposal keyed by source:id with its story id', (() => { const l = readLedger(dir); return l.proposed['server-errors:research-tracks:TIMEOUT'] && l.proposed['server-errors:research-tracks:TIMEOUT'].story_id === 'S16-PROD-001' && l.runs.length === 1 && l.runs[0].candidates === 6; })());
  check('the live repo\'s prd.json was NOT touched without --apply', JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'prd.json'), 'utf8'))) === JSON.stringify(PRD));

  console.log('thresholds hold back noise and say why');
  check('3 events held with the min_count reason', json.held.some((h) => h.id === 'minor-thing:HTTP_500' && /count 3 < min_count 5/.test(h.reason)), JSON.stringify(json.held));
  check('40 events all under 2 h old held as a deploy in progress', json.held.some((h) => h.id === 'just-deployed:CHUNK_404' && /min_age_hours/.test(h.reason)), JSON.stringify(json.held));
  check('60 events inside 9 minutes six days ago held as a burst, not a chronic defect', json.held.some((h) => h.id === 'json-burst:∅' && /burst: spanned 0\.1 h < min_span_hours 24/.test(h.reason)), JSON.stringify(json.held));
  check('a weekly heartbeat at 86 h is fresh under its declared 192 h interval', json.held.some((h) => h.id === 'weekly_mix_send_last_run' && /fresh \(86 h < 192 h\)/.test(h.reason)), JSON.stringify(json.held));
  check('  and the same glob makes a 200 h weekly heartbeat stale', json.candidates.some((c) => c.source.id === 'weekly_digest_last_run' && /stale 200 h ≥ 192 h/.test(c.source.proposed_because)));

  console.log('no secret reaches any byte the collector writes');
  const everything = r.all + everyByteWritten(dir);
  check('canary key absent from stdout, stderr, report, json and ledger', !everything.includes(CANARY));
  check('canary URL absent everywhere too', !everything.includes(CANARY_URL));
  check('  and it was redacted, not dropped: the leaky message survives with [REDACTED]', /leaky-fn[\s\S]*\[REDACTED\]/.test(report), report.slice(0, 300));
  check('  the sentry title that echoed the token is redacted as well', /TypeError: cannot read x \(token \[REDACTED\]\)/.test(report));
  check('  the JSON report and the ledger are scrubbed as parsed objects, not as escaped text', !JSON.stringify(readReportJson(dir)).includes(JSON.stringify(CANARY).slice(1, -1)) && !JSON.stringify(readLedger(dir)).includes(JSON.stringify(CANARY).slice(1, -1)));

  console.log('the ledger prevents a re-proposal');
  const before = fs.statSync(path.join(dir, '.claude', 'reports', 'production-candidates-2026-09-08.md')).mtimeMs;
  const r2 = run(dir);
  check('second identical run exits 0', r2.code === 0, r2.all);
  check('second identical run emits ZERO bytes on stdout', r2.out === '', JSON.stringify(r2.out));
  check('second identical run emits ZERO bytes on stderr', r2.err === '', JSON.stringify(r2.err));
  check('the report is not rewritten', fs.statSync(path.join(dir, '.claude', 'reports', 'production-candidates-2026-09-08.md')).mtimeMs === before);
  const l2 = readLedger(dir);
  check('the quiet run is still recorded in the ledger', l2.runs.length === 2 && l2.runs[1].candidates === 0 && l2.runs[1].held === 13, JSON.stringify(l2.runs[1]));
  const r3 = run(dir, ['--summary']);
  check('--summary prints the population on a quiet run', /4\/4 sources checked, .* 0 new candidate/.test(r3.out), r3.out);
  check('a seen-but-held signal refreshes its ledger last_seen', readLedger(dir).proposed['server-errors:research-tracks:TIMEOUT'].first_proposed === NOW && readLedger(dir).proposed['server-errors:research-tracks:TIMEOUT'].last_proposed === NOW);
}

// ---------------------------------------------------------------------------
console.log('a chronic signal that never goes quiet is proposed ONCE across sliding windows');
{
  const cfg = { sources: [CONFIG.sources[0]] };
  const dir = mkRepo('chronic', { remote: LIVE_REMOTE, prd: PRD, config: cfg, fixtures: {} });
  const day = 86400000;
  const proposals = [];
  // Runs every 10 days, closer together than the 14-day window, which is how the
  // skill is meant to be run. (Two runs 45 days apart with a 14-day window leave a
  // real 31-day hole in what the collector SAW, and a return after a hole is a
  // regression by definition.)
  for (const dayOffset of [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]) {
    const at = nowMs + dayOffset * day;
    // rows spread over the 14 days ending at `at`, so first_seen slides forward with the window
    const rows = Array.from({ length: 10 }, (_, i) => ({ created_at: new Date(at - i * 1.2 * day).toISOString(), function_name: 'chronic', error_code: 'E', message: 'always' }));
    fs.writeFileSync(path.join(dir, 'fixtures', 'server-errors.json'), JSON.stringify(rows));
    const r = spawnSync(process.execPath, [SCRIPT, '--fixture-dir', 'fixtures', '--now', new Date(at).toISOString()], { cwd: dir, encoding: 'utf8', env: Object.assign({}, process.env, { SUPABASE_SERVICE_ROLE_KEY: CANARY, SUPABASE_URL: CANARY_URL }) });
    proposals.push(/new candidate/.test(r.stdout) ? 1 : 0);
  }
  check('proposed on day 0 and never again across nine later runs', proposals.join(',') === '1,0,0,0,0,0,0,0,0,0', proposals.join(','));
  check('first_proposed survives, last_seen moved to day 90', (() => { const p = readLedger(dir).proposed['server-errors:chronic:E']; return p.first_proposed === NOW && Date.parse(p.last_seen) > nowMs + 89 * day; })());
}

// ---------------------------------------------------------------------------
console.log('quiet sources: zero bytes, no report, exit 0');
{
  const dir = mkRepo('quiet', { remote: LIVE_REMOTE, prd: PRD, config: CONFIG, fixtures: QUIET_FIXTURES });
  const r = run(dir);
  check('exit 0', r.code === 0, r.all);
  check('zero bytes on stdout', r.out === '', JSON.stringify(r.out));
  check('zero bytes on stderr', r.err === '', JSON.stringify(r.err));
  check('no candidates file written; only the ledger', reportsOf(dir).join(',') === 'production-signals-ledger.json', reportsOf(dir).join(','));
}

// ---------------------------------------------------------------------------
console.log('re-proposal: only after a quiet spell, or a tenfold escalation');
{
  const dir = mkRepo('requiet', { remote: LIVE_REMOTE, prd: PRD, config: { sources: [CONFIG.sources[0]] }, fixtures: { 'server-errors': [].concat(errorRows('returned', 'X', 8, 48), errorRows('escalated', 'Y', 60, 100), errorRows('steady', 'Z', 8, 100)) } });
  fs.mkdirSync(path.join(dir, '.claude', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'reports', 'production-signals-ledger.json'), JSON.stringify({
    schema: 1, runs: [], proposed: {
      'server-errors:returned:X': { first_proposed: ago(24 * 90), last_seen: ago(24 * 80), count: 8, story_id: 'S16-PROD-001' },   // quiet 80 days, back -> regression
      'server-errors:escalated:Y': { first_proposed: ago(24 * 20), last_seen: ago(24 * 5), count: 5, story_id: 'S16-PROD-002' },   // 5 -> 60 = 12x
      'server-errors:steady:Z': { first_proposed: ago(24 * 20), last_seen: ago(24 * 5), count: 7, story_id: 'S16-PROD-003' },      // 7 -> 8, already proposed
    },
  }));
  const r = run(dir);
  const json = readReportJson(dir);
  check('a signal quiet for 30+ days that returned is re-proposed as a regression', json.candidates.some((c) => c.source.id === 'returned:X' && /regression of S16-PROD-001/.test(c.source.proposed_because)), JSON.stringify(json.candidates.map((c) => c.source.proposed_because)));
  check('a tenfold escalation is re-proposed', json.candidates.some((c) => c.source.id === 'escalated:Y' && /escalated 5 → 60/.test(c.source.proposed_because)));
  check('a steady already-proposed signal is held, naming its story', json.held.some((h) => h.id === 'steady:Z' && /already proposed .* as S16-PROD-003/.test(h.reason)), JSON.stringify(json.held));
  check('new ids continue after the highest PROD id in the ledger', json.candidates.map((c) => c.id).sort().join(',') === 'S16-PROD-004,S16-PROD-005', json.candidates.map((c) => c.id).join(','));
}

// ---------------------------------------------------------------------------
console.log('ignore list holds back a known flake');
{
  const cfg = Object.assign({}, CONFIG, { sources: [CONFIG.sources[0]], ignore: ['server-errors:research-tracks:*'] });
  const dir = mkRepo('ignore', { remote: LIVE_REMOTE, prd: PRD, config: cfg, fixtures: { 'server-errors': errorRows('research-tracks', 'TIMEOUT', 12, 72) } });
  const r = run(dir, ['--summary']);
  check('ignored pattern produces no candidate and is listed as held', r.code === 0 && /0 new candidate/.test(r.out) && reportsOf(dir).join(',') === 'production-signals-ledger.json', r.all + reportsOf(dir).join(','));
}

// ---------------------------------------------------------------------------
console.log('--apply refuses a live repo, applies to the allowlisted one');
{
  const live = mkRepo('live', { remote: LIVE_REMOTE, prd: PRD, config: CONFIG, fixtures: NOISY_FIXTURES });
  const before = fs.readFileSync(path.join(live, 'prd.json'), 'utf8');
  const r = run(live, ['--apply']);
  check('live repo: exit 2', r.code === 2, r.all);
  check('live repo: stderr says APPLY REFUSED and names the allowlist', /APPLY REFUSED: example-org\/live-product is not on the direct-write allowlist/.test(r.err), r.err);
  check('live repo: prd.json byte-identical', fs.readFileSync(path.join(live, 'prd.json'), 'utf8') === before);
  check('live repo: the proposal file was still written, so the work is not lost', reportsOf(live).includes('production-candidates-2026-09-08.md'));
  check('live repo: ledger marks the proposals as NOT applied', Object.values(readLedger(live).proposed).every((p) => p.applied === false));

  const allowed = mkRepo('allowed', { remote: ALLOWED_REMOTE, prd: PRD, config: CONFIG, fixtures: NOISY_FIXTURES });
  const allowedBefore = fs.readFileSync(path.join(allowed, 'prd.json'), 'utf8');
  const r1 = run(allowed);
  check('allowlisted repo WITHOUT --apply: prd.json byte-identical (the allowlist is not the guard, the flag is)', r1.code === 0 && fs.readFileSync(path.join(allowed, 'prd.json'), 'utf8') === allowedBefore, r1.all);
  fs.rmSync(path.join(allowed, '.claude', 'reports'), { recursive: true, force: true });
  const r2 = run(allowed, ['--apply']);
  check('allowlisted repo: exit 0', r2.code === 0, r2.all);
  check('allowlisted repo: stdout reports the apply', /applied 6 stories into prd.json/.test(r2.out), r2.out);
  const prd = JSON.parse(fs.readFileSync(path.join(allowed, 'prd.json'), 'utf8'));
  const stories = prdStates.storiesOf(prd);
  check('allowlisted repo: the six stories are in prd.json, pending', prdStates.summarise(stories).pending === 7 && stories['S16-PROD-001'] && stories['S16-PROD-001'].passes === null, Object.keys(stories).join(','));
  check('allowlisted repo: existing stories untouched', stories['S16-AUD-001'].passes === true && stories['S16-AUD-002'].passes === null);
  check('allowlisted repo: applied prd.json carries no canary', !fs.readFileSync(path.join(allowed, 'prd.json'), 'utf8').includes(CANARY));
  check('allowlisted repo: ledger marks applied', Object.values(readLedger(allowed).proposed).every((p) => p.applied === true));
  const r3 = run(allowed, ['--apply']);
  check('allowlisted repo: a second --apply has nothing new and applies nothing', r3.code === 0 && /apply: nothing new to apply/.test(r3.out) && prdStates.summarise(prdStates.storiesOf(JSON.parse(fs.readFileSync(path.join(allowed, 'prd.json'), 'utf8')))).pending === 7, r3.all);

  const noPrd = mkRepo('allowed-noprd', { remote: ALLOWED_REMOTE, config: CONFIG, fixtures: NOISY_FIXTURES });
  const r4 = run(noPrd, ['--apply']);
  check('allowlisted repo without prd.json: refused, and the reason names prd.json rather than inventing one', r4.code === 2 && /APPLY REFUSED: .*prd\.json is missing/.test(r4.err) && !fs.existsSync(path.join(noPrd, 'prd.json')), r4.err);

  const noRemote = mkRepo('noremote', { prd: PRD, config: CONFIG, fixtures: NOISY_FIXTURES });
  const r5 = run(noRemote, ['--apply']);
  check('no origin remote: refused with that reason', r5.code === 2 && /no origin remote/.test(r5.err), r5.err);

  const nested = mkRepo('nested', { remote: ALLOWED_REMOTE, config: { sources: [CONFIG.sources[0]] }, fixtures: { 'server-errors': errorRows('a', 'B', 12, 72) }, prd: { sprints: [{ id: 'S1', stories: { 'S1-001': { passes: true } } }, { id: 'S2', stories: { 'S2-001': { passes: null } } }] } });
  const r6 = run(nested, ['--apply']);
  const nprd = JSON.parse(fs.readFileSync(path.join(nested, 'prd.json'), 'utf8'));
  check('nested prd.json: exit 0 and the story lands in the NEWEST sprint under the first-seen prefix (S1: stable sort, equal counts)', r6.code === 0 && nprd.sprints[1].stories['S1-PROD-001'] !== undefined, r6.all + JSON.stringify(nprd.sprints.map((s) => Object.keys(s.stories))));
  check('nested prd.json: sprint 1 untouched', Object.keys(nprd.sprints[0].stories).join(',') === 'S1-001');
}

// ---------------------------------------------------------------------------
console.log('a source that cannot be checked is named, never silently empty');
{
  const fx = Object.assign({}, NOISY_FIXTURES); delete fx.sentry;
  const dir = mkRepo('failure', { remote: LIVE_REMOTE, prd: PRD, config: CONFIG, fixtures: fx });
  const r = run(dir);
  check('exit 2 when a source fails', r.code === 2, r.all);
  check('stderr says COULD NOT CHECK and names the source', /COULD NOT CHECK sentry: fixture missing/.test(r.err), r.err);
  check('the other three sources still produced candidates', /5 new candidate/.test(r.err), r.err);
  check('the report carries a "Could not check" section', /## Could not check[\s\S]*\*\*sentry\*\*/.test(readReport(dir)));
  check('the failed source is recorded in the ledger run', readLedger(dir).runs[0].sources_failed.join(',') === 'sentry');
  check('no canary on the failure path either', !(r.all + everyByteWritten(dir)).includes(CANARY));
}

// ---------------------------------------------------------------------------
console.log('no config: refuses with a pointer, exit 2');
{
  const dir = mkRepo('noconfig', { remote: LIVE_REMOTE, prd: PRD });
  const r = run(dir);
  check('exit 2 and stderr names the config path and the skill', r.code === 2 && /no sources configured at \.claude\/production-signals\.json/.test(r.err) && /production-radar/.test(r.err), r.all);
  check('nothing written', reportsOf(dir).length === 0);
}

// ---------------------------------------------------------------------------
console.log('unit seams');
{
  check('derivePrefix picks the majority prefix', subject.derivePrefix({ stories: { 'S16-A': {}, 'S16-B': {}, 'S15-C': {} } }) === 'S16');
  check('derivePrefix falls back to PROD with no prd.json', subject.derivePrefix(null) === 'PROD');
  check('--sprint overrides derivation', subject.derivePrefix({ stories: { 'S16-A': {} } }, 'S17') === 'S17');
  check('APPLY_ALLOWLIST holds two well-formed digests and no names', subject.APPLY_ALLOWLIST.every((d) => /^[a-f0-9]{64}$/.test(d)) && subject.APPLY_ALLOWLIST.length === 2);
  check('the fixture remote is one of them; a refused remote is not', subject.APPLY_ALLOWLIST.includes(subject.sha256('example.invalid/production-signals-apply-fixture')) && !subject.APPLY_ALLOWLIST.includes(subject.sha256('example-org/live-product')));
  check('sentryRegion accepts sentry.io hosts over https only', subject.sentryRegion({ region: 'https://de.sentry.io' }) === 'https://de.sentry.io' && subject.sentryRegion({}) === 'https://sentry.io');
  check('sentryRegion refuses any other host before a credential is read', ['http://127.0.0.1:9', 'https://sentry.io.evil.test', 'https://example.com', 'not a url'].every((r) => { try { subject.sentryRegion({ region: r }); return false; } catch (e) { return /refusing|not a URL/.test(e.message); } }));
  check('a bare PROD prefix yields PROD-001, not PROD-PROD-001', (() => { const d = mkRepo('noprd', { remote: LIVE_REMOTE, config: { sources: [CONFIG.sources[0]] }, fixtures: { 'server-errors': errorRows('a', 'B', 12, 72) } }); run(d); return Object.values(readLedger(d).proposed)[0].story_id === 'PROD-001'; })());
  check('a malformed --now is an error, not a silent fallback to the wall clock', (() => { const d = mkRepo('badnow', { remote: LIVE_REMOTE, prd: PRD, config: { sources: [CONFIG.sources[0]] }, fixtures: { 'server-errors': [] } }); const r = spawnSync(process.execPath, [SCRIPT, '--fixture-dir', 'fixtures', '--now', 'yesterday-ish'], { cwd: d, encoding: 'utf8' }); return r.status === 2 && /--now is not a parseable timestamp/.test(r.stderr); })());
  check('originOwnerRepo parses ssh and https shapes', (() => {
    const d = mkRepo('ssh', { remote: 'git@github.com:Some-Org/Some.Repo.git' });
    return subject.originOwnerRepo(d) === 'some-org/some.repo';
  })());
  const red = new subject.Redactor(); red.add('short'); red.add(CANARY);
  check('Redactor scrubs long values and ignores values under 8 chars', red.scrub(`a ${CANARY} b short`) === 'a [REDACTED] b short');
  check('staleHoursFor: exact key beats glob beats default', subject.staleHoursFor('a_last_run', { intervals: { a_last_run: 10, 'a_*': 20 } }, { stale_hours: 48 }) === 10 && subject.staleHoursFor('a_x', { intervals: { 'a_*': 20 } }, { stale_hours: 48 }) === 20 && subject.staleHoursFor('b', { intervals: { 'a_*': 20 } }, { stale_hours: 48 }) === 48);
  check('DEFAULT_THRESHOLDS carries every source kind', ['sentry-issues', 'postgrest-errors', 'postgrest-heartbeats', 'vercel-deploys'].every((k) => subject.DEFAULT_THRESHOLDS[k]));
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const thresholdDoc = src.slice(src.indexOf('DEFAULT THRESHOLDS'), src.indexOf('const DEFAULT_THRESHOLDS'));
  check('the threshold doc block itself carries dated measurements', (thresholdDoc.match(/\[measured 2026-09-08\]/g) || []).length >= 3);
}

// ---------------------------------------------------------------------------
console.log('real network path: GET only, Content-Range pagination, host refusal — against a local server');
{
  const http = require('http');
  const seen = [];
  const rowsAll = Array.from({ length: 1500 }, (_, i) => ({ created_at: ago(72 - (i % 70)), function_name: 'paged', error_code: 'P', message: 'row ' + i }));
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', range: req.headers.range || '' });
    const m = /^(\d+)-(\d+)$/.exec(req.headers.range || '');
    const from = m ? Number(m[1]) : 0;
    const page = rowsAll.slice(from, from + 700); // server clamps at 700, BELOW the client's 1000
    res.setHeader('content-range', `${from}-${from + page.length - 1}/${rowsAll.length}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(page));
  });
  const done = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  done.then(() => {
    const port = server.address().port;
    const dir = mkRepo('net', { remote: LIVE_REMOTE, prd: PRD, config: { sources: [
      { id: 'server-errors', kind: 'postgrest-errors', url_env: 'SUPABASE_URL', key_env: 'SUPABASE_SERVICE_ROLE_KEY', table: 'server_errors', group_by: ['function_name', 'error_code'] },
      { id: 'sentry', kind: 'sentry-issues', org: 'o', project: 'p', region: `http://127.0.0.1:${port}`, token_env: 'SUPABASE_SERVICE_ROLE_KEY' },
    ] } });
    // spawn, not spawnSync: the server lives in THIS process and must answer while the child runs
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [SCRIPT, '--now', NOW, '--summary'], { cwd: dir, env: Object.assign({}, process.env, { SUPABASE_URL: `http://127.0.0.1:${port}`, SUPABASE_SERVICE_ROLE_KEY: CANARY }) });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    return new Promise((resolve) => child.on('close', (status) => resolve({ status, stdout: out, stderr: err })));
  }).then((r) => {
    server.close();
    check('every request the collector made was a GET', seen.length > 0 && seen.every((s) => s.method === 'GET'), JSON.stringify(seen.map((s) => s.method)));
    check('it paged past a server clamp of 700 using Content-Range: 3 pages for 1500 rows', seen.filter((s) => /rest\/v1/.test(s.url)).length === 3, JSON.stringify(seen.map((s) => s.range)));
    check('  and counted all 1500 rows into one group (on stderr: a failed source routes the whole report there)', /1500 over/.test(r.stderr), r.stdout + r.stderr);
    check('the credential went only to the host the ENVIRONMENT named, never to the host the config named', seen.every((s) => /rest\/v1/.test(s.url)) && !seen.some((s) => /api\/0\/projects/.test(s.url)), JSON.stringify(seen.map((s) => s.url)));
    check('the config-named sentry host was refused by name on stderr, exit 2', r.status === 2 && /COULD NOT CHECK sentry: sentry region 127\.0\.0\.1:\d+ is not a sentry\.io host/.test(r.stderr), r.stderr);
    check('no canary in that output either', !(r.stdout + r.stderr).includes(CANARY));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  });
}

// the skill section below runs synchronously before the network section resolves
{
}

// ---------------------------------------------------------------------------
console.log('the skill runs this script and never as a hook');
{
  const skill = fs.readFileSync(SKILL, 'utf8');
  check('production-radar skill exists and invokes the collector', /production-signals\.js/.test(skill));
  check('skill is user-invocable and declares Bash', /user-invocable:\s*true/.test(skill) && /allowed-tools:[^\n]*Bash/.test(skill));
  check('skill forbids --apply on a repo with users', /--apply/.test(skill) && /allowlist/.test(skill));
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'hooks.json'), 'utf8'));
  check('no hook wires production-signals (it must not run every turn)', !JSON.stringify(hooks).includes('production-signals'));
}

