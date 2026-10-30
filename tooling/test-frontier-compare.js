#!/usr/bin/env node
'use strict';
// test-frontier-compare.js - the frontier's preregistered comparison.
//
// tooling/frontier/compare.js reads tooling/frontier/path-to-10.json against
// recorded rows. This suite plants each defect the four fields guard and
// watches its field go red, then runs the real command on the real plan:
//
//   arms                 a duplicate arm or an unknown variant is INVALID, and so
//                        is a counted row that ran another arm's variant or pin
//   live rows            a row built by run.js's own rowFor under --arm is
//                        counted in that arm through the real compare command.
//                        Fixture rows carry arm by hand, so they alone could not
//                        show a recorder that drops it (every arm read 0 of 36)
//   independent_oracles  a row passed by a reviewer's verdict, a row whose pass
//                        contradicts its checks, and a task graded by anything
//                        but its endpoint each read FAIL
//   leakage_controls     a withheld task in the tuning set, a withheld row used
//                        for tuning, and a withheld brief line copied into a
//                        tuning input each read FAIL
//   missing_runs         an incomplete arm reads UNKNOWN with no rate, a
//                        complete set reads NONE, and a reader that scores a
//                        missing run as a zero reads FAIL
//   run_identity         a second counted row for one cell, and a repeat
//                        beyond the plan, each read FAIL with the arm in
//                        CONFLICT and no rate, even when the arm looks full
//   candidate pin        an untagged candidate loads a different plugin hash
//                        than the current release, and its rows record the
//                        commit. A candidate at the release commit loads the
//                        release hash, so the difference is the content
//   promotion            a full set of planned cells promotes. A missing,
//                        contaminated or duplicated cell, a wrong-commit row,
//                        a candidate on the release's plugins, an unsealed or
//                        absent held-out row, a worse outcome or an unknown
//                        cost each block it, and the fixture rows that read
//                        green above never promote
//
// No run is launched: --fixtures reads recorded rows only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./frontier/compare.js');
const R = require('./frontier/run.js');

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
    check(`baseline: ${base.line}`, base.line === 'arms=3 independent_oracles=PASS leakage_controls=PASS missing_runs=UNKNOWN run_identity=PASS');

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
    const full = clone(rows).filter((r) => r.arm !== 'BAS').concat(clone(rows).filter((r) => r.arm === 'CUR').map((r) => Object.assign(r, { arm: 'BAS', pluginPin: 'none' })));
    check('control: every arm complete reads NONE', run(plan, full).missing === 'NONE');
    const relabelled = clone(rows).filter((r) => r.arm !== 'BAS').concat(clone(rows).filter((r) => r.arm === 'CUR').map((r) => Object.assign(r, { arm: 'BAS' })));
    const rl = run(plan, relabelled);
    check('plant arms: CUR rows relabelled BAS, still pinned current, are INVALID and not counted in BAS', /^arms=INVALID/.test(rl.line) && rl.runs.BAS.counted === 0, rl.line);
    const zeroed = clone(arms); zeroed.BAS.passRate = 0;
    check('plant missing: an incomplete arm scored as zero reads FAIL', C.missingRuns(zeroed) === 'FAIL');
    const passed = clone(arms); passed.BAS.status = 'COMPLETE';
    check('plant missing: an incomplete arm marked complete reads FAIL', C.missingRuns(passed) === 'FAIL');
    check('missing: no arm at all is UNKNOWN, not NONE', C.missingRuns({}) === 'UNKNOWN');
    // run identity: every counted row fills its own planned cell once.
    const curFail = rows.find((r) => r.arm === 'CUR' && r.verdict === 'fail');
    const rerun = clone(rows).concat([Object.assign(clone(curFail), { verdict: 'pass', pass: true, grade: { checks: [{ exit: 0 }], passToPass: [], pass: true } })]);
    const rr = run(plan, rerun);
    check(`plant identity: a re-run that turns a CUR fail into a pass reads ${rr.identity}`, rr.identity === 'FAIL' && rr.runs.CUR.status === 'CONFLICT' && rr.runs.CUR.passRate === null && !C.verdictOk(rr), JSON.stringify(rr.runs.CUR));
    check('plant identity: the CONFLICT names the cell recorded twice', rr.runs.CUR.unplanned.includes(`${curFail.task}#${curFail.repeat} recorded twice`), JSON.stringify(rr.runs.CUR.unplanned));
    check('plant identity: render marks the conflicted arm FAIL', /^FAIL arm CUR: .*CONFLICT: .*recorded twice/m.test(C.render(rr)));
    const beyond = clone(rows).concat([Object.assign(clone(curFail), { repeat: plan.repeats + 1 })]);
    const rb = run(plan, beyond);
    check('plant identity: a repeat beyond the plan reads FAIL', rb.identity === 'FAIL' && rb.runs.CUR.unplanned.some((u) => /beyond 3 repeat/.test(u)));
    const shuffled = clone(rows).reverse();
    check('control: row order changes nothing', run(plan, shuffled).line === base.line && run(plan, shuffled).runs.CUR.passRate === 0.75);
    const contaminatedTwice = clone(rows).concat([Object.assign(clone(curFail), { verdict: 'contaminated' })]);
    check('control: an uncounted row beside a counted one is no conflict', run(plan, contaminatedTwice).identity === 'PASS');
    const dropped = clone(arms); delete dropped.CUR.unplanned;
    check('plant identity: an arm without its unplanned list fails closed', C.runIdentity(dropped) === 'FAIL');
    check('identity: no arm at all is UNKNOWN, not PASS', C.runIdentity({}) === 'UNKNOWN');
    check('render: one line per arm and the verdict line last', C.render(base).trim().split('\n').pop() === base.line && C.verdictOk(base));

    // promotion: the only reading that may say the candidate improved. The full
    // set fills every cell: CAN copies CUR's outcomes, BAS fails every run.
    const SHA = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).stdout.trim();
    const failed = (r) => Object.assign(r, { verdict: 'fail', pass: false,
        grade: r.lane === 'fix' ? { checks: [{ exit: 1 }], passToPass: [] } : Object.assign({}, r.grade, { pass: false }) });
    const sealed = (r) => (withheldIds.has(r.task) ? Object.assign(r, { split: 'held-out', sealed: true, splitId: 'a'.repeat(64), taskIdHash: 'b'.repeat(64),
        heldOutHash: 'c'.repeat(64), splitAt: '2026-11-01T00:00:00Z', startedAt: '2026-11-03T00:00:00Z',
        seal: { checkedAt: '2026-11-02T00:00:00Z', contentMatches: true, currentHash: 'c'.repeat(64), visibleToLearning: false, hits: [], errors: [] } }) : r);
    const as = (r, arm, pluginPin, fingerprint) => sealed(Object.assign(r, { arm, pluginPin, fingerprint, costUsd: 0.1 }));
    const curRows = rows.filter((r) => r.arm === 'CUR');
    const promo = clone(curRows).map((r) => as(r, 'CUR', 'current', { pinCommit: 'e'.repeat(40), pinHash: 'h-release' }))
        .concat(clone(curRows).map((r) => as(r, 'CAN', 'candidate', { pinCommit: SHA, pinHash: 'h-candidate' })))
        .concat(clone(curRows).map((r) => as(failed(r), 'BAS', 'none', { pinCommit: null, pinHash: null })));
    const pr = run(plan, promo);
    const pp = C.promotion(pr, SHA);
    check(`control: the full set promotes (${pp.line}, ${pp.problems.join('; ')})`, pp.ok && pp.line === `promotion=PASS candidate=${SHA.slice(0, 12)}` && pr.missing === 'NONE');
    check('control: promotion reports the cost of both pinned arms', pp.cost.candidate.known === 36 && pp.cost.release.known === 36 && pp.cost.candidate.usd === 3.6);
    check('promotion: the fixture rows never promote, though compare reads them green', C.verdictOk(base) && !C.promotion(base, SHA).ok);
    const blocks = (name, mutate, want, cand = SHA, p = plan) => {
        const rs = clone(promo);
        mutate(rs);
        const got = C.promotion(run(p, rs), cand);
        check(`plant promotion: ${name} blocks (${got.problems[0] || 'nothing'})`, !got.ok && got.problems.some((x) => want.test(x)), got.problems.join('; '));
    };
    const canCell = (rs, i = 0) => rs.filter((r) => r.arm === 'CAN')[i];
    blocks('a missing candidate cell', (rs) => rs.splice(rs.indexOf(canCell(rs)), 1), /^missing_runs=UNKNOWN/);
    blocks('a contaminated candidate cell', (rs) => { canCell(rs).verdict = 'contaminated'; }, /^missing_runs=UNKNOWN/);
    blocks('a duplicated candidate cell', (rs) => rs.push(clone(canCell(rs))), /^run_identity=FAIL/);
    blocks('a candidate row that loaded another commit', (rs) => { canCell(rs, 5).fingerprint.pinCommit = 'f'.repeat(40); }, /^1 candidate row\(s\) did not load/);
    blocks('a candidate that loaded the release plugins', (rs) => rs.filter((r) => r.arm === 'CAN').forEach((r) => { r.fingerprint.pinHash = 'h-release'; }), /loaded the release's plugins/);
    blocks('two plugin hashes in one arm', (rs) => { canCell(rs, 3).fingerprint.pinHash = 'h-other'; }, /^arm CAN: 2 plugin hashes/);
    blocks('a held-out row visible to learning', (rs) => { rs.find((r) => r.split === 'held-out').seal.visibleToLearning = true; }, /held-out row\(s\) were not sealed/);
    blocks('no held-out row at all', (rs) => rs.forEach((r) => { delete r.split; }), /^no held-out row/);
    blocks('a candidate worse than the release', (rs) => failed(rs.find((r) => r.arm === 'CAN' && r.pass === true)), /below the release's/);
    blocks('a candidate no better than no plugins', (rs) => rs.filter((r) => r.arm === 'BAS').forEach((r, i) => Object.assign(r, clone(curRows[i]), { arm: 'BAS', pluginPin: 'none' })), /does not beat the no-plugin baseline/);
    blocks('a release row with no cost', (rs) => { delete rs.find((r) => r.arm === 'CUR').costUsd; }, /^1 candidate or release row\(s\) carry no cost/);
    blocks('no candidate commit named', () => {}, /^no candidate commit named/, null);
    blocks('a plan with no candidate arm', () => {}, /needs one candidate, one current and one none arm, it has 0, 1 and 1/, SHA,
        Object.assign(clone(plan), { arms: plan.arms.map((a) => (a.pluginPin === 'candidate' ? Object.assign(clone(a), { pluginPin: 'previous' }) : a)) }));
    check('render: promotion prints each problem, the cost, then its line', /^FAIL promotion: missing_runs=UNKNOWN/m.test(C.renderPromotion(C.promotion(base, SHA)))
        && C.renderPromotion(pp).trim().split('\n').pop() === pp.line && /^cost: candidate \$3\.6 over 36 row\(s\), release \$3\.6 over 36 row\(s\)$/m.test(C.renderPromotion(pp)));

    // The real command, as the scorecard runs it.
    const r = spawnSync(process.execPath, [RUN, 'compare', '--plan', 'tooling/frontier/path-to-10.json', '--fixtures'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    const last = r.stdout.trim().split('\n').pop();
    check(`command: run.js compare --fixtures exits 0 and prints ${last}`, r.status === 0 && last === 'arms=3 independent_oracles=PASS leakage_controls=PASS missing_runs=UNKNOWN run_identity=PASS', r.stderr);
    const u = spawnSync(process.execPath, [RUN, 'compare'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    check('command: compare without --plan is a usage error', u.status === 1 && /compare needs --plan/.test(u.stdout));
    const empty = path.join(scratch, 'data');
    const d = spawnSync(process.execPath, [RUN, 'compare', '--plan', PLAN, '--data', empty], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    check('command: with no recorded rows every arm is UNKNOWN, never a zero', d.status === 0 && /missing_runs=UNKNOWN run_identity=PASS$/.test(d.stdout.trim()) && /arm CUR: 0 of 36 run\(s\), 36 missing, rate UNKNOWN/.test(d.stdout));

    // Live rows: what run.js itself records, through its own rowFor, not a fixture.
    // Fixture rows carry arm by hand, so they alone could never show a recorder that drops it.
    const c = { data: path.join(scratch, 'live') };
    const cur = R.loadArm(PLAN, 'CUR');
    const graded = { verdict: 'pass', pass: true, grade: { checks: [{ exit: 0 }], passToPass: [], pass: true } };
    const liveMeta = (arm, over = {}) => Object.assign({ run: 'F-18120000-T1-V0-1', task: 'T1', taskHash: 'h', lane: 'fix', variant: arm ? arm.variant : 'V0',
        arm: arm ? arm.id : null, pluginPin: arm ? arm.pluginPin : null, model: 'm', effort: null, account: 'a', repeat: 1,
        pin: { tag: 'v0.0.0', hash: 'p', plugins: ['autodev-core'], dir: null }, snapshot: 's', harnessCommit: 'c', contamination: { tokens: 0, hits: [] } }, over);
    const live = R.rowFor(c, liveMeta(cur), graded);
    check(`live: rowFor records the arm it ran (${live.arm}/${live.variant}/${live.pluginPin})`, live.arm === 'CUR' && live.variant === 'V0' && live.pluginPin === 'current');
    const lr = C.armRuns(plan, [live]);
    check('live: a rowFor row is counted in its arm, and only there', lr.CUR.counted === 1 && lr.CAN.counted === 0 && lr.BAS.counted === 0, JSON.stringify(lr.CUR));
    check('live: its oracle record matches its pass', C.independentOracles(plan, [live], TASKS).verdict === 'PASS');
    const unarmed = R.rowFor(c, liveMeta(null), graded);
    const ur = C.armRuns(plan, [unarmed]);
    check('plant live: a run without --arm records arm null and no arm counts it', unarmed.arm === null && ur.CUR.counted + ur.CAN.counted + ur.BAS.counted === 0);
    const wrongPin = R.rowFor(c, liveMeta(cur, { pluginPin: 'previous' }), graded);
    const wp = run(plan, rows.filter((r) => !(r.arm === 'CUR' && r.task === 'T1' && r.repeat === 1)).concat([wrongPin]));
    check('plant live: a row naming CUR that ran the previous pin is INVALID and not counted', /^arms=INVALID/.test(wp.line) && wp.runs.CUR.counted === 35, wp.line);
    const liveData = path.join(scratch, 'live-data');
    fs.mkdirSync(liveData, { recursive: true });
    fs.writeFileSync(path.join(liveData, 'runs.jsonl'), JSON.stringify(live) + '\n');
    const lc = spawnSync(process.execPath, [RUN, 'compare', '--plan', PLAN, '--data', liveData], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    check('command: run.js compare on live data counts the rowFor row in CUR', lc.status === 0 && /arm CUR: 1 of 36 run\(s\), 35 missing/.test(lc.stdout) && /arm CAN: 0 of 36/.test(lc.stdout), lc.stdout.trim().split('\n').slice(3, 6).join(' | '));

    const fx = spawnSync(process.execPath, [RUN, 'compare', '--plan', PLAN, '--fixtures', '--promote', '--candidate', SHA], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    check('command: compare --promote on the fixtures exits 1, BLOCKED', fx.status === 1 && /^promotion=BLOCKED\(\d+\) candidate=/.test(fx.stdout.trim().split('\n').pop()), fx.stdout.trim().split('\n').pop());
    const promoData = path.join(scratch, 'promo-data');
    fs.mkdirSync(promoData, { recursive: true });
    fs.writeFileSync(path.join(promoData, 'runs.jsonl'), promo.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const pc = spawnSync(process.execPath, [RUN, 'compare', '--plan', PLAN, '--data', promoData, '--promote', '--candidate', SHA], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    check('command: compare --promote on the full set exits 0, PASS', pc.status === 0 && pc.stdout.trim().split('\n').pop() === `promotion=PASS candidate=${SHA.slice(0, 12)}`, pc.stdout.trim().split('\n').slice(-3).join(' | '));
    const pn = spawnSync(process.execPath, [RUN, 'compare', '--plan', PLAN, '--data', promoData, '--promote'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    check('command: compare --promote without --candidate exits 1', pn.status === 1 && /^FAIL promotion: no candidate commit named/m.test(pn.stdout));
    const pd = spawnSync(process.execPath, [RUN, 'compare', '--plan', PLAN, '--data', promoData], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    check('command: compare without --promote prints no promotion line', pd.status === 0 && !/promotion/.test(pd.stdout));

    // The arm is taken from the plan, and the runner refuses one it would mislabel.
    const refused = (fn, code) => { try { fn(); return false; } catch (e) { return e.publicCode === code; } };
    check('arm: an id the plan does not define is refused', refused(() => R.loadArm(PLAN, 'ZZZ'), 'no-arm'));
    check('arm: --variant that is not the arm\'s variant is refused', refused(() => R.loadArm(PLAN, 'CUR', 'V1'), 'arm-variant'));
    check('arm: --arm without --plan is a usage error', refused(() => R.armOpt({ arm: 'CUR' }), 'usage'));
    check('arm: no --arm is no arm', R.armOpt({ variant: 'V0' }) === null);
    const badPin = path.join(scratch, 'bad-pin.json');
    fs.writeFileSync(badPin, JSON.stringify({ arms: [{ id: 'X', variant: 'V0', pluginPin: 'latest' }] }));
    check('arm: a pluginPin the runner cannot load is refused', refused(() => R.loadArm(badPin, 'X'), 'bad-arm'));
    check('arm: prepare refuses an arm whose variant it was not given, before building anything',
        refused(() => R.prepare({ data: path.join(scratch, 'never'), tasks: TASKS }, 'T1', 'V1', 1, { arm: cur }), 'arm-variant') && !fs.existsSync(path.join(scratch, 'never')));

    // The pin each arm loads: a two-release repo with an untagged commit on top,
    // so current, previous and the candidate all differ.
    const g = path.join(scratch, 'pins-src');
    const plug = path.join(g, 'plugins', 'autodev-core');
    fs.mkdirSync(plug, { recursive: true });
    const gx = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: g, encoding: 'utf8', windowsHide: true });
    gx('init', '-q');
    for (const v of ['v1.0.0', 'v1.1.0']) { fs.writeFileSync(path.join(plug, 'f'), v); gx('add', '-A'); gx('commit', '-qm', v); gx('tag', v); }
    fs.writeFileSync(path.join(plug, 'f'), 'after'); gx('commit', '-qam', 'after');
    const tagOf = (rev) => gx('describe', '--tags', '--abbrev=0', '--match', 'v*', rev).stdout.trim();
    const head = gx('rev-parse', 'HEAD').stdout.trim();
    const gc = { src: g, work: path.join(scratch, 'pins-work') };
    const prvPlan = path.join(scratch, 'prv-plan.json');
    fs.writeFileSync(prvPlan, JSON.stringify({ arms: [{ id: 'PRV', variant: 'V0', pluginPin: 'previous' }] }));
    check('pin: current is the source HEAD\'s release', tagOf(R.pinRev(gc, {}, R.loadArm(PLAN, 'CUR'))) === 'v1.1.0');
    check('pin: previous is the release before it', tagOf(R.pinRev(gc, {}, R.loadArm(prvPlan, 'PRV'))) === 'v1.0.0');
    check('pin: none loads no plugins', R.pinRev(gc, {}, R.loadArm(PLAN, 'BAS')) === null);
    check('pin: without an arm, the task\'s parent as before', R.pinRev(gc, { parentSha: 'abc' }, null) === 'abc');
    check('arm: a candidate arm without --candidate is refused', refused(() => R.loadArm(PLAN, 'CAN'), 'no-candidate'));
    check('arm: a candidate arm with a short sha is refused', refused(() => R.loadArm(PLAN, 'CAN', null, head.slice(0, 12)), 'no-candidate'));
    const can = R.armOpt({ plan: PLAN, arm: 'CAN', candidate: 'HEAD' }, g);
    check('arm: --candidate HEAD resolves to the full sha in the source repo', can.sha === head && can.pluginPin === 'candidate', JSON.stringify(can));
    check('arm: --candidate with no commit is a usage error', refused(() => R.armOpt({ plan: PLAN, arm: 'CAN', candidate: true }, g), 'usage'));
    check('pin: candidate is the exact commit it names', R.pinRev(gc, {}, can) === head);
    // The acceptance case: an untagged candidate loads different plugins than current,
    // through armPin, the call prepare makes.
    const relPin = R.armPin(gc, {}, R.loadArm(PLAN, 'CUR'));
    const canPin = R.armPin(gc, {}, can);
    check('pin: the none arm loads no plugin dir', R.armPin(gc, {}, R.loadArm(PLAN, 'BAS')).pluginDir === null);
    check(`pin: an untagged candidate changes the loaded plugin hash (${canPin.tag} ${String(canPin.hash).slice(0, 12)} vs ${relPin.tag} ${String(relPin.hash).slice(0, 12)})`,
        canPin.hash && relPin.hash && canPin.hash !== relPin.hash && canPin.commit === head && canPin.tag === `candidate-${head.slice(0, 12)}`);
    check('pin: the release pin records the tagged commit', relPin.tag === 'v1.1.0' && relPin.commit === gx('rev-parse', 'v1.1.0^{commit}').stdout.trim());
    const tagged = R.pinFor(gc, relPin.commit, true);
    check('control: a candidate at the release commit loads the release hash', tagged.hash === relPin.hash && tagged.tag !== relPin.tag);
    check('pin: a candidate pin refuses anything but a full sha', refused(() => R.pinFor(gc, 'HEAD', true), 'bad-candidate'));
    const liveCan = R.rowFor(c, liveMeta(Object.assign({}, can, { variant: 'V0' }), { pin: { tag: canPin.tag, commit: canPin.commit, hash: canPin.hash, plugins: canPin.plugins, dir: null } }), graded);
    check('live: a candidate row records the commit it loaded', liveCan.fingerprint.pinCommit === head && liveCan.fingerprint.pinHash === canPin.hash && liveCan.pluginPin === 'candidate');

    // A batch over arms carries each item's arm to the run.
    const bc = { data: path.join(scratch, 'batch-data'), budgetStop: 0.7 };
    const arms3 = Object.fromEntries(['CAN', 'CUR', 'BAS'].map((id) => [id, R.loadArm(PLAN, id, null, 'a'.repeat(40))]));
    const b = R.createBatch(bc, { tasks: ['T1', 'T2'], arms: arms3, account: 'a', k: 1, max: 2 });
    check(`batch: --arms queues ${b.items.length} item(s), each with its arm and that arm's variant`,
        b.items.length === 6 && b.items.every((it) => arms3[it.arm] && it.variant === arms3[it.arm].variant) && b.arms.BAS.pluginPin === 'none' && b.arms.CAN.sha === 'a'.repeat(40) && b.arms.CUR.sha === undefined);
    const bv = R.createBatch(bc, { tasks: ['T1'], variants: ['V0', 'V1'], account: 'a', k: 1, max: 2 });
    check('batch: --variants queues items with no arm, as before', bv.items.length === 2 && bv.items.every((it) => it.arm === undefined) && bv.arms === undefined);
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
