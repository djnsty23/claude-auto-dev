#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/auth-matrix.js, driven as a SUBPROCESS
// against a local http server that plays one app per case.
// Run: node tooling/test-auth-matrix.js
// Exits 1 on any failure; 0 if all pass.
//
// WHY A SUBPROCESS. The script is consumed by its exit code (0 clean, 1 leak or
// failure, 2 unverified), and no in-process test can see an exit code. The
// server runs in THIS process, so the child is spawned asynchronously: a
// spawnSync would block the event loop the server answers on.
//
// WHAT THE CASES PROVE.
//   - a correct app exits 0 and prints its population;
//   - each planted leak fires ALONE, on the row it was planted in;
//   - a missing credential and an unreachable server are UNVERIFIED (exit 2),
//     never a pass and never a silent skip;
//   - the cookie values never reach stdout or stderr in ANY case, in any of
//     the forms a transform could produce (raw, JSON-escaped, URL-encoded).
//
// DETECTOR MUTANTS. For each planted leak the suite also runs a COPY of the
// script with the detector that should catch it disabled, and asserts the copy
// now exits 0 on that leak while still exiting 0 on the correct app. That is
// the proof the leak row went red for the reason credited, not because some
// other branch happened to fire. The anchors are exact strings and each must
// match exactly once, or the mutant proves nothing and the case fails.
//
// The four API/page leaks are built so that each is reachable by exactly ONE
// detector: the two 2xx API leaks carry data WITHOUT a sensitive marker (so
// only the status rule can catch them), and the page and 403 leaks carry the
// marker behind a status the status rule accepts (so only the marker scan can).

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'auth-matrix.js');

// Canaries carry a quote, a backslash, a percent sign and enough length to be
// clipped by any truncating transform, so a leak through JSON escaping, URL
// encoding or a clipped preview is still findable.
const ADMIN_COOKIE = 'sess=ADMIN-CANARY-"q\\b%41-' + 'a'.repeat(160);
const MEMBER_COOKIE = 'sess=MEMBER-CANARY-"q\\b%42-' + 'm'.repeat(160);
const MARKER = 'SENSITIVE-ROW-7731';

