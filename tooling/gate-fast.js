#!/usr/bin/env node
/**
 * gate-fast.js - the gate's cheap half, and an honest account of what it skipped.
 *
 * WHY. The gate's cost is concentrated in the steps that make a full pass over
 * the suites (`npm test`, `check:suites`, `check:coverage`); every other step
 * costs seconds. `[measured 2026-09-15 at d07c421, 14 cores, load 2.3-5.7]`
 * those three were 99.43% of a 48.9 min run, and this script end to end was
 * 16.6 s (n=3). On 2026-09-08 the same shape read "two steps, 99.46%, 11.1 s",
 * before check:coverage joined the chain. The figures move; re-time before
 * quoting one. CLAUDE.md carries the per-step table.
 *
 * In this repo a wrapped gate:fast run is the merge bar for an ordinary PR,
 * and the FULL gate runs once on each release candidate (publish-release.js
 * refuses any other receipt). Product repos keep the full gate per merge.
 *
 * `check:entrypoints` is most of this tier: it probes every tooling script with
 * `--help` under a 10 s budget each, so its worst case is minutes and its cost
 * grows with the script count (7.8 s on 2026-09-08, 12.7 s on 2026-09-15).
 *
 * WHAT IT IS NOT. It is NOT the gate and it never reports as though it were.
 * `npm run gate` still means every step, unchanged; a session running that from
 * memory or from an older brief gets the full thing. The split lowers the bar
 * for nobody, and this script's loudest line is the one naming what it skipped.
 *
 * WHY A SCRIPT AND NOT AN `&&` CHAIN. Three reasons, each a failure this repo
 * has already had:
 *
 *   1. `&&` SHORT-CIRCUITS. A red first step means the rest never ran, and the
 *      chain's exit status is a verdict on one step wearing the clothes of a
 *      verdict on all of them. Every step here runs independently, so "3 ran,
 *      1 failed" cannot be confused with "5 passed".
 *   2. EXIT 2 IS INDETERMINATE, not failure - this repo's convention. An `&&`
 *      chain folds 2 into red, and folding a refusal into a verdict is how a
 *      session comes to believe a gate answered a question it declined.
 *   3. A PARTIAL RUN MUST LOOK PARTIAL. A chain exiting 0 having run five of
 *      seven steps is indistinguishable from one that ran seven. That is the
 *      false green the gate exists to prevent.
 *
 * THE POPULATION IS DERIVED, NOT LISTED. The full step set comes from
 * package.json's gate chain (`scripts["gate:chain"]`, read by gate-lock.js's
 * readGateChain) split on `&&` - the same authority
 * check-claude-md.js grades the prose against. A hand-maintained copy would rot
 * the first time someone added a step, silently, which is how the `passes` table
 * came to list four states while five existed. A step this script does not
 * recognise is DEFERRED, never assumed cheap: the safe default is for the fast
 * tier to claim LESS than it covers, not more.
 *
 *   node tooling/gate-fast.js
 *   node tooling/gate-fast.js --json
 *   node tooling/gate-fast.js --selftest
 *   node tooling/gate-fast.js --root <dir>   # drive another tree of the same shape
 *
 * TOUCHED SUITES. `npm test` stays deferred, but in a git checkout every
 * tooling/test-*.js suite whose static reach holds a file changed since the
 * merge base with --base (default origin/main) runs too (touched-suites.js
 * says how reach is built). `[measured 2026-10-19]` #425 edited gate-lock.js,
 * the file a critical mutant in test-gate-evidence.js anchors on, and merged
 * on this tier with that suite red. A diff that cannot be read against the
 * base is INDETERMINATE, never an empty selection.
 *
 * THE RUN RECORD. In a git checkout each run writes
 * `<config dir>/autodev/locks/fast-gate.runs/<runId>.json`: the head it read
 * before the first step, whether the tree was dirty, and every step and
 * suite with its status, exit and output tail. The scorecard's gate-window
 * reads it to tie a merge day to the tree that landed.
 *
 * Exit: 0 every fast step and touched suite passed (a PARTIAL pass - read the
 * banner), 1 one failed, 2 indeterminate or the population could not be derived.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { readGateChain } = require('./gate-lock.js');
const { createTail } = require('./gate-steps.js');
const touchedSuites = require('./touched-suites.js');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

// ---------------------------------------------------------------------------
// The population. Derived from package.json, never listed here.
// ---------------------------------------------------------------------------

/**
 * The gate chain split on `&&`, reduced to the npm script NAMES it invokes.
 * The chain is `scripts["gate:chain"]` (`scripts.gate` is the lock wrapper,
 * gate-lock.js), or `scripts.gate` in a tree with no wrapper. readGateChain()
 * is the one definition of that.
 *
 * `npm test` and `npm run check:suites` are the two spellings the chain uses.
 * Anything else keeps `name: null` and is reported by its raw text, so an
 * unrecognised step is VISIBLE and deferred rather than silently dropped.
 */
