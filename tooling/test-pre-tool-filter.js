#!/usr/bin/env node
// Tests for hooks/pre-tool-filter.js — write protection + read skipping.
// Run: node tooling/test-pre-tool-filter.js
// Exits 1 on any failure; 0 if all pass.
//
// The Bash denylist cases were deleted with the denylist on 2026-08-17; the
// hook's own header carries the measurement behind that. What replaces them is
// the block below, which asserts Bash is not filtered AT ALL. Those cases exist
// so that re-adding a denylist shows up as a failing test naming the decision,
// rather than as a mystery block six months later.
//
// SINCE 2026-09-02 A DIFFERENT HOOK DOES MATCH Bash: coordinator-write-guard.js,
// tested by tooling/test-coordinator-write-guard.js. It is not a denylist —
// it is inert unless a Brain role file exists, and it refuses exactly two
// subcommands writing outside that file's declared home repos. The cases below
// still hold for THIS hook and still mean what they say; noted here so a reader
// who finds a blocked Bash call does not conclude the 2026-08-17 decision was
// quietly reversed.

const { spawnSync } = require('child_process');
const path = require('path');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'pre-tool-filter.js');

function run(toolName, toolInput) {
  const input = JSON.stringify({ tool_name: toolName, tool_input: toolInput });
  const r = spawnSync('node', [HOOK], { input, encoding: 'utf8' });
  return { exitCode: r.status, stderr: r.stderr || '' };
}

const cases = [
  // [label, tool, input, expectedExit]

  // ---- Bash is not this hook's business any more ----
  //
  // Each of these was blocked before 2026-08-17. The first four are the measured
  // false positives: read-only inspection, the standard non-interactive form of
  // a command setup-project itself prescribes, a single-file restore that looked
  // like `git checkout .`, and the SAFE force-push. The last two are the
  // uncomfortable half of the decision, written down on purpose — genuinely
  // destructive commands now reach the permission layer, which reads intent,
  // instead of a regex over command text that never once caught one.
  ['node -e is not filtered', 'Bash', { command: 'node -e "console.log(1)"' }, 0],
  ['npx with a flag is not filtered', 'Bash', { command: 'npx -y create-next-app my-app' }, 0],
  ['single-file restore is not filtered', 'Bash', { command: 'git checkout -- .gitignore' }, 0],
  ['--force-with-lease is not filtered', 'Bash', { command: 'git push --force-with-lease origin HEAD' }, 0],
  ['grepping FOR a dangerous string is not filtered', 'Bash',
    { command: 'grep -rn "DROP TABLE" supabase/migrations/' }, 0],
  ['destructive commands are the permission layer\'s call now', 'Bash',
    { command: 'rm -rf /some/path' }, 0],

  // Write/Edit to protected paths
  ['Write to .claude/hooks blocked', 'Write', { file_path: '/home/user/.claude/hooks/my.js' }, 2],
  ['Write to .claude/settings.json blocked', 'Write', { file_path: '/home/user/.claude/settings.json' }, 2],
  ['Edit to random file allowed', 'Edit', { file_path: '/home/user/project/src/app.tsx' }, 0],

  // Read skip patterns (generated/large)
  ['Read node_modules blocked', 'Read', { file_path: 'node_modules/react/index.js' }, 2],
  ['Read package-lock blocked', 'Read', { file_path: 'package-lock.json' }, 2],
  ['Read source file allowed', 'Read', { file_path: 'src/app.tsx' }, 0],
];

// ---------------------------------------------------------------------------
// Private-name leak protection (Write/Edit content).
//
// These build a THROWAWAY repo with its own tooling/check-no-private-names.js
// carrying a synthetic name. Two reasons, both load-bearing:
//
//   1. This test file is itself scanned by the real gate. Writing a real
//      private name here to test the blocker would trip the blocker.
//   2. Scoping is the behaviour most worth testing, and a fixture proves it
//      properly: the same string is blocked inside a guarded repo and allowed
//      outside one, which is exactly what keeps product repos writable.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ptf-names-'));
const guarded = path.join(fixture, 'guarded');
const unguarded = path.join(fixture, 'unguarded');
fs.mkdirSync(path.join(guarded, 'tooling'), { recursive: true });
fs.mkdirSync(path.join(guarded, 'docs'), { recursive: true });
fs.mkdirSync(path.join(unguarded, 'docs'), { recursive: true });

