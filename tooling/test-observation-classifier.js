#!/usr/bin/env node
// Tests for plugins/autodev-memory/scripts/observation-classifier.js — the PostToolUse observation
// classifier. Pure logic, NO database, auto-discovered by tooling/test-all.js.
// Asserts the module's ACTUAL contract (verified against the source), so a
// change in classification behavior fails these tests.
// Run: node tooling/test-observation-classifier.js

const { classifyObservation, VALID_TYPES } = require('../plugins/autodev-memory/scripts/observation-classifier');

const cases = [];
const eq = (label, actual, expected) =>
  cases.push([`${label} (got ${JSON.stringify(actual)})`, actual === expected]);
const truthy = (label, v) => cases.push([label, !!v]);

// --- classifyObservation: Write ---
// Write with a neutral prompt defaults to the 'feature' type and a
// "Created <file>" title; the file path is captured in sourceFiles.
{
  const o = classifyObservation('Write', { file_path: 'x.js' }, '', '');
  truthy('Write: returns an observation', o);
  eq('Write: default type is feature', o.type, 'feature');
  eq('Write: title is "Created x.js"', o.title, 'Created x.js');
  eq('Write: sourceFiles captures the path', JSON.stringify(o.sourceFiles), JSON.stringify(['x.js']));
}
// A prompt keyword overrides the default type via detectType.
{
  const o = classifyObservation('Write', { file_path: 'x.js' }, '', 'please fix the bug');
  eq('Write: "fix" prompt classifies as bugfix', o.type, 'bugfix');
}

// --- classifyObservation: Edit ---
// Edit with a neutral prompt defaults to the 'change' type ("Modified <file>").
{
  const o = classifyObservation('Edit', { file_path: 'x.js', old_string: 'a', new_string: 'b' }, '', '');
  eq('Edit: default type is change', o.type, 'change');
  eq('Edit: title is "Modified x.js"', o.title, 'Modified x.js');
}
// A "refactor" prompt yields the refactor type + "Refactored" verb.
{
  const o = classifyObservation('Edit', { file_path: 'x.js' }, '', 'refactor this module');
  eq('Edit: "refactor" prompt classifies as refactor', o.type, 'refactor');
  eq('Edit: refactor verb in title', o.title, 'Refactored x.js');
}

// --- classifyObservation: Bash ---
// NOTE (actual contract): a git commit is typed 'change', NOT 'decision'.
{
  const o = classifyObservation('Bash', { command: 'git commit -m "x"' }, '', '');
  eq('Bash git commit: type is change', o.type, 'change');
  truthy('Bash git commit: title starts with "Git:"', o.title.startsWith('Git:'));
}
// A test command is typed 'discovery'; pass/fail is read from the result text.
{
  const pass = classifyObservation('Bash', { command: 'npm test' }, 'all good', '');
  eq('Bash test (passing): type is discovery', pass.type, 'discovery');
  truthy('Bash test (passing): title says passed', pass.title.includes('passed'));
  const fail = classifyObservation('Bash', { command: 'npm test' }, '1 FAIL', '');
  eq('Bash test (failing): type is discovery', fail.type, 'discovery');
  truthy('Bash test (failing): title says FAILED', fail.title.includes('FAILED'));
}
// NOTE (actual contract): a package install is typed 'change' (title "Dependency:").
{
  const o = classifyObservation('Bash', { command: 'npm install lodash' }, '', '');
  eq('Bash install: type is change', o.type, 'change');
  truthy('Bash install: title starts with "Dependency:"', o.title.startsWith('Dependency:'));
}
// NOTE (actual contract): a build/deploy command is typed 'change' (title "Build/Deploy:").
{
  const o = classifyObservation('Bash', { command: 'docker build .' }, '', '');
  eq('Bash build: type is change', o.type, 'change');
  truthy('Bash build: title starts with "Build/Deploy:"', o.title.startsWith('Build/Deploy:'));
}
// Trivial commands are skipped (null).
eq('Bash trivial "ls": null', classifyObservation('Bash', { command: 'ls -la' }, '', ''), null);
eq('Bash trivial "cd": null', classifyObservation('Bash', { command: 'cd /tmp' }, '', ''), null);