function gateStepNames(root) {
    const pkgPath = path.join(root, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { return null; }
    const gate = readGateChain(pkg);
    if (typeof gate !== 'string') return null;
    return gate.split('&&').map((s) => s.trim()).filter(Boolean).map((raw) => {
        const run = /^npm run ([\w:-]+)$/.exec(raw);
        if (run) return { raw, name: run[1] };
        if (raw === 'npm test') return { raw, name: 'test' };
        return { raw, name: null };
    });
}

/**
 * The steps measured cheap enough to re-run while iterating.
 *
 * An ALLOWLIST, so a step added to the chain lands in the slow tier by default.
 * The opposite default would put an unmeasured step into the tier whose entire
 * claim is that it costs seconds. `check:skill-plugin-root` was the live example:
 * it joined the chain after this list was written and stayed DEFERRED until it
 * was measured (0.2 s on 2026-09-15) and added by hand. That is the intended
 * path for every new step: measured first, listed second.
 *
 * Membership is tested against whatever the gate chain actually contains, so a
 * name listed here but absent from the chain costs nothing.
 */
const FAST = new Set([          // [measured 2026-09-15, load 4.6-5.4]
    'check:probe-shapes',   // 0.2 s
    'check:population',     // 0.6 s
    'check:entrypoints',    // 12.7 s
    'check:skill-tools',    // 0.3 s
    'check:skill-plugin-root', // 0.2 s
    'check:agents-md',      // 0.2 s
    'check:claude-md',      // 2.6 s
    'check:hook-parse',     // 1.8 s [measured 2026-09-24, two full gates running]
    'check:conflict-markers', // 0.4-0.6 s [measured 2026-09-27, 707 files, n=3]
]);

// ---------------------------------------------------------------------------
// Running. Independently: no `&&`, no short-circuit.
// ---------------------------------------------------------------------------

/** 0 pass, 2 indeterminate (this repo's refusal convention), else fail. */
function classify(code) {
    if (code === 0) return 'PASS';
    if (code === 2) return 'INDETERMINATE';
    return 'FAIL';
}

function runStep(step, root) {
    const started = Date.now();
    const r = spawnSync('npm', ['run', step.name], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
    });
    const ms = Date.now() - started;
    if (r.error) {
        return { ...step, status: 'INDETERMINATE', code: null, ms,
                 out: `could not spawn npm: ${r.error.message}` };
    }
    return { ...step, status: classify(r.status), code: r.status, ms,
             out: (r.stdout || '') + (r.stderr || '') };
}

// ---------------------------------------------------------------------------
// Touched suites, and the run record.
// ---------------------------------------------------------------------------

// test-all.js's per-suite budget, and its env rule: a suite never inherits the operator's
// profile (CLAUDE_CONFIG_DIR), or a suite that fakes HOME still reaches the real config dir.
const SUITE_TIMEOUT_MS = 600000;
const LEAKY_ENV = ['CLAUDE_CONFIG_DIR'];
const suiteEnv = () => { const env = { ...process.env }; for (const k of LEAKY_ENV) delete env[k]; return env; };
const SUITE_CONCURRENCY = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));

