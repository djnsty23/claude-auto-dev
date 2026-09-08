#!/usr/bin/env node
// Tests for plugins/autodev-memory/scripts/observation-classifier.js — the
// PostToolUse observation classifier. Pure logic, no database, auto-discovered
// by tooling/test-all.js.
//
// Rewritten 2026-09-08 with the classifier. The old contract (Bash commands as
// `Ran:` discoveries, type from a prompt keyword, concept = the prompt) was
// measured in docs/evidence-memory-recall-2026-09-08.md and dropped. Every case
// here asserts the NEW contract, and the controls at the top establish that a
// real project write IS still recorded — a classifier that returns null for
// everything would pass the exclusion cases and fail those.
// Run: node tooling/test-observation-classifier.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyObservation, isProjectFile, VALID_TYPES } =
  require('../plugins/autodev-memory/scripts/observation-classifier');

const cases = [];
const eq = (label, actual, expected) =>
  cases.push([`${label} (got ${JSON.stringify(actual)})`, actual === expected]);
const truthy = (label, v) => cases.push([label, !!v]);

// A real project directory, so the inside/outside decision runs on real paths
// (realpath is applied to both sides; a /var vs /private/var mismatch on macOS
// would otherwise make every file look outside the project).
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-cls-'));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-cls-out-'));
fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true });
const inProj = (rel) => path.join(PROJ, rel);
const ctx = { cwd: PROJ };
const DISTINCT_PROMPT = 'zebra-lantern-prompt-token';

// --- CONTROLS: a project write is recorded ---
{
  const o = classifyObservation('Write', { file_path: inProj('src/app.js') }, '', ctx);
  truthy('control: Write inside the project returns an observation', o);
  eq('control: Write type is change', o && o.type, 'change');
  eq('control: Write title is "Created app.js"', o && o.title, 'Created app.js');
  eq('control: Write concept names the project-relative path', o && o.concept, 'New file: src/app.js');
  eq('control: Write sourceFiles keeps the absolute path',
    o && JSON.stringify(o.sourceFiles), JSON.stringify([inProj('src/app.js')]));
}
{
  const o = classifyObservation('Edit', { file_path: inProj('src/app.js'), old_string: 'a', new_string: 'b' }, '', ctx);
  truthy('control: Edit inside the project returns an observation', o);
  eq('control: Edit type is change', o && o.type, 'change');
  eq('control: Edit title is "Modified app.js"', o && o.title, 'Modified app.js');
  eq('control: Edit concept is the edit itself', o && o.concept, 'a → b');
}
// A relative path cannot be placed, so it is taken as project-relative.
{
  const o = classifyObservation('Write', { file_path: 'x.js' }, '', ctx);
  truthy('relative path: recorded', o);
  eq('relative path: concept shows the path as given', o && o.concept, 'New file: x.js');
}
// With no cwd at all, only the fragment exclusions apply.
truthy('no cwd: a plain path is recorded',
  classifyObservation('Write', { file_path: '/somewhere/else/x.js' }, '', undefined));

// --- The prompt no longer shapes anything ---
// The fourth argument used to be the prompt. A string there is ignored, an
// object carries the cwd. Both forms assert that the prompt's words reach
// neither the type nor the concept.
{
  const o = classifyObservation('Write', { file_path: inProj('src/x.js') }, '', `please fix the bug ${DISTINCT_PROMPT}`);
  truthy('legacy string 4th arg: still recorded', o);
  eq('legacy string 4th arg: "fix" does NOT make it a bugfix', o && o.type, 'change');
  truthy('legacy string 4th arg: the prompt is not the concept', o && !o.concept.includes(DISTINCT_PROMPT));
}
{
  const o = classifyObservation('Edit', { file_path: inProj('src/x.js'), old_string: 'q', new_string: 'r' }, '', { cwd: PROJ, prompt: DISTINCT_PROMPT });
  eq('object 4th arg: "refactor"-free type is change', o && o.type, 'change');
  truthy('object 4th arg: a prompt field is ignored', o && !o.concept.includes(DISTINCT_PROMPT));
}
{
  const o = classifyObservation('Edit', { file_path: inProj('src/x.js') }, '', ctx);
  eq('Edit with no strings: concept falls back to the path', o && o.concept, 'Edited src/x.js');
}
{
  const long = 'z'.repeat(300);
  const o = classifyObservation('Edit', { file_path: inProj('src/x.js'), old_string: long, new_string: long }, '', ctx);
  eq('Edit concept caps each side at 80 chars', o && o.concept.length, 80 + 3 + 80);
}