// --- classifyObservation: Read ---
// A significant source read is typed 'discovery'; an insignificant one is skipped.
{
  const o = classifyObservation('Read', { file_path: 'src/app.js' }, '', '');
  eq('Read significant .js: type is discovery', o.type, 'discovery');
  eq('Read significant .js: title is "Read app.js"', o.title, 'Read app.js');
}
eq('Read package-lock.json: null (skip)',
  classifyObservation('Read', { file_path: 'package-lock.json' }, '', ''), null);
eq('Read extensionless (Makefile): null (skip)',
  classifyObservation('Read', { file_path: 'Makefile' }, '', ''), null);

// A skip-pattern file read is skipped (null), even with a significant extension.
eq('Read tsconfig.json: null (skip-pattern)',
  classifyObservation('Read', { file_path: 'tsconfig.json' }, '', ''), null);
eq('Read .env: null (skip-pattern)',
  classifyObservation('Read', { file_path: '.env' }, '', ''), null);

// --- classifyObservation: Grep ---
// Grep is always captured as a 'discovery'; the path (when given) is a sourceFile.
{
  const o = classifyObservation('Grep', { pattern: 'TODO', path: 'src' }, '', '');
  truthy('Grep: returns an observation', o);
  eq('Grep: type is discovery', o.type, 'discovery');
  truthy('Grep: title references the pattern', o.title.includes('TODO'));
  eq('Grep: path captured in sourceFiles', JSON.stringify(o.sourceFiles), JSON.stringify(['src']));
}
// Grep without a path yields empty sourceFiles.
{
  const o = classifyObservation('Grep', { pattern: 'foo' }, '', '');
  eq('Grep (no path): sourceFiles empty', JSON.stringify(o.sourceFiles), JSON.stringify([]));
}

// --- classifyObservation: Bash "Other significant" (>20 chars, no keyword) ---
// A non-trivial command with no test/git/install/build keyword and length > 20
// falls through to the generic 'discovery' capture ("Ran: <cmd>").
{
  const o = classifyObservation('Bash', { command: 'find . -name "*.config.js"' }, '', '');
  truthy('Bash other-significant: returns an observation', o);
  eq('Bash other-significant: type is discovery', o.type, 'discovery');
  truthy('Bash other-significant: title starts with "Ran:"', o.title.startsWith('Ran:'));
}
// A short (<=20 char) non-trivial command is skipped.
eq('Bash short non-trivial "make all": null',
  classifyObservation('Bash', { command: 'make all' }, '', ''), null);

// --- classifyObservation: Glob is always skipped; unknown tools skipped ---
eq('Glob: null', classifyObservation('Glob', { pattern: '**/*.js' }, '', ''), null);
eq('missing toolName: null', classifyObservation('', {}, '', ''), null);
eq('unknown tool: null', classifyObservation('NotARealTool', {}, '', ''), null);

// --- detectType keyword mapping (exercised via Write's prompt-driven type) ---
// Keywords are checked in order bugfix → refactor → feature → discovery → decision;
// first match wins. Use single-keyword prompts to avoid overlap.
const detect = (prompt) => classifyObservation('Write', { file_path: 'x.js' }, '', prompt).type;
eq('detectType: "bug" → bugfix', detect('there is a bug here'), 'bugfix');
eq('detectType: "refactor" → refactor', detect('refactor the parser'), 'refactor');
eq('detectType: "add" → feature', detect('add a new endpoint'), 'feature');
eq('detectType: "investigate" → discovery', detect('investigate the slowdown'), 'discovery');
eq('detectType: "choose" → decision', detect('choose the database'), 'decision');
eq('detectType: no keyword → Write fallback feature', detect('just some neutral words'), 'feature');

// --- extractConcept truncation cap (200 chars) ---
{
  const long = 'z'.repeat(300);
  const o = classifyObservation('Write', { file_path: 'x.js' }, '', long);
  eq('extractConcept: caps concept at 200 chars', o.concept.length, 200);
}
// A short/empty prompt falls back to the provided default (not the prompt).
{
  const o = classifyObservation('Write', { file_path: 'x.js' }, '', '');
  eq('extractConcept: empty prompt uses fallback', o.concept, 'New file: x.js');
}

// --- VALID_TYPES matches the set the DB accepts (memory-db saveObservation) ---
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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