function git(root, args) {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    return !r.error && r.status === 0 ? r.stdout.trim() : null;
}

/** True when `root` is the top of a git work tree, so its diff and head mean something. */
function isRepoRoot(root) {
    const top = git(root, ['rev-parse', '--show-toplevel']);
    if (!top) return false;
    const norm = (p) => { try { p = fs.realpathSync.native(p); } catch { /* keep */ } return process.platform === 'win32' ? p.toLowerCase() : p; };
    return norm(path.resolve(top)) === norm(path.resolve(root));
}

/** One suite as a child process, with its output tail. A timeout is INDETERMINATE, not a verdict. */
function runSuite(suite, root) {
    return new Promise((resolve) => {
        const started = Date.now();
        const tail = createTail();
        let child;
        try {
            child = spawn(process.execPath, [suite], { cwd: root, env: suiteEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch (e) {
            resolve({ name: suite, status: 'INDETERMINATE', code: null, ms: 0, tail: { text: `could not spawn: ${e.message}`, bytes: 0, truncated: false } });
            return;
        }
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* gone */ } }, SUITE_TIMEOUT_MS);
        child.stdout.on('data', (b) => tail.push(b));
        child.stderr.on('data', (b) => tail.push(b));
        child.on('error', (e) => tail.push(`\nspawn error: ${e.message}\n`));
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            const status = timedOut ? 'INDETERMINATE' : (signal ? 'FAIL' : classify(code));
            if (timedOut) tail.push(`\ntimed out after ${SUITE_TIMEOUT_MS / 60000} min\n`);
            resolve({ name: suite, status, code, signal: signal || null, ms: Date.now() - started, tail: tail.read() });
        });
    });
}

async function pool(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    const lane = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
    return out;
}

function runIdNow(d = new Date()) {
    return `${d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '')}-${process.pid}`;
}

