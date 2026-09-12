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

const { dependencyProblems, VALID, storiesOf } = require('./prd-states.js');
const { readRequirements } = require('./prd-requirements.js');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log('Usage: node check-spec-output.js [--existing] [prd.json] [schema.sql]'); process.exit(0); }
const existing = args[0] === '--existing';
if (existing) args.shift();
if (args.length > 2 || args.some(arg => arg.startsWith('--'))) { console.error('check-spec-output: usage: [--existing] [prd.json] [schema.sql]'); process.exit(1); }
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

const TYPES = new Set(['fix', 'feature', 'refactor', 'qa', 'perf']);
const seen = new Set();

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

  // passes must be null: a freshly planned story cannot already be done, and
  // `false`/`"deferred"` are decisions nobody has made yet.
  if (!existing && s.passes !== null) note(id, `passes is ${JSON.stringify(s.passes)}; a newly planned story must be null`);
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
  + (sqlPath ? `, ${tables} tables in ${path.basename(sqlPath)} (${rlsOn} with RLS)` : ', no schema given'));

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('plan structure checks passed' + (tables ? '; RLS and policy declarations found for each table' : '; schema not checked')
  + '. Acceptance behavior and database access still require execution.');
