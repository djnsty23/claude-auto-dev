#!/usr/bin/env node
// Suite for analyze-skill-invocations.js.
//
// Fully hermetic. The script takes --dir and --plugins, so the whole thing runs
// against a fixture transcript tree and a fixture plugin tree rather than this
// machine's real ~/.claude/projects. A suite that read the real one would report
// a different number every day and would be measuring the operator's habits
// instead of this code.
//
// The case that matters most is the one that was live for an hour before it was
// caught: a version reading only the `"skill"` field reported that ONE of this
// plugin's skills had ever been invoked. Three others had been invoked seventeen,
// eleven and three times, as slash commands, in a `<command-name>` block the
// probe never looked at. It was confident and tenfold wrong.
//
// So the fixtures deliberately put a skill in ONLY the command channel, and
// assert it is counted. A probe that regresses to one channel fails here.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'analyze-skill-invocations.js');
let pass = 0, fail = 0;

const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillinv-'));
const projects = path.join(root, 'projects');
const plugins = path.join(root, 'plugins');

/** A fixture skill. `invocable` false writes the frontmatter that opts out. */
const skill = (plugin, name, invocable) => {
  const d = path.join(plugins, plugin, 'skills', name);
  fs.mkdirSync(d, { recursive: true });
  const fm = ['---', 'name: ' + name, 'description: fixture'];
  if (!invocable) fm.push('user-invocable: false');
  fm.push('---', '', '# ' + name, '',
    'Prose below the frontmatter mentioning user-invocable: false must NOT count.');
  fs.writeFileSync(path.join(d, 'SKILL.md'), fm.join('\n'), 'utf8');
};

skill('fixture-core', 'typed-only', true);    // reached ONLY by slash command
skill('fixture-core', 'model-only', true);    // reached ONLY by the Skill tool
skill('fixture-core', 'never-fired', true);   // reached by neither
skill('fixture-core', 'also-never', true);
skill('fixture-core', 'rule-auto', false);    // auto-loaded, not user-invocable

const transcript = (name, lines) => {
  const d = path.join(projects, 'proj-a');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), lines.join('\n') + '\n', 'utf8');
};

transcript('a.jsonl', [
  JSON.stringify({ type: 'x', skill: 'model-only' }),
  JSON.stringify({ type: 'x', skill: 'fixture-core:rule-auto' }),
  JSON.stringify({ type: 'x', skill: 'artifact-design' }),
  '<command-name>/fixture-core:typed-only</command-name>',
  '<command-name>/typed-only</command-name>',
  '<command-name>/compact</command-name>',
]);

const run = (extra) => spawnSync(process.execPath,
  [SCRIPT, '--dir', projects, '--plugins', plugins].concat(extra || []),
  { encoding: 'utf8' });

// ---------------------------------------------------------------------------
// 1. the selftest table
// ---------------------------------------------------------------------------
const st = spawnSync(process.execPath, [SCRIPT, '--selftest'], { encoding: 'utf8' });
check('selftest exits 0', st.status === 0, 'exit ' + st.status);
check('selftest reports its case count', /\d+ cases, 0 failed/.test(st.stdout || ''));
check('selftest covers the command channel',
  /extracts a plugin-qualified slash command/.test(st.stdout || ''));
check('selftest refuses a regex literal as a command',
  /refuses a regex literal masquerading as a command/.test(st.stdout || ''));

// ---------------------------------------------------------------------------
// 2. BOTH channels counted. This is the regression that shipped once.
// ---------------------------------------------------------------------------
const r = run(['--json']);
let j = null;
try { j = JSON.parse(r.stdout || '{}'); } catch (e) { /* asserted below */ }
check('the run produces parseable json', j !== null, (r.stdout || '').slice(0, 200));

