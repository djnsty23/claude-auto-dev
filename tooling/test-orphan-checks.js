#!/usr/bin/env node
// Tests for find-orphan-checks.js.
//
// Both of this tool's real-world failure modes are asserted here, because both
// happened while running it against a live repo and both produced confident,
// wrong output:
//
//   1. A script invoked exactly once (only from package.json) was reported as
//      an orphan, because the logic discounted a "self-mention" most files do
//      not contain.
//   2. Files matched by a runner's include GLOB were reported as orphans,
//      because the search was by filename only. Five live test files that ran on
//      every CI build were called abandoned.
//
// Run: node tooling/test-orphan-checks.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'find-orphan-checks.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-test-')));

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

let n = 0;
function repo(files) {
    const dir = path.join(TMP, 'r' + ++n);
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    }
    return dir;
}

function run(dir) {
    const r = spawnSync(process.execPath, [TOOL, dir, '--json'], { encoding: 'utf8' });
    try { return JSON.parse(r.stdout); } catch { return { parseError: r.stdout + r.stderr }; }
}

const ASSERTS = 'if (x !== 1) { throw new Error("bad"); }\n';
const MIGRATION = 'await db.query("update things set a = 1");\n';

// 1. An assertion script nothing references is an orphan.
let out = run(repo({
    'package.json': JSON.stringify({ name: 'r', scripts: { test: 'vitest run' } }),
    'scripts/lonely-check.mjs': ASSERTS,
}));
check('unreferenced assertion is reported', (out.orphanChecks || []).some((o) => o.script === 'scripts/lonely-check.mjs'));

// 2. REGRESSION: referenced exactly once, from package.json only.
out = run(repo({
    'package.json': JSON.stringify({ name: 'r', scripts: { check: 'node scripts/wired-check.mjs' } }),
    'scripts/wired-check.mjs': ASSERTS,
}));
check('a script wired only in package.json is NOT an orphan', (out.orphanChecks || []).length === 0);

// 3. REGRESSION: matched by a runner include glob, named nowhere.
out = run(repo({
    'package.json': JSON.stringify({ name: 'r', scripts: { test: 'vitest run' } }),
    'vite.config.ts': 'export default { test: { include: ["scripts/**/*.test.mjs"] } };',
    'scripts/qa/deep.test.mjs': ASSERTS,
}));
check('a file matched by an include glob is NOT an orphan', (out.orphanChecks || []).length === 0);
check('the glob is reported as honoured', (out.includeGlobs || []).includes('scripts/**/*.test.mjs'));

// 4. Brace alternation in a glob.
out = run(repo({
    'package.json': JSON.stringify({ name: 'r' }),
    'vite.config.ts': 'export default { test: { include: ["scripts/**/*.{test,spec}.mjs"] } };',
    'scripts/a.spec.mjs': ASSERTS,
    'scripts/b.test.mjs': ASSERTS,
}));
check('brace alternation matches both forms', (out.orphanChecks || []).length === 0);

// 5. A glob must not match beyond its directory segment.
out = run(repo({
    'package.json': JSON.stringify({ name: 'r' }),
    'vite.config.ts': 'export default { test: { include: ["scripts/*.test.mjs"] } };',
    'scripts/nested/deep.test.mjs': ASSERTS,
}));
check('single * does not span directories', (out.orphanChecks || []).some((o) => o.script === 'scripts/nested/deep.test.mjs'));

// 6. A one-off migration is not a gate, even when unreferenced.
out = run(repo({
    'package.json': JSON.stringify({ name: 'r' }),
    'scripts/migrate-users.mjs': MIGRATION,
}));
check('unreferenced migration is not called an orphaned check', (out.orphanChecks || []).length === 0);

// 7. Referenced from CI counts.
out = run(repo({
    'package.json': JSON.stringify({ name: 'r' }),
    '.github/workflows/ci.yml': 'jobs:\n  t:\n    steps:\n      - run: node scripts/ci-check.mjs\n',
    'scripts/ci-check.mjs': ASSERTS,
}));
check('a script referenced from CI is not an orphan', (out.orphanChecks || []).length === 0);

// 8. Referenced by another script counts.
out = run(repo({
    'package.json': JSON.stringify({ name: 'r', scripts: { check: 'node scripts/runner.mjs' } }),
    'scripts/runner.mjs': 'import "./child-check.mjs";\n',
    'scripts/child-check.mjs': ASSERTS,
}));
check('a script invoked by another script is not an orphan', (out.orphanChecks || []).length === 0);

// 9. Exit code is non-zero when an orphaned check exists, so CI can use it.
const dir = repo({
    'package.json': JSON.stringify({ name: 'r' }),
    'scripts/lonely2.mjs': ASSERTS,
});
const r = spawnSync(process.execPath, [TOOL, dir], { encoding: 'utf8' });
check('exits non-zero on an orphaned check', r.status === 1);
check('names the file in human output', /lonely2\.mjs/.test(r.stdout));

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
