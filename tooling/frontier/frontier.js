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
 *   node tooling/frontier/frontier.js [--data <dir>] [--json] [--write]
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

function summarise(rows) {
    const counted = rows.filter((r) => COUNTED.has(r.verdict));
    const excluded = {};
    for (const r of rows) if (!COUNTED.has(r.verdict)) excluded[r.verdict] = (excluded[r.verdict] || 0) + 1;
    const variants = {};
    const matrix = {};
    for (const r of counted) {
        const v = variants[r.variant] || (variants[r.variant] = { n: 0, passes: 0, costs: [], walls: [], quietWalls: [], apis: [], tokens: [], lanes: {}, load: { quiet: 0, loaded: 0, unknown: 0 } });
        v.n++; if (r.pass) v.passes++;
        const cls = loadClass(r);
        v.load[cls]++;
        v.costs.push(r.costUsd); v.walls.push(r.wallMs); v.apis.push(r.durationApiMs); v.tokens.push(r.tokens ? r.tokens.total : null);
        if (cls === 'quiet') v.quietWalls.push(r.wallMs);
        const l = v.lanes[r.lane] || (v.lanes[r.lane] = { n: 0, passes: 0 });
        l.n++; if (r.pass) l.passes++;
        const cell = (matrix[r.task] || (matrix[r.task] = {}))[r.variant] || (matrix[r.task][r.variant] = { n: 0, passes: 0 });
        cell.n++; if (r.pass) cell.passes++;
    }
    const out = {};
    for (const [id, v] of Object.entries(variants)) {
        const lanes = {};
        for (const [lane, l] of Object.entries(v.lanes)) lanes[lane] = { n: l.n, passes: l.passes, passRate: rate(l.passes, l.n) };
        out[id] = { n: v.n, passes: v.passes, passRate: rate(v.passes, v.n), medianCostUsd: median(v.costs), medianApiMs: median(v.apis),
            medianWallQuietMs: median(v.quietWalls), medianWallAnyLoadMs: median(v.walls), medianTokens: median(v.tokens), load: v.load, lanes };
    }
    const disagreements = Object.entries(matrix).filter(([, cells]) => new Set(Object.values(cells).map((c) => rate(c.passes, c.n))).size > 1).map(([t]) => t).sort();
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
    lines.push(`pareto on cost: ${s.pareto.cost.join(', ') || '-'}; on API time: ${s.pareto.api.join(', ') || '-'}; on quiet wall time: ${s.pareto.wall.join(', ') || '-'}`);
    lines.push(`disagreements (k = 3 candidates): ${s.disagreements.join(', ') || 'none'}`);
    return lines.join('\n') + '\n';
}

function main(argv) {
    if (argv.includes('--help')) {
        process.stdout.write('Usage: node tooling/frontier/frontier.js [--data <dir>] [--json] [--write]\n  Summarises runs.jsonl: pass rate, median cost, tokens, API time and quiet-load wall time per variant, the Pareto sets and the disagreements.\n');
        return 0;
    }
    const i = argv.indexOf('--data');
    const data = path.resolve(i >= 0 ? argv[i + 1] : (process.env.FRONTIER_DATA || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.claude', 'autodev', 'frontier')));
    let rows;
    try { rows = readRows(path.join(data, 'runs.jsonl')); } catch (e) {
        process.stderr.write(`frontier: cannot read ${path.join(data, 'runs.jsonl')}: ${e.code || e.message}\n`);
        return 1;
    }
    const s = Object.assign({ generatedAt: new Date().toISOString() }, summarise(rows));
    if (argv.includes('--write')) fs.writeFileSync(path.join(data, 'frontier.json'), JSON.stringify(s, null, 2) + '\n');
    process.stdout.write(argv.includes('--json') ? JSON.stringify(s) + '\n' : render(s));
    return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { summarise, pareto, median, loadClass };
