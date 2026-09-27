#!/usr/bin/env node
'use strict';
/**
 * security-gate.js - the security properties of a web app that a machine can
 * decide, checked before it ships.
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT. A green run means every rule listed by
 * `--rules` found nothing in the files that would be committed, and, with
 * `--url`, in the live response. It does not mean the app is secure: it cannot
 * see a missing ownership check inside a query, a business rule that lets a
 * user act on another user's row, or a secret already pushed and since deleted.
 * Those still need the `security` skill's review. The gate makes the review
 * start from the properties a reviewer should never have to re-check by hand.
 *
 * TWO HALVES.
 *   static   every file `git ls-files -co --exclude-standard` lists, so an
 *            untracked file that is not ignored counts as committed
 *   live     `--url` fetches the page and grades its headers; `--api <path>`
 *            asserts a protected path refuses an anonymous caller;
 *            `--invite-only` asserts Supabase sign-up is closed
 *
 * EXIT. 0 clean, 1 findings at error level (or any finding under --strict),
 * 2 indeterminate: the control failed, a URL could not be fetched, or a check
 * asked for could not run. Findings win over indeterminate, because a known
 * defect is actionable whatever else went wrong.
 *
 * WAIVERS need a reason, or they do not count. Inline: `security-ok: <why>` on
 * the line or the line above. File: `.security-gate.json` at the root,
 * `{ "allow": [{ "rule": "...", "path": "glob", "reason": "..." }] }`. Every
 * waiver used is printed with its reason, so a waiver is reviewable in the log.
 *
 * THE CONTROL runs on every invocation, before the verdict: a planted sample
 * with one defect per static rule, and a clean sample that must stay silent.
 * If either fails the run is indeterminate, because a gate that cannot see a
 * planted defect has not looked at your code either.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const C = require(path.join(__dirname, 'security-checks.js'));

const HELP = `security-gate.js - decidable security properties of a web app, before it ships

Usage:
  node security-gate.js [--root <dir>] [--url <https://...>]... [--api <path>]...
                        [--invite-only] [--strict] [--json]
  node security-gate.js --rules      list every rule with its severity
  node security-gate.js --selftest   run only the planted control

Options:
  --root <dir>     project root (default: cwd). Files come from git when it is a repo.
  --url <url>      also grade the live response headers of this page (repeatable, or a comma list)
  --api <path>     a protected path, fetched with no credentials against the first --url;
                   a 2xx is a finding (repeatable, or a comma list)
  --invite-only    assert Supabase sign-up is disabled; reads SUPABASE_URL (or
                   NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_ANON_KEY (or the NEXT_PUBLIC_ one)
  --strict         warnings fail too
  --json           machine-readable report on stdout

Config: .security-gate.json at the root may hold { "allow": [...], "url": [...], "api": [...],
"inviteOnly": true }. Command-line values are added to the file's.

Exit: 0 clean, 1 findings, 2 indeterminate (control failed, fetch failed, check could not run).
A green run proves only the listed rules. It is not a claim that the app is secure.`;

// ------------------------------------------------------------------ scan

const WEB_FRAMEWORKS = ['next', 'vite', 'astro', '@remix-run/react', 'nuxt', '@sveltejs/kit', 'react-scripts', 'gatsby'];
const TEXT = /\.(?:[cm]?[jt]sx?|json|sql|html?|toml|ya?ml|env(?:\..*)?|md|txt|conf|ini|properties|pem|key|sh|ps1|py)$|(^|\/)\.env[^/]*$|(^|\/)_headers$/i;
const MAX_BYTES = 1024 * 1024;

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const under = (dir, p) => dir === '' || p === dir || p.startsWith(`${dir}/`);

function readJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * files: Map of repo-relative path (forward slashes) to text, or null for a
 * file present but not read (binary or too large). Returns every raw finding
 * and the population it examined.
 */
