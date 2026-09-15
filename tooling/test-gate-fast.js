#!/usr/bin/env node
/**
 * test-gate-fast.js - drives tooling/gate-fast.js as a SUBPROCESS.
 *
 * The selftest inside gate-fast.js exercises its functions in-process. This
 * drives the real binary against synthetic trees, because the two things most
 * worth proving here are properties of a RUN and not of a function:
 *
 *   - a partial run reads as partial, in the bytes a session actually sees;
 *   - exit 2 survives the whole pipeline as INDETERMINATE rather than arriving
 *     as red, which is what an `&&` chain would have done to it.
 *
 * Each synthetic tree is a package.json whose `scripts.gate` names REAL fast
 * step names bound to fake commands, so the allowlist is exercised as written
 * rather than around.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.join(__dirname, 'gate-fast.js');
let failed = 0;

function check(name, cond, detail) {
    if (cond) { console.log(`PASS  ${name}`); return; }
    failed++;
    console.log(`FAIL  ${name}`);
    if (detail) console.log(String(detail).split('\n').map((l) => '      ' + l).join('\n'));
}

/** A tree whose gate chain is `steps`, each mapped to a shell command. */
function tree(gate, scripts) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fast-suite-'));
    fs.writeFileSync(path.join(dir, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '0.0.0', scripts: { gate, ...scripts } }, null, 2));
    return dir;
}

function run(dir, extra = []) {
    const r = spawnSync(process.execPath, [SUBJECT, '--root', dir, ...extra],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const trees = [];
const mk = (...a) => { const d = tree(...a); trees.push(d); return d; };

// -- 1. The clean partial run -------------------------------------------------
// Two steps in the chain, one fast. A clean result must still say ONE ran and
// ONE did not; if this reads like a full pass the split has made a false green.
{
    const d = mk('npm test && npm run check:agents-md',
        { 'check:agents-md': 'node -e "process.exit(0)"' });
    const r = run(d);
    check('a clean partial run exits 0', r.code === 0, r.out);
    check('a clean partial run states the ratio', /1 of 2 gate steps ran\. 1 DEFERRED\./.test(r.out), r.out);
    check('a clean partial run names the step it skipped', /DEFERRED\s+test\b/.test(r.out), r.out);
    check('a clean partial run says it is not the gate', /THIS IS NOT THE GATE/.test(r.out), r.out);
    check('a clean partial run points at the full gate', /npm run gate\s+\(all 2 steps\)/.test(r.out), r.out);
}

// -- 2. It can FAIL -----------------------------------------------------------
// A gate that cannot go red is decoration.
{
    const d = mk('npm test && npm run check:agents-md',
        { 'check:agents-md': 'node -e "console.log(\'drifted\');process.exit(1)"' });
    const r = run(d);
    check('a failing fast step exits 1', r.code === 1, r.out);
    check('a failing fast step is named', /FAIL —.*check:agents-md/.test(r.out), r.out);
    check("a failing step's own output is shown", /drifted/.test(r.out), r.out);
    check('a failing run does not claim the steps are clean', !/steps are clean/.test(r.out), r.out);
}

// -- 3. Exit 2 stays INDETERMINATE -------------------------------------------
// The third state. An `&&` chain folds this into red; this must not.
{
    const d = mk('npm test && npm run check:probe-shapes',
        { 'check:probe-shapes': 'node -e "process.exit(2)"' });
    const r = run(d);
    check('an exit-2 fast step exits 2, not 1', r.code === 2, `exit=${r.code}\n${r.out}`);
    check('an exit-2 fast step is reported INDETERMINATE', /INDETERMINATE/.test(r.out), r.out);
    check('exit 2 is called a refusal, not a verdict', /refusal, not a verdict/.test(r.out), r.out);
    check('an indeterminate run does not read as clean', !/steps are clean/.test(r.out), r.out);
}

// -- 4. A FAIL outranks an INDETERMINATE -------------------------------------
// Both present: the run must be red. Reporting 2 here would let a real failure
// be re-run away as "indeterminate, try again on a quiet tree".
{
    const d = mk('npm run check:probe-shapes && npm run check:agents-md',
        { 'check:probe-shapes': 'node -e "process.exit(2)"',
          'check:agents-md': 'node -e "process.exit(1)"' });
    const r = run(d);
    check('a FAIL alongside an INDETERMINATE exits 1', r.code === 1, `exit=${r.code}\n${r.out}`);
}

// -- 5. Steps run INDEPENDENTLY, with no short-circuit ------------------------
// The defect the whole design exists to avoid: a red step hiding the ones after
// it. Three fast steps, the first red - all three must still report.
{
    const d = mk('npm run check:probe-shapes && npm run check:population && npm run check:agents-md',
        { 'check:probe-shapes': 'node -e "process.exit(1)"',
          'check:population': 'node -e "process.exit(0)"',
          'check:agents-md': 'node -e "process.exit(0)"' });
    const r = run(d);
    check('a red first step does not skip the rest', /3 of 3 gate steps ran/.test(r.out), r.out);
    check('the steps after a red one still report PASS',
        /PASS\s+check:population/.test(r.out) && /PASS\s+check:agents-md/.test(r.out), r.out);
    check('the run is still red', r.code === 1, `exit=${r.code}`);
}

// -- 6. An unclassified step is DEFERRED, never assumed cheap -----------------
// The drift case: a step is added to the chain and nobody touches gate-fast.js.
{
    const d = mk('npm run check:agents-md && npm run check:brand-new',
        { 'check:agents-md': 'node -e "process.exit(0)"',
          'check:brand-new': 'node -e "process.exit(1)"' });
    const r = run(d);
    check('an unclassified step is deferred, not run', r.code === 0, r.out);
    check('an unclassified step is listed as DEFERRED', /DEFERRED\s+check:brand-new/.test(r.out), r.out);
}

// -- 7. No authority is indeterminate, not an empty pass ----------------------
// "0 of 0 passed" is this repo's canonical false green.
{
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fast-suite-'));
    trees.push(d);
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: {} }));
    const r = run(d);
    check('a tree with no scripts.gate is INDETERMINATE (exit 2)', r.code === 2, `exit=${r.code}\n${r.out}`);
    check('it says why rather than reporting a clean sweep', /no readable .scripts\.gate./.test(r.out), r.out);
}
{
    const d = mk('npm test && npm run check:suites', {});   // chain with zero fast steps
    const r = run(d);
    check('a chain with no fast steps is INDETERMINATE, not a pass', r.code === 2, `exit=${r.code}\n${r.out}`);
    check('it names the chain it could not classify', /npm test && npm run check:suites/.test(r.out), r.out);
}