// --- Writes that must NOT become rows ---
eq('outside the project: null',
  classifyObservation('Write', { file_path: path.join(OUTSIDE, 'x.js') }, '', ctx), null);
eq('under a scratchpad: null',
  classifyObservation('Write', { file_path: inProj('scratchpad/x.js') }, '', ctx), null);
eq('under .claude/probe: null',
  classifyObservation('Write', { file_path: inProj('.claude/probe/x.js') }, '', ctx), null);
eq('a memory file under ~/.claude/projects: null',
  classifyObservation('Write', { file_path: '/home/u/.claude/projects/-home-u-proj/memory/note.md' }, '', undefined), null);
eq('Edit outside the project: null',
  classifyObservation('Edit', { file_path: path.join(OUTSIDE, 'x.js'), old_string: 'a', new_string: 'b' }, '', ctx), null);
eq('Write with no path: null', classifyObservation('Write', {}, '', ctx), null);

// --- Every other tool is null, including the shapes the old classifier kept ---
for (const [label, name, input, result] of [
  ['Bash test run', 'Bash', { command: 'npm test' }, 'all good'],
  ['Bash failing test run', 'Bash', { command: 'npm test' }, '1 FAIL'],
  ['Bash git commit', 'Bash', { command: 'git commit -m "x"' }, ''],
  ['Bash npm install', 'Bash', { command: 'npm install lodash' }, ''],
  ['Bash docker build', 'Bash', { command: 'docker build .' }, ''],
  ['Bash long find', 'Bash', { command: 'find . -name "*.config.js"' }, ''],
  ['Bash trivial ls', 'Bash', { command: 'ls -la' }, ''],
  ['Read of a source file', 'Read', { file_path: inProj('src/app.js') }, 'contents'],
  ['Grep', 'Grep', { pattern: 'TODO', path: 'src' }, ''],
  ['Glob', 'Glob', { pattern: '**/*.js' }, ''],
  ['unknown tool', 'NotARealTool', {}, ''],
]) {
  eq(`${label}: null`, classifyObservation(name, input, result, ctx), null);
}
eq('missing toolName: null', classifyObservation('', {}, '', ctx), null);

// --- isProjectFile directly, so a future caller has a contract to lean on ---
eq('isProjectFile: inside', isProjectFile(inProj('src/a.js'), PROJ), true);
eq('isProjectFile: the project root itself', isProjectFile(PROJ, PROJ), true);
eq('isProjectFile: sibling dir sharing a prefix is outside',
  isProjectFile(PROJ + '-sibling/a.js', PROJ), false);
eq('isProjectFile: empty path', isProjectFile('', PROJ), false);
eq('isProjectFile: backslash path with an excluded fragment',
  isProjectFile('C:\\u\\proj\\scratchpad\\x.js', undefined), false);

// --- VALID_TYPES still matches the set the DB accepts (memory-db saveObservation) ---
{
  const dbAccepted = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'];
  eq('VALID_TYPES matches DB-accepted set',
    JSON.stringify([...VALID_TYPES].sort()), JSON.stringify([...dbAccepted].sort()));
}

// --- Report ---
let pass = 0, fail = 0;
cases.forEach(([label, ok]) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
  ok ? pass++ : fail++;
});
try { fs.rmSync(PROJ, { recursive: true, force: true }); fs.rmSync(OUTSIDE, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
