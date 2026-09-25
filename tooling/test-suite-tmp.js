#!/usr/bin/env node
// Tests tooling/suite-tmp.js: every suite child gets its own temp root, and the
// root is gone when the child ends, whatever the child did.
//
// Why this exists: `[measured 2026-09-25]` the suites here leave their mkdtemp
// fixtures in os.tmpdir(), and one machine's temp directory gained 62,325
// entries in a day. The fix lives in the runners, so what has to be proven is
// the runners' behaviour, not any one suite's:
//
//   1. test-all.js, run over planted suites that leak, leaves NOTHING in the
//      temp dir it was given, and still reports PASS for the passing suite and
//      FAIL for the failing one. A control runs the same leaky suite without
//      the runner and counts what it leaves, so "nothing left" is the runner's
//      doing and not a fixture that never leaked.
//   2. A suite killed at its budget loses its root too, and the verdict stays
//      "no verdict" (driven through the --run CLI, a real subprocess).
//   3. A root that cannot be removed is reported on one line and does not
//      change the exit status the caller sees, for a red child and a green one.
//   4. A root that cannot be created leaves the suite running, on the shared
//      temp dir, with its own verdict.
//   5. Case variants of TEMP/TMP/TMPDIR in the base env are replaced, never
//      left beside the new keys, and the child's os.tmpdir() is the root.
//   6. The four runners that start suites all route through the helper.
//
// Run: node tooling/test-suite-tmp.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tally, exitCode } = require('./spawn-budget.js');
const st = require('./suite-tmp.js');

