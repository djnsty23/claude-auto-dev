#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/known-flakes.js, the list of recurring
// gate flakes that the gates and the Brain match a red against.
// Run: node tooling/test-known-flakes.js
// Exits 1 on any failure; 0 if all pass.
//
// WHAT MUST HOLD.
//   1. A known flake's log matches its entry, and only when BOTH the suite
//      string and the signature appear. A real failure in the same suite does
//      not match.
//   2. Entries for another repo never match.
//   3. A broken list (absent, not JSON, bad entries) matches nothing, and the
//      gate helper returns no notes instead of throwing.
//   4. A match is advice: the note says to rerun and that a second red is real.
//   5. gate-fast.js routes each failed step through gateNotes, loaded inside
//      a try so a fixture copy of the gate with no plugins/ still runs.
//
// THE FIXTURES are shaped on real gate output from the offload eval (a sitekit
// EPERM, a TypeError a rerun passed, a B12 animation read, a 1 s crash), with
// the product renamed. Every CLI case runs the shipped script as a subprocess
// with AUTODEV_KNOWN_FLAKES pointed at a temp file, so this machine's real list
// is never read.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'known-flakes.js');
const kf = require(SCRIPT);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'known-flakes-'));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
}

const ENTRIES = [
  { id: 'demo-site-eperm', repo: 'demo-app', suite: 'site-check', signature: 'EPERM, Permission denied: .*sitekit-site-check-', cause: 'Windows held the temp dir', rerun: 'npm run check:site', added: '2026-11-05', evidence: 'rerun passed' },
  { id: 'demo-b12-radius', repo: 'demo-app', suite: 'check-builder', signature: '^\\s*B12 @\\S+ \\d+x\\d+: a: Escape mid-opening, the closing circle grew', cause: 'B12 frame read under load', rerun: 'node scripts/check-builder.mjs', added: '2026-11-05', evidence: 'passes alone' },
  { id: 'demo-site-crash', repo: 'demo-app', suite: 'check:site', signature: 'check:site exit 3221226505 in [0-9]s', cause: 'the site check crashed in its first second', rerun: 'npm run check:site', added: '2026-11-05', evidence: 'rerun passed' },
  { id: 'other-repo-flake', repo: 'other-app', suite: 'families.test.ts', signature: "TypeError: Cannot read properties of undefined \\(reading 'id'\\)", cause: 'fixture race', rerun: 'node --test families.test.ts', added: '2026-11-05', evidence: 'rerun passed' },
  { id: 'old-entry', repo: '*', suite: 'slow.test', signature: 'timed out after 20000ms', cause: 'a 20 s budget under load', rerun: 'node --test slow.test', added: '2026-01-01', evidence: 'rerun passed' },
];
const listFile = path.join(tmp, 'known-flakes.json');
fs.writeFileSync(listFile, JSON.stringify({ flakes: ENTRIES }, null, 2));
const env = { ...process.env, AUTODEV_KNOWN_FLAKES: listFile };

const LOGS = {
  eperm: '> check:site · npm run check:site\nverdict INDETERMINATE: EPERM, Permission denied: \\\\?\\C:\\Users\\me\\AppData\\Local\\Temp\\sitekit-site-check-kBe2l7\ngate FAIL in 580s',
  b12: '> check-builder · node scripts/check-builder.mjs --self-test\nFAIL, 1 finding(s):\n  B12 @live 1890x1900: a: Escape mid-opening, the closing circle grew to 1356px from 1258px\ngate FAIL in 584s',
  b8real: "> check-builder · node scripts/check-builder.mjs --self-test\nFAIL, 1 finding(s):\n  B8 @live 390x844: the payload differs from main's: phone\ngate FAIL in 584s",
  crash: 'gate steps:\n  check:site       exit 3221226505 1s\n< check:site exit 3221226505 in 1s\ngate FAIL in 514s',
  tsReal: "> typecheck · tsc --noEmit\nsrc/lib/offers/vat.ts(88,14): error TS2322: Type 'string | undefined' is not assignable to type 'string'.\ngate FAIL in 139s",
  b12NoSuite: '  B12 @live 1890x1900: a: Escape mid-opening, the closing circle grew to 1356px',
  families: "test at src/families.test.ts:406:1\n  TypeError: Cannot read properties of undefined (reading 'id')",
  slow: "not ok 1 - slow.test\n  error: 'test timed out after 20000ms'",
};