function scanFiles(files) {
  const all = [...files.keys()].sort();
  const read = all.filter((p) => files.get(p) !== null);
  const findings = [];
  const add = (list) => findings.push(...list);

  add(C.checkEnvFiles(all));

  const migrations = read.filter((p) => /(^|\/)supabase\/migrations\/.+\.sql$/i.test(p));
  const code = read.filter((p) => C.isCode(p));
  const routes = code.filter((p) => C.isRoute(p) && !C.isTestPath(p));

  for (const p of read) {
    const text = files.get(p);
    add(C.checkSecrets(p, text));
    // Names only, so a test naming a variable is not a leak. A real key in a test still is, above.
    if ((C.isCode(p) && !C.isTestPath(p)) || /(^|\/)\.env/.test(p)) add(C.checkClientEnv(p, text));
  }
  for (const p of code) {
    if (C.isTestPath(p)) continue;
    add(C.checkSinks(p, files.get(p)));
  }

  // Extensions: a manifest.json declaring manifest_version.
  const manifests = [];
  const extensionFiles = new Set();
  for (const p of read.filter((x) => /(^|\/)manifest\.json$/.test(x))) {
    const json = readJson(files.get(p));
    if (!json || !json.manifest_version) continue;
    manifests.push(p);
    const base = dirOf(p);
    const rel = (f) => (base ? `${base}/${f}` : f).replace(/\/\.\//g, '/');
    add(C.checkManifest(p, json));
    const bg = [json.background?.service_worker, ...(json.background?.scripts || [])].filter(Boolean).map(rel);
    for (const b of bg) {
      extensionFiles.add(b);
      if (files.get(b)) add(C.checkBackground(b, files.get(b)));
    }
    for (const cs of json.content_scripts || []) {
      for (const f of (cs.js || []).map(rel)) {
        extensionFiles.add(f);
        if (files.get(f)) add(C.checkMessageListeners(f, files.get(f), true));
      }
    }
  }
  for (const p of code) {
    if (C.isTestPath(p) || extensionFiles.has(p)) continue;
    add(C.checkMessageListeners(p, files.get(p), false));
  }

  for (const p of routes) add(C.checkRoute(p, files.get(p)));

  const sqlFiles = migrations.map((p) => ({ path: p, text: files.get(p) }));
  add(C.checkMigrations(sqlFiles));

  // Web apps: a package.json depending on a web framework needs a CSP somewhere at or under it.
  const apps = [];
  for (const p of read.filter((x) => /(^|\/)package\.json$/.test(x) && !/node_modules\//.test(x))) {
    const json = readJson(files.get(p));
    if (!json) continue;
    const deps = { ...json.dependencies, ...json.devDependencies };
    const fw = WEB_FRAMEWORKS.find((f) => f in deps);
    if (!fw) continue;
    const dir = dirOf(p);
    apps.push({ dir: dir || '.', framework: fw });
    const hasCsp = read.some((f) => (under(dir, f) || /(^|\/)(vercel|netlify)\.(json|toml)$/.test(f) || /(^|\/)_headers$/.test(f))
      && !C.isTestPath(f) && (/content-security-policy|contentSecurityPolicy/i.test(files.get(f)) || (/(^|\/)astro\.config\.[cm]?[jt]s$/.test(f) && /\bcsp\s*:/.test(files.get(f)))));
    if (!hasCsp) findings.push({ rule: 'csp-missing', severity: C.RULES['csp-missing'].severity, path: p, line: 1, message: `The ${fw} app at ${dir || '.'} sets no Content-Security-Policy in any file.`, fix: 'Set a nonce-based policy in middleware or the server, and prove it live with --url.' });
  }

  const tables = new Set();
  let definers = 0;
  for (const { text } of sqlFiles) {
    for (const m of text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?(\w+)"?\s*\(/gi)) tables.add(m[1].toLowerCase());
    for (const m of text.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:"?public"?\.)?"?(\w+)"?/gi)) tables.delete(m[1].toLowerCase());
    definers += (text.match(/security\s+definer/gi) || []).length;
  }

  return {
    findings,
    population: {
      files: all.length,
      read: read.length,
      code: code.length,
      migrations: migrations.length,
      tables: tables.size,
      definerMentions: definers,
      webApps: apps,
      manifests: manifests.length,
      routes: routes.length,
    },
  };
}

// --------------------------------------------------------------- control

// Planted samples, assembled at runtime so no literal in this file matches a
// secret format: the gate scans its own repo, and a push-protection scanner
// would refuse a literal key even when it is fake.
function plantedSample() {
  const jwt = (role) => ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ role, iss: 'supabase' })).toString('base64url'), 'x'.repeat(24)].join('.');
  const files = new Map();
  files.set('.env.local', ['DB', '=', 'x'].join(''));
  files.set('src/keys.ts', `export const k = '${['sk', 'live', 'Z'.repeat(24)].join('_')}';\nexport const s = '${jwt('service_role')}';`);
  files.set('src/client.tsx', `'use client';\nconst k = process.env.${['NEXT', 'PUBLIC', 'SUPABASE', 'SERVICE', 'ROLE', 'KEY'].join('_')};\nexport const H = () => <div dangerouslySetInnerHTML={{ __html: k }} />;`);
  files.set('src/listen.ts', "window.addEventListener('message', (e) => run(e.data));");
  files.set('app/api/open/route.ts', 'export async function GET() { return Response.json(await db.all()); }');
  files.set('package.json', JSON.stringify({ dependencies: { next: '16.0.0' } }));
  files.set('supabase/migrations/0001_init.sql', [
    'create table public.notes (id bigint primary key, body text);',
    "create function public.peek() returns int language sql security definer as $$ select 1 $$;",
    'create policy anyone on public.notes for all to anon using (true);',
    'create view public.all_notes as select * from public.notes;',
  ].join('\n'));
  files.set('ext/manifest.json', JSON.stringify({
    manifest_version: 3,
    background: { service_worker: 'bg.js' },
    content_scripts: [{ matches: ['<all_urls>'], js: ['cs.js'] }],
    externally_connectable: { matches: ['*://*/*'] },
    content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'" },
  }));
  files.set('ext/bg.js', 'chrome.runtime.onMessage.addListener((m, s, r) => { r(store[m.key]); });');
  files.set('ext/cs.js', "window.addEventListener('message', (e) => chrome.runtime.sendMessage(e.data));");
  return files;
}

