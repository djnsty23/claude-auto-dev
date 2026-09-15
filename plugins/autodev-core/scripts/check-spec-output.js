#!/usr/bin/env node
// Validates what the `spec` skill produced, before anyone builds on it.
//
// A planning skill's failure mode is not crashing — it is emitting confident
// filler. "Auth flow", "Dashboard layout", "Set up the database": each looks
// like a plan, none says what the thing does, and the cost only appears later
// when `auto` works through stories nobody can tell are finished. Every rule
// here exists to make that specific failure loud at generation time.
//
// A SECOND FAILURE, added 2026-09-08: a plan that names an external service and
// plans no human step for it. `[measured 2026-09-07]` a greenfield run's
// SPEC.md said "Supabase holds the members ... Vercel serves the page" and its
// prd.json had zero stories about either. This check passed it. `auto` then hit
// the missing project on its first story, hand-edited `passes: "needs-setup"`
// into prd.json, and wrote the handback into a log file. With `--spec SPEC.md`
// the same plan fails here, at generation time, naming the two services.
//
// HOW THE SPEC RULE IS SHAPED, and why the lexicon below is not the verdict.
// `[measured 2026-09-08]` the lexicon run over that SPEC.md and eight README /
// CLAUDE.md files hit 49 times; read one by one, 35 were services the product
// actually integrates and 14 were mentions — "no Google OAuth", "Slack-style
// preview", "refs purged", "considered later". A gate that FAILED on every
// mention would be wrong one time in three and would be learned around. So:
//
//   - SPEC.md carries a `## External services` section, written by `spec`,
//     listing each service that needs an account, a key, a domain or a payment
//     method — or the single word "none". THAT LIST is the verdict: every item
//     must have a setup story that names it.
//   - The lexicon guards the one failure the list cannot: the section missing
//     altogether while the prose names services. That is the greenfield case,
//     and it fails with the candidates listed for the author to confirm.
//   - A lexicon hit outside the section, when the section exists, is a NOTE.
//     The author saw the section and did not list it; the gate says so once.
//
// Usage: node check-spec-output.js [--existing] [prd.json] [schema.sql] [--spec SPEC.md]
// Exit 1 on any violation.
// Exit 1 on any violation.

const fs = require('fs');
const path = require('path');

const { dependencyProblems, VALID, NEEDS_SETUP, storiesOf } = require('./prd-states.js');
const { readRequirements } = require('./prd-requirements.js');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log('Usage: node check-spec-output.js [--existing] [prd.json] [schema.sql] [--spec SPEC.md]'); process.exit(0); }
// `--spec SPEC.md` may sit anywhere; remove the flag and its value before the
// positional check so it never eats (or is mistaken for) prd.json or schema.sql.
let specPath = null;
const specIdx = args.indexOf('--spec');
if (specIdx >= 0) {
  specPath = args[specIdx + 1];
  if (!specPath || specPath.startsWith('--')) { console.error('check-spec-output: --spec needs a SPEC.md path'); process.exit(1); }
  args.splice(specIdx, 2);
}
const existing = args[0] === '--existing';
if (existing) args.shift();
if (args.length > 2 || args.some(arg => arg.startsWith('--'))) { console.error('check-spec-output: usage: [--existing] [prd.json] [schema.sql] [--spec SPEC.md]'); process.exit(1); }
const prdPath = args[0] || 'prd.json';
const sqlPath = args[1] || null;

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

// `setup` is the type of a story whose whole content is a human act: create the
// account, buy the domain, flip the console toggle. It is born `needs-setup`
// and is the only type allowed to be.
const TYPES = new Set(['fix', 'feature', 'refactor', 'qa', 'perf', 'setup']);

