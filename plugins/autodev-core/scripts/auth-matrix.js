#!/usr/bin/env node
'use strict';
/**
 * auth-matrix.js - probe every protected route as every role, server-side.
 *
 * WHY. "Auth checks on protected routes" was a checklist line that nothing
 * executed. A page that hides its UI client-side while its server, or the API
 * behind it, still returns the data passes every visual check: the screenshot
 * is empty and the network response is full. This asks the server directly,
 * once per role per target, and fails when a role that should be denied gets
 * data.
 *
 * INPUT. A matrix file (JSON):
 *
 *   {
 *     "baseUrl": "https://example.com",
 *     "roles": {
 *       "anon":   {},
 *       "member": { "cookieEnv": "MEMBER_COOKIE" },
 *       "admin":  { "headerEnv": "ADMIN_TOKEN", "header": "Authorization" }
 *     },
 *     "loginPattern": "^/login",
 *     "sensitiveMarkers": ["a string only privileged data contains"],
 *     "targets": [
 *       { "path": "/admin", "method": "GET", "allowEmpty200": true,
 *         "expect": { "anon": "deny", "member": "deny", "admin": "allow" } }
 *     ]
 *   }
 *
 * Credentials come ONLY from the named environment variables. Their values are
 * never printed: output names the variable and whether it is set.
 *
 * VERDICTS, per cell (role x target):
 *   PASS        deny held (401/403/404, or a 3xx whose Location matches
 *               loginPattern, with no marker in the body; or an empty 200 on a
 *               target with allowEmpty200), or allow held (a 2xx).
 *   LEAK        a deny was expected and the response carried data: a marker in
 *               the body at any status, or a 2xx the target does not excuse.
 *   FAIL        the expectation did not hold and no data leaked: an allowed
 *               role was refused, or a deny came back as a 5xx or a redirect
 *               somewhere other than login.
 *   UNVERIFIED  the cell was not measured: its credential variable is unset,
 *               the request failed, no expectation was declared, or an empty
 *               200 was excused by a marker no allowed response ever carried.
 *
 * EXIT. 1 on any LEAK or FAIL. Otherwise 2 on any UNVERIFIED, or on an invalid
 * matrix. 0 only when every expected cell was probed and passed.
 *
 * Usage:
 *   node auth-matrix.js <matrix.json> [--json] [--timeout <ms>]
 *   node auth-matrix.js --help
 */

const fs = require('fs');

const HELP = `Usage: node auth-matrix.js <matrix.json> [--json] [--timeout <ms>]

Probes each target in the matrix as each role, with redirects NOT followed,
and grades every cell PASS, LEAK, FAIL or UNVERIFIED.

  --json          print one JSON object instead of the table
  --timeout <ms>  per-request timeout (default 10000)
  --help          this text

Exit: 0 all cells probed and passed, 1 any LEAK or FAIL, 2 any UNVERIFIED
or an invalid matrix. Credentials come only from the environment variables
the matrix names (cookieEnv, headerEnv); their values are never printed.`;

