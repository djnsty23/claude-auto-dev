#!/usr/bin/env node
/**
 * gate-fast.js - the gate's cheap half, and an honest account of what it skipped.
 *
 * WHY. `[measured 2026-09-08, this machine, load 4.2 rising to 12.5]` the seven
 * steps of `npm run gate`, timed INDEPENDENTLY on a clean tree:
 *
 *     npm test               323.7 s   20.00%
 *     check:suites          1286.2 s   79.46%
 *     check:probe-shapes       0.1 s    0.01%
 *     check:population         0.4 s    0.02%
 *     check:entrypoints        7.8 s    0.48%
 *     check:skill-tools        0.3 s    0.02%
 *     check:agents-md          0.2 s    0.01%
 *                           -------
 *                           1618.7 s = 27.0 min
 *
 * Two steps are 99.46% of it. The other five are 8.8 SECONDS TOGETHER. The merge
 * bar requires a re-run AFTER every rebase and docs/decisions.md is newest-first,
 * so roughly half the open queue rebases on every merge to main; that product,
 * not any single step, is the fleet's dominant cost. This runs that half.
 *
 * 8.8 s is the SUM of those step times, not the cost of a run: each step is
 * spawned through `npm run`, which adds ~0.3 s apiece. `[measured 2026-09-08,
 * load 5.9, 14 cores]` end to end this script is 11.1 s (n=3) against 27 min.
 *
 * `check:entrypoints` was the one worth measuring rather than assuming: it
 * probes ~118 scripts with `--help` under a 10 s budget each, so its worst case
 * is minutes and a cost model that guessed would have put it in the wrong tier.
 * Measured, it was 7.8 s at load 4.2 and 9.5 s at load 5.9 - nearly the whole
 * of this tier either way, and the only step in it whose cost tracks the load.
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
 * package.json's `scripts.gate` split on `&&` - the same authority
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
 * Exit: 0 every fast step passed (a PARTIAL pass - read the banner), 1 a fast
 * step failed, 2 indeterminate or the population could not be derived.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

// ---------------------------------------------------------------------------
// The population. Derived from package.json, never listed here.
// ---------------------------------------------------------------------------

/**
 * `scripts.gate` split on `&&`, reduced to the npm script NAMES it invokes.
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
    const gate = pkg.scripts && pkg.scripts.gate;
    if (typeof gate !== 'string') return null;
    return gate.split('&&').map((s) => s.trim()).filter(Boolean).map((raw) => {
        const run = /^npm run ([\w:-]+)$/.exec(raw);
        if (run) return { raw, name: run[1] };
        if (raw === 'npm test') return { raw, name: 'test' };
        return { raw, name: null };
    });
}

/**
 * The steps measured cheap enough to re-run after every rebase.
 *
 * An ALLOWLIST, so a step added to the chain lands in the slow tier by default.
 * The opposite default would put an unmeasured step into the tier whose entire
 * claim is that it costs seconds.
 *
 * `check:claude-md` is here ahead of the step itself: PR #210 adds it to the
 * chain, and it measures 2.1 s (selftest plus run). A name that is not in
 * `scripts.gate` costs nothing here - this is a membership test against
 * whatever the chain actually contains - so classifying it now means #210 lands
 * into the correct tier instead of silently into the slow one.
 */
const FAST = new Set([
    'check:probe-shapes',   // 0.1 s
    'check:population',     // 0.4 s
    'check:entrypoints',    // 7.8 s
    'check:skill-tools',    // 0.3 s
    'check:agents-md',      // 0.2 s
    'check:claude-md',      // 2.1 s - enters the chain with #210
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

function render(ran, deferred, total) {
    const lines = [];
    const failed = ran.filter((r) => r.status === 'FAIL');
    const indet = ran.filter((r) => r.status === 'INDETERMINATE');

    for (const r of ran) {
        lines.push(`  ${r.status.padEnd(13)} ${r.name.padEnd(20)} exit=${r.code}  ${(r.ms / 1000).toFixed(1)}s`);
    }
    for (const d of deferred) {
        lines.push(`  ${'DEFERRED'.padEnd(13)} ${(d.name || d.raw).padEnd(20)} not run here — \`npm run gate\` runs it`);
    }

    lines.push('');
    lines.push(`  ${ran.length} of ${total} gate steps ran. ${deferred.length} DEFERRED.`);
    lines.push('');
    if (failed.length) {
        lines.push(`  FAIL — ${failed.length} fast step(s) failed: ${failed.map((f) => f.name).join(', ')}`);
    } else if (indet.length) {
        lines.push(`  INDETERMINATE — ${indet.map((f) => f.name).join(', ')} exited 2.`);
        lines.push('  Exit 2 is a refusal, not a verdict. Re-run on a quiet tree.');
    } else {
        lines.push(`  The ${ran.length} fast steps are clean. THIS IS NOT THE GATE.`);
    }
    lines.push(`  Before merging: npm run gate   (all ${total} steps)`);
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

function main() {
    // --help first: check:entrypoints probes every script in tooling/ with
    // --help inside a scratch copy of the tree. A script that ignored the flag
    // and did its default action instead would spawn the whole fast tier there.
    if (has('--help') || has('-h')) {
        console.log('usage: node tooling/gate-fast.js [--json] [--root DIR] [--selftest]');
        console.log('');
        console.log('Runs the cheap steps of package.json `scripts.gate` INDEPENDENTLY and');
        console.log('reports which steps it did not run. This is NOT the gate: `npm run gate`');
        console.log('runs every step and is what a merge needs.');
        return;
    }
    if (has('--selftest')) { selftest(); return; }

    const root = path.resolve(val('--root', path.join(__dirname, '..')));
    const steps = gateStepNames(root);
    if (steps === null) {
        console.error('INDETERMINATE — package.json has no readable `scripts.gate`.');
        console.error('This script derives its step list from that chain and will not guess');
        console.error('one: a hardcoded population is how a fast tier comes to claim a step');
        console.error('nobody added it to.');
        process.exitCode = 2;
        return;
    }

    const fast = steps.filter((s) => s.name && FAST.has(s.name));
    const deferred = steps.filter((s) => !(s.name && FAST.has(s.name)));

    if (fast.length === 0) {
        console.error(`INDETERMINATE — none of the ${steps.length} steps in scripts.gate are`);
        console.error('classified fast. Either the chain was rewritten or FAST is stale.');
        console.error('Chain: ' + steps.map((s) => s.raw).join(' && '));
        process.exitCode = 2;
        return;
    }

    const ran = fast.map((s) => runStep(s, root));

    // A non-clean step's own output is the actionable part. Print it under the
    // step's name so a reader can tell which of several steps produced it.
    for (const r of ran) {
        if (r.status === 'PASS') continue;
        console.log(`\n--- ${r.name} (exit ${r.code}) ---`);
        console.log((r.out || '').trimEnd());
    }

    if (has('--json')) {
        console.log(JSON.stringify({
            total: steps.length, ran: ran.length, deferred: deferred.length,
            steps: ran.map(({ name, status, code, ms }) => ({ name, status, code, ms })),
            deferredSteps: deferred.map((d) => d.name || d.raw),
        }, null, 2));
    } else {
        console.log('\ngate:fast — the cheap steps of `npm run gate`, run independently\n');
        console.log(render(ran, deferred, steps.length));
    }

    if (ran.some((r) => r.status === 'FAIL')) process.exitCode = 1;
    else if (ran.some((r) => r.status === 'INDETERMINATE')) process.exitCode = 2;
    else process.exitCode = 0;
}

main();
