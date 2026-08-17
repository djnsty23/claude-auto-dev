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
fs.writeFileSync(checkerPath, "const NAMES = [\n    'zarblewidget',\n    'quibnorth',\n];\n");

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

cases.push(
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
