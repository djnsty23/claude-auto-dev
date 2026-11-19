#!/usr/bin/env node
'use strict';
// test-coverage-diff.js: gate:fast's coverage-of-the-diff step, driven as the
// real CLI (tooling/gate-fast.js) over git fixtures, plus the predicate it rests on.
//
// Each fixture is a git repository under the OS temp root, never under this
// checkout, so no ancestor repository can answer for it. Its gate chain names one
// real fast step bound to a no-op, one plugin source and one suite that requires
// it. The base is a branch; every change under test is left uncommitted, which is
// how gate:fast sees a working tree (touched-suites.js diffs the tree, not HEAD).
//
// Every planted case asserts the NAME the verdict prints, not only the exit code:
// a red run for another reason must not pass for this one.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const cd = require('./coverage-diff.js');

const GATE_FAST = path.join(__dirname, 'gate-fast.js');
let failed = 0;
let passed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log(`PASS  ${name}`); return; }
    failed++;
    console.log(`FAIL  ${name}`);
    if (detail) console.log(String(detail).split('\n').map((l) => '      ' + l).join('\n'));
}

// --- the predicate, in process ------------------------------------------------

{
    const diff = [
        'diff --git a/plugins/p/a.js b/plugins/p/a.js',
        '--- a/plugins/p/a.js',
        '+++ b/plugins/p/a.js',
        '@@ -3,0 +4,2 @@ x',
        '+function planted() {}',
        '+',
        '@@ -9 +11 @@ y',
        '-old',
        '+new',
        'diff --git a/plugins/p/gone.js b/plugins/p/gone.js',
        '--- a/plugins/p/gone.js',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
    ].join('\n');
    const m = cd.parseAddedLines(diff);
    const a = m.get('plugins/p/a.js');
    check('parseAddedLines reads a multi-line hunk and a one-line hunk', a && [...a].join(',') === '4,5,11', a && [...a].join(','));
    check('parseAddedLines skips a deleted file', !m.has('/dev/null') && !m.has('plugins/p/gone.js'));
}
{
    // Declaration styles V8 names. Each must count as already declared at base.
    const styles = {
        fnDecl: 'function fnDecl(a) {}',
        asyncGen: 'async function* asyncGen() {}',
        arrow: 'const arrow = (x) => x;',
        bareArrow: 'let bareArrow = x => x;',
        fnExpr: 'var fnExpr = function () {};',
        prop: 'const o = { prop: () => 1 };',
        assigned: 'module.exports.assigned = function () {};',
        method: 'class K {\n    method(a, b) {\n    }\n}',
        Klass: 'class Klass {}',
    };
    for (const [name, text] of Object.entries(styles)) check(`declares() finds the ${name} style`, cd.declares(text, name), text);
    check('declares() does not count a call as a declaration', !cd.declares('sleep(5);\nconst x = sleep(1);', 'sleep'));
    check('declares() does not count a comment mention', !cd.declares('// readRange is next\n', 'readRange'));
    check('declares() treats a missing base file as declaring nothing', !cd.declares(null, 'x'));
    check('lineOf maps an offset to its 1-based line', cd.lineOf('a\nbc\nd', 0) === 1 && cd.lineOf('a\nbc\nd', 3) === 2 && cd.lineOf('a\nbc\nd', 5) === 3);
    check('evalFloors reads a floors file without a require', (cd.evalFloors("module.exports = { FLOORS: { linux: { untested: 3, neverLoaded: 1 } } };") || {}).FLOORS.linux.untested === 3);
    check('evalFloors returns null for a missing base file', cd.evalFloors(null) === null);
}

// --- the CLI, over git fixtures -------------------------------------------------

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-diff-suite-'));
const cfg = path.join(scratch, 'config');
fs.mkdirSync(cfg);

function sh(dir, args) {
    const r = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=.no-hooks', '-c', 'commit.gpgsign=false', ...args],
        { cwd: dir, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
}

const LIB = [
    "'use strict';",
    'function used() { return 1; }',
    'function legacyUnused(a) { return a; }',
    'module.exports = { used, legacyUnused };',
    '',
].join('\n');
const SUITE = [
    "'use strict';",
    "const lib = require('../plugins/p/scripts/lib.js');",
    "if (lib.used() !== 1) { console.log('FAIL used'); process.exitCode = 1; } else console.log('PASS used');",
    '',
].join('\n');

let n = 0;
/** A fixture repo with a `base` branch; returns its dir. `floors` writes tooling/coverage-floors.js. */
function fixture({ floors = null } = {}) {
    const dir = path.join(scratch, `repo-${++n}`);
    fs.mkdirSync(path.join(dir, 'plugins', 'p', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tooling'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0', scripts: {
        gate: 'npm test && npm run check:agents-md',
        'check:agents-md': 'node -e "process.exit(0)"',
    } }, null, 2));
    fs.writeFileSync(path.join(dir, 'plugins', 'p', 'scripts', 'lib.js'), LIB);
    fs.writeFileSync(path.join(dir, 'tooling', 'test-lib.js'), SUITE);
    if (floors !== null) fs.writeFileSync(path.join(dir, 'tooling', 'coverage-floors.js'), floorsText(floors));
    sh(dir, ['init', '-q', '-b', 'main']);
    sh(dir, ['add', '.']);
    sh(dir, ['commit', '-q', '-m', 'base']);
    sh(dir, ['branch', 'base']);
    const top = sh(dir, ['rev-parse', '--show-toplevel']).trim();
    if (path.resolve(top).toLowerCase() !== path.resolve(fs.realpathSync.native(dir)).toLowerCase()
        && path.resolve(top).toLowerCase() !== path.resolve(dir).toLowerCase()) throw new Error(`fixture is inside another repo: ${top}`);
    return dir;
}
const floorsText = (u) => `'use strict';\nconst FLOORS = { ${process.platform}: { untested: ${u}, neverLoaded: 1, measured: 'fixture' } };\nconst REFUSED_BY_DESIGN = {};\nmodule.exports = { FLOORS, REFUSED_BY_DESIGN };\n`;