function parseArgs(argv) {
  const out = { file: null, json: false, timeout: 10000, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (!out.file) out.file = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  return out;
}

// ---- matrix validation -----------------------------------------------------

function loadMatrix(file) {
  const errors = [];
  let m;
  try {
    m = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { errors: [`cannot read matrix ${file}: ${e.code || e.message}`] };
  }
  if (!m || typeof m !== 'object') return { errors: ['matrix is not an object'] };
  try { new URL(m.baseUrl); } catch { errors.push('baseUrl is missing or not a URL'); }
  const roles = m.roles && typeof m.roles === 'object' ? m.roles : null;
  if (!roles || Object.keys(roles).length === 0) errors.push('roles is missing or empty');
  for (const [name, r] of Object.entries(roles || {})) {
    if (!r || typeof r !== 'object') { errors.push(`role ${name} is not an object`); continue; }
    if (r.cookieEnv !== undefined && typeof r.cookieEnv !== 'string') errors.push(`role ${name}: cookieEnv must be a variable name`);
    if (r.headerEnv !== undefined && (typeof r.headerEnv !== 'string' || typeof r.header !== 'string')) {
      errors.push(`role ${name}: headerEnv needs a variable name and a header name`);
    }
    if (r.cookieEnv && r.headerEnv) errors.push(`role ${name}: give cookieEnv or headerEnv, not both`);
  }
  let loginPattern = null;
  if (m.loginPattern !== undefined) {
    try { loginPattern = new RegExp(m.loginPattern); } catch { errors.push('loginPattern is not a valid regex'); }
  }
  const markers = Array.isArray(m.sensitiveMarkers) ? m.sensitiveMarkers.filter((s) => typeof s === 'string' && s) : [];
  if (m.sensitiveMarkers !== undefined && !Array.isArray(m.sensitiveMarkers)) errors.push('sensitiveMarkers must be an array');
  const targets = Array.isArray(m.targets) ? m.targets : [];
  if (targets.length === 0) errors.push('targets is missing or empty');
  targets.forEach((t, i) => {
    if (!t || typeof t.path !== 'string' || !t.path.startsWith('/')) errors.push(`target ${i}: path must start with /`);
    if (!t || !t.expect || typeof t.expect !== 'object') { errors.push(`target ${i}: expect is missing`); return; }
    for (const [role, e] of Object.entries(t.expect)) {
      if (!roles || !(role in roles)) errors.push(`target ${i}: expect names unknown role ${role}`);
      if (e !== 'allow' && e !== 'deny') errors.push(`target ${i}: expect.${role} must be allow or deny`);
    }
  });
  return { errors, matrix: { baseUrl: m.baseUrl, roles: roles || {}, loginPattern, markers, targets } };
}

// ---- credentials -----------------------------------------------------------

// Reads a role's credential. The value stays inside this object and the
// request headers; nothing that prints ever receives it.
function credentialOf(role) {
  const env = role.cookieEnv || role.headerEnv || null;
  if (!env) return { env: null, present: true, headers: {} };
  const value = process.env[env];
  if (!value) return { env, present: false, headers: {} };
  const headers = role.cookieEnv ? { cookie: value } : { [role.header]: value };
  return { env, present: true, headers, value };
}

// Scrub every credential value, in the forms a URL can carry it, from a
// string before it is stored for output.
function scrubber(values) {
  const forms = [];
  for (const v of values) {
    forms.push(v, encodeURIComponent(v), encodeURI(v));
  }
  forms.sort((a, b) => b.length - a.length);
  return (s) => {
    let out = String(s);
    for (const f of forms) if (f) out = out.split(f).join('[REDACTED]');
    return out;
  };
}

// ---- probing ---------------------------------------------------------------

async function probe(url, target, credential, timeout) {
  const headers = { ...credential.headers };
  let body;
  if (target.body !== undefined) {
    body = typeof target.body === 'string' ? target.body : JSON.stringify(target.body);
    if (typeof target.body !== 'string') headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, {
    method: (target.method || 'GET').toUpperCase(),
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), text };
}

// Grades one measured cell. Kept pure so every rule is visible in one place.
function grade(expect, resp, target, loginPattern, markerHits) {
  const s = resp.status;
  if (expect === 'allow') {
    if (s >= 200 && s < 300) return { verdict: 'PASS', why: 'allowed' };
    return { verdict: 'FAIL', why: `allowed role got ${s}` };
  }
  // A deny was expected. Data in the body is a leak at any status.
  if (markerHits.length > 0) {
    return { verdict: 'LEAK', why: `sensitive marker in a ${s} body` };
  }
  if (s === 401 || s === 403 || s === 404) return { verdict: 'PASS', why: 'denied' };
  if (s >= 300 && s < 400) {
    if (loginPattern && resp.location && loginPattern.test(resp.location)) return { verdict: 'PASS', why: 'redirected to login' };
    return { verdict: 'FAIL', why: 'redirect that is not to login' };
  }
  if (s >= 200 && s < 300) {
    if (s === 200 && target.allowEmpty200) return { verdict: 'PASS', why: 'empty 200, excused by allowEmpty200', empty200: true };
    return { verdict: 'LEAK', why: 'a 2xx where a deny was expected' };
  }
  return { verdict: 'FAIL', why: `unexpected ${s} where a deny was expected` };
}

// Measures one cell into `row`. Every early return leaves a verdict behind.
async function measureCell(row, url, target, credential, matrix, timeout, scrub) {
  const unverified = (why) => { row.verdict = 'UNVERIFIED'; row.why = why; };
  if (!row.expect) return unverified('no expectation declared for this role');
  if (!credential.present) return unverified(`${credential.env} is not set`);
  let resp;
  try {
    resp = await probe(url, target, credential, timeout);
  } catch (e) {
    const code = (e && e.cause && e.cause.code) || (e && e.name) || 'error';
    return unverified(`request failed: ${scrub(code)}`);
  }
  row.probed = true;
  row.status = resp.status;
  row.location = resp.location === null ? null : scrub(resp.location);
  row.bytes = Buffer.byteLength(resp.text);
  row.markerHits = matrix.markers.filter((mk) => resp.text.includes(mk));
  const g = grade(row.expect, resp, target, matrix.loginPattern, row.markerHits);
  row.verdict = g.verdict;
  row.why = g.why;
  if (g.empty200) row.empty200 = true;
}

async function runMatrix(matrix, timeout) {
  const roleNames = Object.keys(matrix.roles);
  const creds = {};
  for (const name of roleNames) creds[name] = credentialOf(matrix.roles[name]);
  const scrub = scrubber(Object.values(creds).map((c) => c.value).filter(Boolean));

  const rows = [];
  for (const target of matrix.targets) {
    const method = (target.method || 'GET').toUpperCase();
    const url = new URL(target.path, matrix.baseUrl).toString();
    const targetRows = [];
    for (const role of roleNames) {
      const row = { role, method, path: target.path, expect: target.expect[role] || null,
        status: null, location: null, bytes: null, markerHits: [], probed: false, verdict: null, why: '' };
      rows.push(row);
      targetRows.push(row);
      await measureCell(row, url, target, creds[role], matrix, timeout, scrub);
    }
    // An empty 200 passes as a deny only because no marker was found in it.
    // That absence means something only if the marker is findable: some
    // allowed response on this target must have carried it. Otherwise the
    // marker may be wrong, and the empty 200 is unmeasured, not safe.
    const markerSeen = targetRows.some((r) => r.expect === 'allow' && r.probed && r.markerHits.length > 0);
    for (const r of targetRows) {
      if (r.empty200 && r.verdict === 'PASS' && !markerSeen) {
        r.verdict = 'UNVERIFIED';
        r.why = 'empty 200, but no allowed response on this target carried a marker, so its absence proves nothing';
      }
    }
  }
  return { rows, creds };
}

// ---- output ----------------------------------------------------------------

function summarise(rows, roleCount, targetCount) {
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  const summary = {
    roles: roleCount,
    targets: targetCount,
    expected: roleCount * targetCount,
    probed: rows.filter((r) => r.probed).length,
    pass: count('PASS'),
    leak: count('LEAK'),
    fail: count('FAIL'),
    unverified: count('UNVERIFIED'),
  };
  // A cell that was expected and never graded is unverified too, so a row
  // lost between the loop and here cannot read as a pass.
  const graded = summary.pass + summary.leak + summary.fail + summary.unverified;
  if (graded !== summary.expected) summary.unverified += summary.expected - graded;
  summary.exitCode = summary.leak > 0 || summary.fail > 0 ? 1 : summary.unverified > 0 ? 2 : 0;
  summary.verdict = summary.leak > 0 ? 'LEAK' : summary.fail > 0 ? 'FAIL' : summary.unverified > 0 ? 'UNVERIFIED' : 'PASS';
  return summary;
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

function renderTable(matrix, creds, rows, summary) {
  const lines = [];
  lines.push(`auth-matrix: ${matrix.baseUrl}`);
  lines.push(`population: roles: ${summary.roles}, targets: ${summary.targets}, probed ${summary.probed} of ${summary.expected} cells`);
  for (const [name, c] of Object.entries(creds)) {
    const r = matrix.roles[name];
    const kind = r.cookieEnv ? 'cookie' : r.headerEnv ? `header ${r.header}` : null;
    lines.push(`  role ${name}: ${kind ? `${kind} from ${c.env} (${c.present ? 'set' : 'UNSET'})` : 'signed out, no credential'}`);
  }
  lines.push(`  sensitive markers: ${matrix.markers.length}`);
  lines.push('');
  const head = ['role', 'target', 'expect', 'status', 'location', 'bytes', 'markers', 'verdict'];
  const body = rows.map((r) => [
    r.role, `${r.method} ${r.path}`, r.expect || '-', r.status === null ? '-' : r.status,
    r.location || '-', r.bytes === null ? '-' : r.bytes,
    r.markerHits.length ? r.markerHits.join(',') : '-', `${r.verdict}  ${r.why}`,
  ]);
  const last = head.length - 1;
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => String(b[i]).length)));
  lines.push(head.map((h, i) => (i === last ? h : pad(h, widths[i]))).join('  '));
  for (const b of body) lines.push(b.map((c, i) => (i === last ? c : pad(c, widths[i]))).join('  '));
  lines.push('');
  lines.push(`auth-matrix ${summary.verdict}: probed ${summary.probed} of ${summary.expected} cells; `
    + `${summary.pass} pass, ${summary.leak} leak, ${summary.fail} fail, ${summary.unverified} unverified`);
  return `${lines.join('\n')}\n`;
}