if (j) {
  check('a skill reached ONLY by slash command is counted as fired',
    (j.firedInvocable || []).indexOf('typed-only') >= 0, JSON.stringify(j.firedInvocable));
  check('a skill reached ONLY by the Skill tool is counted as fired',
    (j.firedInvocable || []).indexOf('model-only') >= 0, JSON.stringify(j.firedInvocable));
  check('the two channels are attributed separately, not merged',
    (j.firedByUser || []).indexOf('typed-only') >= 0 &&
    (j.firedByModel || []).indexOf('model-only') >= 0 &&
    (j.firedByModel || []).indexOf('typed-only') < 0,
    'model=' + JSON.stringify(j.firedByModel) + ' user=' + JSON.stringify(j.firedByUser));
  check('a plugin-qualified and a bare slash command are the same skill',
    j.typedMine === 2, 'typedMine=' + j.typedMine);

  check('skills reached by neither channel are listed as never-fired',
    (j.never || []).indexOf('never-fired') >= 0 && (j.never || []).indexOf('also-never') >= 0,
    JSON.stringify(j.never));
  check('a fired skill never appears in the never-fired list',
    (j.never || []).indexOf('typed-only') < 0 && (j.never || []).indexOf('model-only') < 0);

  check('an auto-loaded rule-* hit is not counted as a chosen invocation',
    j.mine === 1 && j.auto === 1, 'mine=' + j.mine + ' auto=' + j.auto);
  check('a rule-* skill is not in the user-invocable inventory',
    j.invocable === 4 && j.autoOnly === 1, 'invocable=' + j.invocable + ' autoOnly=' + j.autoOnly);
  check('prose below the frontmatter does not flip a skill to auto-only',
    j.invocable === 4, 'invocable=' + j.invocable);

  check('a skill outside this plugin is attributed as foreign',
    j.foreign === 1, 'foreign=' + j.foreign);
  check('a built-in slash command is attributed as foreign too',
    j.typedForeign === 1, 'typedForeign=' + j.typedForeign);
  check('the population is reported, not just the counts',
    j.transcripts === 1 && j.unreadable === 0, JSON.stringify({ t: j.transcripts, u: j.unreadable }));
}

check('never-fired skills exit 1', r.status === 1, 'exit ' + r.status);

// ---------------------------------------------------------------------------
// 3. a zero total is PROBE BROKEN, never a finding
// ---------------------------------------------------------------------------
const emptyProjects = path.join(root, 'empty');
fs.mkdirSync(path.join(emptyProjects, 'p'), { recursive: true });
fs.writeFileSync(path.join(emptyProjects, 'p', 'e.jsonl'), '{"type":"nothing"}\n', 'utf8');
const zero = spawnSync(process.execPath,
  [SCRIPT, '--dir', emptyProjects, '--plugins', plugins], { encoding: 'utf8' });
check('a zero total says PROBE BROKEN', /PROBE BROKEN/.test(zero.stdout || ''),
  (zero.stdout || '').slice(0, 200));
check('a zero total exits 2, distinct from a finding', zero.status === 2, 'exit ' + zero.status);
check('a zero total refuses to list never-fired skills as the finding',
  !/NEVER FIRED/.test(zero.stdout || ''));

// ---------------------------------------------------------------------------
// 4. an unreadable inventory is COULD NOT CHECK, not an empty one
// ---------------------------------------------------------------------------
const noPlugins = spawnSync(process.execPath,
  [SCRIPT, '--dir', projects, '--plugins', path.join(root, 'no-such-plugins')],
  { encoding: 'utf8' });
check('an unreadable inventory says COULD NOT CHECK',
  /COULD NOT CHECK/.test(noPlugins.stdout || ''), (noPlugins.stdout || '').slice(0, 200));
check('an unreadable inventory exits 2', noPlugins.status === 2, 'exit ' + noPlugins.status);
check('an unreadable inventory refuses to read as a pass',
  /That is not a pass/.test(noPlugins.stdout || ''));

// ---------------------------------------------------------------------------
// 5. the human report states what it scanned and what it does not mean
// ---------------------------------------------------------------------------
const human = run([]);
check('the report prints the population', /population: 1 transcript/.test(human.stdout || ''));
check('the report names both channels', /MODEL chose/.test(human.stdout || '') &&
  /PERSON typed/.test(human.stdout || ''));
check('the report says this is reachability, not quality',
  /REACHABILITY number, not a quality one/.test(human.stdout || ''));

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