function gateFast(dir) {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
    delete env.NODE_V8_COVERAGE;
    const r = spawnSync(process.execPath, [GATE_FAST, '--root', dir, '--base', 'base'], { encoding: 'utf8', env, windowsHide: true });
    const json = spawnSync(process.execPath, [GATE_FAST, '--root', dir, '--base', 'base', '--json'], { encoding: 'utf8', env, windowsHide: true });
    let parsed = null;
    // The run-record line follows the JSON on stdout, so read up to the last brace.
    try { parsed = JSON.parse(json.stdout.slice(json.stdout.indexOf('{'), json.stdout.lastIndexOf('}') + 1)); } catch { /* reported by the caller */ }
    return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), jsonCode: json.status, cov: parsed && parsed.touched && parsed.touched.coverage };
}
const libPath = (dir) => path.join(dir, 'plugins', 'p', 'scripts', 'lib.js');
const addFn = (dir, body, exportIt = true) => fs.writeFileSync(libPath(dir), LIB.replace('module.exports = { used, legacyUnused };',
    `${body}\nmodule.exports = { used, legacyUnused${exportIt ? ', ' + /function (\w+)/.exec(body)[1] : ''} };`));

try {
    // 1. THE PLANT: a function the diff adds and no suite enters.
    {
        const d = fixture();
        addFn(d, 'function plantedNeverCalled() { return 2; }');
        const r = gateFast(d);
        check('an added, never-entered function exits 1', r.code === 1, r.out);
        check('the verdict names exactly the planted function and its line',
            /✗ plugins\/p\/scripts\/lib\.js:4 plantedNeverCalled\(\) added and entered by no touched suite/.test(r.out), r.out);
        check('it does not name the legacy never-called function', !/legacyUnused/.test(r.out), r.out);
        check('the coverage row is in the FAIL line', /FAIL — .*coverage of the diff/.test(r.out), r.out);
        check('--json carries the verdict and the same exit',
            r.jsonCode === 1 && r.cov && r.cov.status === 'FAIL' && r.cov.unentered.length === 1 && r.cov.unentered[0].name === 'plantedNeverCalled', JSON.stringify(r.cov));
    }
    // 2. The same function, entered by the suite: PASS, and the population printed.
    {
        const d = fixture();
        addFn(d, 'function plantedNeverCalled() { return 2; }');
        fs.writeFileSync(path.join(d, 'tooling', 'test-lib.js'), SUITE + 'lib.plantedNeverCalled();\n');
        const r = gateFast(d);
        check('an added function a touched suite enters exits 0', r.code === 0, r.out);
        check('the PASS line states what it graded',
            /coverage of the diff: PASS, 1 changed plugin source\(s\), [1-9]\d* dump\(s\): 1 added function\(s\), 0 never entered/.test(r.out), r.out);
    }
    // 3. A diff with no plugin source pays nothing and grades nothing.
    {
        const d = fixture();
        fs.writeFileSync(path.join(d, 'tooling', 'test-lib.js'), SUITE + '// a comment\n');
        const r = gateFast(d);
        check('a diff that changes no plugin source exits 0', r.code === 0, r.out);
        check('and says nothing was graded', /coverage of the diff: PASS, 0 changed plugin sources, nothing graded/.test(r.out), r.out);
    }
    // 4. Editing the declaration line of a function the base already declared is not an addition.
    {
        const d = fixture();
        fs.writeFileSync(libPath(d), LIB.replace('function legacyUnused(a) { return a; }', 'function legacyUnused(a, b) { return a || b; }'));
        const r = gateFast(d);
        check('an edited declaration of an existing never-called function exits 0', r.code === 0, r.out);
        check('and is graded as 0 added', /0 added function\(s\), 0 never entered/.test(r.out), r.out);
    }
    // 5. An added plugin source no touched suite loads.
    {
        const d = fixture();
        fs.writeFileSync(path.join(d, 'plugins', 'p', 'scripts', 'orphan.js'), "'use strict';\nfunction orphan() {}\nmodule.exports = { orphan };\n");
        const r = gateFast(d);
        check('an added source no touched suite loads exits 1', r.code === 1, r.out);
        check('the verdict names the file', /✗ plugins\/p\/scripts\/orphan\.js added and loaded by no touched suite/.test(r.out), r.out);
    }
    // 6. Parity: a diff that raises the release ceiling by one may add one never-entered function.
    {
        const d = fixture({ floors: 5 });
        addFn(d, 'function platformGated() { return 3; }');
        fs.writeFileSync(path.join(d, 'tooling', 'coverage-floors.js'), floorsText(6));
        const r = gateFast(d);
        check('a ceiling raised by 1 admits 1 never-entered function', r.code === 0, r.out);
        check('the allowance is printed', /1 never entered \(allowance 1\)/.test(r.out), r.out);
        // ...and only one.
        addFn(d, 'function platformGated() { return 3; }\nfunction secondGated() { return 4; }', false);
        const r2 = gateFast(d);
        check('the same raise does not admit a second', r2.code === 1 && /secondGated\(\)/.test(r2.out) && /platformGated\(\)/.test(r2.out), r2.out);
    }
    // 7. No raise, same floors file at base and head: no allowance.
    {
        const d = fixture({ floors: 5 });
        addFn(d, 'function platformGated() { return 3; }');
        const r = gateFast(d);
        check('an unchanged ceiling admits nothing', r.code === 1 && /\(allowance 0\)/.test(r.out), r.out);
    }
} finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