// External services a SPEC.md can name, each of which implies an account, a key,
// a domain, a payment method or an approval that no agent can produce.
//
// DELIBERATELY UNAMBIGUOUS NAMES ONLY. "render", "segment", "neon" and "resend"
// are English words and were left out; a false positive here fails a spec that
// planned nothing wrong, and a gate that cries wolf is one people learn to
// skip. Each entry is a word-boundary regex, case-insensitive. Measured against
// one real SPEC.md and four repos' README/CLAUDE.md before shipping — see
// docs/evidence-needs-setup-2026-09-08.md for the hit list and what each was.
const SERVICES = [
  ['Supabase', /\bsupabase\b/i],
  ['Vercel', /\bvercel\b/i],
  ['Netlify', /\bnetlify\b/i],
  ['Cloudflare', /\bcloudflare\b/i],
  ['Firebase', /\bfirebase\b/i],
  ['Stripe', /\bstripe\b/i],
  ['Paddle', /\bpaddle\b/i],
  ['Lemon Squeezy', /\blemon ?squeezy\b/i],
  ['PayPal', /\bpaypal\b/i],
  ['SendGrid', /\bsendgrid\b/i],
  ['Postmark', /\bpostmark\b/i],
  ['Mailgun', /\bmailgun\b/i],
  ['Twilio', /\btwilio\b/i],
  ['OpenAI', /\bopenai\b/i],
  ['Anthropic', /\banthropic\b/i],
  ['Gemini', /\bgemini\b/i],
  ['Clerk', /\bclerk\b/i],
  ['Auth0', /\bauth0\b/i],
  ['Google OAuth', /\bgoogle (oauth|sign[- ]?in|login)\b/i],
  ['Sign in with Apple', /\b(sign[- ]?in with apple|apple sign[- ]?in)\b/i],
  ['GitHub OAuth', /\bgithub (oauth|sign[- ]?in|login|app)\b/i],
  ['App Store', /\bapp store\b/i],
  ['Play Store', /\b(play store|google play)\b/i],
  ['TestFlight', /\btestflight\b/i],
  ['Sentry', /\bsentry\b/i],
  ['PostHog', /\bposthog\b/i],
  ['Plausible', /\bplausible\.io\b|\bplausible analytics\b/i],
  ['Mixpanel', /\bmixpanel\b/i],
  ['Google Analytics', /\bgoogle analytics\b|\bga4\b/i],
  ['Doppler', /\bdoppler\b/i],
  ['Upstash', /\bupstash\b/i],
  ['PlanetScale', /\bplanetscale\b/i],
  ['Railway', /\brailway\b/i],
  ['Fly.io', /\bfly\.io\b/i],
  ['Heroku', /\bheroku\b/i],
  ['AWS', /\baws\b|\bamazon web services\b/i],
  ['Algolia', /\balgolia\b/i],
  ['Pinecone', /\bpinecone\b/i],
  ['Spotify API', /\bspotify (api|developer|oauth)\b/i],
  ['HubSpot', /\bhubspot\b/i],
  ['Slack', /\bslack\b/i],
  ['Discord', /\bdiscord\b/i],
  ['Mapbox', /\bmapbox\b/i],
  ['Google Maps', /\bgoogle maps\b/i],
  ['Expo EAS', /\bexpo\b|\beas build\b/i],
  ['custom domain', /\bcustom domain\b|\bdns\b|\bregistrar\b/i],
];

/** The body of the first heading matching `re`, up to the next heading. */
function sectionBody(text, re) {
  const m = new RegExp('^(#{1,6})\\s*' + re + '[^\\n]*\\n([\\s\\S]*?)(?=^#{1,6}\\s|(?![\\s\\S]))', 'im').exec(text);
  return m ? { body: m[2], index: m.index, length: m[0].length } : null;
}

/**
 * What a SPEC.md says about external services, in three parts:
 *
 *   declared  the items under `## External services` (empty if it says "none")
 *   hasSection  whether that section exists at all
 *   candidates  lexicon hits in the prose OUTSIDE Non-goals and OUTSIDE the
 *               section itself — what the author may have forgotten to list
 *   excused   lexicon hits found only under Non-goals: a service the spec
 *             decided against ("Posting to Slack (webhook or bot)")
 *
 * A declared item is one bullet line. Its NAME is the text before the first
 * " — ", " - ", ":" or "(", so
 *   "- Supabase — a project, its URL and anon key (https://supabase.com/dashboard)"
 * declares "Supabase".
 */
