#!/usr/bin/env node
'use strict';
/**
 * The frontier over the runner's rows: pass rate per variant and lane, the
 * median notional cost, tokens, API time and wall time, the task-by-variant
 * matrix, the tasks where variants disagree (the ones that get k = 3), and the
 * Pareto set on (pass rate, cost), (pass rate, API time) and (pass rate, wall).
 *
 * Wall time moves with the machine's load: a worker's suite runs 8x slower
 * beside a peer's coverage run. So the wall median reads only rows whose load
 * class is quiet (no gate, coverage run or full suite outside the run's own
 * tree at any reading), and a row with no load record counts as unknown. API
 * time is the model's own time and reads every counted row.
 *
 *   node tooling/frontier/frontier.js [--data <dir>] [--tasks <dir>] [--json] [--write]
 *
 * A routed variant (V3 in variants.json) is reported twice: its own rows under
 * V3, and V3* derived from rows already measured, per task the rows of the
 * variant that task's brief routes to. V3* is labelled derived, lists the tasks
 * with no rows of the pick, and sits out of the disagreements.
 *
 * Counted: pass, fail and timeout rows (a timeout is a fail). Not counted, and
 * reported beside the rest: billed-api, contaminated and no-stream rows, which
 * measured the harness failing to run, not the variant failing the task.
 * Exit 0 always when the rows were read, 1 when the rows file is unreadable.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const COUNTED = new Set(['pass', 'fail', 'timeout']);

function median(xs) {
    const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
const rate = (p, n) => (n ? Math.round((p / n) * 1000) / 1000 : null);

const blank = () => ({ n: 0, passes: 0, costs: [], walls: [], quietWalls: [], apis: [], tokens: [], lanes: {}, load: { quiet: 0, loaded: 0, unknown: 0 } });
function tally(v, r) {
    v.n++; if (r.pass) v.passes++;
    const cls = loadClass(r);
    v.load[cls]++;
    v.costs.push(r.costUsd); v.walls.push(r.wallMs); v.apis.push(r.durationApiMs); v.tokens.push(r.tokens ? r.tokens.total : null);
    if (cls === 'quiet') v.quietWalls.push(r.wallMs);
    const l = v.lanes[r.lane] || (v.lanes[r.lane] = { n: 0, passes: 0 });
    l.n++; if (r.pass) l.passes++;
}
function stats(v) {
    const lanes = {};
    for (const [lane, l] of Object.entries(v.lanes)) lanes[lane] = { n: l.n, passes: l.passes, passRate: rate(l.passes, l.n) };
    return { n: v.n, passes: v.passes, passRate: rate(v.passes, v.n), medianCostUsd: median(v.costs), medianApiMs: median(v.apis),
        medianWallQuietMs: median(v.quietWalls), medianWallAnyLoadMs: median(v.walls), medianTokens: median(v.tokens), load: v.load, lanes };
}

/**
 * A routed variant read from rows measured without it: per task, the rows of
 * the variant its route picks. The route comes from the task's brief (routes),
 * else from the latest row that recorded one. A task with no route is unrouted
 * and a task with no rows of the picked variant is missing: both are listed,
 * because a derived rate over fewer tasks than the others is not comparable.
 */
function derive(counted, map, routes) {
    const byTask = {};
    for (const r of counted) (byTask[r.task] || (byTask[r.task] = [])).push(r);
    const v = blank();
    const from = {};
    const missing = [];
    const unrouted = [];
    for (const [task, rs] of Object.entries(byTask).sort(([a], [b]) => a.localeCompare(b))) {
        const when = (r) => String(r.finishedAt || r.startedAt || '');
        const recorded = rs.filter((r) => r.route).sort((a, b) => when(a).localeCompare(when(b))).pop();
        const route = routes[task] || (recorded && recorded.route) || null;
        const pick = route ? map[route] : null;
        if (!pick) { unrouted.push(task); continue; }
        from[task] = pick;
        const picked = rs.filter((r) => r.variant === pick);
        if (!picked.length) { missing.push(task); continue; }
        for (const r of picked) tally(v, r);
    }
    return Object.assign(stats(v), { derived: true, from, missing, unrouted });
}

function summarise(rows, { routes = {}, routed = {} } = {}) {
    const counted = rows.filter((r) => COUNTED.has(r.verdict));
    const excluded = {};
    for (const r of rows) if (!COUNTED.has(r.verdict)) excluded[r.verdict] = (excluded[r.verdict] || 0) + 1;
    const variants = {};
    const matrix = {};
    for (const r of counted) {
        tally(variants[r.variant] || (variants[r.variant] = blank()), r);
        const cell = (matrix[r.task] || (matrix[r.task] = {}))[r.variant] || (matrix[r.task][r.variant] = { n: 0, passes: 0 });
        cell.n++; if (r.pass) cell.passes++;
    }
    const out = {};
    for (const [id, v] of Object.entries(variants)) out[id] = stats(v);
    // Disagreements read measured variants only: a derived variant copies
    // another's cells, so it can never disagree on its own.
    const disagreements = Object.entries(matrix).filter(([, cells]) => new Set(Object.values(cells).map((c) => rate(c.passes, c.n))).size > 1).map(([t]) => t).sort();
    for (const [id, map] of Object.entries(routed)) {
        const d = derive(counted, map, routes);
        if (d.n > 0) out[`${id}*`] = d;
    }
    return { rows: rows.length, counted: counted.length, excluded, variants: out, matrix, disagreements,
        pareto: { cost: pareto(out, 'medianCostUsd'), api: pareto(out, 'medianApiMs'), wall: pareto(out, 'medianWallQuietMs') } };
}