// ---- main ------------------------------------------------------------------

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`${e.message}\n${HELP}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.help) { process.stdout.write(`${HELP}\n`); return; }
  if (!args.file) { process.stderr.write(`${HELP}\n`); process.exitCode = 2; return; }
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
    process.stderr.write('--timeout needs a positive number of milliseconds\n');
    process.exitCode = 2;
    return;
  }
  const { errors, matrix } = loadMatrix(args.file);
  if (errors.length) {
    process.stderr.write(`auth-matrix UNVERIFIED: invalid matrix, nothing probed\n${errors.map((e) => `  ${e}`).join('\n')}\n`);
    process.exitCode = 2;
    return;
  }
  const { rows, creds } = await runMatrix(matrix, args.timeout);
  const summary = summarise(rows, Object.keys(matrix.roles).length, matrix.targets.length);
  if (args.json) {
    const credentials = Object.fromEntries(Object.entries(creds).map(([n, c]) => [n, { env: c.env, set: c.present }]));
    const population = { roles: summary.roles, targets: summary.targets, probed: summary.probed, expected: summary.expected };
    const clean = rows.map(({ empty200, ...r }) => r);
    process.stdout.write(`${JSON.stringify({ baseUrl: matrix.baseUrl, population, credentials, rows: clean, summary }, null, 2)}\n`);
  } else {
    process.stdout.write(renderTable(matrix, creds, rows, summary));
  }
  process.exitCode = summary.exitCode;
}

if (require.main === module) {
  main().catch((e) => {
    // Only the error's name or code: a message could quote a header.
    process.stderr.write(`auth-matrix UNVERIFIED: ${(e && (e.code || e.name)) || 'error'}\n`);
    process.exitCode = 2;
  });
}

module.exports = { grade, loadMatrix };