const TOOLING = __dirname;
const HELPER = path.join(TOOLING, 'suite-tmp.js');

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);
let infra = 0;
const indeterminate = [];

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'suitetmptest'));
process.on('exit', () => {
    try { fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* reported by nobody: WORK is itself under a runner's root */ }
});
const mk = (name) => { const d = path.join(WORK, name); fs.mkdirSync(d, { recursive: true }); return d; };
const entries = (d) => fs.readdirSync(d);
const tmpEnv = (dir) => st.envWithTmp(process.env, dir);

// A leaky suite: three fixtures in os.tmpdir(), one holding a read-only file and
// one a nested tree (git objects are read-only, and fixtures nest), then it
// records the os.tmpdir() it saw into RECORDS so the test can find the root.
const RECORDS = mk('records');
const leaky = (name, exit) => [
    "const fs = require('fs'), os = require('os'), path = require('path');",
    "const a = fs.mkdtempSync(path.join(os.tmpdir(), 'leakfixture-'));",
    "fs.writeFileSync(path.join(a, 'ro.txt'), 'x'); fs.chmodSync(path.join(a, 'ro.txt'), 0o444);",
    "const b = fs.mkdtempSync(path.join(os.tmpdir(), 'leakfixture-'));",
    "fs.mkdirSync(path.join(b, 'deep', 'er'), { recursive: true }); fs.writeFileSync(path.join(b, 'deep', 'er', 'f'), 'y');",
    "fs.mkdtempSync(path.join(os.tmpdir(), 'leakfixture-'));",
    `fs.writeFileSync(path.join(${JSON.stringify(RECORDS)}, ${JSON.stringify(name)}), os.tmpdir());`,
    `process.exit(${exit});`,
].join('\n') + '\n';

// --- 1. test-all.js over planted suites ------------------------------------
{
    const root = mk('fixture-root');
    const tooling = path.join(root, 'tooling');
    fs.mkdirSync(tooling);
    fs.copyFileSync(path.join(TOOLING, 'test-all.js'), path.join(tooling, 'test-all.js'));
    fs.copyFileSync(HELPER, path.join(tooling, 'suite-tmp.js'));
    fs.writeFileSync(path.join(tooling, 'validate.js'), 'process.exit(0);\n');
    fs.writeFileSync(path.join(tooling, 'test-a-leak-pass.js'), leaky('a', 0));
    fs.writeFileSync(path.join(tooling, 'test-b-leak-fail.js'), leaky('b', 1));

    const parent = mk('runner-parent');
    const r = spawnSync(process.execPath, [path.join(tooling, 'test-all.js')], {
        cwd: root, encoding: 'utf8', timeout: 120000, env: tmpEnv(parent),
    });
    const out = (r.stdout || '') + (r.stderr || '');
    if (r.error || r.signal) {
        infra++;
        indeterminate.push('the fixture runner did not finish (' + (r.error ? r.error.code : r.signal) + ')');
    } else {
        check('test-all.js over a passing and a failing leaky suite exits 1', r.status === 1, 'exit ' + r.status);
        // The runner pads its state to five columns, then two spaces: `PASS   x`.
        check('  and still reports the passing suite PASS', /^PASS +test-a-leak-pass\s*$/m.test(out), out.slice(-600));
        check('  and the failing suite FAIL', /^FAIL +test-b-leak-fail\s*$/m.test(out), out.slice(-600));
        check('  and leaves NOTHING in the temp dir it was given', entries(parent).length === 0,
            entries(parent).join(', '));
        const seen = ['a', 'b'].map((n) => {
            try { return fs.readFileSync(path.join(RECORDS, n), 'utf8'); } catch { return null; }
        });
        check('both planted suites ran and recorded their os.tmpdir()', seen.every(Boolean), JSON.stringify(seen));
        if (seen.every(Boolean)) {
            check('  each saw its own root, named adsuite*, directly under the given temp dir',
                seen[0] !== seen[1] && seen.every((d) => path.dirname(d) === parent && path.basename(d).startsWith(st.PREFIX)),
                JSON.stringify(seen));
            check('  and neither root exists afterwards', seen.every((d) => !fs.existsSync(d)), JSON.stringify(seen));
        }
    }

    // CONTROL, derived from the subject: the same suite run bare leaks. Without
    // this, an empty parent above could mean the fixture never wrote anything.
    const bare = mk('bare-parent');
    const c = spawnSync(process.execPath, [path.join(tooling, 'test-a-leak-pass.js')], {
        encoding: 'utf8', timeout: 60000, env: tmpEnv(bare),
    });
    check('control: the same suite run without a runner leaves its 3 fixtures behind',
        c.status === 0 && entries(bare).filter((n) => n.startsWith('leakfixture-')).length === 3,
        `exit ${c.status}, left: ${entries(bare).join(', ')}`);
}

// --- 2. a suite killed at its budget ---------------------------------------
{
    const hang = path.join(mk('hang'), 'test-hang.js');
    fs.writeFileSync(hang, [
        "const fs = require('fs'), os = require('os'), path = require('path');",
        "const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hangfixture-'));",
        "fs.writeFileSync(path.join(d, 'held.txt'), 'x');",
        `fs.writeFileSync(path.join(${JSON.stringify(RECORDS)}, 'hang'), os.tmpdir());`,
        'setInterval(() => {}, 1000);',
    ].join('\n') + '\n');
    const parent = mk('hang-parent');
    const r = spawnSync(process.execPath, [HELPER, '--run', hang, '--timeout', '8000'], {
        encoding: 'utf8', timeout: 120000, env: tmpEnv(parent),
    });
    let rec = null;
    try { rec = fs.readFileSync(path.join(RECORDS, 'hang'), 'utf8'); } catch { /* checked below */ }
    if (r.error || r.signal || rec === null) {
        // The hang must have STARTED and written before the kill, or an empty
        // parent proves nothing about removal. Not a verdict either way.
        infra++;
        indeterminate.push('the hanging suite never recorded its root before the budget ('
            + (r.error ? r.error.code : r.signal || 'no record') + ')');
    } else {
        check('a suite killed at its budget is reported INDET, not PASS or FAIL',
            r.status === 2 && /^INDET {2}test-hang \(ETIMEDOUT\)/m.test(r.stdout), `exit ${r.status}: ${r.stdout}`);
        check('  its root is removed after the kill', /temp root removed/.test(r.stdout) && !fs.existsSync(rec),
            r.stdout + ' root=' + rec);
        check('  and the temp dir it was given is empty', entries(parent).length === 0, entries(parent).join(', '));
    }
}

// --- 3. a root that cannot be removed ---------------------------------------
{
    const parent = mk('rm-parent');
    for (const exit of [1, 0]) {
        const lines = [];
        const busy = () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; };
        const r = st.spawnSuiteSync(process.execPath, ['-e', `process.exit(${exit})`],
            { encoding: 'utf8' }, { label: 'rm-' + exit, parent, log: (l) => lines.push(l), rm: busy });
        check(`removal failure leaves an exit ${exit} as exit ${exit}`, r.status === exit, 'exit ' + r.status);
        check('  and is reported on exactly one line naming the root',
            lines.length === 1 && lines[0].includes('temp root not removed (EBUSY)') && lines[0].includes(r.tmpRoot),
            JSON.stringify(lines));
        check('  and the result says it was not removed', r.tmpRemoved === false && fs.existsSync(r.tmpRoot),
            `tmpRemoved=${r.tmpRemoved}`);
        fs.rmSync(r.tmpRoot, { recursive: true, force: true });
    }
    // Control: the same call with the real remover removes it and logs nothing.
    const lines = [];
    const r = st.spawnSuiteSync(process.execPath, ['-e', 'process.exit(1)'],
        { encoding: 'utf8' }, { label: 'rm-real', parent, log: (l) => lines.push(l) });
    check('control: with the real remover the root is gone and nothing is logged',
        r.status === 1 && r.tmpRemoved === true && !fs.existsSync(r.tmpRoot) && lines.length === 0,
        `exit ${r.status} tmpRemoved=${r.tmpRemoved} lines=${JSON.stringify(lines)}`);
}

