#!/usr/bin/env node
// Suite for check-spec-output.js.
//
// The load-bearing case is not "a good plan passes" — it is that a plausible
// GENERIC plan fails. A validator that green-lights "Auth flow / Dashboard
// layout / Set up the database" is worse than no validator, because it puts a
// tick next to the exact output it exists to catch. Every negative case below
// is paired against a positive one so none of them can be passing merely
// because the checker always fails.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHECK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-spec-output.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specout-'));
let pass = 0, fail = 0;

const check = (label, ok, detail) => {
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};

let seq = 0;
const run = (stories, sql, missingSchema = false) => {
  const dir = path.join(tmp, 'c' + seq++);
  fs.mkdirSync(dir);
  const prd = path.join(dir, 'prd.json');
  fs.writeFileSync(prd, typeof stories === 'string' ? stories : JSON.stringify({ stories }, null, 2));
  const args = [CHECK, prd];
  if (sql !== undefined) {
    const s = path.join(dir, 'schema.sql');
    if (!missingSchema) fs.writeFileSync(s, sql);
    args.push(s);
  }
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};

const good = (over = {}) => ({
  'S1-001': {
    id: 'S1-001', title: 'Log a habit for today from the home screen', priority: 1,
    passes: null, realness: null, type: 'feature', category: 'habits',
    notes: 'Tapping a habit inserts a check-in for today and the streak count increments without a reload.',
    resolution: '', ...over,
  },
});

const GOOD_SQL = `
create table public.habits (id uuid primary key, user_id uuid not null, name text not null);
alter table public.habits enable row level security;
create policy habits_own on public.habits using (auth.uid() = user_id);
`;

console.log('test-check-spec-output');

// ---- the positive control, first: everything valid must pass ----
const ok = run(good(), GOOD_SQL);
check('a specific, checkable plan passes', ok.code === 0, ok.err.trim() || ('exit ' + ok.code));
check('prints the population it read', /1 stories.*1 tables.*1 with RLS/.test(ok.out), ok.out.trim());

// ---- the case this file exists for ----
const generic = run({
  'S1-001': { id: 'S1-001', title: 'Auth flow', priority: 1, passes: null, realness: null, type: 'feature', category: 'auth', notes: 'Users can log in and the session persists correctly.', resolution: '' },
  'S1-002': { id: 'S1-002', title: 'Set up the database', priority: 1, passes: null, realness: null, type: 'feature', category: 'db', notes: 'The database is created and returns rows as expected.', resolution: '' },
  'S1-003': { id: 'S1-003', title: 'Dashboard layout', priority: 2, passes: null, realness: null, type: 'feature', category: 'ui', notes: 'The dashboard displays the main widgets for the user.', resolution: '' },
});
check('a generic layer-named backlog is rejected', generic.code === 1, 'exit ' + generic.code);
check('  and it names every generic story, not just the first',
  ['S1-001', 'S1-002', 'S1-003'].every((id) => generic.err.includes(id)), generic.err.trim());

// ---- one rule per case, each with its own reason to fire ----
const cases = [
  ['a story already marked done is rejected', run(good({ passes: true })), 1],
  ['a malformed id is rejected', run({ 'oops-1': { id: 'oops-1', title: 'Log a habit for today', priority: 1, passes: null, type: 'feature', notes: 'Tapping a habit inserts a check-in and the count increments.' } }), 1],
  ['a key disagreeing with the id is rejected', run({ 'S1-999': { ...good()['S1-001'] } }), 1],
  ['a bad type is rejected', run(good({ type: 'chore' })), 1],
  ['an out-of-range priority is rejected', run(good({ priority: 7 })), 1],
  ['a missing acceptance criterion is rejected', run(good({ notes: '' })), 1],
  ['a too-short acceptance criterion is rejected', run(good({ notes: 'it works' })), 1],
  ['a criterion leaning on vague words is rejected', run(good({ notes: 'The habit feature should be nice and intuitive for people' })), 1],
  // Guards the regression that the positive control caught: the first version
  // required a verb from a fixed list and rejected this very phrasing.
  ['an unusual but concrete verb is allowed', run(good({ notes: 'Archiving a habit hides it from the list and retains its history rows.' })), 0],
  ['a two-word title is rejected', run(good({ title: 'Habit UI' })), 1],
  ['an empty backlog is rejected', run({}), 1],
  ['unparseable prd.json is rejected', run('{ not json'), 1],
  ['a table without RLS is rejected', run(good(), 'create table public.habits (id uuid primary key);'), 1],
  ['RLS with no policy at all is rejected', run(good(),
    'create table public.habits (id uuid primary key);\nalter table public.habits enable row level security;'), 1],
  // …and the paired positives, so none of the above is passing by accident.
  ['priority 0 is allowed', run(good({ priority: 0 })), 0],
  ['type refactor is allowed', run(good({ type: 'refactor' })), 0],
  ['no schema argument is allowed', run(good()), 0],
];
for (const [label, r, want] of cases) check(label, r.code === want, `exit ${r.code}, wanted ${want}`);