/** Writes the run record. Returns its path, or throws. Records older than 21 days are pruned. */
function writeRecord(rec, env = process.env) {
    const { configDir } = require('../plugins/autodev-core/scripts/claude-paths.js');
    const dir = path.join(configDir(env), 'autodev', 'locks', 'fast-gate.runs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${rec.runId}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
    fs.renameSync(tmp, file);
    for (const n of fs.readdirSync(dir)) {
        const f = path.join(dir, n);
        try { if (Date.now() - fs.statSync(f).mtimeMs > 21 * 86400000) fs.unlinkSync(f); } catch { /* in use or gone */ }
    }
    return file;
}

function evidenceRow(r, index, of) {
    return { index, of, step: r.name, status: r.status.toLowerCase(), exit: Number.isInteger(r.code) ? r.code : null,
             signal: r.signal || null, ms: r.ms, tail: r.tail || { text: String(r.out || '').slice(-4096), bytes: String(r.out || '').length, truncated: String(r.out || '').length > 4096 } };
}

// ---------------------------------------------------------------------------
// Reporting.
//
// The banner is the point of this script. `[decided by the operator 2026-09-08]`
// "a partial run must be visibly partial: '6 of 8 ran, 2 deferred' must not
// render like '8 of 8 passed'. If they look alike the split has manufactured a
// false green." So a CLEAN run here is deliberately NOT silent. Silence is what
// a complete pass is allowed to look like, and this is never a complete pass.
// It follows the convention the other gate steps already use - check:agents-md
// prints its population on a clean run so a quiet result is distinguishable
// from an empty scan.
// ---------------------------------------------------------------------------

function render(ran, deferred, total, touched = null) {
    const lines = [];
    const suites = touched && touched.ran ? touched.ran : [];
    const all = [...ran, ...suites];
    const failed = all.filter((r) => r.status === 'FAIL');
    const indet = all.filter((r) => r.status === 'INDETERMINATE');

    for (const r of ran) {
        lines.push(`  ${r.status.padEnd(13)} ${r.name.padEnd(20)} exit=${r.code}  ${(r.ms / 1000).toFixed(1)}s`);
    }
    for (const d of deferred) {
        lines.push(`  ${'DEFERRED'.padEnd(13)} ${(d.name || d.raw).padEnd(20)} not run here — \`npm run gate\` runs it`);
    }
    for (const s of suites) {
        lines.push(`  ${s.status.padEnd(13)} ${s.name}  exit=${s.code}  ${(s.ms / 1000).toFixed(1)}s  (touched)`);
    }

    lines.push('');
    lines.push(`  ${ran.length} of ${total} gate steps ran. ${deferred.length} DEFERRED.`);
    if (touched && touched.error) lines.push(`  touched suites: INDETERMINATE, ${touched.error}`);
    else if (touched) lines.push(`  touched suites: ${suites.length} of ${touched.suites} selected by ${touched.files} changed file(s) since ${String(touched.base).slice(0, 12)}, all run.`);
    else lines.push('  touched suites: not a git checkout, none selected.');
    lines.push('');
    if (failed.length) {
        lines.push(`  FAIL — ${failed.length} step(s) or touched suite(s) failed: ${failed.map((f) => f.name).join(', ')}`);
    } else if (touched && touched.error) {
        lines.push('  INDETERMINATE — the diff could not be read, so no touched suite was selected.');
    } else if (indet.length) {
        lines.push(`  INDETERMINATE — ${indet.map((f) => f.name).join(', ')} exited 2.`);
        lines.push('  Exit 2 is a refusal, not a verdict. Re-run on a quiet tree.');
    } else {
        lines.push(`  The ${ran.length} fast steps are clean. THIS IS NOT THE GATE.`);
    }
    lines.push('  Merging a PR: this run under the gate-receipt wrapper is the receipt (CLAUDE.md).');
    lines.push(`  Before a release: npm run gate   (all ${total} steps)`);
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Selftest.
//
// rule-gate-integrity: a gate that cannot go red is decoration. This drives the
// partition, the exit-code mapping and the banner against synthetic trees, so
// the three states stay three and a step nobody classified stays deferred.
// ---------------------------------------------------------------------------

function selftest() {
    let failed = 0;
    const check = (name, cond, detail) => {
        if (cond) { console.log(`PASS  ${name}`); return; }
        failed++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    };

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fast-selftest-'));
    const write = (gate) => {
        fs.writeFileSync(path.join(tmp, 'package.json'),
            JSON.stringify({ scripts: { gate } }, null, 2));
        return gateStepNames(tmp);
    };

    // 1. Both spellings the chain uses reduce to npm script names.
    let steps = write('npm test && npm run check:suites && npm run check:agents-md');
    check('parses `npm test` and `npm run X` into script names',
        steps.length === 3 && steps[0].name === 'test'
        && steps[1].name === 'check:suites' && steps[2].name === 'check:agents-md',
        JSON.stringify(steps));

    // 2. A step nobody classified is DEFERRED, never assumed fast. This is the
    //    drift case: someone adds a step and never touches this file.
    steps = write('npm test && npm run check:agents-md && npm run check:brand-new');
    const partition = steps.map((s) => (s.name && FAST.has(s.name) ? 'fast' : 'deferred'));
    check('an unrecognised step defaults to DEFERRED',
        partition[2] === 'deferred', `got ${partition[2]}`);
    check('a classified step is picked up from the chain', partition[1] === 'fast');
    check('a slow step stays out of the fast tier', partition[0] === 'deferred');

    // 3. THREE states, kept three. Folding 2 into red is the documented way
    //    check:suites' indeterminate result gets misread as a failure.
    check('exit 0 is PASS', classify(0) === 'PASS');
    check('exit 2 is INDETERMINATE, not FAIL', classify(2) === 'INDETERMINATE');
    check('exit 1 is FAIL', classify(1) === 'FAIL');
    check('exit 127 is FAIL', classify(127) === 'FAIL');

    // 4. No authority means indeterminate, never an empty pass. A population of
    //    zero reporting success is this repo's canonical false green.
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ not json');
    check('unparseable package.json yields no population', gateStepNames(tmp) === null);
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ scripts: {} }));
    check('a package.json with no scripts.gate yields no population',
        gateStepNames(tmp) === null);

    // 4b. The real tree's shape: `gate` is the lock wrapper, the chain lives in
    //     `gate:chain`. Reading the wrapper as the chain would make every step
    //     vanish into one unrecognised, deferred command.
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ scripts: {
        gate: 'node tooling/gate-lock.js',
        'gate:chain': 'npm test && npm run check:agents-md',
    } }));
    steps = gateStepNames(tmp);
    check('the chain is read from gate:chain, not from the lock wrapper',
        steps && steps.length === 2 && steps[1].name === 'check:agents-md', JSON.stringify(steps));

    // 5. The banner separates partial from complete. This is the whole point of
    //    the split and the only line a reader acts on.
    const okPartial = render([{ name: 'check:agents-md', status: 'PASS', code: 0, ms: 900 }],
        [{ name: 'test', raw: 'npm test' }], 2);
    check('a CLEAN partial run still says how many steps did NOT run',
        /1 of 2 gate steps ran\. 1 DEFERRED\./.test(okPartial)
        && /THIS IS NOT THE GATE/.test(okPartial), okPartial);
    check('a clean partial run never claims the gate passed',
        !/\bgate passed\b/i.test(okPartial) && !/^\s*PASS\s*$/m.test(okPartial));

    const red = render([{ name: 'check:agents-md', status: 'FAIL', code: 1, ms: 900 }],
        [{ name: 'test', raw: 'npm test' }], 2);
    check('a failing run says FAIL and names the step',
        /FAIL —/.test(red) && /check:agents-md/.test(red), red);

    const ind = render([{ name: 'check:suites', status: 'INDETERMINATE', code: 2, ms: 90 }], [], 1);
    check('an indeterminate run says so and does not read as a pass',
        /INDETERMINATE/.test(ind) && /refusal, not a verdict/.test(ind)
        && !/clean/.test(ind), ind);

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failed ? `\n${failed} selftest check(s) failed` : '\ngate-fast selftest OK');
    process.exitCode = failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// main
