#!/usr/bin/env node
// Suite for check-version-drift.js.
//
// The case that matters is the one a drift gate cannot demonstrate on its own:
// that it FAILS when the table is stale. Running it against the real table only
// ever exercises the passing branch, which looks identical to a check that
// parsed nothing and had nothing to say.
//
// Hermetic on purpose — CLAUDE_VERSION_REGISTRY replaces the registry with a
// fixture. The first version of this suite hit npm for real and died under
// test-all's parallelism with a Windows abort code instead of a verdict.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GATE = path.join(__dirname, 'check-version-drift.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdrift-'));
let pass = 0, fail = 0;

const write = (name, body) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return p;
};

const REGISTRY = write('registry.json', {
  next: '16.3.1', react: '19.2.8', 'react-dom': '19.2.8',
  typescript: '7.0.2', '@ai-sdk/react': '4.0.69', shadcn: '4.18.0',
});

const run = (table) => spawnSync('node', [GATE], {
  encoding: 'utf8',
  env: { ...process.env, CLAUDE_VERSION_TABLE: table, CLAUDE_VERSION_REGISTRY: REGISTRY },
});

const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};

const header = '| Package | Version | Risk |\n|---|---|---|\n';
// The gate refuses to run on fewer than five rows; pad past that so these cases
// exercise drift detection rather than accidentally testing the row-count guard.
const filler = Array.from({ length: 8 }, () => '| react | ^19.2 | filler |\n').join('');

console.log('test-version-drift');

// 1. Stale major → non-zero, and it must say which package.
const stale = run(write('stale.md', header + '| next | ^1.0 | deliberately ancient |\n' + filler));
check('stale major exits non-zero', stale.status === 1, 'got exit ' + stale.status);
check('stale major names the package', /MAJOR\s+next:/.test(stale.stdout), stale.stdout.trim().split('\n').pop());

// 2. Table level with the registry → zero. Proves case 1 is not "always fails".
const current = run(write('current.md', header + '| next | ^16.3 | level |\n' + filler));
check('current table exits zero', current.status === 0, 'got exit ' + current.status);
check('current table reports no MAJOR', !/MAJOR/.test(current.stdout));

// 3. Minor drift warns without failing the build.
const minor = run(write('minor.md', header + '| typescript | ^7.0 | minor behind 7.0.2? no — same |\n'
  + '| next | ^16.1 | one minor behind |\n' + filler));
check('minor drift does not fail', minor.status === 0, 'got exit ' + minor.status);
check('minor drift is still reported', /minor\s+next:/.test(minor.stdout), minor.stdout);

// 4. Population reporting — a zero must be distinguishable from a no-op.
check('prints how many packages it scanned', /\d+ packages in the table/.test(current.stdout));

// 5. Unparseable table fails closed rather than passing silently.
const empty = run(write('empty.md', '# no table here\n\njust prose.\n'));
check('unparseable table fails closed', empty.status === 1, 'got exit ' + empty.status);
check('unparseable table says it went blind', /went blind/.test(empty.stderr));

// 6. Column shapes that broke the first version: a scoped name must not split on
//    its slash, a shared row must expand to two packages, a trailing role word
//    must be dropped. Any of these failing shows up as an unresolved lookup.
const shapes = run(write('shapes.md', header
  + '| @ai-sdk/react | ^4.0 | scoped, must stay one package |\n'
  + '| react / react-dom | ^19.2 | one row, two packages |\n'
  + '| shadcn CLI | ^4.18 | trailing role word |\n' + filler));
check('no unresolved lookups from column shapes', !/not in fixture registry/.test(shapes.stdout),
  shapes.stdout.match(/\?.*/)?.[0]);
check('shared row counted as two packages', /1[12] packages in the table/.test(shapes.stdout),
  shapes.stdout.match(/\d+ packages in the table/)?.[0]);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