let failures = 0;
let passes = 0;
function check(label, ok, detail) {
  if (ok) { passes++; console.log(`  ok   ${label}`); }
  else { failures++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
}

// ---- the app ---------------------------------------------------------------

function roleOf(req) {
  const c = req.headers.cookie || '';
  if (c === ADMIN_COOKIE) return 'admin';
  if (c === MEMBER_COOKIE) return 'member';
  return 'anon';
}

// defect: null (correct app) | 'api-anon' | 'page-marker' | 'api-member' | 'deny-body'
function makeApp(defect) {
  return (req, res) => {
    const role = roleOf(req);
    const url = new URL(req.url, 'http://x');
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/plain', ...headers });
      res.end(body);
    };
    if (url.pathname === '/login') return send(200, 'login form');
    if (url.pathname === '/admin') {
      if (role === 'admin') return send(200, `<html><table>${MARKER}</table></html>`);
      if (role === 'member') {
        // The UI is hidden client-side: the server returns the shell. The
        // defect is the shell shipping the rows anyway.
        if (defect === 'page-marker') return send(200, `<html><div hidden>${MARKER}</div></html>`);
        return send(200, '<html><div id="root"></div></html>');
      }
      return send(307, '', { location: '/login?next=%2Fadmin' });
    }
    if (url.pathname === '/api/admin/users') {
      if (role === 'admin') return send(200, JSON.stringify({ users: [{ id: 1, note: MARKER }] }));
      if (role === 'member') {
        if (defect === 'api-member') return send(200, JSON.stringify({ users: [{ id: 1 }] }));
        if (defect === 'deny-body') return send(403, `forbidden, but here it is: ${MARKER}`);
        return send(403, 'forbidden');
      }
      if (defect === 'api-anon') return send(200, JSON.stringify({ users: [{ id: 1 }] }));
      return send(401, 'unauthorized');
    }
    return send(404, 'not found');
  };
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    // unref: a case that throws must not leave the run hanging on a socket.
    server.listen(0, '127.0.0.1', () => { server.unref(); resolve(server); });
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// ---- the matrix ------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-matrix-test-'));

function writeMatrix(baseUrl, extra = {}) {
  const matrix = {
    baseUrl,
    roles: {
      anon: {},
      member: { cookieEnv: 'AM_TEST_MEMBER_COOKIE' },
      admin: { cookieEnv: 'AM_TEST_ADMIN_COOKIE' },
    },
    loginPattern: '^/login',
    sensitiveMarkers: [MARKER],
    targets: [
      { path: '/admin', method: 'GET', allowEmpty200: true,
        expect: { anon: 'deny', member: 'deny', admin: 'allow' } },
      { path: '/api/admin/users', method: 'GET',
        expect: { anon: 'deny', member: 'deny', admin: 'allow' } },
    ],
    ...extra,
  };
  const file = path.join(TMP, `matrix-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(matrix, null, 2));
  return file;
}

// ---- running the child -----------------------------------------------------

// A socket-using node child on Windows can die with 0xC0000409 (a native
// fast-fail, 3221226505) under load, with no output. Measured 2026-09-25 on
// Node 24.15: 6 of 100 concurrent suite runs, with fetch and with node:http
// alike, and 0 of 800 for a child with no sockets. That code is never a verdict
// (the script exits 0, 1 or 2), so the invocation is retried ONCE and the retry
// is printed. A crash that repeats still fails the assertion.
const NATIVE_CRASH = 3221226505;

async function run(...a) {
  let r = await runOnce(...a);
  if (r.code === NATIVE_CRASH) {
    console.log(`note: a child died with 0xC0000409 (native crash, no verdict); retrying it once: ${a[1].join(' ')}`);
    r = await runOnce(...a);
  }
  return r;
}

function runOnce(script, args, envOverrides) {
  return new Promise((resolve) => {
    const env = { ...process.env, AM_TEST_ADMIN_COOKIE: ADMIN_COOKIE, AM_TEST_MEMBER_COOKIE: MEMBER_COOKIE };
    for (const [k, v] of Object.entries(envOverrides || {})) {
      if (v === undefined) delete env[k]; else env[k] = v;
    }
    const child = spawn(process.execPath, [script, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 60000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const SECRET_FORMS = [];
for (const c of [ADMIN_COOKIE, MEMBER_COOKIE]) {
  SECRET_FORMS.push(c, JSON.stringify(c).slice(1, -1), encodeURIComponent(c));
  // The distinctive stem alone, so a clipped or partially transformed copy
  // still counts as a leak.
  SECRET_FORMS.push(c.slice(5, 22));
}

function assertNoSecrets(label, r) {
  const hit = SECRET_FORMS.find((s) => r.stdout.includes(s) || r.stderr.includes(s));
  check(`${label}: no cookie value in stdout or stderr`, !hit,
    hit ? `found a form of a cookie value (${hit.length} chars)` : '');
}

// Row lookup against the --json output, so assertions name the cell.
function rowOf(json, role, p) {
  return (json.rows || []).find((r) => r.role === role && r.path === p);
}

function parseJson(r) {
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// ---- mutants ---------------------------------------------------------------

// Each anchor must exist exactly once in the real script. The replacement
// disables one detector and nothing else.
const MUTANTS = {
  status: {
    anchor: "return { verdict: 'LEAK', why: 'a 2xx where a deny was expected' };",
    replace: "return { verdict: 'PASS', why: 'MUTANT: status detector disabled' };",
  },
  marker: {
    anchor: 'if (markerHits.length > 0) {',
    replace: 'if (false) {',
  },
  credential: {
    anchor: "if (!credential.present) return unverified(`${credential.env} is not set`);",
    // A silent skip scored as a pass: the defect this check exists for.
    replace: "if (!credential.present) { row.verdict = 'PASS'; row.why = 'skipped'; return; }",
  },
};

function makeMutant(name) {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const { anchor, replace } = MUTANTS[name];
  const count = src.split(anchor).length - 1;
  const file = path.join(TMP, `auth-matrix.mutant-${name}.js`);
  fs.writeFileSync(file, src.split(anchor).join(replace));
  return { file, count };
}

// ---- cases -----------------------------------------------------------------

async function main() {
  console.log('auth-matrix.js');

  // --help returns, and does no work.
  {
    const r = await run(SCRIPT, ['--help']);
    check('--help exits 0', r.code === 0, `exit ${r.code}`);
    check('--help prints usage', /usage/i.test(r.stdout), r.stdout.slice(0, 200));
  }

  // A bad matrix is indeterminate, not a pass.
  {
    const bad = path.join(TMP, 'bad.json');
    fs.writeFileSync(bad, '{"baseUrl": "http://127.0.0.1:1", "roles": {}, "targets": []}');
    const r = await run(SCRIPT, [bad]);
    check('invalid matrix exits 2', r.code === 2, `exit ${r.code}\n${r.stdout}${r.stderr}`);
  }

  // A correct app.
  const correct = await listen(makeApp(null));
  const correctUrl = `http://127.0.0.1:${correct.address().port}`;
  const correctMatrix = writeMatrix(correctUrl);
  {
    const r = await run(SCRIPT, [correctMatrix]);
    check('correct app exits 0', r.code === 0, `exit ${r.code}\n${r.stdout}${r.stderr}`);
    check('prints the role count', /roles:\s*3\b/.test(r.stdout), r.stdout.slice(0, 400));
    check('prints the target count', /targets:\s*2\b/.test(r.stdout), r.stdout.slice(0, 400));
    check('prints cells probed of expected', /probed 6 of 6/.test(r.stdout), r.stdout.slice(0, 400));
    check('names the credential variable and that it is set',
      /AM_TEST_ADMIN_COOKIE \(set\)/.test(r.stdout), r.stdout.slice(0, 600));
    check('anon redirect shows its Location', r.stdout.includes('/login?next=%2Fadmin'), r.stdout);
    assertNoSecrets('correct app', r);

    const j = await run(SCRIPT, [correctMatrix, '--json']);
    const json = parseJson(j);
    check('--json parses', json !== null, j.stdout.slice(0, 300));
    if (json) {
      check('--json exit 0 and 6 rows', j.code === 0 && json.rows.length === 6, `exit ${j.code}, ${json.rows.length} rows`);
      const anon = rowOf(json, 'anon', '/admin');
      check('anon /admin is a 307 deny that PASSES',
        anon && anon.status === 307 && anon.verdict === 'PASS', JSON.stringify(anon));
      const adminApi = rowOf(json, 'admin', '/api/admin/users');
      check('admin API allow PASSES and its body carried the marker (positive control)',
        adminApi && adminApi.verdict === 'PASS' && adminApi.markerHits.includes(MARKER), JSON.stringify(adminApi));
      check('--json population matches', json.population && json.population.probed === 6 && json.population.expected === 6,
        JSON.stringify(json.population));
    }
    assertNoSecrets('correct app --json', j);
  }

  // Planted leaks, one per app, each firing alone.
  const leaks = [
    { defect: 'api-anon', role: 'anon', path: '/api/admin/users', detector: 'status' },
    { defect: 'page-marker', role: 'member', path: '/admin', detector: 'marker' },
    { defect: 'api-member', role: 'member', path: '/api/admin/users', detector: 'status' },
    { defect: 'deny-body', role: 'member', path: '/api/admin/users', detector: 'marker' },
  ];
  const mutantResults = [];
  for (const leak of leaks) {
    const server = await listen(makeApp(leak.defect));
    const matrix = writeMatrix(`http://127.0.0.1:${server.address().port}`);
    const r = await run(SCRIPT, [matrix, '--json']);
    const json = parseJson(r);
    check(`${leak.defect}: exits 1`, r.code === 1, `exit ${r.code}\n${r.stdout.slice(0, 600)}${r.stderr}`);
    if (json) {
      const bad = json.rows.filter((x) => x.verdict !== 'PASS');
      check(`${leak.defect}: exactly one row is not PASS, and it is ${leak.role} ${leak.path} LEAK`,
        bad.length === 1 && bad[0].role === leak.role && bad[0].path === leak.path && bad[0].verdict === 'LEAK',
        JSON.stringify(bad));
    } else {
      check(`${leak.defect}: --json parses`, false, r.stdout.slice(0, 300));
    }
    const human = await run(SCRIPT, [matrix]);
    check(`${leak.defect}: the table says LEAK`, /\bLEAK\b/.test(human.stdout), human.stdout.slice(0, 600));
    assertNoSecrets(leak.defect, r);
    assertNoSecrets(`${leak.defect} (table)`, human);

    // The same leak against a copy with its detector disabled.
    const mutant = makeMutant(leak.detector);
    check(`${leak.defect}: mutant anchor '${leak.detector}' matched exactly once`, mutant.count === 1, `matched ${mutant.count}`);
    const m = await run(mutant.file, [matrix]);
    const mc = await run(mutant.file, [correctMatrix]);
    check(`${leak.defect}: with the ${leak.detector} detector disabled the leak goes undetected (exit 0)`,
      m.code === 0, `mutant exit ${m.code}\n${m.stdout.slice(0, 600)}`);
    check(`${leak.defect}: the ${leak.detector} mutant still exits 0 on the correct app`,
      mc.code === 0, `mutant exit ${mc.code}`);
    mutantResults.push({ defect: leak.defect, detector: leak.detector, real: r.code, mutant: m.code });
    server.close();
  }

  // A missing credential is UNVERIFIED, never a pass.
  {
    const r = await run(SCRIPT, [correctMatrix], { AM_TEST_ADMIN_COOKIE: undefined });
    check('admin credential unset: exits 2', r.code === 2, `exit ${r.code}\n${r.stdout}`);
    check('admin credential unset: the row says UNVERIFIED', /admin.*UNVERIFIED/.test(r.stdout), r.stdout);
    check('admin credential unset: names the variable as unset', /AM_TEST_ADMIN_COOKIE \(UNSET\)/.test(r.stdout), r.stdout);
    check('admin credential unset: probed 4 of 6', /probed 4 of 6/.test(r.stdout), r.stdout.slice(0, 400));
    assertNoSecrets('credential unset', r);

    const mutant = makeMutant('credential');
    check("credential mutant anchor matched exactly once", mutant.count === 1, `matched ${mutant.count}`);
    // The API target alone: on the page target the empty-200 control would
    // ALSO go UNVERIFIED once the admin row is skipped, and the mutant would
    // be caught by that rule rather than the one it disables.
    const apiOnly = writeMatrix(correctUrl, { targets: [
      { path: '/api/admin/users', method: 'GET', expect: { anon: 'deny', member: 'deny', admin: 'allow' } },
    ] });
    const real = await run(SCRIPT, [apiOnly], { AM_TEST_ADMIN_COOKIE: undefined });
    check('credential unset, API target only: real script exits 2', real.code === 2, `exit ${real.code}\n${real.stdout}`);
    const m = await run(mutant.file, [apiOnly], { AM_TEST_ADMIN_COOKIE: undefined });
    check('credential unset: with the credential check disabled it silently passes (exit 0)', m.code === 0,
      `mutant exit ${m.code}\n${m.stdout}`);
    mutantResults.push({ defect: 'credential-unset', detector: 'credential', real: real.code, mutant: m.code });
  }

  // A leak beats an unverified row.
  {
    const server = await listen(makeApp('api-anon'));
    const matrix = writeMatrix(`http://127.0.0.1:${server.address().port}`);
    const r = await run(SCRIPT, [matrix], { AM_TEST_ADMIN_COOKIE: undefined });
    check('leak plus unset credential: the leak wins with exit 1', r.code === 1, `exit ${r.code}`);
    server.close();
  }

  // An allowEmpty200 deny is only as good as the marker it scans for: with no
  // allowed response on that target ever showing the marker, an empty 200 is
  // unverified rather than a pass.
  {
    const matrix = writeMatrix(correctUrl, { sensitiveMarkers: ['NEVER-APPEARS-9912'] });
    const j = await run(SCRIPT, [matrix, '--json']);
    const json = parseJson(j);
    const member = json && rowOf(json, 'member', '/admin');
    check('a marker never seen in an allowed response makes the empty-200 deny UNVERIFIED',
      j.code === 2 && member && member.verdict === 'UNVERIFIED', `exit ${j.code} ${JSON.stringify(member)}`);
  }

  // An unreachable server.
  {
    const port = await freePort();
    const matrix = writeMatrix(`http://127.0.0.1:${port}`);
    const r = await run(SCRIPT, [matrix]);
    check('server unreachable: exits 2', r.code === 2, `exit ${r.code}\n${r.stdout}${r.stderr}`);
    check('server unreachable: rows say UNVERIFIED', /UNVERIFIED/.test(r.stdout), r.stdout);
    assertNoSecrets('server unreachable', r);
  }

  correct.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log('\n  detector mutants (real exit vs mutant exit on the planted defect):');
  for (const m of mutantResults) console.log(`    ${m.defect.padEnd(18)} ${m.detector.padEnd(11)} real=${m.real} mutant=${m.mutant}`);
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
