#!/usr/bin/env node
'use strict';
// test-frontier-compare.js - the frontier's preregistered comparison.
//
// tooling/frontier/compare.js reads tooling/frontier/path-to-10.json against
// recorded rows. This suite plants each defect the four fields guard and
// watches its field go red, then runs the real command on the real plan:
//
//   arms                 a duplicate arm or an unknown variant is INVALID
//   independent_oracles  a row passed by a reviewer's verdict, a row whose pass
//                        contradicts its checks, and a task graded by anything
//                        but its endpoint each read FAIL
//   leakage_controls     a withheld task in the tuning set, a withheld row used
//                        for tuning, and a withheld brief line copied into a
//                        tuning input each read FAIL
//   missing_runs         an incomplete arm reads UNKNOWN with no rate, a
//                        complete set reads NONE, and a reader that scores a
//                        missing run as a zero reads FAIL
//
// No run is launched: --fixtures reads recorded rows only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./frontier/compare.js');

const ROOT = path.resolve(__dirname, '..');
const RUN = path.join(__dirname, 'frontier', 'run.js');
const PLAN = path.join(__dirname, 'frontier', 'path-to-10.json');
const TASKS = path.join(__dirname, 'frontier', 'tasks');
const VARIANTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'frontier', 'variants.json'), 'utf8'));

const lines = [];
const failures = [];
const check = (name, ok, detail) => {
    if (ok) lines.push(`ok ${name}`);
    else { lines.push(`FAIL ${name}${detail ? ` (${detail})` : ''}`); failures.push(name); }
};