function cli(args, input, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8', env: { ...env, ...extraEnv }, windowsHide: true });
}

const list = kf.loadList(env);
console.log('loading the list');
check('all five entries load valid', list.entries.length === 5 && list.invalid.length === 0, JSON.stringify(list.invalid));

console.log('matching');
const ids = (text, repo) => kf.matchLog(text, list.entries, repo).map((e) => e.id).join(',');
check('sitekit EPERM matches its entry', ids(LOGS.eperm, 'demo-app') === 'demo-site-eperm', ids(LOGS.eperm, 'demo-app'));
check('B12 radius read matches its entry', ids(LOGS.b12, 'demo-app') === 'demo-b12-radius', ids(LOGS.b12, 'demo-app'));
check('1 s site-check crash matches its entry', ids(LOGS.crash, 'demo-app') === 'demo-site-crash', ids(LOGS.crash, 'demo-app'));
check('a real B8 payload diff in the same suite matches nothing', ids(LOGS.b8real, 'demo-app') === '', ids(LOGS.b8real, 'demo-app'));
check('a real type error matches nothing', ids(LOGS.tsReal, 'demo-app') === '', ids(LOGS.tsReal, 'demo-app'));
check('the signature without its suite string matches nothing', ids(LOGS.b12NoSuite, 'demo-app') === '', ids(LOGS.b12NoSuite, 'demo-app'));
check('another repo\'s entry does not match here', ids(LOGS.families, 'demo-app') === '', ids(LOGS.families, 'demo-app'));
check('it matches in its own repo', ids(LOGS.families, 'other-app') === 'other-repo-flake', ids(LOGS.families, 'other-app'));
check('repo "*" matches in any repo', ids(LOGS.slow, 'demo-app') === 'old-entry' && ids(LOGS.slow, 'other-app') === 'old-entry');

console.log('a note is advice, never a verdict');
const notes = kf.annotate(LOGS.b12, list, 'demo-app', Date.parse('2026-11-05T12:00:00Z'));
check('the note names the id, the rerun and that a second red is real',
  notes.length === 1 && /known flake demo-b12-radius/.test(notes[0]) && /node scripts\/check-builder\.mjs/.test(notes[0]) && /second red is real/.test(notes[0]), JSON.stringify(notes));
const old = kf.annotate(LOGS.slow, list, 'demo-app', Date.parse('2026-11-05T12:00:00Z'));
check('an entry past 90 days asks to be re-measured', /308 days old: re-measure it/.test(old[0] || ''), JSON.stringify(old));

console.log('a broken list matches nothing and never throws');
const bad = path.join(tmp, 'bad.json');
fs.writeFileSync(bad, JSON.stringify({ flakes: [
  ENTRIES[0],
  { ...ENTRIES[1], signature: '(' },
  { ...ENTRIES[2], signature: '.*', id: 'too-wide' },
  { ...ENTRIES[0] },
  { id: 'half', repo: 'demo-app' },
] }));
const badList = kf.loadList({ AUTODEV_KNOWN_FLAKES: bad });
check('only the one valid entry survives', badList.entries.length === 1 && badList.invalid.length === 4, JSON.stringify(badList.invalid));
check('reasons: uncompilable, matches everything, duplicate, missing fields',
  /does not compile/.test(JSON.stringify(badList.invalid)) && /matches everything/.test(JSON.stringify(badList.invalid)) &&
  /duplicate id/.test(JSON.stringify(badList.invalid)) && /missing suite/.test(JSON.stringify(badList.invalid)), JSON.stringify(badList.invalid));