const checkerPath = path.join(guarded, 'tooling', 'check-no-private-names.js');
// The third entry is DOTTED on purpose. A private project name is very often a
// domain, and the first version of the ReDoS guard rejected any entry carrying a
// regex metacharacter — which includes '.'. That made this hook drop exactly the
// entries it exists to catch, silently, while still reporting a clean pass.
// Escaping handles a dot correctly; rejection was the over-broad half.
fs.writeFileSync(checkerPath,
  "const NAMES = [\n    'zarblewidget',\n    'quibnorth',\n    'plinthworks.io',\n];\n");

// A denylist carrying an entry the caps DO drop: over MAX_NAME_LEN (64). The
// hook must still block the entries it kept AND say on stderr which one it did
// not check — a narrowed denylist reported as full coverage is worse than none.
const cappedRepo = path.join(fixture, 'capped');
fs.mkdirSync(path.join(cappedRepo, 'tooling'), { recursive: true });
fs.mkdirSync(path.join(cappedRepo, 'docs'), { recursive: true });
fs.writeFileSync(path.join(cappedRepo, 'tooling', 'check-no-private-names.js'),
  "const NAMES = [\n    'quibnorth',\n    '" + 'q'.repeat(65) + "',\n];\n");

// A guarded repo whose checker cannot be read — proves this block fails OPEN.
// A guarded repo whose denylist is EMPTY — a legitimate state for a repo that
// has the checker but no private names yet.
const emptyListRepo = path.join(fixture, 'emptylist');
fs.mkdirSync(path.join(emptyListRepo, 'tooling'), { recursive: true });
fs.mkdirSync(path.join(emptyListRepo, 'docs'), { recursive: true });
fs.writeFileSync(path.join(emptyListRepo, 'tooling', 'check-no-private-names.js'), 'const NAMES = [\n];\n');

const brokenRepo = path.join(fixture, 'broken');
fs.mkdirSync(path.join(brokenRepo, 'tooling', 'check-no-private-names.js'), { recursive: true });
fs.mkdirSync(path.join(brokenRepo, 'docs'), { recursive: true });

// A guarded repo in the HASHED format, which is what the real checker has used
// since 2026-08-22. The fixture above stays because an installed copy of this
// hook can meet an older checker, but this one is the format that ships — and a
// test that only exercised the legacy branch would go on passing while the path
// that actually runs was broken.
//
// The digests are computed with the real checker's own `digest()` rather than
// pasted in, so a change to PREFIX or DIGEST_LEN cannot leave this fixture
// asserting against a scheme nothing uses any more. The names are synthetic,
// with a two-word one to cover the n-gram join the plaintext regex could not do.
const { digest } = require('./check-no-private-names.js');
const hashedRepo = path.join(fixture, 'hashed');
fs.mkdirSync(path.join(hashedRepo, 'tooling'), { recursive: true });
fs.mkdirSync(path.join(hashedRepo, 'docs'), { recursive: true });
fs.writeFileSync(path.join(hashedRepo, 'tooling', 'check-no-private-names.js'),
  "const PREFIX = 'autodev/no-private-names/v1:';\n"
  + 'const DIGEST_LEN = 16;\n'
  + 'const DIGESTS = [\n'
  + ['zarblewidget', 'quibnorth', 'plinth harrow']
      .map((n) => `    '${digest(n)}',\n`).join('')
  + '];\n');

// A guarded repo whose checker is in NEITHER format — the hook must say it
// checked nothing rather than pass quietly. Still exit 0 (this block fails
// open by design), but with a warning on stderr, asserted below.
const unknownFormatRepo = path.join(fixture, 'unknownformat');
fs.mkdirSync(path.join(unknownFormatRepo, 'tooling'), { recursive: true });
fs.mkdirSync(path.join(unknownFormatRepo, 'docs'), { recursive: true });
fs.writeFileSync(path.join(unknownFormatRepo, 'tooling', 'check-no-private-names.js'),
  '// a future format this hook has never heard of\nconst RULES = new Map();\n');