// -- 8. --help returns, and does not run the tier -----------------------------
// check:entrypoints probes this file with --help inside a scratch copy.
{
    const r = spawnSync(process.execPath, [SUBJECT, '--help'], { encoding: 'utf8' });
    check('--help exits 0', r.status === 0);
    check('--help says this is not the gate', /NOT the gate/.test(r.stdout || ''), r.stdout);
    check('--help does not run any step', !/DEFERRED/.test(r.stdout || ''), r.stdout);
}

// -- 9. --json carries the same partiality ------------------------------------
// A machine reader must see the deferral too, or the split leaks a false green
// through the JSON path only.
{
    const d = mk('npm test && npm run check:agents-md',
        { 'check:agents-md': 'node -e "process.exit(0)"' });
    const r = run(d, ['--json']);
    const m = /\{[\s\S]*\}/.exec(r.out);
    let j = null;
    try { j = JSON.parse(m[0]); } catch { /* reported below */ }
    check('--json emits parseable JSON', j !== null, r.out);
    check('--json reports total, ran and deferred',
        j && j.total === 2 && j.ran === 1 && j.deferred === 1, JSON.stringify(j));
    check('--json names the deferred steps', j && j.deferredSteps.includes('test'), JSON.stringify(j));
}

// -- 10. The selftest is wired and green --------------------------------------
{
    const r = spawnSync(process.execPath, [SUBJECT, '--selftest'], { encoding: 'utf8' });
    check('--selftest exits 0', r.status === 0, r.stdout);
    check('--selftest actually asserts something', /PASS  exit 2 is INDETERMINATE/.test(r.stdout || ''), r.stdout);
}

for (const d of trees) fs.rmSync(d, { recursive: true, force: true });

console.log(failed ? `\n${failed} check(s) failed` : '\nall gate-fast checks passed');
process.exitCode = failed ? 1 : 0;