// Missing or inert inputs must not earn the same result as the real schema.
const structuralCases = [
  ['missing supplied schema is rejected', run(good(), '', true), /could not read schema/],
  ['empty supplied schema is rejected', run(good(), ''), /no CREATE TABLE/],
  ['comment-only schema is rejected', run(good(), '-- ' + GOOD_SQL.replace(/\n/g, '\n-- ')), /no CREATE TABLE/],
  ['commented security is not executable evidence', run(good(),
    'create table habits (id uuid);\n-- alter table habits enable row level security;\n-- create policy own on habits using (true);'), /habits.*without.*row level security/],
  ['nested block comments cannot enable RLS', run(good(),
    'create table habits (id uuid); /* outer /* nested */ alter table habits enable row level security; create policy own on habits using (true); */'), /habits.*without.*row level security/],
  ['string constants cannot enable RLS', run(good(),
    "create table habits (id uuid, note text default 'alter table habits enable row level security; create policy own on habits using (true);');"), /habits.*without.*row level security/],
  ['dollar strings cannot enable RLS', run(good(),
    'create table habits (id uuid); select $body$alter table habits enable row level security; create policy own on habits using (true);$body$;'), /habits.*without.*row level security/],
  ['each new table needs its own policy declaration', run(good(), GOOD_SQL +
    '\ncreate table entries (id uuid); alter table entries enable row level security;'), /entries.*no policy/],
  ['later disable invalidates earlier enable', run(good(), GOOD_SQL + '\nalter table habits disable row level security;'), /habits.*without.*row level security/],
  ['dropped policy is not evidence', run(good(), GOOD_SQL + '\ndrop policy habits_own on habits;'), /habits.*no policy/],
  ['duplicate IDs across sprints are rejected before flattening', run(JSON.stringify({sprints:[{stories:good()},{stories:good()}]})), /S1-001.*duplicate/],
  ['null story is reported without a stack trace', run({'S1-001':null}), /S1-001.*object/],
  ['non-string title is reported without a stack trace', run(good({title:42})), /S1-001.*title/],
  ['non-string notes are reported without a stack trace', run(good({notes:[]})), /S1-001.*acceptance/],
];
for (const [label, r, reason] of structuralCases) {
  check(label, r.code === 1 && reason.test(r.err) && !/TypeError:|at Object\./.test(r.err), r.err.trim());
}
for (const [label, sql] of [
  ['quoted qualified identifiers', 'create table "public"."habits" (id uuid); alter table "public"."habits" enable row level security; create policy "own policy" on "public"."habits" using (true);'],
  ['mixed-case quoted identifiers', 'create table "Habits" (id uuid); alter table "Habits" enable row level security; create policy own on "Habits" using (true);'],
  ['unquoted names fold to lower case', 'CREATE TABLE HABITS (id uuid); ALTER TABLE habits ENABLE ROW LEVEL SECURITY; CREATE POLICY own ON Habits USING (true);'],
  ['comment delimiters in literal strings remain literals', GOOD_SQL.replace('id uuid primary key', "note text default '-- /* not a comment */', id uuid primary key")],
]) {
  const r = run(good(), sql);
  check(label + ' passes', r.code === 0, r.err.trim());
}
const differentCase = run(good(), 'create table "Habits" (id uuid); alter table habits enable row level security; create policy own on habits using (true);');
check('quoted case mismatch is not the same table', differentCase.code === 1 && /Habits/.test(differentCase.err), differentCase.err);

// Independent review: partial SQL interpretation must refuse unsupported
// lifecycle forms instead of keeping declarations from an earlier table.
for (const [label, sql] of [
  ['multi-action disable', GOOD_SQL + '\nalter table habits add column note text, disable row level security;'],
  ['drop and recreate', GOOD_SQL + '\ndrop table habits; create table habits (id uuid);'],
  ['renamed table', GOOD_SQL + '\nalter table habits rename to entries;'],
  ['drop and recreate schema', GOOD_SQL + '\ndrop schema public cascade; create schema public; create table public.habits (id uuid);'],
  ['move and recreate table', GOOD_SQL + '\nalter table habits set schema archive; create table public.habits (id uuid);'],
  ['rename and drop policy', GOOD_SQL + '\nalter policy habits_own on habits rename to other; drop policy other on habits;'],
]) {
  const r = run(good(), sql);
  check(label + ' requires database verification', r.code === 1 && /needs database verification/.test(r.err), r.err);
}
const mixed = run(JSON.stringify({stories:good(),sprints:[{stories:good()}]}));
check('mixed root and nested stories cannot hide records', mixed.code === 1 && /mixed root/.test(mixed.err), mixed.err);
const special = run('{"sprints":[{"stories":{"__proto__":null,"S1-001":' + JSON.stringify(good()['S1-001']) + '}},{"stories":{"__proto__":null}}]}');
check('special keys cannot disappear while flattening', special.code === 1 && /__proto__: duplicate/.test(special.err) && /__proto__: story must be an object/.test(special.err), special.err);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