cases.push(
  // ---- hashed format: the one that actually ships ----
  ['hashed denylist blocks a name', 'Write',
    { file_path: path.join(hashedRepo, 'docs/handoff.md'), content: 'the zarblewidget audit found 22 things' }, 2],
  ['hashed denylist is case- and punctuation-insensitive', 'Write',
    { file_path: path.join(hashedRepo, 'docs/handoff.md'), content: 'Zarble-Widget ships tomorrow' }, 2],
  ['hashed denylist joins adjacent words', 'Write',
    { file_path: path.join(hashedRepo, 'docs/handoff.md'), content: 'ask the Plinth Harrow team' }, 2],
  ['hashed denylist allows clean content', 'Write',
    { file_path: path.join(hashedRepo, 'docs/handoff.md'), content: 'the Project A audit found 22 things' }, 0],
  ['hashed denylist does not fire on a substring', 'Write',
    { file_path: path.join(hashedRepo, 'docs/handoff.md'), content: 'zarblewidgetry is not a project' }, 0],

  ['private name in a guarded repo blocked', 'Write',
    { file_path: path.join(guarded, 'docs/handoff.md'), content: 'the zarblewidget audit found 22 things' }, 2],
  ['second name in the list also blocked', 'Write',
    { file_path: path.join(guarded, 'docs/handoff.md'), content: 'quibnorth ships tomorrow' }, 2],
  ['name is case-insensitive', 'Write',
    { file_path: path.join(guarded, 'docs/handoff.md'), content: 'ZarbleWidget' }, 2],
  ['Edit new_string is scanned too', 'Edit',
    { file_path: path.join(guarded, 'docs/handoff.md'), old_string: 'x', new_string: 'ran zarblewidget' }, 2],
  // The scoping guarantee: identical text, no guarded repo above it.
  ['same name outside a guarded repo allowed', 'Write',
    { file_path: path.join(unguarded, 'docs/readme.md'), content: 'the zarblewidget audit found 22 things' }, 0],
  ['clean content in a guarded repo allowed', 'Write',
    { file_path: path.join(guarded, 'docs/handoff.md'), content: 'the Project A audit found 22 things' }, 0],
  // Word-bounded: a substring is not a hit.
  ['substring of a name allowed', 'Write',
    { file_path: path.join(guarded, 'docs/handoff.md'), content: 'zarblewidgetry is not a project' }, 0],
  // A DOTTED denylist entry must be checked, not dropped. This is the case the
  // metacharacter rejection silently removed: the hook went quiet and less
  // protective in the same change.
  ['a dotted denylist name is blocked', 'Write',
    { file_path: path.join(guarded, 'docs/handoff.md'), content: 'we host it on plinthworks.io now' }, 2],
  // ...and the dot must still be a LITERAL, not the regex wildcard it would be
  // if the escape were dropped. If '.' matched any character, this would block.
  ['a dotted name does not match an arbitrary character', 'Write',
    { file_path: path.join(guarded, 'docs/handoff.md'), content: 'the plinthworksXio release' }, 0],
  // The denylist file IS the list; editing it must not trip on itself.
  ['the denylist file itself allowed', 'Write',
    { file_path: checkerPath, content: "const NAMES = ['zarblewidget'];" }, 0],
  // Fail-open: a broken checker must not brick writing.
  ['unreadable checker fails OPEN', 'Write',
    { file_path: path.join(brokenRepo, 'docs/a.md'), content: 'anything at all' }, 0],

  // ---- consequences of mutants that LOOKED equivalent ----
  //
  // An empty denylist builds the regex \b()\b, which matches at every word
  // boundary. Without the `names.length` guard, a repo that has the checker but
  // has not listed a name yet would have EVERY write blocked, reporting a
  // private name of "".
  ['an empty denylist blocks nothing', 'Write',
    { file_path: path.join(emptyListRepo, 'docs/a.md'), content: 'perfectly ordinary text' }, 0],

  // The protected-path rules are about WRITING to security-critical files.
  // Applying them to Read as well would stop anyone reading their own settings,
  // which is the ordinary way to answer a question about configuration.
  ['Read of a protected path is allowed', 'Read',
    { file_path: '/home/user/.claude/settings.json' }, 0],

  // SKIP_READ_PATTERNS exists to keep large generated files out of context on
  // READ. Applying it to writes would block tooling from writing a lockfile.
  ['Write to package-lock.json is allowed', 'Write',
    { file_path: '/home/user/project/package-lock.json', content: '{}' }, 0],
);

let pass = 0, fail = 0;
for (const [label, tool, input, expected] of cases) {
  const { exitCode, stderr } = run(tool, input);
  const ok = exitCode === expected;
  if (ok) pass++;
  else fail++;
  const mark = ok ? 'PASS' : 'FAIL';
  const actual = `got ${exitCode}, expected ${expected}`;
  console.log(`${mark}  ${label}  (${actual})`);
  if (!ok && stderr.trim()) console.log('       stderr:', stderr.trim().split('\n')[0]);
}


