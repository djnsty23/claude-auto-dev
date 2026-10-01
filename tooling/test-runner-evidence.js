#!/usr/bin/env node
// test-runner-evidence.js - what tooling/test-all.js reports, and what the
// coverage receipt it publishes can and cannot be made to claim.
//
// Every case runs the REAL runner (a copy of tooling/test-all.js with its
// helpers) over a small fixture repo of planted suites, as a subprocess, so the
// exit code and the printed summary are the ones a gate reads.
//
//   1. HEAD moves while the status stays clean: INDETERMINATE (exit 2) with the
//      two HEADs printed as evidence, never a pass.
//   2. HEAD stable and a suite modifies a file: tree-inert FAILS (exit 1).
//   3. A suite fails on its own in a run where HEAD also moved: it stays FAIL
//      beside the INDET tree row, and the run exits 1, not 2.
//   4. Coverage gathered per suite and published as a receipt gives the same
//      census as one shared NODE_V8_COVERAGE directory, including a function
//      entered only by a suite's CHILD process and a file nothing loads.
//   5. The receipt cannot vouch for what it did not see: a missing dump, a
//      suite that never ran, a source changed since the run, a red run and a
//      runner killed mid-run are each refused, never read as exit 0.
//   6. A report far larger than a pipe buffer arrives whole, and the runner
//      never calls process.exit().
//   7. The runOne interface: a pool module drives it, a broken one fails
//      visibly, --serial ignores it, and absence means serial.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RUNNER = path.join(__dirname, 'test-all.js');
const RECEIPT_LIB = path.join(__dirname, 'coverage-receipt.js');
const SUITE_TMP = path.join(__dirname, 'suite-tmp.js');
const CENSUS = path.join(__dirname, 'find-untested-functions.js');
const receipts = require('./coverage-receipt.js');