function cleanSample() {
  const files = new Map();
  files.set('.env.example', 'SUPABASE_URL=\nSUPABASE_ANON_KEY=');
  files.set('src/client.tsx', "'use client';\nexport const H = ({ t }: { t: string }) => <p>{t}</p>;");
  files.set('src/listen.ts', "window.addEventListener('message', (e) => { if (e.origin !== location.origin) return; run(e.data); });");
  files.set('app/api/mine/route.ts', 'export async function GET() { const { data } = await supabase.auth.getUser(); return Response.json(data); }');
  files.set('package.json', JSON.stringify({ dependencies: { next: '16.0.0' } }));
  files.set('src/proxy.ts', "headers.set('Content-Security-Policy', policy);");
  files.set('supabase/migrations/0001_init.sql', [
    'create table public.notes (id bigint primary key, user_id uuid, body text);',
    'alter table public.notes enable row level security;',
    'grant select, insert on public.notes to authenticated;',
    'create policy own on public.notes for all to authenticated using (auth.uid() = user_id);',
    "create function public.peek() returns int language sql security definer set search_path = '' as $$ select 1 $$;",
    'create view public.my_notes with (security_invoker = true) as select * from public.notes;',
  ].join('\n'));
  files.set('ext/manifest.json', JSON.stringify({
    manifest_version: 3,
    background: { service_worker: 'bg.js' },
    content_scripts: [{ matches: ['https://shop.example.com/*'], js: ['cs.js'] }],
  }));
  files.set('ext/bg.js', 'chrome.runtime.onMessage.addListener((m, sender, r) => { if (sender.id !== chrome.runtime.id) return; r({}); });');
  files.set('ext/cs.js', 'chrome.runtime.sendMessage({ type: "ingest" });');
  // Placeholders measured in real repos, which must stay silent.
  files.set('docs/setup.md', [
    `KEY="${['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')}\\n...\\n-----END PRIVATE KEY-----"`,
    `aws_access_key_id = ${['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('')}`,
    `OPENAI_API_KEY=${['sk', 'proj', 'a'.repeat(30)].join('-')}`,
  ].join('\n'));
  files.set('supabase/migrations/0002_more.sql', [
    'create table public.a (id int);',
    'create table public.b (id int);',
    "do $$ declare t text; begin foreach t in array array['a','b'] loop",
    "  execute format('alter table public.%I enable row level security', t);",
    "  execute format('grant select on public.%I to authenticated', t);",
    'end loop; end $$;',
  ].join('\n'));
  return files;
}

