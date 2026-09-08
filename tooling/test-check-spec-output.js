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
const run = (stories, sql) => {
  const dir = path.join(tmp, 'c' + seq++);
  fs.mkdirSync(dir);
  const prd = path.join(dir, 'prd.json');
  fs.writeFileSync(prd, typeof stories === 'string' ? stories : JSON.stringify({ stories }, null, 2));
  const args = [CHECK, prd];
  if (sql !== undefined) {
    const s = path.join(dir, 'schema.sql');
    fs.writeFileSync(s, sql);
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

// ---- the setup manifest: SPEC.md's External services vs setup stories ----
//
// [measured 2026-09-07] a greenfield run's SPEC.md named Supabase and Vercel
// and its prd.json planned no human step for either; the gate passed it, and
// `auto` discovered the missing project on story one. The fixture under
// tooling/fixtures/spec/oncall/ is that run's SPEC.md and prd.json exactly as
// committed, so the case below is the incident, not a paraphrase of it.

const FIX = path.resolve(__dirname, 'fixtures', 'spec', 'oncall');
const runSpec = (stories, specText, extraArgs = []) => {
  const dir = path.join(tmp, 'c' + seq++);
  fs.mkdirSync(dir);
  const prd = path.join(dir, 'prd.json');
  fs.writeFileSync(prd, typeof stories === 'string' ? stories : JSON.stringify({ stories }, null, 2));
  const spec = path.join(dir, 'SPEC.md');
  fs.writeFileSync(spec, specText);
  const r = spawnSync(process.execPath, [CHECK, prd, '--spec', spec, ...extraArgs], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};

const setupStory = (over = {}) => ({
  'S1-000': {
    id: 'S1-000', title: 'Create the Supabase project and put its URL and anon key in Vercel', priority: 0,
    passes: 'needs-setup', realness: null, type: 'setup', category: 'setup',
    notes: 'The Vercel project lists NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY and a deploy renders the home page rather than the setup notice.',
    blockedReason: 'Create a project at https://supabase.com/dashboard (about 5 minutes), apply supabase/migrations/0001_init.sql, then paste the URL and anon key into the Vercel project settings.',
    resolution: '', ...over,
  },
});
const withDep = () => ({ ...setupStory(), ...good({ blockedBy: ['S1-000'] }) });
const SPEC_DECLARES = '# Thing\n\n## What it is\n\nSupabase holds the rows. Vercel serves the page.\n\n## Non-goals\n\n- Posting to Slack.\n\n## External services\n\n- Supabase — a project, its URL and anon key (https://supabase.com/dashboard)\n\n## Done means\n\nA row appears.\n';
const SPEC_NONE = '# Thing\n\n## What it is\n\nA local page.\n\n## External services\n\nnone\n\n## Done means\n\nA row appears.\n';
const SPEC_NO_SECTION = '# Thing\n\n## What it is\n\nSupabase holds the rows.\n\n## Done means\n\nA row appears.\n';

// The incident itself, from the committed files.
{
  const r = spawnSync(process.execPath, [CHECK, path.join(FIX, 'prd.fixture.json'), '--spec', path.join(FIX, 'SPEC.md')], { encoding: 'utf8' });
  check('FIXTURE: the greenfield spec that shipped with no setup story is rejected', r.status === 1, 'exit ' + r.status);
  check('  and the rejection names the services the prose mentions',
    /names Supabase, Vercel, Slack/.test(r.stderr), r.stderr.trim());
  check('  and says what to add', /External services/.test(r.stderr) && /setup story/.test(r.stderr));
  check('  and the population line says the section is absent', /\[no External services section\]/.test(r.stdout), r.stdout.trim());
  // Without --spec the same files pass, exactly as they did on 2026-09-07 —
  // the control that shows the new verdict comes from the spec argument.
  const ctl = spawnSync(process.execPath, [CHECK, path.join(FIX, 'prd.fixture.json')], { encoding: 'utf8' });
  check('  CONTROL: the same prd.json without --spec still passes (the old verdict)', ctl.status === 0, ctl.stderr.trim());
}

const specCases = [
  ['a declared service with a matching setup story passes', runSpec(withDep(), SPEC_DECLARES), 0],
  ['a declared service with NO setup story is rejected', runSpec(good(), SPEC_DECLARES), 1],
  ['no section, prose names a service → rejected', runSpec(good(), SPEC_NO_SECTION), 1],
  ['no section, prose names nothing → still rejected (say "none")', runSpec(good(), '# T\n\n## What it is\n\nA page.\n'), 1],
  ['section says "none", prose names nothing → passes', runSpec(good(), SPEC_NONE), 0],
  // A comparison is not an integration, and a mention outside the section is a
  // note, not a verdict: the author wrote the section and did not list it.
  ['"Slack-style preview" with section "none" → passes', runSpec(good(), SPEC_NONE.replace('A local page.', 'A local page with a Slack-style preview.')), 0],
  ['a prose mention outside the section → passes with a note', runSpec(good(), SPEC_NONE.replace('A local page.', 'Nothing posts to Slack.')), 0],
  ['a service named only under Non-goals → excused, passes', runSpec(good(), SPEC_NONE.replace('## External services', '## Non-goals\n\n- Posting to Slack.\n\n## External services')), 0],
  // The setup story's own shape.
  ['a setup story that is passes: null is rejected', runSpec({ ...setupStory({ passes: null }), ...good({ blockedBy: ['S1-000'] }) }, SPEC_DECLARES), 1],
  ['a setup story with no blockedReason is rejected', runSpec({ ...setupStory({ blockedReason: '' }), ...good({ blockedBy: ['S1-000'] }) }, SPEC_DECLARES), 1],
  ['a blockedReason with no URL is rejected', runSpec({ ...setupStory({ blockedReason: 'Create the project in the dashboard and paste the keys into Vercel.' }), ...good({ blockedBy: ['S1-000'] }) }, SPEC_DECLARES), 1],
  ['needs-setup on a non-setup type is rejected', runSpec({ ...setupStory({ type: 'feature' }), ...good({ blockedBy: ['S1-000'] }) }, SPEC_DECLARES), 1],
  ['type "setup" is a valid type', run({ ...setupStory(), ...good({ blockedBy: ['S1-000'] }) }), 0],
  // blockedBy must resolve.
  ['blockedBy naming a story that does not exist is rejected', run(good({ blockedBy: ['S1-999'] })), 1],
  ['blockedBy naming itself is rejected', run(good({ blockedBy: ['S1-001'] })), 1],
  ['blockedBy that is not an array is rejected', run(good({ blockedBy: 'S1-000' })), 1],
  ['an empty blockedBy is allowed', run(good({ blockedBy: [] })), 0],
];
for (const [label, r, want] of specCases) check(label, r.code === want, `exit ${r.code}, wanted ${want}\n${(r.err || r.out).trim()}`);

// The messages, not only the exit codes, so a mutant that rejects for the wrong
// reason is seen.
{
  const r = runSpec(good(), SPEC_DECLARES);
  check('  the declared-but-unplanned message names the service', /declares Supabase under External services and no setup story/.test(r.err), r.err.trim());
  const noted = runSpec(good(), SPEC_NONE.replace('A local page.', 'Nothing posts to Slack.'));
  check('  the prose-mention note names the service', /note: SPEC\.md also names Slack outside External services/.test(noted.out), noted.out.trim());
  const excused = runSpec(good(), SPEC_NONE.replace('## External services', '## Non-goals\n\n- Posting to Slack.\n\n## External services'));
  check('  the Non-goals excuse is reported in the population line', /under Non-goals: Slack/.test(excused.out), excused.out.trim());
  const ok = runSpec(withDep(), SPEC_DECLARES);
  check('  the population line counts setup stories', /1 setup, blocked on you/.test(ok.out) && /declares 1 external service\(s\) \(Supabase\)/.test(ok.out), ok.out.trim());
  check('  a setup story WITH a dependent draws no "no dependents" note', !/no dependents/.test(ok.out), ok.out.trim());
  const lonely = runSpec({ ...setupStory(), ...good() }, SPEC_DECLARES);
  check('  a setup story with NO dependent passes with a note', lonely.code === 0 && /S1-000 has no dependents/.test(lonely.out), lonely.out.trim());
  const hinted = runSpec({ ...setupStory({ type: 'feature' }), ...good({ blockedBy: ['S1-000'] }) }, SPEC_DECLARES);
  check('  needs-setup on a feature hints at type "setup"', /or type "setup" if this is a human step/.test(hinted.err), hinted.err.trim());
}

// Argument order: --spec may come first or last, and never eats a positional.
{
  const dir = path.join(tmp, 'c' + seq++);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'prd.json'), JSON.stringify({ stories: withDep() }, null, 2));
  fs.writeFileSync(path.join(dir, 'schema.sql'), GOOD_SQL);
  fs.writeFileSync(path.join(dir, 'SPEC.md'), SPEC_DECLARES);
  const a = spawnSync(process.execPath, [CHECK, '--spec', 'SPEC.md', 'prd.json', 'schema.sql'], { cwd: dir, encoding: 'utf8' });
  const b = spawnSync(process.execPath, [CHECK, 'prd.json', 'schema.sql', '--spec', 'SPEC.md'], { cwd: dir, encoding: 'utf8' });
  check('--spec first: prd and schema both read', a.status === 0 && /1 tables/.test(a.stdout), (a.stderr || a.stdout).trim());
  check('--spec last: prd and schema both read', b.status === 0 && /1 tables/.test(b.stdout), (b.stderr || b.stdout).trim());
  const missing = spawnSync(process.execPath, [CHECK, 'prd.json', '--spec', 'nope.md'], { cwd: dir, encoding: 'utf8' });
  check('a missing SPEC.md path is an error, not a pass', missing.status === 1 && /no nope\.md/.test(missing.stderr), missing.stderr.trim());
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