// A clean write must be SILENT, not merely allowed.
//
// `if (hit)` forced to `true` looked equivalent: hit is null on a clean write,
// so hit[1] throws, the fail-open catch swallows it, and the write proceeds —
// same exit code, mutant survives. But the catch also writes to stderr, so the
// mutant puts a "private-name check skipped" line on EVERY clean Write and Edit.
// Exit code alone cannot see that; this can. Same shape as a session-carrier
// mutant that also survived by exit code while deleting a file it should not.
{
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: path.join(guarded, 'docs/handoff.md'), content: 'the Project A audit' },
    }),
    encoding: 'utf8',
  });
  const ok = r.status === 0 && (r.stderr || '') === '';
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  a clean write is silent, not just allowed  `
    + `(exit ${r.status}, stderr ${JSON.stringify((r.stderr || '').slice(0, 40))})`);
}

// An UNREADABLE denylist format must announce itself, not pass quietly.
//
// This block fails open by design, so exit code cannot distinguish "checked and
// clean" from "understood nothing and checked nothing". That is the shape where
// an honest-looking skip converts absent coverage into reported coverage, so the
// assertion is on the warning, not on the status.
{
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: path.join(unknownFormatRepo, 'docs/a.md'), content: 'anything at all' },
    }),
    encoding: 'utf8',
  });
  const ok = r.status === 0 && /was NOT checked/.test(r.stderr || '');
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  an unreadable denylist format warns instead of passing quietly  `
    + `(exit ${r.status}, stderr ${JSON.stringify((r.stderr || '').slice(0, 40))})`);
}

// The ReDoS guard, which the metacharacter-rejection change put at risk.
//
// Removing that rejection means `(a+)+$` now reaches the escaper instead of
// being thrown away. Escaping is what makes it safe — `\(a\+\)\+\$` is a literal
// and cannot backtrack — but "is safe" was previously an argument, not a
// measurement, and this suite had no timing case at all. So measure it: a
// denylist entry that is a catastrophic-backtracking bomb must not hang the
// hook. The bound is deliberately loose (2s against a 20s hook timeout) so this
// is a hang detector, not a performance benchmark that flakes on a busy machine.
{
  const bombRepo = path.join(fixture, 'bomb');
  fs.mkdirSync(path.join(bombRepo, 'tooling'), { recursive: true });
  fs.mkdirSync(path.join(bombRepo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(bombRepo, 'tooling', 'check-no-private-names.js'),
    "const NAMES = [\n    '(a+)+$',\n];\n");
  const t0 = Date.now();
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: path.join(bombRepo, 'docs/a.md'), content: 'a'.repeat(40) + 'b' },
    }),
    encoding: 'utf8',
    timeout: 20000,
  });
  const ms = Date.now() - t0;
  const ok = r.status === 0 && ms < 2000;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  a backtracking-bomb denylist entry does not hang the hook  `
    + `(exit ${r.status}, ${ms}ms)`);
}

// A denylist entry the caps DO drop must be REPORTED, not dropped silently, and
// the entries that survived must still be checked. Absent coverage reported as
// coverage is the failure this warning exists for.
{
  const blocked = spawnSync('node', [HOOK], {
    input: JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: path.join(cappedRepo, 'docs/a.md'), content: 'quibnorth ships tomorrow' },
    }),
    encoding: 'utf8',
  });
  const ok = blocked.status === 2 && /was NOT checked|were NOT checked/.test(blocked.stderr || '')
    && /over the 64 cap/.test(blocked.stderr || '');
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  an over-long entry is named on stderr while the rest still block  `
    + `(exit ${blocked.status}, stderr ${JSON.stringify((blocked.stderr || '').slice(0, 90))})`);
}

// The fail-CLOSED parse guard. Every case above builds its input with
// JSON.stringify, so the "input did not parse" branch was unreachable from this
// suite and an operator mutation flipping its exit(2) to exit(0) survived
// undetected. A hook that silently allows everything when it cannot read its
// input is the worst failure this file has.
{
  const r = spawnSync('node', [HOOK], { input: 'this is not json', encoding: 'utf8' });
  const ok = r.status === 2;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  unparseable input fails CLOSED  (got ${r.status}, expected 2)`);
}

fs.rmSync(fixture, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
