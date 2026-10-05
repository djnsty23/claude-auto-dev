'use strict';
/**
 * security-checks.js - the rules behind security-gate.js.
 *
 * Pure: every function takes file text or response headers and returns
 * findings. Nothing here reads the disk or the network, so a suite can drive
 * each rule with a planted defect and a clean control.
 *
 * A finding is { rule, severity, path, line, message, fix }. It never carries
 * the matched text of a secret: a gate that prints the key it found has leaked
 * it into every log that captures its output.
 *
 * SEVERITY. An `error` rule turns the gate red. A rule is `error` only when a
 * match is a defect on its face (a tracked .env, a service_role JWT, a SECURITY
 * DEFINER function with no search_path) or when a live response lacks a header
 * outright. Anything that needs judgement (an HTML sink, a route with no
 * visible auth call) is `warn`: a check with false positives that can turn a
 * build red gets muted, and a muted check stops catching the real thing.
 */

const RULES = {
  'env-file': { severity: 'error', what: 'A .env file would be committed.' },
  'secret-in-source': { severity: 'error', what: 'A live-format credential is in a file that would be committed.' },
  'service-role-jwt': { severity: 'error', what: 'A Supabase service_role JWT is in a file that would be committed.' },
  'public-secret-env': { severity: 'error', what: 'A secret-named variable carries a client-bundle prefix.' },
  'client-privileged-key': { severity: 'error', what: 'A "use client" module references a service-role or secret key.' },
  'sql-rls-missing': { severity: 'error', what: 'A public table never has row level security enabled.' },
  'sql-definer-search-path': { severity: 'error', what: 'A SECURITY DEFINER function does not pin search_path.' },
  'sql-policy-true': { severity: 'warn', what: 'A write-capable policy is USING (true) or WITH CHECK (true).' },
  'sql-view-definer': { severity: 'warn', what: 'A public view without security_invoker bypasses RLS.' },
  'sql-grant-missing': { severity: 'warn', what: 'A public table has no explicit GRANT (Supabase stops auto-granting new tables from 2026-10-30).' },
  'csp-missing': { severity: 'error', what: 'A web app sets no Content-Security-Policy anywhere in its source.' },
  'html-sink': { severity: 'warn', what: 'An HTML or code sink runs whatever text reaches it.' },
  'message-origin': { severity: 'warn', what: 'A window message listener never checks the origin.' },
  'route-no-auth': { severity: 'warn', what: 'A server route shows no authentication or signature check.' },
  'ext-external': { severity: 'error', what: 'Any site or extension may message the extension.' },
  'ext-csp': { severity: 'error', what: 'The extension CSP allows eval, inline or remote script.' },
  'ext-sender-unchecked': { severity: 'error', what: 'An extension worker handles messages without checking the sender.' },
  'ext-content-origin': { severity: 'error', what: 'An extension content script trusts window messages without checking origin.' },
  'ext-broad-hosts': { severity: 'warn', what: 'The extension asks for every site.' },
  'esm-inline-require': { severity: 'warn', what: 'A Node builtin is loaded with require() inside an ES module, where require does not exist.' },
  'sql-policy-initplan': { severity: 'warn', what: 'A policy calls auth.uid() or an is_admin() style function per row instead of once per statement.' },
  'sql-fk-unindexed': { severity: 'warn', what: 'A foreign key column has no index that leads with it.' },
  'admin-no-role-check': { severity: 'warn', what: 'An admin page or route shows no server-side role check, only (at most) a sign-in check.' },
  'select-star': { severity: 'warn', what: 'A query selects every column of every row it returns.' },
  'cron-fetch-no-timeout': { severity: 'warn', what: 'A scheduled job calls fetch with no timeout or abort signal.' },
  'backup-unbounded-read': { severity: 'warn', what: 'A backup or export reads a table with no range, so it silently stops at the API row cap.' },
  'uncached-stripe-list': { severity: 'warn', what: 'A page or route lists from Stripe with no cache, so every render pays a Stripe call.' },
  'live-csp-missing': { severity: 'error', what: 'The live page sends no enforced Content-Security-Policy.' },
  'live-csp-script': { severity: 'error', what: 'The live script policy allows inline script, eval, data: or any host.' },
  'live-frame': { severity: 'error', what: 'The live page can be framed.' },
  'live-csp-object-base': { severity: 'warn', what: 'The live policy leaves object-src or base-uri open.' },
  'live-hsts': { severity: 'error', what: 'The live HTTPS page sends no Strict-Transport-Security.' },
  'live-nosniff': { severity: 'error', what: 'The live page sends no X-Content-Type-Options: nosniff.' },
  'live-referrer': { severity: 'warn', what: 'The live page sends no Referrer-Policy.' },
  'live-powered-by': { severity: 'warn', what: 'The live page advertises its framework.' },
  'live-cors-credentials': { severity: 'error', what: 'The live response allows any origin with credentials.' },
  'live-api-open': { severity: 'error', what: 'A protected API path answered 2xx with no credentials.' },
  'live-signup-open': { severity: 'error', what: 'Supabase sign-up is open on an app declared invite-only.' },
};

const finding = (rule, path, line, message, fix) => ({ rule, severity: RULES[rule].severity, path, line, message, fix });

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** True when this line or the one above carries `security-ok:` and a reason of at least three characters. */
function waivedInline(text, line) {
  if (!line) return false;
  const lines = text.split('\n');
  return [lines[line - 1], lines[line - 2]].some((l) => /security-ok:\s*\S.{2,}/.test(l || ''));
}