let pass = 0;
let fail = 0;
let infra = 0;
const indeterminate = [];
function check(name, ok, detail) {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1500)}`);
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'runnerev'));
process.on('exit', () => { try { fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp debris only */ } });

// The environment every fixture process gets: git variables a hook might have
// set would point git at the wrong repo, and an inherited coverage directory
// or receipt store would mix this suite's evidence with the outer run's.
function cleanEnv(extra) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        const K = k.toUpperCase();
        if (K.startsWith('GIT_') || K === 'NODE_V8_COVERAGE' || K === 'AUTODEV_COVERAGE_STORE' || K === 'CLAUDE_CONFIG_DIR') continue;
        env[k] = v;
    }
    return Object.assign(env, { GIT_AUTHOR_NAME: 'fx', GIT_AUTHOR_EMAIL: 'fx@example.invalid', GIT_COMMITTER_NAME: 'fx', GIT_COMMITTER_EMAIL: 'fx@example.invalid' }, extra || {});
}

const git = (root, args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: cleanEnv(), windowsHide: true });

// A fixture repo: the real runner and its helpers, a trivial validate, the
// given suites and plugin files, committed. The receipt store sits BESIDE the
// root, never inside it, or the runner's own output would dirty the tree.
let n = 0;
const TOOL_DIR = 'tooling';
function fixture(spec) {
    const root = path.join(WORK, 'fx' + (++n));
    const tooling = path.join(root, TOOL_DIR);
    fs.mkdirSync(tooling, { recursive: true });
    fs.mkdirSync(path.join(root, 'plugins', 'fxr', 'scripts'), { recursive: true });
    for (const src of [RUNNER, RECEIPT_LIB, SUITE_TMP]) fs.copyFileSync(src, path.join(tooling, path.basename(src)));
    fs.writeFileSync(path.join(tooling, 'validate' + '.js'), "console.log('validate ok');\n");
    for (const [name, body] of Object.entries(spec.suites || {})) fs.writeFileSync(path.join(tooling, name), body);
    for (const [name, body] of Object.entries(spec.plugins || {})) fs.writeFileSync(path.join(root, 'plugins', 'fxr', 'scripts', name), body);
    if (spec.pool) fs.writeFileSync(path.join(tooling, receipts.POOL_FILE), spec.pool);
    fs.writeFileSync(path.join(root, '.gitignore'), 'scratch/\n');
    git(root, ['init', '-q']);
    git(root, ['add', '-A']);
    const c = git(root, ['commit', '-qm', 'fixture']);
    if (c.status !== 0) throw new Error('fixture commit failed: ' + c.stderr);
    if (spec.afterCommit) spec.afterCommit(root);
    const store = root + '-store';
    return { root, store, tooling };
}

function runAll(fx, args, opts) {
    const o = opts || {};
    return spawnSync(process.execPath, [path.join(fx.tooling, 'test-all.js'), ...(args || [])], {
        cwd: fx.root, encoding: 'utf8', timeout: o.timeout || 180000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
        env: cleanEnv({ AUTODEV_COVERAGE_STORE: fx.store }),
    });
}
const out = (r) => (r.stdout || '') + (r.stderr || '');
const row = (r, state, label) => new RegExp('^' + state + ' +' + label.replace(/[-.]/g, '\\$&') + '\\s*$', 'm').test(out(r));
const readReceipt = (fx) => { try { return JSON.parse(fs.readFileSync(path.join(fx.store, 'receipt.json'), 'utf8')); } catch { return null; } };
const checkReceipt = (fx) => receipts.check(fx.root, { AUTODEV_COVERAGE_STORE: fx.store });
const finished = (r, what) => {
    if (r.error || r.signal) { infra++; indeterminate.push(`${what} did not finish (${r.error ? r.error.code : r.signal})`); return false; }
    return true;
};

const PASSING = "console.log('ok');\n";
const FAILING = "console.log('FAIL  planted'); process.exitCode = 1;\n";
// Commits from inside the run: HEAD moves, and the tree is clean before and after.
const COMMITS = "const { spawnSync } = require('child_process');\n"
    + "const r = spawnSync('git', ['commit', '--allow-empty', '-qm', 'mid-run'], { cwd: require('path').join(__dirname, '..'), encoding: 'utf8' });\n"
    + "process.exitCode = r.status === 0 ? 0 : 3;\n";
// Rewrites a tracked file and leaves it changed.
const MODIFIES = "require('fs').appendFileSync(require('path').join(__dirname, '..', 'README.md'), 'touched by a suite\\n');\n";

async function main() {
    // --- 1. HEAD moves, status stays clean --------------------------------------
    {
        const fx = fixture({ suites: { 'test-a-commits.js': COMMITS, 'test-b-ok.js': PASSING } });
        const before = git(fx.root, ['rev-parse', 'HEAD']).stdout.trim();
        const r = runAll(fx);
        if (finished(r, 'case 1 runner')) {
            const after = git(fx.root, ['rev-parse', 'HEAD']).stdout.trim();
            check('1. control: the planted suite did move HEAD and left the status clean',
                before !== after && git(fx.root, ['status', '--porcelain']).stdout.trim() === '', { before, after });
            check('1. HEAD moved, status clean: the runner exits 2 (INDETERMINATE), not 0', r.status === 2, `exit ${r.status}\n${out(r).slice(-1500)}`);
            check('1. the summary row is INDET tree-inert, and both suites still PASS',
                row(r, 'INDET', 'tree-inert') && row(r, 'PASS ', 'test-a-commits') && row(r, 'PASS ', 'test-b-ok'), out(r).slice(-800));
            const ev = (out(r).match(/^evidence: (.*)$/m) || [])[1];
            let parsed = null;
            try { parsed = JSON.parse(ev); } catch { /* asserted below */ }
            check('1. the evidence names both HEADs as structured data',
                parsed && parsed.headBefore === before && parsed.headAfter === after, ev);
            const rc = readReceipt(fx);
            check('1. the receipt records it as indeterminate, with the evidence',
                rc && rc.verdict === 'indet' && rc.treeInert && rc.treeInert.why === 'head-moved' && rc.treeInert.evidence.headAfter === after, rc && rc.treeInert);
            const c = checkReceipt(fx);
            check('1. and the coverage gate refuses that receipt', !c.ok && /did not pass/.test(c.problem), c.problem);
        }
    }

    // --- 2. HEAD stable, a suite modifies a file -------------------------------
    {
        const fx = fixture({ suites: { 'test-a-modifies.js': MODIFIES, 'test-b-ok.js': PASSING } });
        fs.writeFileSync(path.join(fx.root, 'README.md'), 'readme\n');
        git(fx.root, ['add', 'README.md']);
        git(fx.root, ['commit', '-qm', 'readme']);
        const r = runAll(fx);
        if (finished(r, 'case 2 runner')) {
            check('2. control: the planted suite did modify the tracked file',
                /M README\.md/.test(git(fx.root, ['status', '--porcelain']).stdout), git(fx.root, ['status', '--porcelain']).stdout);
            check('2. HEAD stable and the tree modified: exit 1 and FAIL tree-inert',
                r.status === 1 && row(r, 'FAIL ', 'tree-inert'), `exit ${r.status}\n${out(r).slice(-1200)}`);
            check('2. the message says a suite rewrote the tree and names the file',
                /MODIFIED THE WORKING TREE/.test(out(r)) && /now: +M README\.md/.test(out(r)), out(r).slice(-1200));
        }
    }

    // --- 3. an independent failure alongside a HEAD move -----------------------
    {
        const fx = fixture({ suites: { 'test-a-commits.js': COMMITS, 'test-b-fails.js': FAILING } });
        const r = runAll(fx);
        if (finished(r, 'case 3 runner')) {
            check('3. a suite that failed on its own stays FAIL beside INDET tree-inert',
                row(r, 'FAIL ', 'test-b-fails') && row(r, 'INDET', 'tree-inert'), out(r).slice(-800));
            check('3. and the run exits 1: a commit elsewhere cannot turn a red into "no verdict"', r.status === 1, `exit ${r.status}`);
            const rc = readReceipt(fx);
            const o = rc && rc.outcomes.find((x) => x.label === 'test-b-fails');
            check('3. the receipt keeps the failure as a failure', rc && rc.verdict === 'fail' && o && o.state === 'fail', rc && rc.outcomes);
        }
    }

    // --- 4. shared vs per-suite coverage give the same census ------------------
    let goodFx = null;
    {
        const plugins = {
            'fxr-census-a.js': 'function enteredInProcess() { return 1; }\nfunction neverEnteredA() { return 2; }\nmodule.exports = { enteredInProcess, neverEnteredA };\n',
            'fxr-census-b.js': 'function enteredByAChild() { return 3; }\nfunction neverEnteredB() { return 4; }\nmodule.exports = { enteredByAChild, neverEnteredB };\nif (require.main === module) enteredByAChild();\n',
            'fxr-census-orphan.js': 'function orphanNeverLoaded() { return 5; }\nmodule.exports = { orphanNeverLoaded };\n',
        };
        const suites = {
            'test-a-inproc.js': "const a = require('../plugins/fxr/scripts/fxr-census-a.js'); a.enteredInProcess(); console.log('ok');\n",
            // The function is entered ONLY in the child: a reduction that keeps
            // the suite's own dump and drops its children loses it.
            'test-b-child.js': "const { spawnSync } = require('child_process'); const path = require('path');\n"
                + "const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'plugins', 'fxr', 'scripts', 'fxr-census-b.js')], { stdio: 'inherit' });\n"
                + "process.exitCode = r.status;\n",
        };
        const fx = fixture({ suites, plugins });
        goodFx = fx;
        const r = runAll(fx);
        if (finished(r, 'case 4 runner')) {
            check('4. control: the fixture run passed and published a receipt', r.status === 0 && readReceipt(fx) && readReceipt(fx).verdict === 'pass', `exit ${r.status}\n${out(r).slice(-1200)}`);
            const census = (mode) => spawnSync(process.execPath, [CENSUS, '--root', fx.root, mode, '--max-untested', '99', '--max-never-loaded', '99', '--json'], {
                cwd: fx.root, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
                env: cleanEnv({ AUTODEV_COVERAGE_STORE: fx.store }),
            });
            const fresh = census('--fresh');
            const fromReceipt = census('--receipt');
            let a = null;
            let b = null;
            try { a = JSON.parse(fresh.stdout); } catch { /* asserted below */ }
            try { b = JSON.parse(fromReceipt.stdout); } catch { /* asserted below */ }
            const pick = (j) => j && JSON.stringify({
                untested: j.untested.map((u) => u.file + '::' + u.name),
                neverLoaded: j.filesNeverLoaded, noNamed: j.filesLoadedNoNamedFunctions,
                seen: j.functionsSeen, executed: j.executed, loaded: j.filesLoaded,
            });
            check('4. both censuses ran to a verdict', fresh.status === 0 && fromReceipt.status === 0 && a && b,
                `fresh ${fresh.status} receipt ${fromReceipt.status}\n${(fresh.stderr || '').slice(-400)}\n${(fromReceipt.stderr || '').slice(-400)}`);
            if (a && b) {
                check('4. one shared coverage directory and per-suite dumps give IDENTICAL lists', pick(a) === pick(b), `fresh ${pick(a)}\nreceipt ${pick(b)}`);
                check('4. the receipt census came from the receipt and spawned no test', b.source === 'receipt' && b.receipt && b.receipt.suites === 3, b.receipt);
                const names = b.untested.map((u) => u.name).sort().join(',');
                check('4. control: the census is not trivial (two never-entered, the child-entered one counted as entered)',
                    names === 'neverEnteredA,neverEnteredB' && b.executed === 2, names);
                check('4. control: the file nothing loads is in the never-loaded census',
                    b.filesNeverLoaded.length === 1 && /fxr-census-orphan\.js$/.test(b.filesNeverLoaded[0]), b.filesNeverLoaded);
            }
        }
    }

    // --- 5. what the receipt cannot vouch for ----------------------------------
    if (goodFx && readReceipt(goodFx)) {
        const fx = goodFx;
        const base = fs.readFileSync(path.join(fx.store, 'receipt.json'), 'utf8');
        const reset = () => fs.writeFileSync(path.join(fx.store, 'receipt.json'), base);
        check('5. control: the untouched receipt is accepted', checkReceipt(fx).ok, checkReceipt(fx).problem);

        // a missing dump
        const rc = JSON.parse(base);
        const dumpFile = path.join(rc.runDir, rc.dumps[0].file);
        const saved = fs.readFileSync(dumpFile);
        fs.unlinkSync(dumpFile);
        const missing = checkReceipt(fx);
        fs.writeFileSync(dumpFile, saved);
        check('5. a missing dump file is refused, not read as an empty suite', !missing.ok && /missing dump/.test(missing.problem), missing.problem);

        // a dump file that is there but is not the one the run wrote
        fs.writeFileSync(dumpFile, saved.toString('utf8').replace('"files":{', '"files":{"x":{},'));
        const altered = checkReceipt(fx);
        fs.writeFileSync(dumpFile, saved);
        check('5. an altered dump file is refused by its hash', !altered.ok && /altered dump/.test(altered.problem), altered.problem);

        // a suite whose process left no dump: exit 0 is not coverage
        const zero = JSON.parse(base); zero.dumps[0].rawDumps = 0;
        fs.writeFileSync(path.join(fx.store, 'receipt.json'), JSON.stringify(zero));
        const noDump = checkReceipt(fx);
        reset();
        check('5. a suite that exited 0 but left no coverage dump is refused', !noDump.ok && /left 0 coverage dump/.test(noDump.problem), noDump.problem);

        // an omitted suite
        const omit = JSON.parse(base); omit.executedSuites = omit.executedSuites.slice(1);
        fs.writeFileSync(path.join(fx.store, 'receipt.json'), JSON.stringify(omit));
        const partial = checkReceipt(fx);
        reset();
        check('5. a receipt whose run omitted an expected suite is refused', !partial.ok && /never ran/.test(partial.problem), partial.problem);

        // a suite added after the run
        const extra = path.join(fx.tooling, 'test-c-added.js');
        fs.writeFileSync(extra, PASSING);
        const added = checkReceipt(fx);
        fs.unlinkSync(extra);
        check('5. a suite added after the run makes the receipt stale or partial', !added.ok && /(stale|partial)/.test(added.problem), added.problem);

        check('5. control: after every restore the receipt is accepted again', checkReceipt(fx).ok, checkReceipt(fx).problem);

        // a red run
        const red = JSON.parse(base); red.verdict = 'fail'; red.outcomes[0].state = 'fail';
        fs.writeFileSync(path.join(fx.store, 'receipt.json'), JSON.stringify(red));
        const redC = checkReceipt(fx);
        reset();
        check('5. a red run is refused even though every dump is present', !redC.ok && /did not pass/.test(redC.problem), redC.problem);
    }
    {
        // An old receipt: a source edited after the run, on a file that was
        // ALREADY dirty, so the porcelain status does not change and only the
        // source hashes can see it.
        const fx = fixture({
            suites: { 'test-a-ok.js': PASSING },
            plugins: { 'fxr-stale.js': 'function stale() { return 1; }\nmodule.exports = { stale };\n' },
        });
        const src = path.join(fx.root, 'plugins', 'fxr', 'scripts', 'fxr-stale.js');
        fs.appendFileSync(src, '// dirty before the run\n');
        const r = runAll(fx);
        if (finished(r, 'case 5 stale runner')) {
            const statusBefore = git(fx.root, ['status', '--porcelain']).stdout;
            check('5. control: the stale-case run passed and its receipt is accepted', r.status === 0 && checkReceipt(fx).ok, `exit ${r.status} ${checkReceipt(fx).problem}`);
            fs.appendFileSync(src, '// edited after the run\n');
            check('5. control: the porcelain status did not change', git(fx.root, ['status', '--porcelain']).stdout === statusBefore);
            const c = checkReceipt(fx);
            check('5. a source edited after the run makes the receipt stale, by its hash', !c.ok && /stale receipt: 1 source file/.test(c.problem), c.problem);
            git(fx.root, ['commit', '--allow-empty', '-qm', 'later']);
            const h = checkReceipt(fx);
            check('5. a commit after the run makes it stale too', !h.ok && /stale receipt/.test(h.problem), h.problem);
        }
    }
    {
        // A runner killed mid-run leaves NO receipt, even where an accepted one existed.
        const fx = fixture({ suites: { 'test-a-slow.js': "if (process.env.FX_SLOW) { require('fs').writeFileSync(process.env.FX_SLOW, String(process.pid)); setTimeout(() => {}, 60000); }\nconsole.log('ok');\n" } });
        const first = runAll(fx);
        if (finished(first, 'case 5 killed baseline')) {
            check('5. control: a receipt from a completed run exists and is accepted', first.status === 0 && checkReceipt(fx).ok, checkReceipt(fx).problem);
            const child = spawn(process.execPath, [path.join(fx.tooling, 'test-all.js')], {
                cwd: fx.root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
                env: cleanEnv({ AUTODEV_COVERAGE_STORE: fx.store, FX_SLOW: path.join(WORK, 'slow-suite.pid') }),
            });
            let seen = '';
            child.stdout.on('data', (d) => { seen += d; });
            const started = await new Promise((resolve) => {
                const t0 = Date.now();
                const iv = setInterval(() => {
                    if (/=== test-a-slow ===/.test(seen)) { clearInterval(iv); resolve(true); }
                    else if (Date.now() - t0 > 60000) { clearInterval(iv); resolve(false); }
                }, 100);
            });
            child.kill('SIGKILL');
            await new Promise((resolve) => child.on('close', resolve));
            if (!started) {
                infra++;
                indeterminate.push('the killed-runner case never reached its slow suite');
            } else {
                const c = checkReceipt(fx);
                check('5. a runner killed mid-run leaves no receipt, so the gate refuses', !c.ok && /no coverage receipt/.test(c.problem), c.problem);
            }
            // The orphaned slow suite: the runner died, so its child is ours to end.
            try { process.kill(Number(fs.readFileSync(path.join(WORK, 'slow-suite.pid'), 'utf8'))); } catch { /* already gone */ }
        }
    }

    // --- 6. a large piped report arrives whole ---------------------------------
    {
        const fx = fixture({ suites: { 'test-a-chatty.js': "process.stdout.write('z'.repeat(3 * 1024 * 1024) + '\\nCHATTY-END\\n');\n" } });
        const r = await new Promise((resolve) => {
            const child = spawn(process.execPath, [path.join(fx.tooling, 'test-all.js')], {
                cwd: fx.root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: cleanEnv({ AUTODEV_COVERAGE_STORE: fx.store }),
            });
            const chunks = [];
            // A slow reader, so the runner meets backpressure.
            child.stdout.on('data', (d) => { chunks.push(d); child.stdout.pause(); setTimeout(() => child.stdout.resume(), 2); });
            child.stderr.on('data', () => {});
            child.on('close', (code) => resolve({ code, text: Buffer.concat(chunks).toString('utf8') }));
        });
        check('6. a 3 MiB suite report piped to a slow reader arrives whole, summary last',
            r.code === 0 && r.text.includes('CHATTY-END') && /1\/1 suites passed|\d+\/\d+ suites passed/.test(r.text.slice(-4000)) && /receipt .* published/.test(r.text.slice(-2000)),
            `exit ${r.code}, ${r.text.length} bytes, tail ${JSON.stringify(r.text.slice(-300))}`);
        const rc = readReceipt(fx);
        const log = rc && path.join(rc.runDir, rc.outcomes[0].log || '');
        check('6. and the per-suite log outside the temp roots holds all of it',
            rc && fs.existsSync(log) && fs.statSync(log).size > 3 * 1024 * 1024 && fs.readFileSync(log, 'utf8').includes('CHATTY-END'), log);
        // Windows writes pipes synchronously, so exit() truncates nothing there
        // `[measured 2026-10-02]`; the property is also read from the source.
        const src = fs.readFileSync(RUNNER, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
        check('6. the runner sets process.exitCode and never calls process.exit()',
            !/process\.exit\s*\(/.test(src) && /process\.exitCode\s*=/.test(src), (src.match(/.*process\.exit\s*\(.*/) || [])[0]);
    }

    // --- 7. runOne and the optional pool --------------------------------------
    {
        const suites = { 'test-a-ok.js': PASSING, 'test-b-ok.js': PASSING, 'test-c-ok.js': PASSING };
        const record = path.join(WORK, 'pool-results.json');
        const GOOD_POOL = 'exports.runSuites = async (items, runOne) => {\n'
            + '  const out = []; let i = 0;\n'
            + '  const worker = async () => { while (i < items.length) { const it = items[i++]; out.push(await runOne(it, { echo: false })); } };\n'
            + '  await Promise.all([worker(), worker()]);\n'
            + `  require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(out));\n`
            + '  return out;\n};\n';
        const fx = fixture({ suites, pool: GOOD_POOL });
        const r = runAll(fx);
        if (finished(r, 'case 7 pool runner')) {
            let got = null;
            try { got = JSON.parse(fs.readFileSync(record, 'utf8')); } catch { /* asserted below */ }
            check('7. a pool drives runOne for every suite and the run passes', r.status === 0 && got && got.length === 3, `exit ${r.status}\n${out(r).slice(-800)}`);
            const one = got && got[0];
            check('7. runOne resolves with a structured result after cleanup: state, log, dump, temp root gone',
                one && one.state === 'pass' && typeof one.log === 'string' && one.dump && one.dump.rawDumps > 0 && one.tmpRemoved === true && typeof one.ms === 'number', one);
            check('7. the summary keeps discovery order whatever order the pool finished in',
                /PASS +test-a-ok[\s\S]*PASS +test-b-ok[\s\S]*PASS +test-c-ok/.test(out(r)), out(r).slice(-600));
            check('7. the receipt from a pooled run is accepted', checkReceipt(fx).ok, checkReceipt(fx).problem);
        }
        const broken = fixture({ suites, pool: "throw new Error('pool exploded on load');\n" });
        const b = runAll(broken);
        if (finished(b, 'case 7 broken pool')) {
            check('7. a pool module that throws on load FAILS visibly (exit 1, FAIL test-all-pool)',
                b.status === 1 && row(b, 'FAIL ', 'test-all-pool') && /pool exploded on load/.test(out(b)), `exit ${b.status}\n${out(b).slice(-800)}`);
            check('7. and every suite still ran, serially', ['a', 'b', 'c'].every((x) => row(b, 'PASS ', 'test-' + x + '-ok')), out(b).slice(-600));
            const s = runAll(broken, ['--serial']);
            check('7. --serial ignores the pool module entirely', finished(s, 'serial') && s.status === 0 && !/test-all-pool/.test(out(s)), `exit ${s.status}`);
        }
        const short = fixture({ suites, pool: 'exports.runSuites = async (items, runOne) => [await runOne(items[0])];\n' });
        const sh = runAll(short);
        if (finished(sh, 'case 7 short pool')) {
            check('7. a pool that delivers fewer results than suites FAILS, and the rest run serially',
                sh.status === 1 && row(sh, 'FAIL ', 'test-all-pool') && ['a', 'b', 'c'].every((x) => row(sh, 'PASS ', 'test-' + x + '-ok')), `exit ${sh.status}\n${out(sh).slice(-800)}`);
        }
        const none = fixture({ suites });
        const nr = runAll(none);
        check('7. no pool module: serial, exit 0, no pool row', finished(nr, 'no pool') && nr.status === 0 && !/test-all-pool/.test(out(nr)), `exit ${nr.status}`);
        const pooled = runAll(fixture({ suites: { 'test-all-pool.js': 'exports.runSuites = async () => [];\n', 'test-a-ok.js': PASSING } }), ['--serial']);
        check('7. the pool module is never discovered as a suite', finished(pooled, 'pool discovery') && pooled.status === 0 && !/=== test-all-pool ===/.test(out(pooled)), out(pooled).slice(-400));
    }
}

main().catch((e) => check('the suite ran to the end', false, e && e.stack)).then(() => {
    console.log(`\n${pass} passed, ${fail} failed${infra ? `, ${infra} indeterminate` : ''}`);
    if (infra) console.log('indeterminate: ' + indeterminate.join(' | '));
    process.exitCode = fail ? 1 : infra ? 2 : 0;
});