const STATIC_RULES = Object.keys(C.RULES).filter((r) => !r.startsWith('live-'));

function runControl() {
  const planted = new Set(scanFiles(plantedSample()).findings.map((f) => f.rule));
  const missed = STATIC_RULES.filter((r) => !planted.has(r));
  const noise = scanFiles(cleanSample()).findings;
  // The live rules have their own planted responses.
  const liveBad = C.checkLiveHeaders('https://planted.example', { 'x-powered-by': 'Next.js', 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' });
  const liveCsp = C.checkLiveHeaders('https://planted.example', { 'content-security-policy': "script-src 'self' 'unsafe-inline' 'unsafe-eval'" });
  const liveRules = new Set([...liveBad, ...liveCsp, ...C.checkLiveApi('https://planted.example/api', 200), ...C.checkLiveSignup('https://planted.example', { disable_signup: false })].map((f) => f.rule));
  const liveMissed = Object.keys(C.RULES).filter((r) => r.startsWith('live-') && !liveRules.has(r));
  const liveClean = C.checkLiveHeaders('https://clean.example', {
    'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    'strict-transport-security': 'max-age=63072000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  });
  const total = STATIC_RULES.length + Object.keys(C.RULES).length - STATIC_RULES.length;
  return {
    ok: missed.length === 0 && liveMissed.length === 0 && noise.length === 0 && liveClean.length === 0,
    fired: total - missed.length - liveMissed.length,
    total,
    missed: [...missed, ...liveMissed],
    noise: [...noise, ...liveClean].map((f) => `${f.rule} ${f.path}`),
  };
}

// ----------------------------------------------------------------- disk

const SKIP_DIRS = /(^|\/)(node_modules|\.git|\.next|dist|build|out|coverage|\.vercel|\.turbo|\.claude)\//;

function listFiles(root) {
  const git = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (git.status === 0) return { source: 'git (tracked, plus untracked and not ignored)', paths: git.stdout.split('\0').filter(Boolean) };
  const paths = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.test(`${rel}/`)) walk(rel);
      } else if (e.isFile()) paths.push(rel);
    }
  };
  walk('');
  return { source: 'directory walk (not a git repo; ignore rules not applied)', paths };
}

function readFiles(root, paths) {
  const files = new Map();
  for (const p of paths) {
    if (SKIP_DIRS.test(p)) continue;
    let text = null;
    if (TEXT.test(p)) {
      try {
        const st = fs.statSync(path.join(root, p));
        if (st.size <= MAX_BYTES) text = fs.readFileSync(path.join(root, p), 'utf8');
      } catch {
        text = null;
      }
    }
    files.set(p, text);
  }
  return files;
}

// --------------------------------------------------------------- waivers

const globRe = (g) => new RegExp(`^${g.split('**').map((s) => s.split('*').map((t) => t.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`);

function applyWaivers(findings, files, allow) {
  const kept = [];
  const waived = [];
  for (const f of findings) {
    const entry = allow.find((a) => a.rule === f.rule && globRe(a.path).test(f.path));
    const text = files.get(f.path);
    if (entry) waived.push({ ...f, reason: entry.reason });
    else if (text && C.waivedInline(text, f.line)) waived.push({ ...f, reason: (/security-ok:\s*(.+)/.exec(text.split('\n').slice(Math.max(0, f.line - 2), f.line).join('\n')) || [])[1]?.trim() });
    else kept.push(f);
  }
  return { kept, waived };
}