const isTestPath = (p) => /(^|\/)(__tests__|tests?|fixtures?|e2e|__mocks__|mocks?|stories)\//i.test(p) || /\.(test|spec|stories)\.[cm]?[jt]sx?$/i.test(p);
const isCode = (p) => /\.[cm]?[jt]sx?$/i.test(p) && !/\.d\.ts$/i.test(p) && !/\.min\.js$/i.test(p);

// ------------------------------------------------------------------ secrets

// Formats a real credential has and a placeholder does not. Public identifiers
// (Supabase anon JWTs and publishable keys, Stripe pk_ keys, Firebase web keys)
// are deliberately absent. `[measured 2026-09-26]` over 33 local repos the first
// draft fired 16 times and 1 was a real key: a PEM header with "..." for a body,
// AWS's documented ...EXAMPLE id, and short fakes in security tests. Hence the
// key body after a PEM header, the real minimum lengths, and PLACEHOLDER below.
const SECRET_FORMATS = [
  ['a Stripe live secret or restricted key', /\b[rs]k_live_[0-9A-Za-z]{24,}/],
  ['an AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['a private key block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----(?:\\n|[\s"'`+])*[A-Za-z0-9+/]{60}/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['a Slack token', /\bxox[abprs]-[0-9A-Za-z-]{20,}/],
  ['a Supabase secret key', /\bsb_secret_[0-9A-Za-z_-]{20,}/],
  ['an OpenAI or Anthropic key', /\bsk-(?:proj|ant(?:-api\d\d)?|svcacct)-[0-9A-Za-z_-]{80,}/],
  ['a Google OAuth client secret', /\bGOCSPX-[0-9A-Za-z_-]{28}\b/],
  ['a Resend key', /\bre_[0-9A-Za-z]{8}_[0-9A-Za-z]{24}\b/],
];

const PLACEHOLDER = /EXAMPLE|(?:x|X|0|\*){6}|123456|abcdef/;

const JWT = /\beyJ[0-9A-Za-z_-]{8,1000}\.eyJ[0-9A-Za-z_-]{8,2000}\.[0-9A-Za-z_-]{16,200}/g;

function jwtRole(token) {
  try {
    const body = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(body, 'base64').toString('utf8')).role ?? null;
  } catch {
    return null;
  }
}

/** paths: every file that would be committed (tracked, or untracked and not ignored). */
function checkEnvFiles(paths) {
  const out = [];
  for (const p of paths) {
    const base = p.split('/').pop();
    if (!/^\.env(\..+)?$/.test(base)) continue;
    if (/\.(example|sample|template|defaults?|dist|schema)$/i.test(base)) continue;
    out.push(finding('env-file', p, 1, `${p} would be committed.`, 'Ignore it (and git rm --cached it if tracked). Rotate every value it ever held in a pushed commit.'));
  }
  return out;
}

function checkSecrets(path, text) {
  const out = [];
  for (const [what, re] of SECRET_FORMATS) {
    const m = [...text.matchAll(new RegExp(re.source, 'g'))].find((x) => !PLACEHOLDER.test(x[0]));
    if (m) out.push(finding('secret-in-source', path, lineAt(text, m.index), `Contains ${what}.`, 'Move it to the secret store, rotate it, and purge it from history.'));
  }
  for (const m of text.matchAll(JWT)) {
    if (jwtRole(m[0]) === 'service_role') {
      out.push(finding('service-role-jwt', path, lineAt(text, m.index), 'Contains a service_role JWT, which bypasses every RLS policy.', 'Rotate the project JWT secret, then read the key from server-side env only.'));
      break;
    }
  }
  return out;
}

// Quantifiers are bounded throughout: this runs over minified bundles, where an
// unbounded run beside an alternation costs quadratic time or worse.
const PUBLIC_PREFIX = /\b(?:NEXT_PUBLIC|VITE|EXPO_PUBLIC|PUBLIC|REACT_APP|NUXT_PUBLIC|GATSBY)_[A-Z0-9_]{0,60}?(?:SERVICE_ROLE|SECRET|PRIVATE|PASSWORD)[A-Z0-9_]{0,60}\b/g;

/**
 * True when the module opens with a "use client" directive, after any comments.
 * A scan, not a regex: a regex that skips leading comments backtracks
 * exponentially when a comment holds another comment's delimiter, and hung for
 * minutes on one 485 KB minified file.
 */
function isClientModule(text) {
  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text.startsWith('//', i)) {
      const nl = text.indexOf('\n', i);
      if (nl < 0) return false;
      i = nl + 1;
    } else if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) return false;
      i = close + 2;
    } else return /^['"]use client['"]/.test(text.slice(i, i + 13));
  }
}

function checkClientEnv(path, text) {
  const out = [];
  for (const m of text.matchAll(PUBLIC_PREFIX)) {
    out.push(finding('public-secret-env', path, lineAt(text, m.index), `${m[0]} is inlined into the client bundle.`, 'Drop the public prefix and read it only on the server.'));
  }
  if (isClientModule(text)) {
    const k = /\b[A-Z0-9_]{0,40}?(?:SERVICE_ROLE|SUPABASE_SECRET|STRIPE_SECRET)[A-Z0-9_]{0,40}/.exec(text);
    if (k) out.push(finding('client-privileged-key', path, lineAt(text, k.index), `A client component references ${k[0]}.`, 'Move the call behind a server action or route.'));
  }
  return out;
}

// ---------------------------------------------------------------------- SQL