//
// process.exitCode, NEVER process.exit(). node's process.stdout is ASYNCHRONOUS
// when it is a pipe on darwin and synchronous on linux and win32; process.exit()
// does not drain a pending write, so a script that prints and then exits
// delivers exactly one 64KiB pipe buffer under exit status 0. That defect had a
// suite failing on every mac in this project while CI stayed green.
// ---------------------------------------------------------------------------

async function main() {
    // --help first: check:entrypoints probes every script in tooling/ with
    // --help inside a scratch copy of the tree. A script that ignored the flag
    // and did its default action instead would spawn the whole fast tier there.
    if (has('--help') || has('-h')) {
        console.log('usage: node tooling/gate-fast.js [--json] [--root DIR] [--selftest]');
        console.log('');
        console.log('Runs the cheap steps of the package.json gate chain INDEPENDENTLY and');
        console.log('reports which steps it did not run. This is NOT the gate: `npm run gate`');
        console.log('runs every step and is what a release needs. Under the gate-receipt');
        console.log('wrapper, a clean run here is the merge receipt for an ordinary PR.');
        return;
    }
    if (has('--selftest')) { selftest(); return; }

    const root = path.resolve(val('--root', path.join(__dirname, '..')));
    const steps = gateStepNames(root);
    if (steps === null) {
        console.error('INDETERMINATE — package.json has no readable gate chain (`scripts["gate:chain"]` or `scripts.gate`).');
        console.error('This script derives its step list from that chain and will not guess');
        console.error('one: a hardcoded population is how a fast tier comes to claim a step');
        console.error('nobody added it to.');
        process.exitCode = 2;
        return;
    }

    const fast = steps.filter((s) => s.name && FAST.has(s.name));
    const deferred = steps.filter((s) => !(s.name && FAST.has(s.name)));

    if (fast.length === 0) {
        console.error(`INDETERMINATE — none of the ${steps.length} steps in the gate chain are`);
        console.error('classified fast. Either the chain was rewritten or FAST is stale.');
        console.error('Chain: ' + steps.map((s) => s.raw).join(' && '));
        process.exitCode = 2;
        return;
    }

    // Read before the first step, so a tree moved mid-run cannot be credited.
    const inRepo = isRepoRoot(root);
    const startUtc = new Date().toISOString();
    const runId = runIdNow();
    const head = inRepo ? git(root, ['rev-parse', 'HEAD']) : null;
    const dirty = inRepo ? git(root, ['status', '--porcelain']) !== '' : null;

    const ran = fast.map((s) => runStep(s, root));

    let touched = null;
    if (inRepo) {
        const p = touchedSuites.plan(root, val('--base', 'origin/main'));
        if (p.error) touched = { error: p.error };
        else {
            const list = p.selected.map((s) => s.suite);
            const out = await pool(list, SUITE_CONCURRENCY, (s) => runSuite(s, root));
            touched = { base: p.base, files: p.touched.length, suites: p.suites, selected: p.selected, ran: out };
        }
    }

    // A non-clean step's own output is the actionable part. Print it under the
    // step's name so a reader can tell which of several steps produced it.
    for (const r of [...ran, ...(touched && touched.ran ? touched.ran : [])]) {
        if (r.status === 'PASS') continue;
        console.log(`\n--- ${r.name} (exit ${r.code}) ---`);
        console.log((r.out !== undefined ? r.out : r.tail.text).trimEnd());
    }

    const suitesRan = touched && touched.ran ? touched.ran : [];
    const every = [...ran, ...suitesRan];
    if (every.some((r) => r.status === 'FAIL')) process.exitCode = 1;
    else if ((touched && touched.error) || every.some((r) => r.status === 'INDETERMINATE')) process.exitCode = 2;
    else process.exitCode = 0;

    if (has('--json')) {
        console.log(JSON.stringify({
            total: steps.length, ran: ran.length, deferred: deferred.length,
            steps: ran.map(({ name, status, code, ms }) => ({ name, status, code, ms })),
            deferredSteps: deferred.map((d) => d.name || d.raw),
            touched: touched && (touched.error ? { error: touched.error }
                : { base: touched.base, files: touched.files, suites: suitesRan.map(({ name, status, code, ms }) => ({ name, status, code, ms })) }),
        }, null, 2));
    } else {
        console.log('\ngate:fast — the cheap steps of `npm run gate`, run independently\n');
        console.log(render(ran, deferred, steps.length, touched));
    }

    if (inRepo) {
        const rec = {
            kind: 'gate-fast', runId, head, dirty, startUtc, endUtc: new Date().toISOString(), exit: process.exitCode,
            evidence: ran.map((r, i) => evidenceRow(r, i + 1, ran.length)),
            deferred: deferred.map((d) => d.name || d.raw),
            touched: touched.error ? { error: touched.error } : {
                base: touched.base, files: touched.files, suites: touched.suites,
                selected: touched.selected.map((s) => ({ suite: s.suite, because: s.because.slice(0, 5) })),
                evidence: suitesRan.map((r, i) => evidenceRow(r, i + 1, suitesRan.length)),
            },
        };
        try { console.log(`  run record: ${path.basename(writeRecord(rec))}`); } catch (e) { console.error(`gate-fast: run record NOT written: ${e.message}`); }
    }
}

main().catch((e) => { console.error(`INDETERMINATE — gate-fast crashed: ${e && e.stack || e}`); process.exitCode = 2; });