// --- 4. a root that cannot be created ---------------------------------------
{
    const lines = [];
    const nowhere = path.join(WORK, 'no-such-parent');
    const r = st.spawnSuiteSync(process.execPath, ['-e', 'process.exit(1)'],
        { encoding: 'utf8' }, { label: 'mk', parent: nowhere, log: (l) => lines.push(l) });
    check('a root that cannot be created: the suite still runs and keeps its exit 1',
        r.status === 1 && r.tmpRoot === null && r.tmpRemoved === null, `exit ${r.status} root=${r.tmpRoot}`);
    check('  and it is said on one line', lines.length === 1 && /temp root not created \(ENOENT\)/.test(lines[0]),
        JSON.stringify(lines));
}

// --- 5. the child's temp variables -----------------------------------------
{
    const env = st.envWithTmp({ Temp: 'a', tmp: 'b', TmpDir: 'c', PATH_LIKE: 'kept' }, 'ROOT');
    const tmpish = Object.keys(env).filter((k) => st.TMP_KEYS.includes(k.toUpperCase()));
    check('case variants of TEMP/TMP/TMPDIR are dropped, not left beside the new keys',
        tmpish.sort().join(',') === 'TEMP,TMP,TMPDIR' && tmpish.every((k) => env[k] === 'ROOT'),
        JSON.stringify(env));
    check('  and every other variable is kept', env.PATH_LIKE === 'kept', JSON.stringify(env));

    const base = Object.assign({}, process.env, { Temp: path.join(WORK, 'stale-variant') });
    const r = st.spawnSuiteSync(process.execPath, ['-e', "process.stdout.write(require('os').tmpdir())"],
        { encoding: 'utf8', env: base }, { label: 'env', parent: mk('env-parent') });
    check("the child's os.tmpdir() is its root, even with a stale case variant in the base env",
        r.status === 0 && r.stdout === r.tmpRoot, `child=${r.stdout} root=${r.tmpRoot}`);
}

// --- 6. every runner routes through the helper ------------------------------
// The four places that start a suite as a child. A fifth runner added without
// the helper leaks again, so a new one belongs in this list.
const RUNNERS = ['test-all.js', 'check-suites-can-fail.js', 'find-untested-functions.js', 'find-vacuous-assertions.js'];
for (const f of RUNNERS) {
    const src = fs.readFileSync(path.join(TOOLING, f), 'utf8');
    check(`${f} requires suite-tmp.js and starts suites with spawnSuiteSync`,
        /require\('\.\/suite-tmp\.js'\)/.test(src) && /spawnSuiteSync\(/.test(src));
}

let pass = 0, fail = 0;
for (const [label, ok, detail] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok || !detail ? '' : '  -> ' + detail));
    ok ? pass++ : fail++;
}
console.log(`\n${tally(pass, fail, infra)}  (runners checked: ${RUNNERS.length}, subject: tooling/suite-tmp.js)`);
if (infra) console.log(`indeterminate: ${indeterminate.join(' | ')}`);
process.exitCode = exitCode(fail, infra);
