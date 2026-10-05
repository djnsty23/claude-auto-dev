#!/usr/bin/env node
'use strict';
// Suite for the eight advisory rules the gate learned from a round of
// security and performance fixes. Each rule gets three arms, all driven through
// the real CLI as a subprocess over a temp git repo:
//   bad     the defect as it was written, shrunk to a fixture. Must fire.
//   good    the fix as it was shipped. Must stay silent for that rule.
//   mutant  a one-token variant of the defect that a suppressor or scope
//           filter should still let through. Must fire, so the suppressor is
//           proven narrow and not just present.
// The fixtures are written here by hand. They do not read the rules' own
// vocabulary, so weakening a rule cannot weaken its canary in the same edit.
//
// Run: node tooling/test-security-learned-rules.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GATE = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'security-gate.js');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failures.push(name + (detail !== undefined ? `\n      -> ${JSON.stringify(detail).slice(0, 500)}` : ''));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'learned-rules-'));
let n = 0;
function scan(files) {
  const dir = path.join(tmp, `r${n++}`);
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), text);
  }
  const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  const r = spawnSync(process.execPath, [GATE, '--root', dir, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let json;
  try { json = JSON.parse(r.stdout); } catch { return { status: r.status, findings: null, stderr: r.stderr }; }
  return { status: r.status, findings: json.findings, control: json.control };
}
const hits = (r, rule) => (r.findings || []).filter((f) => f.rule === rule);

function arm(rule, label, files, expectFire) {
  const r = scan(files);
  const h = hits(r, rule);
  check(`${rule}: ${label} ran`, r.findings !== null, r.stderr);
  check(`${rule}: ${label} ${expectFire ? 'fires' : 'is silent'}`, expectFire ? h.length > 0 : h.length === 0, h.map((x) => `${x.path}:${x.line}`));
  if (expectFire && h.length) {
    check(`${rule}: ${label} is advisory`, h.every((f) => f.severity === 'warn'), h.map((f) => f.severity));
    check(`${rule}: ${label} does not block`, r.status === 0, r.status);
  }
  return r;
}

const CASES = [
  {
    rule: 'esm-inline-require',
    bad: { 'package.json': '{"type":"module"}', 'lib/id.js': "export const id = () => require('node:crypto').randomUUID();" },
    good: { 'package.json': '{"type":"module"}', 'lib/id.js': "import { randomUUID } from 'node:crypto';\nexport const id = () => randomUUID();" },
    // .mjs is ESM with no package.json, and a bare builtin name counts.
    mutant: { 'lib/id.mjs': "export const h = () => require('crypto').createHash('sha256');" },
    // A CommonJS package keeps its require.
    cjs: { 'package.json': '{"type":"commonjs"}', 'lib/id.js': "const id = () => require('node:crypto').randomUUID();\nmodule.exports = { id };" },
    // createRequire is the sanctioned bridge.
    bridge: { 'package.json': '{"type":"module"}', 'lib/id.js': "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const id = () => require('node:crypto').randomUUID();" },
  },
  {
    rule: 'sql-policy-initplan',
    bad: {
      'supabase/migrations/0001_t.sql': 'create table public.t (id bigint primary key, user_id uuid);\nalter table public.t enable row level security;\ngrant select on public.t to authenticated;\ncreate policy own on public.t for select to authenticated using (auth.uid() = user_id);',
    },
    good: {
      'supabase/migrations/0001_t.sql': 'create table public.t (id bigint primary key, user_id uuid);\nalter table public.t enable row level security;\ngrant select on public.t to authenticated;\ncreate policy own on public.t for select to authenticated using ((select auth.uid()) = user_id);',
    },
    mutant: {
      'supabase/migrations/0001_t.sql': 'create table public.t (id bigint primary key, user_id uuid);\nalter table public.t enable row level security;\ngrant select on public.t to authenticated;\ncreate policy own on public.t for select to authenticated using (public.is_admin(auth.uid()));',
    },
    // A later migration that rewrites the policy supersedes the earlier one.
    superseded: {
      'supabase/migrations/0001_t.sql': 'create table public.t (id bigint primary key, user_id uuid);\nalter table public.t enable row level security;\ngrant select on public.t to authenticated;\ncreate policy own on public.t for select to authenticated using (auth.uid() = user_id);',
      'supabase/migrations/0002_fix.sql': 'drop policy own on public.t;\ncreate policy own on public.t for select to authenticated using ((select auth.uid()) = user_id);',
    },
  },
  {
    rule: 'sql-fk-unindexed',
    bad: {
      'supabase/migrations/0001_fk.sql': 'create table public.p (id bigint primary key);\ncreate table public.c (id bigint primary key, p_id bigint references public.p(id));\nalter table public.p enable row level security;\nalter table public.c enable row level security;\ngrant select on public.p, public.c to authenticated;',
    },
    good: {
      'supabase/migrations/0001_fk.sql': 'create table public.p (id bigint primary key);\ncreate table public.c (id bigint primary key, p_id bigint references public.p(id));\ncreate index c_p_idx on public.c (p_id);\nalter table public.p enable row level security;\nalter table public.c enable row level security;\ngrant select on public.p, public.c to authenticated;',
    },
    // An index whose leading column is another column does not cover the FK.
    mutant: {
      'supabase/migrations/0001_fk.sql': 'create table public.p (id bigint primary key);\ncreate table public.c (id bigint primary key, p_id bigint references public.p(id), note text);\ncreate index c_note_p_idx on public.c (note, p_id);\nalter table public.p enable row level security;\nalter table public.c enable row level security;\ngrant select on public.p, public.c to authenticated;',
    },
    // A primary key or unique on the FK column is already an index.
    pk: {
      'supabase/migrations/0001_fk.sql': 'create table public.p (id bigint primary key);\ncreate table public.c (p_id bigint primary key references public.p(id));\nalter table public.p enable row level security;\nalter table public.c enable row level security;\ngrant select on public.p, public.c to authenticated;',
    },
  },
  {
    rule: 'admin-no-role-check',
    bad: { 'app/admin/page.tsx': "export default async function A() { const { data } = await supabase.auth.getUser(); return data.user ? 'ok' : null; }" },
    good: { 'app/admin/page.tsx': "export default async function A() { const { data } = await supabase.auth.getUser(); if (!isAdminEmail(data.user?.email)) notFound(); return 'ok'; }" },
    // An operator page outside any admin directory is still an entry.
    mutant: { 'app/debug/page.tsx': "export default async function D() { const rows = await load(); return rows.length; }" },
    // A layout that gates the tree covers the pages under it.
    layout: {
      'app/admin/layout.tsx': "export default async function L({ children }) { if (!(await requireAdmin())) notFound(); return children; }",
      'app/admin/page.tsx': "export default async function A() { return 'ok'; }",
    },
    // A layout with no check does not cover the tree, and is itself reported.
    openLayout: {
      'app/admin/layout.tsx': "export default function L({ children }) { return children; }",
      'app/admin/page.tsx': "export default async function A() { return 'ok'; }",
    },
  },
  {
    rule: 'select-star',
    bad: { 'src/db.ts': "export const all = () => supabase.from('t').select('*');" },
    good: { 'src/db.ts': "export const all = () => supabase.from('t').select('id, name');" },
    mutant: { 'src/db.ts': "export const all = () => supabase.from('t').select('*').eq('a', 1);" },
    // A head-only count never reads rows.
    head: { 'src/db.ts': "export const n = () => supabase.from('t').select('*', { count: 'exact', head: true });" },
  },
  {
    rule: 'cron-fetch-no-timeout',
    bad: { 'app/api/cron/tick/route.ts': "export async function GET() { await fetch('https://example.com/x'); return Response.json({}); }" },
    good: { 'app/api/cron/tick/route.ts': "export async function GET() { await fetch('https://example.com/x', { signal: AbortSignal.timeout(5000) }); return Response.json({}); }" },
    // A cron-named helper outside a cron directory is in scope.
    mutant: { 'lib/nightly-cron.ts': "export async function run() { return fetch('https://example.com/x'); }" },
    // A fetch in an ordinary route is out of scope for this rule.
    scope: { 'app/api/items/route.ts': "export async function GET() { await fetch('https://example.com/x'); return Response.json({}); }" },
  },
  {
    rule: 'backup-unbounded-read',
    bad: { 'app/api/backup/route.ts': "export async function GET() { const { data } = await sb.from('scans').select('id, code'); return Response.json(data); }" },
    good: { 'app/api/backup/route.ts': "export async function GET() { const { data } = await sb.from('scans').select('id, code').range(0, 999); return Response.json(data); }" },
    mutant: { 'scripts/export-all.mjs': "const { data } = await sb.from('events').select('id');\nconsole.log(data.length);" },
    // An ordinary route may read a table unranged: out of scope here.
    scope: { 'app/api/items/route.ts': "export async function GET() { const { data } = await sb.from('scans').select('id, code'); return Response.json(data); }" },
  },
  {
    rule: 'uncached-stripe-list',
    bad: { 'lib/revenue.ts': "export const charges = () => stripe.charges.list({ limit: 100 });" },
    good: { 'lib/revenue.ts': "export const charges = () => cachedRead('charges', 900, () => stripe.charges.list({ limit: 100 }));" },
    // The REST helper form that wraps fetch, in a lib file.
    mutant: { 'lib/revenue.ts': "export const prices = () => stripeApi('prices?limit=100');" },
    // A retrieve by id is a single object, not a list.
    scope: { 'lib/revenue.ts': "export const one = (id: string) => stripe.charges.retrieve(id);" },
  },
];

for (const c of CASES) {
  arm(c.rule, 'bad', c.bad, true);
  arm(c.rule, 'good', c.good, false);
  if (c.mutant) arm(c.rule, 'mutant', c.mutant, true);
  for (const k of ['cjs', 'bridge', 'superseded', 'pk', 'layout', 'head', 'scope']) {
    if (c[k]) arm(c.rule, k, c[k], false);
  }
  if (c.openLayout) arm(c.rule, 'openLayout', c.openLayout, true);
}

// The control runs on every invocation and must still hold with the new rules.
const ctl = scan({ 'README.md': 'x' });
check('control: every rule fires on the planted sample', ctl.control && ctl.control.ok === true && ctl.control.fired === ctl.control.total, ctl.control);

fs.rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(`FAIL  ${failures.length} of ${passed + failures.length} assertions\n  - ${failures.join('\n  - ')}`);
  process.exitCode = 1;
} else {
  console.log(`PASS  ${passed} assertions: eight learned rules, bad, good, mutant and scope arms through the CLI.`);
}
