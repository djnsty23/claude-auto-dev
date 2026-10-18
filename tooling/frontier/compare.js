'use strict';
/**
 * compare.js - read a preregistered frontier plan against its recorded rows.
 *
 * A plan (tooling/frontier/path-to-10.json) fixes, before any run: the tasks,
 * the families they belong to, the arms, the repeat count, the families
 * withheld from tuning and the inputs tuning may change. compare reads that
 * plan and the rows recorded so far and answers four questions, without
 * launching anything:
 *
 *   arms                 how many arms the plan defines validly
 *   independent_oracles  every task has an endpoint oracle (held-out checks for
 *                        a fix, an answer key otherwise), and every row's pass
 *                        is exactly what that oracle recorded. A row passed by
 *                        anything else, such as a reviewer's verdict, fails it.
 *   leakage_controls     no withheld task is a tuning task or a tuning row, and
 *                        no tuning input carries a line of a withheld task's
 *                        brief or names its task file
 *   missing_runs         an arm short of tasks x repeats counted rows reports
 *                        UNKNOWN with no pass rate, never a pass and never a
 *                        zero. NONE when every arm is complete, FAIL when an
 *                        incomplete arm reports a number.
 *   run_identity         every counted row fills its own planned cell once. A
 *                        second counted row for one arm, task and repeat, or a
 *                        repeat beyond the plan, is an unplanned attempt: a
 *                        re-run that replaced a fail would otherwise read as
 *                        the arm's result. FAIL names each, and that arm
 *                        reports CONFLICT with no rate.
 *
 * Counted rows are pass, fail and timeout, as frontier.js counts them. A
 * contaminated, billed-api or no-stream row measured the harness, not the arm,
 * so it is missing, not failed.
 */
const fs = require('fs');
const path = require('path');

const COUNTED = new Set(['pass', 'fail', 'timeout']);
const ANSWER_LANES = new Set(['locate', 'review', 'decide']);
const FINGERPRINT_MIN = 40;