function findServices(specText) {
  const text = String(specText || '');
  const ng = sectionBody(text, 'non[- ]goals?\\b');
  const sec = sectionBody(text, 'external services?\\b');
  const cut = (t, part) => (part ? t.slice(0, part.index) + t.slice(part.index + part.length) : t);
  let rest = cut(text, sec);
  // Recompute Non-goals on the text with the section removed, so offsets hold.
  const ng2 = sectionBody(rest, 'non[- ]goals?\\b');
  rest = cut(rest, ng2);
  const nonGoals = ng ? ng.body : '';

  const declared = [];
  if (sec) {
    for (const line of sec.body.split('\n')) {
      const m = /^\s*[-*+]\s+(.+?)\s*$/.exec(line);
      if (!m) continue;
      const name = m[1].split(/\s+[—–-]\s+|:|\(/)[0].replace(/[*_`]/g, '').trim();
      if (name && !/^none\b/i.test(name)) declared.push(name);
    }
  }
  const candidates = [];
  const excused = [];
  for (const [name, re] of SERVICES) {
    // "Slack-style", "Stripe-like": a comparison, not an integration.
    const rest2 = rest.replace(new RegExp(re.source + '-(style|like|ish)\\b', 'gi'), '');
    if (re.test(rest2)) {
      if (!declared.some((d) => re.test(d))) candidates.push(name);
    } else if (re.test(nonGoals)) excused.push(name);
  }
  return { hasSection: !!sec, declared, candidates, excused };
}

if (!fs.existsSync(prdPath)) { console.error(`check-spec-output: no ${prdPath}`); process.exit(1); }

let prd;
try { prd = JSON.parse(fs.readFileSync(prdPath, 'utf8')); }
catch (e) { console.error(`check-spec-output: ${prdPath} does not parse — ${e.message}`); process.exit(1); }

// A reader may merge carried stories; a NEW spec must not hide duplicate IDs
// or malformed records behind that merge. Validate raw entries, including
// special object keys, before any reader's later-sprint-wins interpretation.
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
if (!isObject(prd)) { console.error('check-spec-output: prd must be an object'); process.exit(1); }
const containers = [];
if (prd.sprints !== undefined) {
  if (!Array.isArray(prd.sprints)) note('sprints', 'must be an array');
  else for (const sprint of prd.sprints) {
    if (!isObject(sprint)) note('sprint', 'must be an object');
    else if (sprint.stories !== undefined) containers.push(sprint.stories);
  }
}
if (prd.stories !== undefined) {
  if (!existing && containers.length) note('stories', 'mixed root and sprint containers are ambiguous in a new spec');
  containers.push(prd.stories);
}
const rawIds = new Set();
let entries = [];
for (const container of containers) {
  if (!isObject(container)) { note('stories', 'must be an object keyed by story id'); continue; }
  entries.push(...Object.entries(container));
  for (const key of Object.keys(container)) {
    if (!existing && rawIds.has(key)) note(key, 'duplicate id across story containers');
    rawIds.add(key);
  }
}

// Existing PRDs can carry a story forward; grade the same effective record
// the runtime reads. Malformed raw containers above remain errors.
if (existing) entries = Object.entries(storiesOf(prd));

if (!entries.length) { console.error('check-spec-output: zero stories — a spec that plans nothing is not a spec'); process.exit(1); }

const seen = new Set();
const setupStories = [];

for (const [key, s] of entries) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    note(key, 'story must be an object');
    continue;
  }
  const id = s.id || key;
  if (!/^S\d+-\d{3}$/.test(id)) note(id, `id does not match S{sprint}-{nnn}`);
  if (seen.has(id)) note(id, 'duplicate id');
  seen.add(id);
  if (key !== id) note(key, `object key "${key}" disagrees with the story's own id "${id}"`);

  const title = typeof s.title === 'string' ? s.title.trim() : '';
  if (!title) note(id, 'no title');
  else {
    if (GENERIC.some((re) => re.test(title))) note(id, `"${title}" names a layer, not a capability — say what it lets someone do`);
    if (title.split(/\s+/).length < 3) note(id, `"${title}" is too short to be a capability`);
  }

  // passes must be null — a freshly planned story cannot already be done, and
  // `false`/`"deferred"` are decisions nobody has made yet — EXCEPT a setup
  // story, which is born blocked on a person and says so. The two are tied:
  // a needs-setup story that is not type setup is a planned story pretending
  // to be blocked, and a setup story that is null is a human act an agent
  // would pick up and fail at. With --existing a setup story may have moved on
  // (cleared, verified, closed), so only a story still needs-setup must carry
  // its handback.
  const isSetup = s.type === 'setup';
  if (isSetup) setupStories.push([id, s]);
  if (!existing) {
    if (isSetup) {
      if (s.passes !== NEEDS_SETUP) note(id, `type is "setup" but passes is ${JSON.stringify(s.passes)}; a setup story is born "needs-setup"`);
    } else if (s.passes !== null) {
      note(id, `passes is ${JSON.stringify(s.passes)}; a newly planned story must be null`
        + (s.passes === NEEDS_SETUP ? ' (or type "setup" if this is a human step)' : ''));
    }
  }
  if (isSetup && (!existing || s.passes === NEEDS_SETUP)) {
    const reason = typeof s.blockedReason === 'string' ? s.blockedReason.trim() : '';
    if (!reason) note(id, 'a setup story needs blockedReason: what is needed and the exact console URL or path');
    else if (!/https?:\/\/\S+/.test(reason)) note(id, `blockedReason has no URL — say exactly where the person goes (got: "${reason.slice(0, 60)}")`);
  }
  if (existing && s.passes !== undefined && !VALID.includes(s.passes)) note(id, `unrecognised passes state ${JSON.stringify(s.passes)}`);
  if (!TYPES.has(s.type)) note(id, `type ${JSON.stringify(s.type)} is not one of ${[...TYPES].join(', ')}`);
  if (!Number.isInteger(s.priority) || s.priority < 0 || s.priority > 3) note(id, `priority ${JSON.stringify(s.priority)} is not 0-3`);

  // The same reader freezes the worker's contract. Diagnostic notes cannot
  // substitute for explicit acceptance, and malformed verification is not dropped.
  let requirements;
  try { requirements = readRequirements(s, id, path.dirname(path.resolve(prdPath))); }
  catch (e) { note(id, e.message); continue; }
  for (const criterion of requirements.acceptance) {
    const words = criterion.description.split(/\s+/).length;
    if (words < 6) note(id, `acceptance criterion ${criterion.id} is ${words} words; too short to check against`);
    else {
      const VAGUE = /\b(works?|correctly|properly|as expected|appropriately|nice|intuitive|seamless|smooth|robust|user[- ]friendly|good|better|improved|handled|functional|successfully)\b/i;
      const hit = VAGUE.exec(criterion.description);
      if (hit) note(id, `acceptance criterion leans on "${hit[1]}" — say what is observably true instead`);
    }
  }
}
for (const problem of dependencyProblems(prd)) note(problem.id, problem.reason);

// The SPEC's own `## External services` list is the verdict: every declared
// item needs a setup story that names it back, in its title, acceptance,
// notes or blockedReason — so "Create the Supabase project" covers a spec that
// declares "Supabase". The lexicon only catches the section being absent.
const out = [];
let services = null;
if (specPath) {
  let specText;
  try { specText = fs.readFileSync(specPath, 'utf8'); }
  catch { console.error(`check-spec-output: no ${specPath}`); process.exit(1); }
  services = findServices(specText);
  const text = (value) => typeof value === 'string' ? value : '';
  const haystack = setupStories.map(([, s]) => [
    text(s.title), text(s.notes), text(s.blockedReason),
    ...(Array.isArray(s.acceptance) ? s.acceptance.map((a) => typeof a === 'string' ? a : text(a && a.description)) : []),
  ].join('\n'));
  const mentions = (name) => {
    const known = SERVICES.find(([n]) => n.toLowerCase() === name.toLowerCase());
    const re = known ? known[1] : new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return haystack.some((h) => re.test(h));
  };
  const specName = path.basename(specPath);
  if (!services.hasSection) {
    if (services.candidates.length) {
      note('spec', `${specName} has no "## External services" section and names ${services.candidates.join(', ')} — list each one that needs an account, a key, a domain or a payment method (or write "none"), and give each a setup story`);
    } else {
      note('spec', `${specName} has no "## External services" section — add it, even if it says "none"`);
    }
  } else {
    for (const name of services.declared) {
      if (!mentions(name)) {
        note('spec', `${specName} declares ${name} under External services and no setup story (type "setup", passes "needs-setup") mentions it — who creates the account, and where?`);
      }
    }
    for (const name of services.candidates) {
      out.push(`note: ${specName} also names ${name} outside External services; if it needs an account, declare it there`);
    }
  }
  // A setup story with no dependents is legal (a legal page, a store listing)
  // but worth a line: a human step nothing waits on is easy to forget.
  for (const [id] of setupStories) {
    const dependents = entries.filter(([, s]) => s && Array.isArray(s.blockedBy) && s.blockedBy.includes(id)).length;
    if (!dependents) out.push(`note: setup story ${id} has no dependents — nothing is blockedBy it, so make sure that is true`);
  }
}

// This is a structural check of a NEW PostgreSQL schema, not proof that SQL
// executes or policies implement the intended access model. Comments and
// string/function bodies are data, never declarations. Keep quoted identifier
// case; PostgreSQL folds only unquoted names. See sql-syntax-lexical.html in
// the PostgreSQL documentation. No database or credentials are touched here.
function sqlStatements(sql) {
  const statements = [];
  let tokens = [], i = 0;
  const push = (value, quoted = false) => tokens.push({ value, quoted });
  while (i < sql.length) {
    if (/\s/.test(sql[i])) { i++; continue; }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error('unterminated block comment');
      continue;
    }
    const dollar = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      if (end < 0) throw new Error('unterminated dollar string');
      push('<literal>', true);
      i = end + dollar[0].length;
      continue;
    }
    const escapeString = /^[eE]'/.test(sql.slice(i));
    if (sql[i] === "'" || sql[i] === '"' || escapeString) {
      if (escapeString) i++;
      const quote = sql[i++];
      let value = '', closed = false;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { value += quote; i += 2; }
          else { i++; closed = true; break; }
        } else if (escapeString && sql[i] === '\\') { i += 2; }
        else value += sql[i++];
      }
      if (!closed) throw new Error('unterminated quoted token');
      push(quote === '"' ? value : '<literal>', true);
      continue;
    }
    if (sql[i] === ';') { if (tokens.length) statements.push(tokens); tokens = []; i++; continue; }
    const word = /^[\p{L}_][\p{L}\p{N}_$]*/u.exec(sql.slice(i));
    if (word) { push(word[0].toLowerCase()); i += word[0].length; }
    else push(sql[i++]);
  }
  if (tokens.length) statements.push(tokens);
  return statements;
}

function keyword(tokens, index, value) {
  return tokens[index]?.quoted === false && tokens[index].value === value;
}

function tableName(tokens, index) {
  const identifier = t => t && (t.quoted ? t.value !== '<literal>' : /^[\p{L}_][\p{L}\p{N}_$]*$/u.test(t.value));
  if (!identifier(tokens[index])) throw new Error('unrecognised table identifier');
  const first = tokens[index++].value;
  let schema = 'public', name = first;
  if (keyword(tokens, index, '.')) {
    if (!identifier(tokens[index + 1])) throw new Error('unrecognised qualified table identifier');
    schema = first; name = tokens[index + 1].value; index += 2;
  }
  return { key: JSON.stringify([schema, name]), label: schema + '.' + name, index };
}

function schemaDeclarations(sql) {
  const created = new Map(), enabled = new Set(), policies = new Map();
  for (const tokens of sqlStatements(sql)) {
    if (keyword(tokens, 0, 'set') && tokens.some(t => !t.quoted && ['search_path', 'standard_conforming_strings'].includes(t.value))) {
      throw new Error('custom search_path or string parsing needs database verification; use explicit schema names and standard strings in the initial schema');
    }
    if (keyword(tokens, 0, 'create')) {
      let i = 1;
      if (['temporary', 'temp', 'unlogged'].some(k => keyword(tokens, i, k))) i++;
      if (keyword(tokens, i, 'table')) {
        i++;
        if (keyword(tokens, i, 'if') && keyword(tokens, i + 1, 'not') && keyword(tokens, i + 2, 'exists')) i += 3;
        const t = tableName(tokens, i);
        created.set(t.key, t.label);
      } else if (keyword(tokens, 1, 'policy') && keyword(tokens, 3, 'on')) {
        const t = tableName(tokens, 4);
        if (!policies.has(t.key)) policies.set(t.key, new Set());
        policies.get(t.key).add(tokens[2].value);
      }
    } else if (keyword(tokens, 0, 'alter') && keyword(tokens, 1, 'table')) {
      let depth = 0;
      const multiple = tokens.some(t => {
        if (t.quoted) return false;
        if (t.value === '(') depth++;
        if (t.value === ')') depth--;
        return depth === 0 && t.value === ',';
      });
      if (multiple || tokens.some(t => !t.quoted && t.value === 'rename')) {
        throw new Error('multi-action or RENAME ALTER TABLE needs database verification; use one action per statement in the initial schema');
      }
      let i = 2;
      if (keyword(tokens, i, 'if') && keyword(tokens, i + 1, 'exists')) i += 2;
      if (keyword(tokens, i, 'only')) i++;
      const t = tableName(tokens, i);
      i = t.index;
      if (keyword(tokens, i, '*')) i++;
      const action = tokens.slice(i).map(t => t.quoted ? '<identifier>' : t.value).join(' ');
      if (!/^(enable|disable|force|no force) row level security$/.test(action)) {
        throw new Error('ALTER TABLE transformation needs database verification; put columns and constraints in CREATE TABLE in the initial schema');
      }
      if (keyword(tokens, i, 'enable')) enabled.add(t.key);
      if (keyword(tokens, i, 'disable')) enabled.delete(t.key);
    } else if (keyword(tokens, 0, 'alter')) {
      throw new Error('ALTER lifecycle needs database verification; initial schema must not reuse renamed object evidence');
    } else if (keyword(tokens, 0, 'drop') && keyword(tokens, 1, 'policy')) {
      let i = 2;
      if (keyword(tokens, i, 'if') && keyword(tokens, i + 1, 'exists')) i += 2;
      const policy = tokens[i++]?.value;
      if (keyword(tokens, i, 'on')) policies.get(tableName(tokens, i + 1).key)?.delete(policy);
    } else if (keyword(tokens, 0, 'drop')) {
      throw new Error('DROP lifecycle needs database verification; initial schema must not reuse removed object evidence');
    }
  }
  return { created, enabled, policies };
}

let tables = 0, rlsOn = 0;
if (sqlPath) {
  let sql;
  try { sql = fs.readFileSync(sqlPath, 'utf8'); }
  catch { note('schema', 'could not read schema ' + path.basename(sqlPath)); }
  if (sql !== undefined) {
    try {
      const { created, enabled, policies } = schemaDeclarations(sql);
      tables = created.size;
      if (!tables) note('schema', 'no CREATE TABLE declarations read; initial schema was not verified');
      for (const [key, label] of created) {
        if (enabled.has(key)) rlsOn++;
        else note(label, 'table created without "enable row level security"');
        if (!policies.get(key)?.size) note(label, 'no policy declaration remains for this table');
      }
    } catch (e) { note('schema', 'could not inspect schema: ' + e.message); }
  }
}

// Print the population, so "no problems" is distinguishable from "read nothing".
console.log(`check-spec-output: ${entries.length} stories in ${path.basename(prdPath)}`
  + (setupStories.length ? ` (${setupStories.length} setup, blocked on you)` : '')
  + (sqlPath ? `, ${tables} tables in ${path.basename(sqlPath)} (${rlsOn} with RLS)` : ', no schema given')
  + (services
    ? `, ${path.basename(specPath)} declares ${services.declared.length} external service(s)`
      + (services.declared.length ? ` (${services.declared.join(', ')})` : '')
      + (!services.hasSection ? ' [no External services section]' : '')
      + (services.candidates.length ? `, prose also names ${services.candidates.join(', ')}` : '')
      + (services.excused.length ? `, under Non-goals: ${services.excused.join(', ')}` : '')
    : ', no SPEC.md given'));
for (const l of out) console.log(l);

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('plan structure checks passed' + (tables ? '; RLS and policy declarations found for each table' : '; schema not checked')
  + (services ? '; every declared external service has a setup story' : '')
  + '. Acceptance behavior and database access still require execution.');