function loadConfig(root) {
  const p = path.join(root, '.security-gate.json');
  if (!fs.existsSync(p)) return { config: {}, problems: [] };
  const json = readJson(fs.readFileSync(p, 'utf8'));
  if (!json) return { config: {}, problems: ['.security-gate.json is not valid JSON'] };
  const problems = [];
  const allow = [];
  for (const a of json.allow || []) {
    if (!a || !C.RULES[a.rule] || typeof a.path !== 'string' || typeof a.reason !== 'string' || a.reason.trim().length < 3) {
      problems.push(`ignored allow entry without a known rule, a path and a reason: ${JSON.stringify(a).slice(0, 120)}`);
    } else allow.push(a);
  }
  return { config: { ...json, allow }, problems };
}

// ------------------------------------------------------------------ live

async function fetchHeaders(url, init = {}) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000), ...init });
  const headers = {};
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return { status: res.status, headers, finalUrl: res.url || url, res };
}

async function liveChecks({ urls, apis, inviteOnly }) {
  const findings = [];
  const problems = [];
  const lines = [];
  for (const url of urls) {
    try {
      const r = await fetchHeaders(url);
      lines.push(`${url} -> ${r.status}${r.finalUrl !== url ? ` at ${r.finalUrl}` : ''}`);
      if (!/text\/html/i.test(r.headers['content-type'] || '')) problems.push(`${url} did not answer HTML (${r.headers['content-type'] || 'no content-type'}); its headers were graded anyway`);
      findings.push(...C.checkLiveHeaders(r.finalUrl, r.headers));
    } catch (e) {
      problems.push(`${url} could not be fetched: ${e.message}`);
    }
  }
  if (apis.length && !urls.length) problems.push('--api needs a --url to resolve against');
  for (const api of apis) {
    if (!urls.length) break;
    // Git Bash rewrites an argument like /api/x into C:/Program Files/Git/api/x.
    // Fetching that would test nothing, so it is reported rather than guessed back.
    if (/^[A-Za-z]:[\\/]/.test(api)) {
      problems.push(`--api ${api} is a local path, likely rewritten by Git Bash: pass it without the leading slash (api/x) or set MSYS_NO_PATHCONV=1`);
      continue;
    }
    const target = new URL(api.startsWith('/') ? api : `/${api}`, urls[0]).toString();
    try {
      const r = await fetchHeaders(target, { redirect: 'manual' });
      lines.push(`${target} (no credentials) -> ${r.status}`);
      findings.push(...C.checkLiveApi(target, r.status));
    } catch (e) {
      problems.push(`${target} could not be fetched: ${e.message}`);
    }
  }
  if (inviteOnly) {
    const base = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!base || !key) problems.push('--invite-only needs SUPABASE_URL and SUPABASE_ANON_KEY in the environment');
    else {
      try {
        const r = await fetchHeaders(`${base.replace(/\/$/, '')}/auth/v1/settings`, { headers: { apikey: key } });
        const settings = await r.res.json().catch(() => null);
        if (!r.res.ok || !settings) problems.push(`auth settings answered ${r.status}`);
        else {
          lines.push(`auth settings -> disable_signup ${settings.disable_signup === true}`);
          findings.push(...C.checkLiveSignup(`${new URL(base).host}/auth/v1/settings`, settings));
        }
      } catch (e) {
        problems.push(`auth settings could not be fetched: ${e.message}`);
      }
    }
  }
  return { findings, problems, lines };
}

// ------------------------------------------------------------------ main