let r = cli(['check'], '', { AUTODEV_KNOWN_FLAKES: bad });
check('check exits 1 and lists the invalid entries', r.status === 1 && /4 invalid and ignored/.test(r.stdout) && /invalid too-wide/.test(r.stdout), r.stdout);
r = cli(['check']);
check('check on the good list exits 0', r.status === 0 && /5 valid entries/.test(r.stdout), r.stdout);
const notJson = path.join(tmp, 'notjson.json');
fs.writeFileSync(notJson, '{ nope');
check('gateNotes on a list that is not JSON returns []', kf.gateNotes(LOGS.b12, { env: { AUTODEV_KNOWN_FLAKES: notJson }, repo: 'demo-app' }).length === 0);
check('gateNotes on an absent list returns []', kf.gateNotes(LOGS.b12, { env: { AUTODEV_KNOWN_FLAKES: path.join(tmp, 'absent.json') }, repo: 'demo-app' }).length === 0);
check('gateNotes on a match returns the note', kf.gateNotes(LOGS.b12, { env, repo: 'demo-app' }).length === 1);
check('gateNotes with no log text returns []', kf.gateNotes(undefined, { env, repo: 'demo-app' }).length === 0);
r = cli(['match', '--repo', 'demo-app', '-'], LOGS.b12, { AUTODEV_KNOWN_FLAKES: notJson });
check('match on an unreadable list exits 2 and says so', r.status === 2 && /unreadable/.test(r.stderr), r.stderr);

console.log('the CLI');
r = cli(['match', '--repo', 'demo-app', '-'], LOGS.eperm);
check('match prints the note, exit 0', r.status === 0 && /known flake demo-site-eperm/.test(r.stdout), r.stdout + r.stderr);
r = cli(['match', '--repo', 'demo-app', '-'], LOGS.tsReal);
check('no match states the population and says treat it as real', r.status === 0 && /no known flake matched \(4 entries for repo demo-app/.test(r.stdout) && /as real/.test(r.stdout), r.stdout);
r = cli(['match', '--repo', 'demo-app', '-'], LOGS.eperm, { AUTODEV_KNOWN_FLAKES: path.join(tmp, 'absent.json') });
check('match with no list says so, exit 0', r.status === 0 && /no known-flake list at/.test(r.stdout), r.stdout);
r = cli(['list', '--repo', 'other-app']);
check('list scopes to the repo', r.status === 0 && /2 for repo other-app/.test(r.stdout) && /other-repo-flake/.test(r.stdout) && !/demo-site-eperm/.test(r.stdout), r.stdout);
r = cli(['match']);
check('match without a log exits 2', r.status === 2);
r = cli(['--help']);
check('--help exits 0 and says a match never changes a verdict', r.status === 0 && /never changes a verdict/.test(r.stdout));

console.log('gate-fast routes failed steps through gateNotes');
for (const [file, re] of [
  ['tooling/gate-fast.js', /every\.filter\(\(r\) => r\.status === 'FAIL'\)[\s\S]{0,200}gateNotes\(f\.tail/],
]) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  check(`${file} annotates each failed suite`, re.test(src) && /require\('\.\.\/plugins\/autodev-core\/scripts\/known-flakes\.js'\)/.test(src));
  // Suites copy these runners into fixtures with no plugins/ beside them, so a
  // top-level require would throw at load and fail every such suite.
  check(`${file} loads the matcher inside a try, never at top level`,
    !/^const .*require\('\.\.\/plugins\/autodev-core\/scripts\/known-flakes\.js'\)/m.test(src) &&
    /try \{[^\n]*require\('\.\.\/plugins\/autodev-core\/scripts\/known-flakes\.js'\)/.test(src));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed (population: ${pass + fail} checks)`);
process.exitCode = fail ? 1 : 0;
