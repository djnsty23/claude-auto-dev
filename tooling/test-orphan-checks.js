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

// ── failure mode 3: a runner that DISCOVERS its work by pattern
//
// This tool reported four of THIS repo's own test suites as unreferenced, under
// a heading saying they touch prod or money and were kept out of CI on purpose.
// All four run on every build — tooling/test-all.js finds them with
// readdirSync().filter(f => /^test-.*\.js$/.test(f)), so no literal filename
// exists anywhere to match.
{
    const dir = repo({
        'package.json': JSON.stringify({ scripts: { test: 'node scripts/run-all.js' } }),
        'scripts/run-all.js':
            "const fs=require('fs');\n"
            + "for (const f of fs.readdirSync(__dirname).filter(f => /^check-.*\\.js$/.test(f))) require('./'+f);\n",
        'scripts/check-alpha.js': ASSERTS,
        'scripts/check-beta.js': ASSERTS,
    });
    const r = spawnSync(process.execPath, [TOOL, dir], { encoding: 'utf8' });
    check('a pattern-discovered script is NOT an orphan', r.status === 0);
    check('  and is not named in the output',
        !/check-alpha\.js/.test(r.stdout) && !/check-beta\.js/.test(r.stdout));
}

// The guard that keeps failure mode 3 from silencing the whole report. An
// extension-only pattern names nothing — a version of this check let
// /\.(js|html|css)$/ through and it suppressed 67 of 120 scripts in a real repo,
// far worse than the false positives it was built to remove.
{
    // The .mjs files matter: without them the extension pattern matches 100% of
    // the fixture and the >90% BREADTH guard rejects it, so the test passes even
    // with the discriminator guard removed — it would prove nothing. Measured:
    // the canary did not fire until these were added.
    const dir = repo({
        'package.json': JSON.stringify({ scripts: { test: 'node scripts/sweep.js' } }),
        'scripts/sweep.js':
            "const fs=require('fs');\n"
            + "for (const f of fs.readdirSync(__dirname).filter(f => /\\.(js|html|css)$/.test(f))) console.log(f);\n",
        'scripts/genuinely-orphaned.js': ASSERTS,
        'scripts/other-a.mjs': MIGRATION,
        'scripts/other-b.mjs': MIGRATION,
        'scripts/other-c.mjs': MIGRATION,
    });
    const r = spawnSync(process.execPath, [TOOL, dir], { encoding: 'utf8' });
    check('an extension-only pattern does NOT suppress a real orphan', r.status === 1);
    check('  the real orphan is still named', /genuinely-orphaned\.js/.test(r.stdout));
}

// `node --test` discovers test files by BUILT-IN pattern and has no config file
// to read the globs out of, so it looked like no runner at all. A real repo
// running `npm test` = `node --test` reported 9 orphaned assertions, 4 of which
// were scripts/*.test.js that Node's own runner discovers and executes.
{
    const withNodeTest = run(repo({
        'package.json': JSON.stringify({ name: 'r', scripts: { test: 'node --test' } }),
        'scripts/store-mapping.test.js': ASSERTS,
        'scripts/genuinely-orphaned.js': ASSERTS,
    }));
    const orphans = (withNodeTest.orphanChecks || []).map((o) => o.script);
    check('node --test discovers scripts/*.test.js',
        !orphans.some((f) => /store-mapping\.test\.js/.test(f)));
    check('  and a non-test script beside it is STILL an orphan',
        orphans.some((f) => /genuinely-orphaned\.js/.test(f)));

    // The over-suppression guard. This must apply ONLY when a script actually
    // runs bare `node --test`. A blanket version would silence every *.test.js
    // in every repo, and nobody sees what a detector stops showing them.
    const withoutNodeTest = run(repo({
        'package.json': JSON.stringify({ name: 'r', scripts: { test: 'node tooling/custom-runner.js' } }),
        'scripts/store-mapping.test.js': ASSERTS,
    }));
    const orphans2 = (withoutNodeTest.orphanChecks || []).map((o) => o.script);
    check('a *.test.js is still an orphan when nothing runs node --test',
        orphans2.some((f) => /store-mapping\.test\.js/.test(f)));

    // `--test-reporter` must not be mistaken for `--test`.
    const reporterOnly = run(repo({
        'package.json': JSON.stringify({ name: 'r', scripts: { test: 'node --test-reporter=spec tooling/x.js' } }),
        'scripts/store-mapping.test.js': ASSERTS,
    }));
    const orphans3 = (reporterOnly.orphanChecks || []).map((o) => o.script);
    check('--test-reporter alone does not trigger node --test discovery',
        orphans3.some((f) => /store-mapping\.test\.js/.test(f)));
}

// MANUAL_TOOL classification. The keyword list knew payments and databases but
// not browser automation, mail, LLM clients, or dotenv-plus-a-live-host, so 18
// of 22 real findings across three repos were manual tools called orphans.
{
    const manualish = {
        'playwright': "import { chromium } from 'playwright';\n" + ASSERTS,
        'sendgrid': "import sg from '@sendgrid/mail';\n" + ASSERTS,
        'dotenv': "import 'dotenv/config';\n" + ASSERTS,
        'external https host': "const API = 'https://api.example.com/v1';\n" + ASSERTS,
    };
    for (const [label, body] of Object.entries(manualish)) {
        const out = run(repo({
            'package.json': JSON.stringify({ name: 'r' }),
            'scripts/probe.mjs': body,
        }));
        check(`${label} is classified MANUAL, not an orphaned check`,
            !(out.orphanChecks || []).some((o) => o.script === 'scripts/probe.mjs'));
    }

    // The over-suppression guard, and the one that matters most. A check with no
    // network, no credentials and no browser must STILL be reported. Both real
    // orphans found by hand were of exactly this shape, and a widening that ate
    // them would have been worse than the false positives it removed.
    const pure = run(repo({
        'package.json': JSON.stringify({ name: 'r' }),
        'scripts/verify-retry-logic.mjs':
            'let tries = 0;\nfunction retry() { tries++; }\nretry();\n' + ASSERTS,
    }));
    check('a dependency-free assertion script is STILL an orphan',
        (pure.orphanChecks || []).some((o) => o.script === 'scripts/verify-retry-logic.mjs'));
}

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
