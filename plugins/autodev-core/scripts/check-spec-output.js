#!/usr/bin/env node
// Validates what the `spec` skill produced, before anyone builds on it.
//
// A planning skill's failure mode is not crashing — it is emitting confident
// filler. "Auth flow", "Dashboard layout", "Set up the database": each looks
// like a plan, none says what the thing does, and the cost only appears later
// when `auto` works through stories nobody can tell are finished. Every rule
// here exists to make that specific failure loud at generation time.
//
// Usage: node check-spec-output.js [prd.json] [schema.sql]
// Exit 1 on any violation.

const fs = require('fs');
const path = require('path');

const prdPath = process.argv[2] || 'prd.json';
const sqlPath = process.argv[3] || null;

const problems = [];
const note = (id, msg) => problems.push(`${id}: ${msg}`);

// Titles that describe a LAYER instead of a capability. A plan made of these
// would fit any product ever specified, which is what makes it worthless.
const GENERIC = [
  /^(set ?up|setup|configure|initialise|initialize|scaffold|create|add|build|implement)\s+(the\s+)?(project|app|database|db|schema|backend|frontend|ui|api|auth|authentication|login|dashboard|layout|components?|tests?|ci|deployment)\.?$/i,
  /^(auth|authentication|login|signup) flow$/i,
  /^(dashboard|admin|settings|profile|landing)( page| layout| screen)?$/i,
  /^(error handling|state management|routing|styling|polish|cleanup|refactor)$/i,
  /^(mvp|v1|phase \d+|milestone \d+)/i,
];

if (!fs.existsSync(prdPath)) { console.error(`check-spec-output: no ${prdPath}`); process.exit(1); }

let prd;
try { prd = JSON.parse(fs.readFileSync(prdPath, 'utf8')); }
catch (e) { console.error(`check-spec-output: ${prdPath} does not parse — ${e.message}`); process.exit(1); }

// Stories may sit at the root or inside the newest sprint, same as every other
// reader of this file.
const sprint = Array.isArray(prd.sprints) && prd.sprints.length ? prd.sprints[prd.sprints.length - 1] : null;
const stories = (sprint && sprint.stories) || prd.stories || {};
const entries = Object.entries(stories);

if (!entries.length) { console.error('check-spec-output: zero stories — a spec that plans nothing is not a spec'); process.exit(1); }

const TYPES = new Set(['fix', 'feature', 'refactor', 'qa', 'perf']);
const seen = new Set();

for (const [key, s] of entries) {
  const id = s.id || key;
  if (!/^S\d+-\d{3}$/.test(id)) note(id, `id does not match S{sprint}-{nnn}`);
  if (seen.has(id)) note(id, 'duplicate id');
  seen.add(id);
  if (key !== id) note(key, `object key "${key}" disagrees with the story's own id "${id}"`);

  const title = (s.title || '').trim();
  if (!title) note(id, 'no title');
  else {
    if (GENERIC.some((re) => re.test(title))) note(id, `"${title}" names a layer, not a capability — say what it lets someone do`);
    if (title.split(/\s+/).length < 3) note(id, `"${title}" is too short to be a capability`);
  }

  // passes must be null: a freshly planned story cannot already be done, and
  // `false`/`"deferred"` are decisions nobody has made yet.
  if (s.passes !== null) note(id, `passes is ${JSON.stringify(s.passes)}; a newly planned story must be null`);
  if (!TYPES.has(s.type)) note(id, `type ${JSON.stringify(s.type)} is not one of ${[...TYPES].join(', ')}`);
  if (!Number.isInteger(s.priority) || s.priority < 0 || s.priority > 3) note(id, `priority ${JSON.stringify(s.priority)} is not 0-3`);

  // The acceptance criterion lives in `notes` — the core schema has no dedicated
  // field and inventing one would drift from every other reader of prd.json.
  const notes = (s.notes || '').trim();
  if (!notes) note(id, 'no acceptance criterion in notes');
  else if (notes.split(/\s+/).length < 6) note(id, `acceptance criterion is ${notes.split(/\s+/).length} words; too short to check against`);
  else {
    // Deliberately a DENYLIST of vagueness, not an allowlist of good verbs.
    // The first version of this check required a verb from a list —
    // shows/returns/rejects/persists — and immediately rejected its own
    // reference example, whose criterion said "inserts a check-in" and "the
    // count increments". The set of verbs describing an observable outcome is
    // open; the set of words used to avoid describing one is small and closed.
    const VAGUE = /\b(works?|correctly|properly|as expected|appropriately|nice|intuitive|seamless|smooth|robust|user[- ]friendly|good|better|improved|handled|functional|successfully)\b/i;
    const hit = VAGUE.exec(notes);
    if (hit) note(id, `acceptance criterion leans on "${hit[1]}" — say what is observably true instead`);
  }
}

// Schema: every table must have RLS turned on. Deny-by-default is the house
// rule, and a table created without it is open to every authenticated user.
let tables = 0, rlsOn = 0;
if (sqlPath && fs.existsSync(sqlPath)) {
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const created = [...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?(?:public\.)?([a-z0-9_]+)/gi)].map((m) => m[1]);
  tables = created.length;
  for (const t of created) {
    const re = new RegExp(`alter\\s+table\\s+["\`]?(?:public\\.)?${t}["\`]?\\s+enable\\s+row\\s+level\\s+security`, 'i');
    if (re.test(sql)) rlsOn++;
    else note(t, 'table created without "enable row level security"');
  }
  if (tables && !/create\s+policy/i.test(sql)) note('schema', 'RLS is enabled but no policy is defined — that denies everyone, including the app');
}

// Print the population, so "no problems" is distinguishable from "read nothing".
console.log(`check-spec-output: ${entries.length} stories in ${path.basename(prdPath)}`
  + (sqlPath ? `, ${tables} tables in ${path.basename(sqlPath)} (${rlsOn} with RLS)` : ', no schema given'));

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('all stories are specific, checkable and pending' + (tables ? '; every table has RLS' : ''));
