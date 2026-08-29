#!/usr/bin/env node
/**
 * skill-prd-commands — execute the inline commands embedded in SKILL.md.
 *
 * WHY THIS EXISTS. A skill's inline `!`node -e "..."`` string is code that runs
 * on a user's machine, and none of the repo's four coverage questions can see it:
 * check:hooks gates wired hooks, find-orphan-checks finds unrun scripts, and
 * check:functions and check:vacuity both need a .js subject. Seven prd.json
 * classifiers shipped ungated this way; three were wrong and one deleted stories.
 *
 * WHAT IT ASSERTS, and why this shape rather than parsing the output. Judging
 * whether a command counts correctly needs a semantic model of each one's output
 * format, which is brittle and would itself need testing. Blindness does not:
 * add exactly one story in state S to a fixture, re-run, and compare. If the
 * output is byte-identical, nothing in that command depends on the story — it is
 * counted by no bucket and reported by no line. That is the invisible class, and
 * it is the one that deleted data.
 *
 * The differential is the canary and it has INDEPENDENT PROVENANCE: the states
 * are a hardcoded literal here, not read from prd-states.js. If a state is
 * dropped from the library, this file still demands it (rule-gate-integrity §3).
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Hardcoded on purpose. Reading these from prd-states.js would make this gate
 * shrink whenever the library shrinks — the same-source canary defect.
 */
const STATES = [
  { label: 'pending (null)', story: { passes: null } },
  { label: 'FAILED (false)', story: { passes: false } },
  { label: 'deferred', story: { passes: 'deferred' } },
  { label: 'needs-setup', story: { passes: 'needs-setup' } },
  { label: 'no passes key', story: {} },
  { label: 'unrecognised value', story: { passes: 'sideways' } },
];

const BASE = {
  project: 'Fixture',
  sprint: 'S1',
  stories: { 'F-1': { id: 'F-1', title: 'a done story', passes: true } },
  archived: { totalCompleted: 159 },
};

/**
 * Pull node -e commands out of a SKILL.md, in both forms they take here.
 *
 * `!`node -e "..."`` is AUTO-EXECUTED at skill load and its output is injected
 * into the session's context. A wrong count here is read as fact by the agent
 * and by the user, silently, on every invocation.
 *
 * A fenced ```node -e "..."``` is an instruction the agent is told to run. It
 * executes on the user's machine just the same, but some are illustrative and
 * carry ellipses or placeholders rather than being runnable. Those are reported
 * as a third outcome rather than folded into either pass or fail.
 */
function extractCommands(md) {
  const out = [];
  const inline = /!`(node -e [\s\S]*?)`/g;
  let m;
  while ((m = inline.exec(md)) !== null) out.push({ kind: 'auto-executed', command: m[1] });

  for (const block of md.match(/```[\s\S]*?```/g) || []) {
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (t.startsWith('node -e ')) out.push({ kind: 'agent-run', command: t });
    }
  }
  return out;
}

function skillFiles() {
  const found = [];
  const pluginsDir = path.join(ROOT, 'plugins');
  for (const plugin of fs.readdirSync(pluginsDir)) {
    const skills = path.join(pluginsDir, plugin, 'skills');
    if (!fs.existsSync(skills)) continue;
    for (const skill of fs.readdirSync(skills)) {
      const f = path.join(skills, skill, 'SKILL.md');
      if (fs.existsSync(f)) found.push({ plugin, skill, file: f });
    }
  }
  return found;
}

function runIn(dir, command) {
  try {
    return execFileSync('/bin/sh', ['-c', command], {
      cwd: dir, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // A command that throws is still a result: capture it rather than losing it.
    return `__EXITED__ ${e.status}\n${e.stdout || ''}${e.stderr || ''}`;
  }
}

function writeFixture(dir, extraStory) {
  const prd = JSON.parse(JSON.stringify(BASE));
  if (extraStory) prd.stories['F-2'] = { id: 'F-2', title: 'the added story', ...extraStory };
  fs.writeFileSync(path.join(dir, 'prd.json'), JSON.stringify(prd, null, 2));
}

// realpath the tmpdir: on macOS /var/folders and /private/var/folders are the
// same directory, and a command comparing cwd against its own path sees two.
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillprd-'));
const skills = skillFiles();
let commandsFound = 0;
let prdCommands = 0;
const failures = [];

const notRunnable = [];

for (const { plugin, skill, file } of skills) {
  const md = fs.readFileSync(file, 'utf8');
  for (const { kind, command } of extractCommands(md)) {
    commandsFound++;
    if (!/prd\.json|passes/.test(command)) continue;
    prdCommands++;
    const rel = path.relative(ROOT, file);

    writeFixture(tmp, null);
    const base = runIn(tmp, command);

    // A command that cannot run on a valid fixture is illustrative, truncated or
    // broken. It is neither blind nor clean, and calling it either would be a
    // could-not-check wearing a verdict.
    if (base.startsWith('__EXITED__')) {
      notRunnable.push({ plugin, skill, kind, rel });
      continue;
    }

    const blind = [];
    for (const { label, story } of STATES) {
      writeFixture(tmp, story);
      if (runIn(tmp, command) === base) blind.push(label);
    }
    if (blind.length) failures.push({ plugin, skill, kind, blind, rel });
  }
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`population: ${skills.length} SKILL.md scanned, ${commandsFound} inline command(s) found, ` +
            `${prdCommands} of them read prd.json`);

// Population floor (rule-gate-integrity §2): a discovery bug must not pass as a
// clean sweep. These commands exist; finding none means the extractor broke.
if (prdCommands === 0) {
  console.error('FAIL: 0 prd.json commands discovered. That is a broken extractor, not a clean tree.');
  process.exit(1);
}

// Three outcomes, never two. A command that would not run is reported as such
// rather than counted among the clean ones.
if (notRunnable.length) {
  console.log(`NOT RUNNABLE on a valid fixture (illustrative, truncated, or broken) - not checked, not clean:`);
  for (const n of notRunnable) console.log(`  ${n.plugin}/${n.skill} [${n.kind}] ${n.rel}`);
}

// Scope, stated so its absence is not read as coverage: this executes commands.
// A skill that describes its bucketing in PROSE for the agent to implement -
// archive-prd separates stories in a numbered list, not in code - is invisible
// here and needs a suite that drives the skill itself.
console.log('scope: executable commands only. Bucketing described in prose for the agent to');
console.log('       implement is NOT covered by this gate and needs its own suite.');

if (!failures.length) {
  const checked = prdCommands - notRunnable.length;
  console.log(`PASS: all ${checked} runnable prd.json command(s) change output for every one of the ${STATES.length} states.`);
  process.exit(0);
}

for (const f of failures) {
  console.error(`FAIL ${f.plugin}/${f.skill} [${f.kind}] (${f.rel})`);
  console.error(`  output is IDENTICAL whether or not a story exists in: ${f.blind.join(', ')}`);
  console.error('  nothing in this command depends on those stories - they are counted by no bucket.');
}
console.error(`\n${failures.length} of ${prdCommands - notRunnable.length} runnable prd.json command(s) are blind to at least one state.`);
process.exit(1);