const ident = (s) => s.replace(/"/g, '').trim().toLowerCase();
const bare = (s) => ident(s).replace(/^public\./, '');

/** Each CREATE FUNCTION with its body cut out, so words inside the body do not count. */
function functionStatements(sql) {
  const out = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+([\w."]+)\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) {
    const start = m.index;
    const rest = sql.slice(start);
    const tag = /\$([A-Za-z_]*)\$/.exec(rest);
    const semi = rest.indexOf(';');
    let outside;
    let end;
    if (tag && (semi < 0 || tag.index < semi)) {
      const open = start + tag.index;
      const close = sql.indexOf(tag[0], open + tag[0].length);
      if (close < 0) break;
      const stop = sql.indexOf(';', close);
      end = stop < 0 ? sql.length : stop;
      outside = `${sql.slice(start, open)}\n${sql.slice(close + tag[0].length, end)}`;
    } else {
      end = semi < 0 ? sql.length : start + semi;
      outside = sql.slice(start, end);
    }
    re.lastIndex = end;
    out.push({ name: bare(m[1]), index: start, outside });
  }
  return out;
}

/**
 * Migrations are read as ONE ordered history: a table created in the first
 * file and given RLS in the seventh is fine, a dropped table is not reported,
 * and a later `alter function ... set search_path` repairs an earlier one.
 * files: [{ path, text }] in apply order.
 */
function checkMigrations(files) {
  const out = [];
  const tables = new Map();
  const rls = new Set();
  const granted = new Set();
  let grantAll = false;
  const definers = new Map();
  const views = new Map();
  const TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?\s*\(/gi;
  for (const { path, text } of files) {
    const sql = text.replace(/--[^\n]*/g, (c) => ' '.repeat(c.length));
    for (const m of sql.matchAll(TABLE)) {
      if ((m[1] || 'public').toLowerCase() !== 'public') continue;
      tables.set(m[2].toLowerCase(), { path, line: lineAt(sql, m.index) });
    }
    for (const m of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:"?public"?\.)?"?(\w+)"?/gi)) tables.delete(m[1].toLowerCase());
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:"?public"?\.)?"?(\w+)"?\s+enable\s+row\s+level\s+security/gi)) rls.add(m[1].toLowerCase());
    // A DO block that enables RLS through format('... %I ...') over a literal
    // array names its tables in that array; one looping over the catalog covers
    // every public table created so far. `[measured 2026-09-26]` the static form
    // alone reported 30 tables in two repos that had RLS on every one of them.
    for (const block of sql.matchAll(/\bdo\s+\$(\w*)\$([\s\S]*?)\$\1\$/gi)) {
      const body = block[2];
      const names = [...body.matchAll(/array\s*\[([^\]]*)\]/gi)].flatMap((a) => [...a[1].matchAll(/'(\w+)'/g)].map((x) => x[1].toLowerCase()));
      const catalog = /\b(?:pg_tables|pg_class|information_schema\.tables)\b/i.test(body);
      const DYNAMIC = [
        [/format\s*\(\s*'[^']*%I[^']*enable\s+row\s+level\s+security/i, rls],
        [/format\s*\(\s*'\s*grant\b[^']*%I/i, granted],
      ];
      for (const [re, set] of DYNAMIC) {
        if (!re.test(body)) continue;
        for (const n of names) set.add(n);
        if (catalog) for (const t of tables.keys()) set.add(t);
      }
    }
    for (const m of sql.matchAll(/\bgrant\s+[^;]*?\bon\s+([^;]*?)\s+to\s+/gi)) {
      if (/all\s+tables\s+in\s+schema\s+"?public"?/i.test(m[1])) grantAll = true;
      for (const t of m[1].replace(/^\s*table\s+/i, '').split(',')) granted.add(bare(t));
    }
    for (const f of functionStatements(sql)) {
      if (/security\s+definer/i.test(f.outside) && !/set\s+search_path/i.test(f.outside)) definers.set(f.name, { path, line: lineAt(sql, f.index) });
      else definers.delete(f.name);
    }
    for (const m of sql.matchAll(/alter\s+function\s+([\w."]+)\s*(?:\([^)]*\))?\s+set\s+search_path/gi)) definers.delete(bare(m[1]));
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?view\s+(?:"?public"?\.)?"?(\w+)"?([^;]*?)\bas\b/gi)) {
      if (/security_invoker\s*=\s*(true|on)/i.test(m[2])) views.delete(m[1].toLowerCase());
      else views.set(m[1].toLowerCase(), { path, line: lineAt(sql, m.index) });
    }
    for (const m of sql.matchAll(/alter\s+view\s+(?:"?public"?\.)?"?(\w+)"?\s+set\s*\(\s*security_invoker\s*=\s*(true|on)/gi)) views.delete(m[1].toLowerCase());
    for (const m of sql.matchAll(/drop\s+view\s+(?:if\s+exists\s+)?(?:"?public"?\.)?"?(\w+)"?/gi)) views.delete(m[1].toLowerCase());
    for (const m of sql.matchAll(/create\s+policy\s[^;]*;/gi)) {
      const p = m[0];
      if (!/(using|with\s+check)\s*\(\s*true\s*\)/i.test(p)) continue;
      if (/\bfor\s+select\b/i.test(p)) continue;
      const roles = (/\bto\s+([\w\s,"]+?)(?:\s+using|\s+with|\s*;)/i.exec(p) || [])[1] || 'public';
      if (/^\s*"?service_role"?\s*$/i.test(roles)) continue;
      out.push(finding('sql-policy-true', path, lineAt(sql, m.index), `A policy lets ${roles.trim()} write every row (true).`, 'Scope it to the owner, for example `using (auth.uid() = user_id)`.'));
    }
  }
  for (const [name, at] of tables) {
    if (!rls.has(name)) out.push(finding('sql-rls-missing', at.path, at.line, `Table public.${name} never has row level security enabled.`, `alter table public.${name} enable row level security; then add owner policies.`));
    if (!grantAll && !granted.has(name)) out.push(finding('sql-grant-missing', at.path, at.line, `Table public.${name} has no explicit GRANT.`, 'Grant each role exactly what the app uses (anon, authenticated, service_role).'));
  }
  for (const [name, at] of definers) out.push(finding('sql-definer-search-path', at.path, at.line, `SECURITY DEFINER function ${name} does not set search_path.`, "Add `set search_path = ''` and schema-qualify every name in the body."));
  for (const [name, at] of views) out.push(finding('sql-view-definer', at.path, at.line, `View ${name} runs with its owner's rights.`, 'Create it `with (security_invoker = true)`, or revoke it from anon and authenticated.'));
  return out;
}

// --------------------------------------------------------------- web source

const SINKS = [
  [/dangerouslySetInnerHTML/g, 'dangerouslySetInnerHTML'],
  [/\.(?:inner|outer)HTML\s*\+?=(?!=)/g, 'an innerHTML assignment'],
  [/\binsertAdjacentHTML\s*\(/g, 'insertAdjacentHTML'],
  [/\bdocument\.write(?:ln)?\s*\(/g, 'document.write'],
  [/(?<![\w.$])eval\s*\(/g, 'eval'],
  [/\bnew\s+Function\s*\(/g, 'new Function'],
];

function checkSinks(path, text) {
  const out = [];
  for (const [re, what] of SINKS) {
    for (const m of text.matchAll(re)) {
      out.push(finding('html-sink', path, lineAt(text, m.index), `Uses ${what}.`, 'Render text as text, or sanitise with a vetted library and waive the line with `security-ok: <why>`.'));
    }
  }
  return out;
}

const MESSAGE_LISTENER = /addEventListener\(\s*['"]message['"]|\bonmessage\s*=/;

function checkMessageListeners(path, text, contentScript) {
  const m = MESSAGE_LISTENER.exec(text);
  if (!m || /\.origin\b/.test(text)) return [];
  return [finding(contentScript ? 'ext-content-origin' : 'message-origin', path, lineAt(text, m.index), 'A window message listener never reads event.origin.', 'Return early unless event.origin (and event.source) is the one expected.')];
}

// exchangeCodeForSession and verifyOtp are the sign-in step itself: an OAuth or
// magic-link callback must be reachable anonymously.
const AUTH_MARKERS = /getUser|getSession|getServerSession|getClaims|getToken|currentUser|exchangeCodeForSession|verifyOtp|\bauth\s*\(|requireAuth|requireUser|requireAdmin|verify|signature|authorization|bearer|x-api-key|timingSafeEqual|CRON_SECRET|webhook/i;

const isRoute = (p) => /(^|\/)app\/(?:.*\/)?route\.[cm]?[jt]s$/.test(p) || /(^|\/)pages\/api\/.+\.[cm]?[jt]s$/.test(p) || /(^|\/)supabase\/functions\/[^/_][^/]*\/index\.ts$/.test(p);

function checkRoute(path, text) {
  if (AUTH_MARKERS.test(text)) return [];
  const m = /export\s+(?:async\s+)?(?:function|const)\s+(?:GET|POST|PUT|PATCH|DELETE)\b|export\s+default|\bDeno\.serve\s*\(|\bserve\s*\(/.exec(text);
  if (!m) return [];
  return [finding('route-no-auth', path, lineAt(text, m.index), 'This handler shows no authentication or signature check.', 'Check the session or a signature first, or allow-list it in .security-gate.json with the reason it is public.')];
}

// ------------------------------------------------------------ extensions

const WILD = /^<all_urls>$|^\*:\/\/\*\/|^https?:\/\/\*\//;

function checkManifest(path, json) {
  const out = [];
  const ec = json.externally_connectable;
  if (ec && ((ec.matches || []).some((x) => WILD.test(x)) || (ec.ids || []).includes('*'))) {
    out.push(finding('ext-external', path, 1, 'externally_connectable admits any site or any extension.', 'List exact origins and extension ids, or remove the key.'));
  }
  const cspRaw = json.content_security_policy;
  const csp = typeof cspRaw === 'string' ? cspRaw : Object.values(cspRaw || {}).join('; ');
  const scriptPart = parseCsp(csp)['script-src'] || [];
  if (scriptPart.some((s) => /unsafe-eval|unsafe-inline|^https?:|^\*$|^data:|^blob:/i.test(s))) {
    out.push(finding('ext-csp', path, 1, 'The extension CSP loosens script-src.', "Remove content_security_policy or keep script-src at 'self'."));
  }
  const hosts = [...(json.host_permissions || []), ...(json.permissions || []), ...(json.content_scripts || []).flatMap((c) => c.matches || [])];
  if (hosts.some((h) => WILD.test(h))) out.push(finding('ext-broad-hosts', path, 1, 'The extension runs on, or can read, every site.', 'Name the hosts it needs.'));
  return out;
}

function checkBackground(path, text) {
  const m = /\b(?:runtime|extension)\.(?:onMessage|onConnect|onMessageExternal|onConnectExternal)\.addListener/.exec(text);
  if (!m) return [];
  if (/\bsender\s*\.\s*(?:id|url|origin|tab)\b|\bport\.sender\b/.test(text)) return [];
  return [finding('ext-sender-unchecked', path, lineAt(text, m.index), 'Messages are handled without reading sender.id, sender.url or sender.tab.', 'Check sender.id === chrome.runtime.id, then allow each message type only from the contexts that need it.')];
}

// ------------------------------------------------------- learned from fixes
//
// Classes found and fixed in the 2026-10 sweeps, each with a signature a grep
// can hold. Every rule here is advisory (`warn`): its measured precision is in
// docs/learned-rules.md, and a rule that cannot show its precision does not turn
// a build red.

const NODE_BUILTINS = 'assert|buffer|child_process|cluster|crypto|dns|events|fs|http|http2|https|net|os|path|perf_hooks|querystring|readline|stream|string_decoder|timers|tls|url|util|vm|worker_threads|zlib';
const BUILTIN_REQUIRE = new RegExp(`(?<![\\w.$])require\\s*\\(\\s*(['"\`])(?:node:)?(?:${NODE_BUILTINS})(?:/[\\w/]+)?\\1\\s*\\)`, 'g');

/** Comments blanked to spaces, offsets kept. Only whole-line // comments, so a URL in a string survives. */
function blankComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/^[ \t]*\/\/.*$/gm, (c) => ' '.repeat(c.length));
}

/**
 * isEsm: the caller knows the module system (.mjs, or the nearest package.json
 * says "type": "module"). `require` does not exist there, so a builtin loaded
 * with it throws on first call, long after the build passed.
 */
function checkEsmRequire(path, text, isEsm) {
  if (!isEsm || /\bcreateRequire\b/.test(text)) return [];
  const hits = [...blankComments(text).matchAll(BUILTIN_REQUIRE)];
  if (!hits.length) return [];
  return [finding('esm-inline-require', path, lineAt(text, hits[0].index), `${hits.length} require() call(s) of a Node builtin inside an ES module.`, "Use a top-level `import ... from 'node:...'`.")];
}

const WRAPPED_CALL = /\(\s*select\s+[\w."]+\s*\([^()]*\)\s*(?:as\s+\w+\s*)?\)/gi;
const PER_ROW_CALL = /\b(?:auth\.(?:uid|jwt|role|email)|(?:\w+\.)?(?:is_admin|has_role))\s*\(/i;

/** True when a policy expression calls an auth function outside a `(select ...)` wrapper. */
function bareAuthCall(expr) {
  let s = expr;
  for (let i = 0; i < 6; i++) {
    const next = s.replace(WRAPPED_CALL, ' ');
    if (next === s) break;
    s = next;
  }
  return PER_ROW_CALL.test(s);
}

/** The USING and WITH CHECK halves of one policy statement's tail. */
function policyClauses(tail) {
  const at = tail.search(/\bwith\s+check\b/i);
  const using = at < 0 ? tail : tail.slice(0, at);
  return { using: /\busing\b/i.test(using) ? using : null, check: at < 0 ? null : tail.slice(at) };
}

/** Policies as the migration history leaves them: a later drop, create or alter replaces an earlier one. */
function checkPolicyInitplan(files) {
  const policies = new Map();
  const key = (n, t) => `${ident(n)}|${bare(t)}`;
  for (const { path, text } of files) {
    const sql = text.replace(/--[^\n]*/g, (c) => ' '.repeat(c.length));
    const events = [];
    for (const m of sql.matchAll(/drop\s+policy\s+(?:if\s+exists\s+)?("[^"]+"|\w+)\s+on\s+([\w."]+)/gi)) events.push({ at: m.index, drop: key(m[1], m[2]) });
    for (const m of sql.matchAll(/create\s+policy\s+("[^"]+"|\w+)\s+on\s+([\w."]+)([^;]*);/gi)) events.push({ at: m.index, create: key(m[1], m[2]), tail: m[3], line: lineAt(sql, m.index) });
    for (const m of sql.matchAll(/alter\s+policy\s+("[^"]+"|\w+)\s+on\s+([\w."]+)([^;]*);/gi)) events.push({ at: m.index, alter: key(m[1], m[2]), tail: m[3] });
    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      if (e.drop) policies.delete(e.drop);
      else if (e.create) policies.set(e.create, { path, line: e.line, ...policyClauses(e.tail) });
      else if (policies.has(e.alter)) {
        const next = policyClauses(e.tail);
        const old = policies.get(e.alter);
        policies.set(e.alter, { ...old, using: next.using ?? old.using, check: next.check ?? old.check });
      }
    }
  }
  const byFile = new Map();
  for (const p of policies.values()) {
    if (!bareAuthCall(`${p.using || ''} ${p.check || ''}`)) continue;
    const at = byFile.get(p.path) || { line: p.line, n: 0 };
    at.n++;
    byFile.set(p.path, at);
  }
  return [...byFile].map(([path, at]) => finding('sql-policy-initplan', path, at.line, `${at.n} polic${at.n === 1 ? 'y calls' : 'ies call'} auth.uid() or is_admin() once per row.`, 'Wrap each call: `(select auth.uid())`, so Postgres evaluates it once per statement.'));
}

/** Top-level comma split of a parenthesised body, quotes respected. */
function splitTop(s) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

const qual = (t) => {
  const parts = ident(t).split('.');
  return parts.length > 1 ? `${parts[0]}.${parts[1]}` : `public.${parts[0]}`;
};
const firstCol = (s) => {
  const m = /\(\s*"?(\w+)"?/.exec(s);
  return m ? m[1].toLowerCase() : null;
};

/** Foreign key columns that no index, primary key or unique constraint leads with. */
function checkFkIndexes(files) {
  const fks = new Map();
  const indexed = new Set();
  const indexNames = new Map();
  const note = (table, col, path, line) => {
    if (col) fks.set(`${table}|${col}`, { path, line });
  };
  const constraint = (table, part, path, line) => {
    const p = part.trim().replace(/^constraint\s+\S+\s+/i, '');
    if (/^foreign\s+key\b/i.test(p)) note(table, firstCol(p), path, line);
    else if (/^(primary\s+key|unique)\b/i.test(p)) {
      const c = firstCol(p);
      if (c) indexed.add(`${table}|${c}`);
    }
  };
  const column = (table, p, path, line) => {
    const col = /^"?(\w+)"?/.exec(p);
    if (!col) return;
    if (/\breferences\b/i.test(p)) note(table, col[1].toLowerCase(), path, line);
    if (/\bprimary\s+key\b|\bunique\b/i.test(p)) indexed.add(`${table}|${col[1].toLowerCase()}`);
  };
  for (const { path, text } of files) {
    const sql = text.replace(/--[^\n]*/g, (c) => ' '.repeat(c.length));
    const CREATE = /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(/gi;
    let m;
    while ((m = CREATE.exec(sql))) {
      const table = qual(m[1]);
      let depth = 1;
      let i = CREATE.lastIndex;
      const start = i;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '(') depth++;
        else if (sql[i] === ')') depth--;
        i++;
      }
      const line = lineAt(sql, m.index);
      for (const part of splitTop(sql.slice(start, i - 1))) {
        const p = part.trim();
        if (/^(constraint|foreign|primary|unique)\b/i.test(p)) constraint(table, p, path, line);
        else column(table, p, path, line);
      }
    }
    for (const a of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)\s+([^;]*);/gi)) {
      const table = qual(a[1]);
      for (const act of splitTop(a[2])) {
        const add = /^\s*add\s+(?:column\s+(?:if\s+not\s+exists\s+)?)?([\s\S]*)$/i.exec(act);
        if (!add) continue;
        const body = add[1].trim();
        if (/^(constraint|foreign|primary|unique)\b/i.test(body)) constraint(table, body, path, lineAt(sql, a.index));
        else column(table, body, path, lineAt(sql, a.index));
      }
    }
    const INDEX = /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:("?\w+"?)\s+)?on\s+(?:only\s+)?([\w."]+)\s*(?:using\s+\w+\s*)?(\([^;]*)/gi;
    for (const ix of sql.matchAll(INDEX)) {
      const c = firstCol(ix[3]);
      if (!c) continue;
      indexed.add(`${qual(ix[2])}|${c}`);
      if (ix[1]) indexNames.set(ident(ix[1]), `${qual(ix[2])}|${c}`);
    }
    for (const d of sql.matchAll(/drop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?([\w."]+)/gi)) {
      const gone = indexNames.get(ident(d[1]).split('.').pop());
      if (gone) indexed.delete(gone);
    }
    for (const d of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?([\w."]+)/gi)) {
      const t = `${qual(d[1])}|`;
      for (const k of [...fks.keys()]) if (k.startsWith(t)) fks.delete(k);
    }
  }
  const out = [];
  for (const [k, at] of fks) {
    if (indexed.has(k)) continue;
    const [table, col] = k.split('|');
    out.push(finding('sql-fk-unindexed', at.path, at.line, `Foreign key ${table}.${col} has no index that leads with it.`, 'Create an index on the column (concurrently on a large table). Without it, every delete on the parent scans this table.'));
  }
  return out;
}

// Directory names that mark an operator-only surface. `debug` and `workers` are here because
// an operator console reached by every signed-in user was found under /settings/workers.
const OPERATOR_DIR = '(?:admin|debug|workers|internal|staff)';
const ADMIN_FILE = new RegExp(`(^|/)(?:app|pages)/(?:[^/]+/)*${OPERATOR_DIR}/(?:[^/]+/)*(page|layout|route|index)\\.[cm]?[jt]sx?$|(^|/)pages/api/(?:[^/]+/)*${OPERATOR_DIR}/[^/]+\\.[cm]?[jt]sx?$`);
const ROLE_MARKER = /\b(?:(?:is_?admin|isAdmin|requireAdmin|requireRole|assertAdmin|checkAdmin|verifyAdmin|ensureAdmin|requireOwner|assertRole)\w*|adminOnly|ADMIN_EMAILS|admin-guard|has_role|readAdminSession|readAdminState|isDbAdmin|superuser|isOwner|passesGate|hasPermission|canAccess)\b|\.role\b|\brole\s*(?:===|!==|==)|\broles?\.includes\(/i;
const isGateFile = (p) => /(^|\/)(?:middleware|proxy)\.[cm]?[jt]s$/.test(p);

/**
 * Pages and routes under an admin directory need a role check on the server:
 * their own, an ancestor layout's up to the admin directory, or a middleware
 * that names /admin and a role. A sign-in check alone lets every signed-in
 * user in. files: [{ path, text }] of non-test code. A page under a layout
 * that has no check is not reported: the layout is the entry that is.
 */
function checkAdminTree(files) {
  const text = new Map(files.map((f) => [f.path, f.text]));
  const gate = files.some((f) => isGateFile(f.path) && /admin/i.test(f.text) && ROLE_MARKER.test(f.text));
  const out = [];
  for (const f of files.filter((x) => ADMIN_FILE.test(x.path))) {
    if (ROLE_MARKER.test(f.text) || gate) continue;
    const isPage = /(^|\/)(page|index)\.[cm]?[jt]sx?$/.test(f.path) && !/\/pages\/api\//.test(f.path);
    let layouts = [];
    if (isPage) {
      let d = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      for (;;) {
        layouts.push(...['tsx', 'ts', 'jsx', 'js'].map((e) => `${d ? `${d}/` : ''}layout.${e}`));
        if (new RegExp(`(^|/)${OPERATOR_DIR}$`).test(d) || !d) break;
        d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
      }
      layouts = layouts.filter((p) => text.has(p));
    }
    if (layouts.length) continue;
    out.push(finding('admin-no-role-check', f.path, 1, 'No server-side role check on this admin entry (own, ancestor layout or middleware).', 'Check the role on the server before any data is read and answer 403 or notFound, not only that a user is signed in.'));
  }
  return out;
}

function checkSelectStar(path, text) {
  const hits = [];
  for (const m of text.matchAll(/\.select\(\s*(['"`])\s*\*\s*(?:\1|,)|[?&]select=\*/g)) {
    if (!/head\s*:\s*true/.test(text.slice(m.index, m.index + 120))) hits.push(m);
  }
  if (!hits.length) return [];
  return [finding('select-star', path, lineAt(text, hits[0].index), `Selects every column (${hits.length} place${hits.length === 1 ? '' : 's'} in this file).`, 'Name the columns the caller reads. A wide row (JSON, logos, prompts) multiplies bytes on every list.')];
}

const CRON_PATH = /(^|\/)crons?\/|(^|\/)[^/]*cron[^/]*\.[cm]?[jt]s$/i;

function checkCronFetch(path, text) {
  if (!CRON_PATH.test(path)) return [];
  const code = blankComments(text);
  const m = /(?<![\w.$])fetch\s*\(/.exec(code);
  if (!m || /AbortSignal|AbortController|\bsignal\s*:|timeout/i.test(code)) return [];
  return [finding('cron-fetch-no-timeout', path, lineAt(text, m.index), 'A scheduled job calls fetch with no timeout or abort signal.', 'Pass `signal: AbortSignal.timeout(ms)` to every fetch and give each step a share of the function budget.')];
}

const BACKUP_PATH = /(backup|dump|export|archive)/i;

function checkBackupRead(path, text) {
  if (!BACKUP_PATH.test(path) || /\.[jt]sx$/.test(path)) return [];
  const code = blankComments(text);
  const m = /\.from\(\s*['"`][\w.]+['"`]\s*\)\s*\.select\(/.exec(code);
  if (!m || /\.range\(|\.limit\(|fetchAll|paginat|hasMore|nextPage|\boffset\b|\.single\(|\.maybeSingle\(|head\s*:\s*true/i.test(code)) return [];
  return [finding('backup-unbounded-read', path, lineAt(text, m.index), 'Reads a table with no range or limit. The API caps a response (1000 rows on Supabase), so a larger table is silently cut.', 'Page with .range() until a short page returns, and fail the backup when the count read back differs from the count written.')];
}

// The SDK form (stripe.charges.list) and a REST helper form (stripeApi('invoices?...')).
const STRIPE_LIST = /\bstripe\w*\.\w+\.(?:list|search)\(|\.autoPagingToArray\(|\bstripe\w*\(\s*[`'"](?:invoices|prices|charges|subscriptions|customers|payment_intents|balance_transactions|checkout\/sessions)\?/i;
const STRIPE_CACHE = /stripe-cache|unstable_cache|\brevalidate\b|use cache|\bcache\w*\(|\bcached\b|\bttl\b|memo|cache-control/i;

function checkStripeList(path, text) {
  if (!isCode(path) || /\.[jt]sx$/.test(path)) return [];
  const code = blankComments(text);
  const m = STRIPE_LIST.exec(code);
  if (!m || STRIPE_CACHE.test(code)) return [];
  return [finding('uncached-stripe-list', path, lineAt(text, m.index), 'Lists from Stripe with no cache in this file, so every call pays a Stripe round trip.', 'Cache the read with a TTL and expire it from the webhook on the events that change it.')];
}

// ---------------------------------------------------------------- live

/** Directive name to value list, from one CSP header value. */
function parseCsp(value) {
  const out = {};
  for (const part of String(value || '').split(';')) {
    const [name, ...vals] = part.trim().split(/\s+/);
    if (name && !(name.toLowerCase() in out)) out[name.toLowerCase()] = vals;
  }
  return out;
}

const ENTITIES = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };

function decodeEntities(s) {
  return s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(quot|apos|amp|lt|gt));/gi, (m, dec, hex, name) => {
    const code = dec ? Number(dec) : hex ? parseInt(hex, 16) : null;
    if (code === null) return ENTITIES[name.toLowerCase()];
    return code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

// Directives a browser ignores when the policy arrives in a <meta> element.
const META_IGNORED = ['frame-ancestors', 'report-uri', 'sandbox'];

/**
 * Every <meta http-equiv="content-security-policy"> in an HTML document, in
 * order, with whether it covers the page. A browser applies a meta policy only
 * from the point it is parsed, and only inside <head>: one after the first
 * <script> leaves that script unrestricted, so it does not count as the page's
 * policy. Comments are blanked first, keeping offsets, so a commented-out tag
 * is neither a policy nor a script.
 */
function metaPolicies(html) {
  if (typeof html !== 'string' || !html) return [];
  const doc = html.replace(/<!--[\s\S]*?(?:-->|$)/g, (c) => ' '.repeat(c.length));
  const firstOf = (re) => {
    const m = re.exec(doc);
    return m ? m.index : Infinity;
  };
  const firstScript = firstOf(/<script\b/i);
  const headEnd = Math.min(firstOf(/<\/head\s*>/i), firstOf(/<body\b/i));
  const out = [];
  // Each alternative starts with a different character, so this stays linear.
  for (const tag of doc.matchAll(/<meta\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const attrs = {};
    for (const a of tag[1].matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const name = a[1].toLowerCase();
      if (!(name in attrs)) attrs[name] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    }
    if ((attrs['http-equiv'] || '').trim().toLowerCase() !== 'content-security-policy') continue;
    const value = (attrs.content || '').trim();
    if (!value) continue;
    const policy = parseCsp(value);
    for (const d of META_IGNORED) delete policy[d];
    const where = tag.index > headEnd ? 'outside <head>' : tag.index > firstScript ? 'after the first <script>' : null;
    out.push({ policy, covers: !where, where });
  }
  return out;
}

/** The reasons one policy leaves script open; empty when it restricts script. */
function scriptGaps(policy) {
  const script = policy['script-src'] || policy['default-src'] || [];
  const nonceOrHash = script.some((s) => /^'(nonce|sha256|sha384|sha512)-/.test(s));
  const strict = script.includes("'strict-dynamic'");
  const bad = [];
  if (script.includes("'unsafe-inline'") && !nonceOrHash) bad.push("'unsafe-inline'");
  if (script.includes("'unsafe-eval'")) bad.push("'unsafe-eval'");
  if (script.some((s) => s === 'data:' || s === 'blob:')) bad.push('data: or blob:');
  if (!strict && script.some((s) => s === '*' || s === 'https:' || s === 'http:')) bad.push('any host');
  if (!script.length) bad.push('no script-src or default-src');
  return bad;
}

/**
 * headers: a lower-cased header map of one HTML response. html: its body, when
 * read. Only an ENFORCED policy counts: Report-Only blocks nothing.
 *
 * A static site cannot mint a nonce, so it pins script hashes in a <meta>
 * policy and sends in the header only what a meta cannot carry. The browser
 * enforces every policy at once, so script is restricted when ANY enforced
 * policy (the header, or a meta that covers the page) restricts it.
 * frame-ancestors counts only from the header: browsers ignore it in a meta.
 */
function checkLiveHeaders(url, headers, html) {
  const out = [];
  const h = (n) => headers[n.toLowerCase()];
  const at = (rule, message, fix) => out.push(finding(rule, url, 0, message, fix));
  const cspValue = h('content-security-policy');
  const csp = parseCsp(cspValue);
  const metas = metaPolicies(html);
  const late = metas.filter((m) => !m.covers).map((m) => ` A meta policy ${m.where} does not cover the page.`);
  const enforced = [
    ...(cspValue ? [{ policy: csp, source: 'the header' }] : []),
    ...metas.filter((m) => m.covers).map((m) => ({ policy: m.policy, source: 'the meta policy' })),
  ];
  if (!enforced.length) {
    const why = h('content-security-policy-report-only') ? 'Only a Report-Only policy is sent, which blocks nothing.' : 'No Content-Security-Policy header.';
    at('live-csp-missing', `${why}${late.join('')}`, 'Send a nonce-based policy from the server on every HTML response.');
  } else {
    const gaps = enforced.map((p) => ({ ...p, bad: scriptGaps(p.policy) }));
    if (gaps.every((p) => p.bad.length)) {
      const allows = gaps.length === 1 && gaps[0].source === 'the header' ? gaps[0].bad.join(', ') : gaps.map((p) => `${p.bad.join(', ')} (${p.source})`).join('; ');
      at('live-csp-script', `script-src allows ${allows}.${late.join('')}`, "Use 'self' plus a per-request nonce and 'strict-dynamic'.");
    }
    const any = (test) => enforced.some((p) => test(p.policy));
    const objectClosed = any((p) => (p['object-src'] || p['default-src'] || []).join(' ') === "'none'");
    const open = [objectClosed ? '' : "object-src is not 'none'.", any((p) => p['base-uri']) ? '' : 'base-uri is not set.'].filter(Boolean);
    if (open.length) at('live-csp-object-base', open.join(' '), "Add object-src 'none' and base-uri 'self'.");
  }
  if (!csp['frame-ancestors'] && !/^(deny|sameorigin)$/i.test(h('x-frame-options') || '')) at('live-frame', 'Neither frame-ancestors nor X-Frame-Options is set.', "Add frame-ancestors 'none' (or 'self').");
  if (/^https:/i.test(url) && !/max-age=\d{6,}/i.test(h('strict-transport-security') || '')) at('live-hsts', 'No Strict-Transport-Security with a max-age of at least 100000 seconds.', 'Send max-age=63072000; includeSubDomains.');
  if (!/nosniff/i.test(h('x-content-type-options') || '')) at('live-nosniff', 'No X-Content-Type-Options: nosniff.', 'Send X-Content-Type-Options: nosniff.');
  if (!h('referrer-policy')) at('live-referrer', 'No Referrer-Policy.', 'Send strict-origin-when-cross-origin.');
  if (h('x-powered-by')) at('live-powered-by', `X-Powered-By: ${String(h('x-powered-by')).slice(0, 40)}.`, 'Turn it off (Next.js: poweredByHeader: false).');
  if (h('access-control-allow-origin') === '*' && /true/i.test(h('access-control-allow-credentials') || '')) at('live-cors-credentials', 'Access-Control-Allow-Origin * together with credentials.', 'Echo only allow-listed origins.');
  return out;
}

function checkLiveApi(url, status) {
  if (status >= 200 && status < 300) return [finding('live-api-open', url, 0, `Answered ${status} with no credentials.`, 'Return 401 before doing any work when the caller is not signed in.')];
  return [];
}

function checkLiveSignup(url, settings) {
  if (settings && settings.disable_signup === true) return [];
  return [finding('live-signup-open', url, 0, 'Sign-up is enabled, so anyone can create an account.', 'Disable sign-up in the Supabase Auth settings and invite users instead.')];
}

module.exports = {
  RULES,
  isTestPath,
  isCode,
  isRoute,
  waivedInline,
  jwtRole,
  parseCsp,
  metaPolicies,
  checkEnvFiles,
  checkSecrets,
  checkClientEnv,
  checkMigrations,
  checkSinks,
  checkMessageListeners,
  checkRoute,
  checkManifest,
  checkBackground,
  checkEsmRequire,
  checkPolicyInitplan,
  checkFkIndexes,
  checkAdminTree,
  checkSelectStar,
  checkCronFetch,
  checkBackupRead,
  checkStripeList,
  bareAuthCall,
  checkLiveHeaders,
  checkLiveApi,
  checkLiveSignup,
};
