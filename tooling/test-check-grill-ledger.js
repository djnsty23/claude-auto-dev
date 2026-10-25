#!/usr/bin/env node
// Suite for check-grill-ledger.js.
//
// Every planted defect is derived from the one good ledger by changing a single
// cell or line, so a defect case can only go red for the rule it plants. The
// good ledger passing is the control: without it, each red below could be the
// checker failing everything.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHECK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-grill-ledger.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grill-ledger-'));
let pass = 0, fail = 0;

const check = (label, ok, detail) => {
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};

let seq = 0;
const run = (text, extraArgs = []) => {
  const file = path.join(tmp, `l${seq++}.md`);
  if (text !== null) fs.writeFileSync(file, text);
  const r = spawnSync(process.execPath, [CHECK, file, ...extraArgs], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

const ROWS = [
  '| DY0 | Slug: reel | Claude | setup | locked at setup |',
  '| Q1 | Single user, no orgs | accepted | spec | locked at spec |',
  '| Q2 | Export as CSV \\| PDF | you | build | open |',
  '| DY3 | Month-one cap is the free tier | Claude | provision | superseded by DY4 |',
  '| DY4 | Month-one cap is the free tier plus one paid seat | `you` | provision | `open` |',
];
const ledger = (rows = ROWS) => [
  'First line: read the idea, commit abc1234.',
  '',
  '# Decision ledger',
  '',
  '| Code | Answer | By | Lock step | Status |',
  '|---|---|---|---|---|',
  ...rows,
  '',
  'Notes after the table are not rows.',
  '',
].join('\n');
// Replace one row by index, the planted defect's only difference from the control.
const withRow = (i, row) => ledger(ROWS.map((r, j) => (j === i ? row : r)));

console.log('check-grill-ledger');

const good = run(ledger());
check('good ledger exits 0', good.code === 0, good.out);
check('good ledger reports its population', /5 rows read from 1 ledger table/.test(good.out), good.out);
check('an escaped pipe stays inside the answer cell', good.code === 0 && !/cells, expected 5/.test(good.out), good.out);

const planted = [
  ['duplicate code', withRow(1, '| DY0 | Single user, no orgs | accepted | spec | locked at spec |'), /code DY0 duplicates line/],
  ['malformed code', withRow(1, '| question one | Single user, no orgs | accepted | spec | locked at spec |'), /code "question one" is not/],
  ['By outside the three values', withRow(1, '| Q1 | Single user, no orgs | operator | spec | locked at spec |'), /Q1 By is "operator"/],
  ['By with the wrong case', withRow(1, '| Q1 | Single user, no orgs | claude | spec | locked at spec |'), /Q1 By is "claude"/],
  ['lock step outside the six', withRow(1, '| Q1 | Single user, no orgs | accepted | review | open |'), /Q1 lock step is "review"/],
  ['status not one of the three shapes', withRow(2, '| Q2 | Export as CSV | you | build | done |'), /Q2 status is "done"/],
  ['locked at a non-step', withRow(0, '| DY0 | Slug: reel | Claude | setup | locked at deploy |'), /"locked at deploy", which is not a chain step/],
  ['locked at a step other than its lock step', withRow(0, '| DY0 | Slug: reel | Claude | setup | locked at spec |'), /DY0 is locked at spec but its lock step is setup/],
  ['superseded by a missing code', withRow(3, '| DY3 | Month-one cap is the free tier | Claude | provision | superseded by DY9 |'), /superseded by DY9, which is not a row/],
  ['superseded by itself', withRow(3, '| DY3 | Month-one cap is the free tier | Claude | provision | superseded by DY3 |'), /DY3 is superseded by itself/],
  ['a row with four cells', withRow(2, '| Q2 | Export as CSV | you | build |'), /4 cells, expected 5/],
  ['an unescaped pipe splits the answer', withRow(2, '| Q2 | Export as CSV | PDF | you | build | open |'), /6 cells, expected 5/],
];
for (const [label, text, expect] of planted) {
  const r = run(text);
  check(`${label}: exits 1`, r.code === 1, `exit ${r.code}`);
  check(`${label}: names the defect`, expect.test(r.out), r.out);
  check(`${label}: exactly one finding`, /check-grill-ledger: 1 finding\(s\)/.test(r.out), r.out);
}

const noTable = run('# Decision ledger\n\nDY1 single user. DY2 free tier.\n');
check('no ledger table exits 1', noTable.code === 1, `exit ${noTable.code}`);
check('no ledger table names it', /no ledger table/.test(noTable.out), noTable.out);

const empty = run(ledger([]));
check('empty ledger exits 1, never ok', empty.code === 1, `exit ${empty.code}`);
check('empty ledger names it', /has no rows/.test(empty.out), empty.out);

const otherTable = run('| Code | Answer |\n|---|---|\n| DY1 | x |\n');
check('a table with another header is not the ledger', otherTable.code === 1 && /no ledger table/.test(otherTable.out), otherTable.out);

const missing = run(null);
check('a missing file exits 2, not run', missing.code === 2, `exit ${missing.code}`);
check('a missing file says not run', /not run, cannot read/.test(missing.out), missing.out);

const badArgs = run(ledger(), ['--strict']);
check('an unknown flag exits 2', badArgs.code === 2, `exit ${badArgs.code}`);

const help = spawnSync(process.execPath, [CHECK, '--help'], { encoding: 'utf8' });
check('--help prints usage and exits 0', help.status === 0 && /Usage:/.test(help.stdout), help.stdout);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