function readJsonFile(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function readRowsFile(file) {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** The plan's tasks, each with its family, and the withheld subset. */
function planTasks(plan) {
    const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
    const withheld = new Set(plan.withheldFamilies || []);
    return { tasks, withheldIds: new Set(tasks.filter((t) => withheld.has(t.family)).map((t) => t.id)) };
}

/** Arms with a unique id, a plugin pin and a variant the runner knows. */
function validArms(plan, variants) {
    const seen = new Set();
    const problems = [];
    for (const a of plan.arms || []) {
        if (!a.id || seen.has(a.id)) problems.push(`arm ${a.id}: missing or duplicate id`);
        seen.add(a.id);
        if (!['current', 'previous', 'none'].includes(a.pluginPin)) problems.push(`arm ${a.id}: pluginPin ${a.pluginPin} is not current, previous or none`);
        if (!variants[a.variant]) problems.push(`arm ${a.id}: variant ${a.variant} is not in variants.json`);
    }
    return { count: seen.size, problems };
}

/** The oracle a task file names: held-out checks for a fix, an answer key otherwise. */
function taskOracle(tasksDir, id) {
    const file = path.join(tasksDir, `${id}.json`);
    if (!fs.existsSync(file)) return { ok: false, why: `${id}: no task file` };
    const t = readJsonFile(file);
    if (t.grader && t.grader !== 'endpoint') return { ok: false, why: `${id}: graded by ${t.grader}, not its endpoint` };
    if (t.lane === 'fix') {
        const checks = Array.isArray(t.checks) ? t.checks : [];
        const heldOut = new Set(t.heldOut || []);
        const independent = checks.length > 0 && checks.every((argv) => argv.some((a) => heldOut.has(a) || String(a).startsWith('{frontier}/checks/')));
        if (!independent) return { ok: false, why: `${id}: a fix check is neither held out nor a frontier check` };
        if (!t.contaminationWaiver && !Array.isArray(t.disclosed)) return { ok: false, why: `${id}: no contamination control (disclosed list or waiver)` };
        return { ok: true, lane: t.lane, kind: 'endpoint', task: t };
    }
    if (ANSWER_LANES.has(t.lane)) {
        if (!t.expected || !fs.existsSync(path.join(tasksDir, t.expected))) return { ok: false, why: `${id}: no answer key` };
        return { ok: true, lane: t.lane, kind: 'key', task: t };
    }
    return { ok: false, why: `${id}: lane ${t.lane} has no oracle` };
}

/** What the oracle recorded for a row: true or false, or null when it recorded nothing. */
function oraclePass(row, lane) {
    const g = row.grade;
    if (!g || typeof g !== 'object') return null;
    if (lane === 'fix') {
        if (!Array.isArray(g.checks) || !g.checks.length) return null;
        return g.checks.every((k) => k.exit === 0) && (g.passToPass || []).every((k) => k.exit === 0);
    }
    return typeof g.pass === 'boolean' ? g.pass : null;
}

function independentOracles(plan, rows, tasksDir) {
    const problems = [];
    const lanes = {};
    for (const t of plan.tasks || []) {
        const o = taskOracle(tasksDir, t.id);
        if (!o.ok) problems.push(o.why); else lanes[t.id] = o.lane;
    }
    let graded = 0;
    for (const r of rows) {
        if (!lanes[r.task] || !COUNTED.has(r.verdict)) continue;
        graded++;
        const want = r.verdict === 'timeout' ? false : oraclePass(r, lanes[r.task]);
        if (want === null) problems.push(`${r.arm}/${r.task}#${r.repeat}: no oracle record behind ${r.verdict}`);
        else if (r.pass !== want || (r.verdict === 'pass') !== want) problems.push(`${r.arm}/${r.task}#${r.repeat}: ${r.verdict} disagrees with its oracle`);
    }
    return { tasks: (plan.tasks || []).length, graded, problems, verdict: problems.length ? 'FAIL' : 'PASS' };
}

/** Lines of a withheld task's brief long enough to be a fingerprint. */
function fingerprints(tasksDir, ids) {
    const out = [];
    for (const id of ids) {
        out.push({ id, text: `frontier/tasks/${id}.` });
        let t;
        try { t = readJsonFile(path.join(tasksDir, `${id}.json`)); } catch { continue; }
        for (const name of [t.brief, t.expected].filter(Boolean)) {
            let body = '';
            try { body = fs.readFileSync(path.join(tasksDir, name), 'utf8'); } catch { continue; }
            for (const line of body.split(/\r?\n/)) {
                const s = line.trim();
                if (s.length >= FINGERPRINT_MIN && !s.startsWith('#')) out.push({ id, text: s });
            }
        }
    }
    return out;
}

function walkFiles(p, out = []) {
    let st;
    try { st = fs.statSync(p); } catch { return out; }
    if (st.isFile()) { out.push(p); return out; }
    for (const e of fs.readdirSync(p)) walkFiles(path.join(p, e), out);
    return out;
}

function leakageControls(plan, rows, root, tasksDir) {
    const { withheldIds } = planTasks(plan);
    const problems = [];
    const tuning = (plan.tuning && plan.tuning.tasks) || [];
    if (!withheldIds.size) problems.push('no task is withheld');
    for (const id of tuning) if (withheldIds.has(id)) problems.push(`${id}: withheld, yet a tuning task`);
    for (const r of rows) if (r.use === 'tuning' && withheldIds.has(r.task)) problems.push(`${r.arm}/${r.task}#${r.repeat}: a withheld task's row is a tuning row`);
    const files = [];
    for (const rel of (plan.tuning && plan.tuning.inputs) || []) walkFiles(path.join(root, rel), files);
    if (!files.length) problems.push('no tuning input file was read');
    const prints = fingerprints(tasksDir, withheldIds);
    for (const f of files) {
        let text;
        try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        for (const fp of prints) if (text.includes(fp.text)) problems.push(`${path.relative(root, f).replace(/\\/g, '/')}: carries withheld ${fp.id} text "${fp.text.slice(0, 50)}"`);
    }
    return { withheld: withheldIds.size, inputs: files.length, fingerprints: prints.length, problems, verdict: problems.length ? 'FAIL' : 'PASS' };
}

/** Per arm: counted runs against tasks x repeats, and a rate only when complete. */
function armRuns(plan, rows) {
    const { tasks, withheldIds } = planTasks(plan);
    const repeats = Number(plan.repeats) || 0;
    const ids = new Set(tasks.map((t) => t.id));
    const out = {};
    for (const a of plan.arms || []) {
        const cells = new Map();
        const unplanned = [];
        for (const r of rows) {
            if (r.arm !== a.id || !ids.has(r.task) || !COUNTED.has(r.verdict)) continue;
            const rep = Number(r.repeat);
            const key = `${r.task}#${r.repeat}`;
            if (!(Number.isInteger(rep) && rep >= 1 && rep <= repeats)) { unplanned.push(`${key} beyond ${repeats} repeat(s)`); continue; }
            if (cells.has(key)) { unplanned.push(`${key} recorded twice`); continue; }
            cells.set(key, r);
        }
        const expected = tasks.length * repeats;
        const counted = [...cells.values()];
        const conflict = unplanned.length > 0;
        const complete = !conflict && expected > 0 && counted.length === expected;
        const rate = (rs) => (rs.length ? Math.round((rs.filter((r) => r.pass === true).length / rs.length) * 1000) / 1000 : null);
        out[a.id] = { expected, counted: counted.length, missing: expected - counted.length, unplanned,
            status: conflict ? 'CONFLICT' : complete ? 'COMPLETE' : 'UNKNOWN',
            passRate: complete ? rate(counted) : null, heldOutPassRate: complete ? rate(counted.filter((r) => withheldIds.has(r.task))) : null };
    }
    return out;
}

function missingRuns(arms) {
    const rows = Object.values(arms);
    if (!rows.length) return 'UNKNOWN';
    const incomplete = rows.filter((a) => a.missing > 0);
    if (incomplete.some((a) => a.status === 'COMPLETE' || a.passRate !== null || a.heldOutPassRate !== null)) return 'FAIL';
    return incomplete.length ? 'UNKNOWN' : 'NONE';
}

/** PASS when no arm holds an unplanned attempt. An arm without the list fails closed. */
function runIdentity(arms) {
    const rows = Object.values(arms);
    if (!rows.length) return 'UNKNOWN';
    return rows.some((a) => !Array.isArray(a.unplanned) || a.unplanned.length > 0 || a.status === 'CONFLICT') ? 'FAIL' : 'PASS';
}

/**
 * The whole comparison. opts: { planFile, root, tasksDir, variants, rows }.
 * rows defaults to the plan's fixture file, resolved beside the plan.
 */
function compare(opts) {
    const plan = readJsonFile(opts.planFile);
    const rows = opts.rows || readRowsFile(path.resolve(path.dirname(opts.planFile), plan.fixtures));
    const arms = validArms(plan, opts.variants);
    const oracles = independentOracles(plan, rows, opts.tasksDir);
    const leakage = leakageControls(plan, rows, opts.root, opts.tasksDir);
    const runs = armRuns(plan, rows);
    const missing = missingRuns(runs);
    const identity = runIdentity(runs);
    const planned = (plan.tasks || []).length * (plan.arms || []).length * (Number(plan.repeats) || 0);
    return { plan, rows: rows.length, planned, arms, oracles, leakage, runs, missing, identity,
        line: `arms=${arms.problems.length ? `INVALID(${arms.problems.length})` : arms.count} independent_oracles=${oracles.verdict} leakage_controls=${leakage.verdict} missing_runs=${missing} run_identity=${identity}` };
}

/** The population lines and the verdict line, as printed by run.js compare. */
function render(r) {
    const out = [];
    const line = (ok, text) => out.push(`${ok ? 'ok' : 'FAIL'} ${text}`);
    line(r.arms.problems.length === 0, `arms: ${r.arms.count} defined${r.arms.problems.length ? ` (${r.arms.problems.join('; ')})` : ''}`);
    line(r.oracles.verdict === 'PASS', `oracles: ${r.oracles.tasks} task(s), ${r.oracles.graded} counted row(s) each matched to its endpoint record${r.oracles.problems.length ? ` (${r.oracles.problems.slice(0, 3).join('; ')})` : ''}`);
    line(r.leakage.verdict === 'PASS', `leakage: ${r.leakage.withheld} withheld task(s), ${r.leakage.fingerprints} fingerprint(s) over ${r.leakage.inputs} tuning input file(s)${r.leakage.problems.length ? ` (${r.leakage.problems.slice(0, 3).join('; ')})` : ''}`);
    for (const [id, a] of Object.entries(r.runs)) {
        line(!a.unplanned.length && (a.status === 'COMPLETE' ? a.passRate !== null : a.passRate === null), `arm ${id}: ${a.counted} of ${a.expected} run(s), ${a.status === 'COMPLETE' ? `pass rate ${a.passRate}, held-out ${a.heldOutPassRate}` : `${a.missing} missing, rate UNKNOWN`}${a.unplanned.length ? `, ${a.status}: ${a.unplanned.slice(0, 3).join('; ')}` : ''}`);
    }
    out.push(`plan: ${r.planned} bounded run(s) preregistered, ${r.rows} row(s) read`);
    out.push(r.line);
    return out.join('\n') + '\n';
}

function verdictOk(r) {
    return r.arms.problems.length === 0 && r.oracles.verdict === 'PASS' && r.leakage.verdict === 'PASS' && r.missing !== 'FAIL' && r.identity !== 'FAIL';
}

module.exports = { compare, render, verdictOk, validArms, taskOracle, oraclePass, independentOracles, fingerprints, leakageControls, armRuns, missingRuns, runIdentity, planTasks, readRowsFile };