/** A row's load class from its record; a row from before the record is unknown. */
function loadClass(r) {
    const c = r.load && r.load.class;
    return c === 'quiet' || c === 'loaded' ? c : 'unknown';
}

/** Variants no other variant beats on pass rate and the metric at once. */
function pareto(variants, metric) {
    const pts = Object.entries(variants).filter(([, v]) => v.passRate !== null && v[metric] !== null);
    return pts.filter(([id, v]) => !pts.some(([other, w]) => other !== id && w.passRate >= v.passRate && w[metric] <= v[metric]
        && (w.passRate > v.passRate || w[metric] < v[metric]))).map(([id]) => id).sort();
}

function readRows(file) {
    const text = fs.readFileSync(file, 'utf8');
    return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function render(s) {
    const lines = [`frontier: ${s.counted} counted of ${s.rows} rows${Object.keys(s.excluded).length ? `, excluded ${JSON.stringify(s.excluded)}` : ''}`];
    const sec = (ms, w) => (ms === null ? '-' : (ms / 1000).toFixed(0)).padStart(w);
    lines.push('variant   n  pass  rate   cost$   api s   quiet wall s   load q/l/u   tokens');
    for (const [id, v] of Object.entries(s.variants).sort()) {
        lines.push(`${id.padEnd(8)} ${String(v.n).padStart(2)}  ${String(v.passes).padStart(4)}  ${String(v.passRate).padStart(5)}  ${v.medianCostUsd === null ? '     -' : v.medianCostUsd.toFixed(2).padStart(6)}  ${sec(v.medianApiMs, 6)}  ${sec(v.medianWallQuietMs, 13)}  ${`${v.load.quiet}/${v.load.loaded}/${v.load.unknown}`.padStart(11)}   ${v.medianTokens === null ? '-' : v.medianTokens}`);
    }
    for (const [id, v] of Object.entries(s.variants).sort()) {
        if (!v.derived) continue;
        const from = Object.entries(v.from).map(([t, w]) => `${t}=${w}`).join(' ');
        lines.push(`${id} is derived, not run: per task, the rows of the variant its route picks (${from || 'none'})${v.missing.length ? `; no rows of the pick for ${v.missing.join(', ')}` : ''}${v.unrouted.length ? `; unrouted ${v.unrouted.join(', ')}` : ''}`);
    }
    lines.push(`pareto on cost: ${s.pareto.cost.join(', ') || '-'}; on API time: ${s.pareto.api.join(', ') || '-'}; on quiet wall time: ${s.pareto.wall.join(', ') || '-'}`);
    lines.push(`disagreements (k = 3 candidates): ${s.disagreements.join(', ') || 'none'}`);
    return lines.join('\n') + '\n';
}

/**
 * Each task's route from its brief, for the tasks the rows name. A task file
 * that is gone leaves its route to the rows. Routed variants come from
 * variants.json: every entry with a route map.
 */
function routing(tasksDir, rows) {
    const { routeFor } = require('./run.js');
    const routes = {};
    for (const id of new Set(rows.map((r) => r.task).filter((t) => /^[A-Za-z0-9]{1,4}$/.test(String(t))))) {
        try {
            const task = JSON.parse(fs.readFileSync(path.join(tasksDir, `${id}.json`), 'utf8'));
            routes[id] = routeFor(fs.readFileSync(path.join(tasksDir, task.brief), 'utf8')).route;
        } catch { /* no task file: the rows' own route stands */ }
    }
    const routed = {};
    let all = {};
    try { all = JSON.parse(fs.readFileSync(path.join(__dirname, 'variants.json'), 'utf8')); } catch { all = {}; }
    for (const [id, v] of Object.entries(all)) if (!id.startsWith('_') && v && v.route) routed[id] = v.route;
    return { routes, routed };
}

function main(argv) {
    if (argv.includes('--help')) {
        process.stdout.write('Usage: node tooling/frontier/frontier.js [--data <dir>] [--tasks <dir>] [--json] [--write]\n  Summarises runs.jsonl: pass rate, median cost, tokens, API time and quiet-load wall time per variant, the Pareto sets and the disagreements.\n  A routed variant (V3) also appears as V3*, derived from the rows of the variant each task\'s brief routes to (tasks from --tasks, default tooling/frontier/tasks).\n');
        return 0;
    }
    const i = argv.indexOf('--data');
    const data = path.resolve(i >= 0 ? argv[i + 1] : (process.env.FRONTIER_DATA || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.claude', 'autodev', 'frontier')));
    const t = argv.indexOf('--tasks');
    const tasksDir = path.resolve(t >= 0 ? argv[t + 1] : path.join(__dirname, 'tasks'));
    let rows;
    try { rows = readRows(path.join(data, 'runs.jsonl')); } catch (e) {
        process.stderr.write(`frontier: cannot read ${path.join(data, 'runs.jsonl')}: ${e.code || e.message}\n`);
        return 1;
    }
    const s = Object.assign({ generatedAt: new Date().toISOString() }, summarise(rows, routing(tasksDir, rows)));
    if (argv.includes('--write')) fs.writeFileSync(path.join(data, 'frontier.json'), JSON.stringify(s, null, 2) + '\n');
    process.stdout.write(argv.includes('--json') ? JSON.stringify(s) + '\n' : render(s));
    return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { summarise, derive, pareto, median, loadClass };