const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
const rows = C.readRowsFile(path.resolve(path.dirname(PLAN), plan.fixtures));
const clone = (x) => JSON.parse(JSON.stringify(x));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-compare-'));
const run = (p, rs, root = ROOT) => {
    const f = path.join(scratch, `plan-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify(Object.assign(clone(p), { fixtures: path.resolve(path.dirname(PLAN), plan.fixtures) })));
    return C.compare({ planFile: f, root, tasksDir: TASKS, variants: VARIANTS, rows: rs });
};

try {
    // The plan itself, as preregistered.
    const { withheldIds } = C.planTasks(plan);
    check(`plan: ${plan.tasks.length} tasks, ${plan.arms.length} arms, ${plan.repeats} repeats, ${plan.tasks.length * plan.arms.length * plan.repeats} bounded runs`,
        plan.tasks.length === 12 && plan.arms.length === 3 && plan.repeats === 3);
    check(`plan: ${plan.withheldFamilies.length} families withheld from tuning, covering ${withheldIds.size} task(s)`,
        plan.withheldFamilies.length === 6 && withheldIds.size >= 6);
    check('plan: every task file in tasks/ is in the plan', fs.readdirSync(TASKS).filter((f) => /^T\d+\.json$/.test(f)).every((f) => plan.tasks.some((t) => `${t.id}.json` === f)));

    const base = run(plan, rows);
    check(`baseline: ${base.line}`, base.line === 'arms=3 independent_oracles=PASS leakage_controls=PASS missing_runs=UNKNOWN');

    // arms
    const dup = clone(plan); dup.arms.push(clone(dup.arms[0]));
    check('plant arms: a duplicate arm id is INVALID', /^arms=INVALID/.test(run(dup, rows).line));
    const badVar = clone(plan); badVar.arms[1].variant = 'ZZZ';
    check('plant arms: a variant missing from variants.json is INVALID', /^arms=INVALID/.test(run(badVar, rows).line));

    // independent oracles
    const brain = clone(rows); const b0 = brain.find((r) => r.verdict === 'fail' && r.lane === 'fix');
    Object.assign(b0, { verdict: 'pass', pass: true, grade: { brainVerdict: 'looks done', pass: true } });
    check('plant oracle: a fix row passed by a reviewer verdict, with no check record, FAILS', run(plan, brain).oracles.verdict === 'FAIL');
    const contra = clone(rows); const c0 = contra.find((r) => r.verdict === 'fail' && r.lane === 'fix');
    Object.assign(c0, { verdict: 'pass', pass: true });
    check('plant oracle: a pass whose held-out check exited 1 FAILS', run(plan, contra).oracles.verdict === 'FAIL');
    const noGrade = clone(rows); delete noGrade.find((r) => r.lane === 'locate').grade;
    check('plant oracle: an answer row with no key grade FAILS', run(plan, noGrade).oracles.verdict === 'FAIL');
    const t = JSON.parse(fs.readFileSync(path.join(TASKS, 'T3.json'), 'utf8'));
    const t3 = C.taskOracle(TASKS, 'T3');
    check('oracle: a fix task is graded by held-out checks with a contamination control', t3.ok && t3.kind === 'endpoint' && t.heldOut.length > 0);
    const fakeTasks = path.join(scratch, 'tasks');
    fs.mkdirSync(fakeTasks);
    fs.writeFileSync(path.join(fakeTasks, 'T3.json'), JSON.stringify(Object.assign({}, t, { grader: 'brain' })));
    check('plant oracle: a task graded by the Brain is refused', !C.taskOracle(fakeTasks, 'T3').ok);
    fs.writeFileSync(path.join(fakeTasks, 'T3.json'), JSON.stringify(Object.assign({}, t, { checks: [['node', 'tooling/some-visible-test.js']] })));
    check('plant oracle: a check the worker can see is not independent', !C.taskOracle(fakeTasks, 'T3').ok);
    check('oracle: a timeout row needs no check record and counts as a fail', C.independentOracles(plan, [{ arm: 'CUR', task: 'T1', repeat: 1, verdict: 'timeout', pass: false }], TASKS).verdict === 'PASS');

    // leakage
    const tuneWithheld = clone(plan); tuneWithheld.tuning.tasks.push([...withheldIds][0]);
    check('plant leakage: a withheld task in the tuning set FAILS', run(tuneWithheld, rows).leakage.verdict === 'FAIL');
    const rowLeak = clone(rows); rowLeak.find((r) => withheldIds.has(r.task)).use = 'tuning';
    check('plant leakage: a withheld task row used for tuning FAILS', run(plan, rowLeak).leakage.verdict === 'FAIL');
    const fakeRoot = path.join(scratch, 'root');
    fs.mkdirSync(path.join(fakeRoot, 'skills'), { recursive: true });
    const wid = [...withheldIds].find((id) => C.fingerprints(TASKS, [id]).length > 1);
    const brief = C.fingerprints(TASKS, [wid]).find((f) => !f.text.startsWith('frontier/tasks/')).text;
    fs.writeFileSync(path.join(fakeRoot, 'skills', 'SKILL.md'), `# tuned\n${brief}\n`);
    const leakPlan = clone(plan); leakPlan.tuning.inputs = ['skills'];
    check(`plant leakage: a ${wid} brief line in a tuning input FAILS`, run(leakPlan, rows, fakeRoot).leakage.verdict === 'FAIL');
    fs.writeFileSync(path.join(fakeRoot, 'skills', 'SKILL.md'), '# tuned\nnothing withheld here\n');
    check('control: the same input without the line PASSES', run(leakPlan, rows, fakeRoot).leakage.verdict === 'PASS');
    const noneWithheld = clone(plan); noneWithheld.withheldFamilies = [];
    check('plant leakage: a plan withholding nothing FAILS', run(noneWithheld, rows).leakage.verdict === 'FAIL');

    // missing runs
    const arms = C.armRuns(plan, rows);
    check(`missing: BAS reads UNKNOWN with ${arms.BAS.missing} run(s) missing and no rate`, arms.BAS.status === 'UNKNOWN' && arms.BAS.passRate === null && arms.BAS.missing > 0);
    check('missing: a contaminated row is missing, not a fail', rows.some((r) => r.arm === 'BAS' && r.verdict === 'contaminated') && arms.BAS.counted === 16);
    check(`missing: CUR complete at ${arms.CUR.passRate}`, arms.CUR.status === 'COMPLETE' && arms.CUR.passRate === 0.75);
    const full = clone(rows).filter((r) => r.arm !== 'BAS').concat(clone(rows).filter((r) => r.arm === 'CUR').map((r) => Object.assign(r, { arm: 'BAS' })));
    check('control: every arm complete reads NONE', run(plan, full).missing === 'NONE');
    const zeroed = clone(arms); zeroed.BAS.passRate = 0;
    check('plant missing: an incomplete arm scored as zero reads FAIL', C.missingRuns(zeroed) === 'FAIL');
    const passed = clone(arms); passed.BAS.status = 'COMPLETE';
    check('plant missing: an incomplete arm marked complete reads FAIL', C.missingRuns(passed) === 'FAIL');
    check('missing: no arm at all is UNKNOWN, not NONE', C.missingRuns({}) === 'UNKNOWN');
    check('render: one line per arm and the verdict line last', C.render(base).trim().split('\n').pop() === base.line && C.verdictOk(base));

    // The real command, as the scorecard runs it.
    const r = spawnSync(process.execPath, [RUN, 'compare', '--plan', 'tooling/frontier/path-to-10.json', '--fixtures'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    const last = r.stdout.trim().split('\n').pop();
    check(`command: run.js compare --fixtures exits 0 and prints ${last}`, r.status === 0 && last === 'arms=3 independent_oracles=PASS leakage_controls=PASS missing_runs=UNKNOWN', r.stderr);
    const u = spawnSync(process.execPath, [RUN, 'compare'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    check('command: compare without --plan is a usage error', u.status === 1 && /compare needs --plan/.test(u.stdout));
    const empty = path.join(scratch, 'data');
    const d = spawnSync(process.execPath, [RUN, 'compare', '--plan', PLAN, '--data', empty], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    check('command: with no recorded rows every arm is UNKNOWN, never a zero', d.status === 0 && /missing_runs=UNKNOWN$/.test(d.stdout.trim()) && /arm CUR: 0 of 36 run\(s\), 36 missing, rate UNKNOWN/.test(d.stdout));
} catch (e) {
    failures.push(`threw: ${e.stack || e.message}`);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}

for (const l of lines) console.log(l);
console.log(`${lines.length} check(s), ${failures.length} failed`);
if (failures.length) {
    process.stderr.write(`FAIL ${failures.length} check(s):\n${failures.map((f) => `  ${f}`).join('\n')}\n`);
    process.exitCode = 1;
}
