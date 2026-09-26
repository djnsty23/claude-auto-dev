#!/usr/bin/env node
'use strict';
// Suite for security-gate.js and security-checks.js.
//
// Every verdict is asserted through the real CLI, as a subprocess, on a real
// git repo written to tmpdir: the gate decides what "would be committed" by
// asking git, so a suite that fed it an in-memory map would skip the part most
// likely to be wrong. The live half runs against a local HTTP server started
// here, one route per header defect.
//
// Secret-shaped strings are assembled from parts at runtime. A literal fake key
// in a committed file is exactly what the gate, and a push-protection scanner,
// exist to refuse.
//
// Run: node tooling/test-security-gate.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'security-gate.js');
const C = require(path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'security-checks.js'));
const G = require(GATE);

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failures.push(name + (detail !== undefined ? `\n      -> ${JSON.stringify(detail).slice(0, 600)}` : ''));
}

// Async, so the in-process HTTP server can answer while the gate runs.
function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATE, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 60000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'security-gate-'));
let repos = 0;
function repo(name, files) {
  repos++;
  const dir = path.join(tmp, name);
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), text);
  }
  const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  return dir;
}
const rules = (r) => new Set(JSON.parse(r.stdout).findings.map((f) => f.rule));

const STRIPE = ['sk', 'live', 'Q7'.repeat(14)].join('_');
const SERVICE_JWT = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url'), 'k'.repeat(30)].join('.');
const ANON_JWT = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url'), 'k'.repeat(30)].join('.');

const CLEAN_APP = {
  '.gitignore': '.env*\n!.env.example\nnode_modules/\n',
  '.env.example': 'NEXT_PUBLIC_SUPABASE_URL=\nNEXT_PUBLIC_SUPABASE_ANON_KEY=\n',
  'package.json': JSON.stringify({ dependencies: { next: '16.0.0' } }),
  'src/proxy.ts': "export function proxy() { res.headers.set('Content-Security-Policy', policy); }\n",
  'src/lib/public.ts': `export const anon = '${ANON_JWT}';\n`,
  'src/app/api/notes/route.ts': 'export async function GET() { const { data } = await supabase.auth.getUser(); return Response.json(data); }\n',
  'supabase/migrations/0001_init.sql': [
    'create table public.notes (id bigint primary key, user_id uuid, body text);',
    'grant select, insert on public.notes to authenticated;',
    "create function public.peek() returns int language sql security definer as $$ select 1 $$;",
  ].join('\n'),
  // History, not a snapshot: RLS and the search_path arrive in a later file.
  'supabase/migrations/0002_harden.sql': [
    'alter table public.notes enable row level security;',
    "alter function public.peek() set search_path = '';",
    'create table public.scratch (id int);',
    'drop table public.scratch;',
  ].join('\n'),
};