async function main(argv) {
  const has = (f) => argv.includes(f);
  const all = (f) => argv.flatMap((a, i) => (a === f && argv[i + 1] ? [argv[i + 1]] : []));
  // --url and --api take a comma list too: joined, the list would be fetched as one path and pass.
  const list = (f) => all(f).flatMap((v) => v.split(',').map((x) => x.trim()).filter(Boolean));
  if (has('--help') || has('-h')) {
    console.log(HELP);
    return 0;
  }
  if (has('--rules')) {
    for (const [id, r] of Object.entries(C.RULES)) console.log(`${r.severity.padEnd(5)} ${id.padEnd(24)} ${r.what}`);
    return 0;
  }
  const control = runControl();
  const controlLine = `control: ${control.fired} of ${control.total} rules fire on the planted sample; ${control.noise.length} findings on the clean sample`;
  if (has('--selftest')) {
    console.log(controlLine);
    if (!control.ok) console.log(`  missed: ${control.missed.join(', ') || 'none'}\n  noise: ${control.noise.join(', ') || 'none'}`);
    return control.ok ? 0 : 2;
  }

  const root = path.resolve(all('--root')[0] || process.cwd());
  if (!fs.existsSync(root)) {
    console.error(`security-gate: no such directory ${root}`);
    return 2;
  }
  const { config, problems } = loadConfig(root);
  const { source, paths } = listFiles(root);
  const files = readFiles(root, paths);
  const scan = scanFiles(files);
  const live = await liveChecks({
    urls: [...(config.url || []), ...list('--url')],
    apis: [...(config.api || []), ...list('--api')],
    inviteOnly: has('--invite-only') || config.inviteOnly === true,
  });
  problems.push(...live.problems);
  if (!control.ok) problems.push(`the control failed (missed: ${control.missed.join(', ') || 'none'}; noise: ${control.noise.join(', ') || 'none'})`);

  const { kept, waived } = applyWaivers([...scan.findings, ...live.findings], files, config.allow || []);
  const errors = kept.filter((f) => f.severity === 'error');
  const warns = kept.filter((f) => f.severity === 'warn');
  const strict = has('--strict');
  const red = errors.length > 0 || (strict && warns.length > 0);
  const code = red ? 1 : problems.length ? 2 : 0;

  if (has('--json')) {
    process.stdout.write(`${JSON.stringify({ exit: code, population: { source, ...scan.population, urls: live.lines }, control, findings: kept, waived, problems }, null, 2)}\n`);
    return code;
  }
  const p = scan.population;
  const apps = p.webApps.map((a) => `${a.framework} at ${a.dir}`).join(', ') || 'none';
  console.log(`security-gate: ${p.files} files from ${source}, ${p.read} read as text`);
  console.log(`population: ${p.code} code files, ${p.routes} route handlers, ${p.migrations} Supabase migrations (${p.tables} public tables, ${p.definerMentions} SECURITY DEFINER), ${p.manifests} extension manifests, web apps: ${apps}, ${live.lines.length} live requests`);
  for (const l of live.lines) console.log(`  live: ${l}`);
  console.log(controlLine);
  for (const f of [...errors, ...warns]) {
    console.log(`${f.severity === 'error' ? 'ERROR' : 'WARN '} ${f.rule}  ${f.path}${f.line ? `:${f.line}` : ''}\n      ${f.message}\n      fix: ${f.fix}`);
  }
  for (const w of waived) console.log(`waived ${w.rule}  ${w.path}${w.line ? `:${w.line}` : ''}  reason: ${w.reason}`);
  for (const pr of problems) console.log(`INDETERMINATE ${pr}`);
  const verdict = code === 0 ? 'GREEN' : code === 1 ? 'RED' : 'INDETERMINATE';
  console.log(`verdict: ${verdict}. ${errors.length} errors, ${warns.length} warnings${strict ? ' (--strict: warnings fail)' : ' (warnings fail only with --strict)'}, ${waived.length} waived, ${problems.length} problems.`);
  if (code === 0) console.log('A green run proves the rules listed by --rules, not that the app is secure. The security skill covers the rest.');
  return code;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => { console.error(`security-gate: ${e.stack || e.message}`); process.exitCode = 2; },
  );
}

module.exports = { scanFiles, runControl, plantedSample, cleanSample, applyWaivers, globRe };