async function main() {
  // ---------------------------------------------------------- entry points
  {
    const r = await run(['--help']);
    check('--help exits 0 and names the exit codes', r.status === 0 && /Exit: 0 clean, 1 findings, 2 indeterminate/.test(r.stdout), r);
    const s = await run(['--selftest']);
    check('--selftest: every rule fires on the planted sample, none on the clean one', s.status === 0 && /control: (\d+) of \1 rules fire.*; 0 findings/.test(s.stdout), s.stdout);
    const l = await run(['--rules']);
    check('--rules lists every rule', l.status === 0 && Object.keys(C.RULES).every((id) => l.stdout.includes(id)), l.stdout);
  }

  // ------------------------------------------------------------- clean app
  const clean = repo('clean', CLEAN_APP);
  {
    const r = await run(['--root', clean]);
    check('a clean app is GREEN with exit 0', r.status === 0 && /verdict: GREEN/.test(r.stdout), r.stdout);
    check('the report prints its population', /population: \d+ code files, 1 route handlers, 2 Supabase migrations \(1 public tables/.test(r.stdout), r.stdout);
    check('the report prints the control on every run', /control: (\d+) of \1 rules fire/.test(r.stdout), r.stdout);
    check('a green run says it is not a claim of security', /not that the app is secure/.test(r.stdout), r.stdout);
    check('an anon JWT is public and not reported', !/service-role-jwt|secret-in-source/.test(r.stdout), r.stdout);
  }

  // ------------------------------------------------------------ defect app
  const defect = repo('defect', {
    'package.json': JSON.stringify({ dependencies: { next: '16.0.0' } }),
    '.env.local': `STRIPE_SECRET_KEY=${STRIPE}\n`,
    'src/keys.ts': `export const admin = '${SERVICE_JWT}';\n`,
    'src/client.tsx': `'use client';\nconst k = process.env.${['NEXT', 'PUBLIC', 'SERVICE', 'ROLE', 'KEY'].join('_')};\n`,
    'src/app/api/all/route.ts': 'export async function GET() { return Response.json(await db.all()); }\n',
    'supabase/migrations/0001.sql': [
      'create table public.open_notes (id int);',
      "create function public.leak() returns int language sql security definer as $$ select 1 $$;",
    ].join('\n'),
    'ext/manifest.json': JSON.stringify({ manifest_version: 3, background: { service_worker: 'bg.js' }, externally_connectable: { ids: ['*'] } }),
    'ext/bg.js': 'chrome.runtime.onMessage.addListener((m, s, reply) => reply(tokens[m.k]));\n',
  });
  {
    const r = await run(['--root', defect, '--json']);
    const got = rules(r);
    const want = ['env-file', 'secret-in-source', 'service-role-jwt', 'public-secret-env', 'client-privileged-key', 'csp-missing', 'sql-rls-missing', 'sql-definer-search-path', 'ext-external', 'ext-sender-unchecked', 'route-no-auth', 'sql-grant-missing'];
    check('the defect app exits 1', r.status === 1, r.status);
    check('every planted defect is reported', want.every((w) => got.has(w)), { missing: want.filter((w) => !got.has(w)) });
    const human = await run(['--root', defect]);
    check('no secret value reaches the output, human or JSON', ![STRIPE, SERVICE_JWT].some((s) => human.stdout.includes(s) || r.stdout.includes(s) || human.stderr.includes(s)));
    check('the human report ends RED', /verdict: RED/.test(human.stdout), human.stdout.slice(-300));
  }

  // --------------------------------------------- ignored vs committed .env
  {
    const dir = repo('envfile', { ...CLEAN_APP, '.gitignore': 'node_modules/\n', '.env.production': 'X=1\n' });
    const r = await run(['--root', dir, '--json']);
    check('an untracked .env that is not ignored counts as committed', r.status === 1 && rules(r).has('env-file'), r.stdout);
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env*\n!.env.example\n');
    const r2 = await run(['--root', dir, '--json']);
    check('the same .env once ignored is not reported', r2.status === 0 && !rules(r2).has('env-file'), r2.stdout);
  }

  // ------------------------------------------------------------- waivers
  {
    const sink = 'export const H = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;\n';
    const dir = repo('waiver', {
      ...CLEAN_APP,
      'src/a.tsx': `// security-ok: html comes from our own sanitised markdown build\n${sink}`,
      'src/b.tsx': `// security-ok:\n${sink}`,
    });
    const r = JSON.parse((await run(['--root', dir, '--json'])).stdout);
    check('an inline waiver with a reason is honoured and printed with it', r.waived.some((w) => w.path === 'src/a.tsx' && /sanitised markdown/.test(w.reason)), r.waived);
    check('an inline waiver without a reason is ignored', r.findings.some((f) => f.path === 'src/b.tsx' && f.rule === 'html-sink'), r.findings);
    const strict = await run(['--root', dir, '--strict']);
    check('a warning fails only under --strict', strict.status === 1, strict.status);
    const loose = await run(['--root', dir]);
    check('the same warning passes without --strict', loose.status === 0, loose.stdout);

    fs.writeFileSync(path.join(dir, '.security-gate.json'), JSON.stringify({ allow: [{ rule: 'html-sink', path: 'src/b.tsx' }] }));
    const noReason = await run(['--root', dir, '--json']);
    const j = JSON.parse(noReason.stdout);
    check('a config waiver without a reason is refused, reported, and makes the run indeterminate', noReason.status === 2 && j.problems.some((p) => /without a known rule, a path and a reason/.test(p)) && j.findings.some((f) => f.path === 'src/b.tsx'), j);
    fs.writeFileSync(path.join(dir, '.security-gate.json'), JSON.stringify({ allow: [{ rule: 'html-sink', path: 'src/**', reason: 'rendered from trusted build output' }] }));
    const withReason = JSON.parse((await run(['--root', dir, '--json'])).stdout);
    check('a config waiver with a reason and a glob covers the path', withReason.findings.length === 0 && withReason.waived.length === 2, withReason);
  }

  // ------------------------------------------------ dynamic RLS in DO blocks
  {
    const dir = repo('dynamic-rls', {
      ...CLEAN_APP,
      'supabase/migrations/0003_loop.sql': [
        'create table public.a (id int);',
        'create table public.b (id int);',
        "do $$ declare t text; begin foreach t in array array['a','b'] loop",
        "  execute format('alter table public.%I enable row level security', t);",
        "  execute format('grant select on public.%I to authenticated', t);",
        'end loop; end $$;',
        'create table public.c (id int);',
      ].join('\n'),
    });
    const r = JSON.parse((await run(['--root', dir, '--json'])).stdout);
    const rls = r.findings.filter((f) => f.rule === 'sql-rls-missing').map((f) => f.message);
    check('RLS enabled through format(%I) over an array covers exactly those tables', rls.length === 1 && /public\.c /.test(rls[0]), rls);
  }

  // ----------------------------------------------- linear time on minified
  {
    // The shape that hung the first draft for minutes: leading comments that
    // hold each other's delimiters, then half a megabyte of minified code.
    const nasty = `${'/* a */ // b */ /* // c */ '.repeat(2000)}\n${'var a=1;//x*/'.repeat(38000)}`;
    const dir = repo('minified', { ...CLEAN_APP, 'public/vendor.js': nasty });
    const t = Date.now();
    const r = await run(['--root', dir]);
    const ms = Date.now() - t;
    check('a 500 KB minified file with nested comment delimiters scans in under 10 s', r.status === 0 && ms < 10000, { ms, status: r.status });
  }

  // -------------------------------------------------------- live headers
  const good = {
    'content-type': 'text/html',
    'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-r4nd0m' 'strict-dynamic'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  };
  const routes = {
    '/good': [200, good],
    '/report-only': [200, { 'content-type': 'text/html', 'content-security-policy-report-only': good['content-security-policy'], 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' }],
    '/inline': [200, { ...good, 'content-security-policy': "script-src 'self' 'unsafe-inline'; frame-ancestors 'none'", 'x-powered-by': 'Next.js' }],
    '/api/private': [401, { 'content-type': 'application/json' }],
    '/api/open': [200, { 'content-type': 'application/json' }],
  };
  const server = http.createServer((req, res) => {
    const [status, headers] = routes[req.url] || [404, {}];
    res.writeHead(status, headers);
    res.end(status === 200 ? '<html></html>' : '{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await run(['--root', clean, '--url', `${base}/good`, '--api', '/api/private']);
    check('a well-configured page and a refusing API are GREEN', r.status === 0, r.stdout);
    check('live requests are part of the population', /2 live requests/.test(r.stdout) && /\/api\/private \(no credentials\) -> 401/.test(r.stdout), r.stdout);

    const ro = await run(['--root', clean, '--url', `${base}/report-only`, '--json']);
    check('a Report-Only policy counts as no policy', ro.status === 1 && rules(ro).has('live-csp-missing'), ro.stdout);

    const inl = rules(await run(['--root', clean, '--url', `${base}/inline`, '--json']));
    check("script-src 'unsafe-inline' with no nonce is an error, and X-Powered-By a warning", inl.has('live-csp-script') && inl.has('live-powered-by'), [...inl]);

    const open = await run(['--root', clean, '--url', `${base}/good`, '--api', '/api/open', '--json']);
    check('a protected path answering 200 anonymously is an error', open.status === 1 && rules(open).has('live-api-open'), open.stdout);

    const bare = await run(['--root', clean, '--url', `${base}/good`, '--api', 'api/open', '--json']);
    check('an --api path without its leading slash resolves from the host root', rules(bare).has('live-api-open'), bare.stdout);
    const mangled = await run(['--root', clean, '--url', `${base}/good`, '--api', 'C:/Program Files/Git/api/open']);
    check('a Git Bash rewritten --api path is INDETERMINATE, never fetched as a URL', mangled.status === 2 && /rewritten by Git Bash/.test(mangled.stdout), mangled.stdout);

    const down = await run(['--root', clean, '--url', 'http://127.0.0.1:9/nothing']);
    check('an unreachable URL is INDETERMINATE (exit 2), never GREEN', down.status === 2 && /INDETERMINATE .*could not be fetched/.test(down.stdout), down.stdout);

    const env = { SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_URL: '', SUPABASE_ANON_KEY: '', NEXT_PUBLIC_SUPABASE_ANON_KEY: '', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '' };
    const inv = await run(['--root', clean, '--invite-only'], env);
    check('--invite-only without Supabase env is INDETERMINATE', inv.status === 2 && /needs SUPABASE_URL/.test(inv.stdout), inv.stdout);
  } finally {
    server.close();
  }

  // -------------------------------------------------- pure header grading
  {
    const hsts = C.checkLiveHeaders('https://x.example', { ...good });
    check('HTTPS without HSTS is an error', hsts.some((f) => f.rule === 'live-hsts'), hsts);
    const ok = C.checkLiveHeaders('https://x.example', { ...good, 'strict-transport-security': 'max-age=63072000' });
    check('the good header set is silent over HTTPS', ok.length === 0, ok);
    const weak = C.checkLiveHeaders('https://x.example', { ...good, 'strict-transport-security': 'max-age=300' });
    check('a five-minute HSTS max-age does not count', weak.some((f) => f.rule === 'live-hsts'), weak);
    const hostWild = C.checkLiveHeaders('http://x.example', { ...good, 'content-security-policy': "script-src https:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'" });
    check('script-src https: without strict-dynamic allows any host', hostWild.some((f) => f.rule === 'live-csp-script'), hostWild);
    check('checkLiveSignup is silent only on disable_signup true', C.checkLiveSignup('u', { disable_signup: true }).length === 0 && C.checkLiveSignup('u', {}).length === 1);
    check('jwtRole reads the role and survives garbage', C.jwtRole(SERVICE_JWT) === 'service_role' && C.jwtRole('not.a.jwt') === null);
    check('globRe: ** crosses directories and * does not', G.globRe('src/**').test('src/a/b.tsx') && !G.globRe('src/*').test('src/a/b.tsx'));
  }
}

main()
  .catch((e) => failures.push(`suite crashed: ${e.stack}`))
  .finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (failures.length) {
      console.error(`\nFAIL  ${failures.length} of ${passed + failures.length}`);
      for (const f of failures) console.error(`    - ${f}`);
      process.exitCode = 1;
      return;
    }
    console.log(`PASS  ${passed} assertions: the gate as a subprocess over ${repos} temp git repos and a local HTTP server.`);
  });
