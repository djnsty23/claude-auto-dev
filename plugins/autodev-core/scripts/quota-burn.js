#!/usr/bin/env node
'use strict';
/**
 * List-price-equivalent spend for the current weekly quota window.
 *
 * WHY THIS EXISTS IN THE PLUGIN. `quota-tripwire.js` spawns a burn-rate source
 * as `node <source> --json --days 0` and reads `windowCost` and `windowStart`
 * out of the JSON. It defaulted to `~/.claude/scripts/quota-burn.js`, a path
 * outside every plugin. `[measured 2026-08-28]` that file existed on no machine
 * here and in no repo, so `--status` read `FAILED code=source-missing` and the
 * tripwire could never fire — while **silence is the tripwire's success signal**.
 * An alarm that cannot ring looks exactly like one with nothing to report.
 *
 * Shipping the source means the alarm works by install rather than by luck.
 *
 * WHAT IT MEASURES, AND WHAT IT DOES NOT. This is a list-price EQUIVALENT: what
 * the same tokens would cost through the API at published rates. It is NOT the
 * subscription price and NOT a bill. It is a comparable number for "how much of
 * the week's headroom is gone", which is exactly what a tripwire needs and the
 * only thing that can be computed from transcripts.
 *
 *   node quota-burn.js --json            machine-readable, this window
 *   node quota-burn.js --json --days 0   same; --days narrows the FILE scan only
 *   node quota-burn.js                   human summary, per model
 */
const fs = require('fs');
const path = require('path');
const claudePaths = require('./claude-paths.js');

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
const val = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const CFG = claudePaths.configDir();
const PROJECTS = path.join(CFG, 'projects');

// Published per-MTok rates. Cache multipliers are applied to the INPUT rate:
// read 0.1x, write 1.25x at the 5-minute TTL and 2x at the 1-hour TTL.
// [verified 2026-08-28 against the claude-api skill's pricing tables]
//
// The 1h write multiplier is not decoration here: sessions on the 1-hour TTL pay
// 2x on every cache write, and treating those as 1.25x understates a long
// session's cost by a wide margin.
const RATES = {
    'claude-fable-5': { in: 10, out: 50 },
    'claude-mythos-5': { in: 10, out: 50 },
    'claude-opus-5': { in: 5, out: 25 },
    'claude-opus-4-8': { in: 5, out: 25 },
    'claude-opus-4-7': { in: 5, out: 25 },
    'claude-opus-4-6': { in: 5, out: 25 },
    'claude-sonnet-5': { in: 2, out: 10 },
    'claude-sonnet-4-6': { in: 3, out: 15 },
    'claude-haiku-4-5': { in: 1, out: 5 },
};
// Fast mode runs Opus 5 at premium rates. usage.speed reports which ran.
const FAST_RATES = { 'claude-opus-5': { in: 10, out: 50 }, 'claude-opus-4-8': { in: 10, out: 50 } };

const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2;

// The priced unit. A source that prints no `measure` summed every usage row.
const MEASURE = 'response';

/**
 * An UNKNOWN model is priced at the most expensive published rate, not skipped
 * and not zero. A tripwire that under-reports is worse than one that over-
 * reports: the first stays silent through the wall, the second cries early.
 */
function ratesFor(model, speed) {
    if (!model) return { rates: RATES['claude-fable-5'], known: false };
    if (speed === 'fast' && FAST_RATES[model]) return { rates: FAST_RATES[model], known: true };
    if (RATES[model]) return { rates: RATES[model], known: true };
    const prefix = Object.keys(RATES).find((k) => model.startsWith(k));
    if (prefix) return { rates: RATES[prefix], known: true };
    return { rates: RATES['claude-fable-5'], known: false };
}

/**
 * The weekly window opens Wednesday 02:00 LOCAL. Computed by walking back from
 * today rather than by arithmetic on epoch milliseconds, so it stays correct
 * across a DST transition — a fixed 7*24h subtraction is wrong by an hour twice
 * a year, and being wrong about when the window opened silently mis-scopes
 * every number below it.
 */
function windowStart(now = new Date()) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 2, 0, 0, 0);
    // 3 = Wednesday. Walk back to the most recent Wednesday 02:00 at or before now.
    while (d.getDay() !== 3 || d.getTime() > now.getTime()) {
        d.setDate(d.getDate() - 1);
        d.setHours(2, 0, 0, 0);
    }
    return d;
}

/**
 * Price ONE transcript usage block at list price, split by token class.
 *
 * Exported so work-cost.js prices a row with this table rather than a copy of
 * it: two price tables drift apart, and then the tripwire and the per-PR cost
 * disagree about the same row. `tokens.cacheWrite` is both TTLs together.
 */
function priceUsage(u, model) {
    const { rates, known } = ratesFor(model, u.speed);
    const cc = u.cache_creation || {};
    const w1h = cc.ephemeral_1h_input_tokens || 0;
    // Any creation not attributed to the 1h bucket is priced at the 5m
    // rate. When the split is absent entirely, cache_creation_input_tokens
    // is the total and all of it lands here: the cheaper assumption, and
    // the only one the data supports.
    const w5m = Math.max(0, (u.cache_creation_input_tokens || 0) - w1h)
        || (cc.ephemeral_5m_input_tokens || 0);
    const input = u.input_tokens || 0;
    const cacheRead = u.cache_read_input_tokens || 0;
    const output = u.output_tokens || 0;
    const cost = (
        input * rates.in
        + cacheRead * rates.in * CACHE_READ_MULT
        + w5m * rates.in * CACHE_WRITE_5M_MULT
        + w1h * rates.in * CACHE_WRITE_1H_MULT
        + output * rates.out
    ) / 1e6;
    return { cost, known, tokens: { input, output, cacheWrite: w5m + w1h, cacheRead } };
}

/**
 * The key of the API response a usage row belongs to, or null.
 *
 * Claude Code writes one transcript row per content block, and every row of a
 * response repeats that response's usage. [measured 2026-09-29] over two days,
 * 14,361 of 24,421 usage rows were repeats and 60.4% of the summed cost, so a
 * sum over rows read about 2.5x the real spend. A response is its message id
 * plus its request id. A row with neither cannot be matched to a response and
 * is counted on its own.
 */
function responseKey(j) {
    const id = (j.message && j.message.id) || '';
    const req = j.requestId || '';
    return id || req ? id + '|' + req : null;
}

function* transcripts(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) yield* transcripts(p);
        else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
    }
}

function main() {
    const ws = windowStart();
    const wsMs = ws.getTime();
    // --days narrows the FILE scan by mtime. It is a speed change only, and safe:
    // a transcript untouched since the window opened holds no rows inside it.
    const days = parseFloat(val('days', ''));
    const mtimeFloor = Number.isFinite(days) && days >= 0
        ? Math.min(wsMs, Date.now() - days * 86400000) : wsMs;

    let files = 0, skipped = 0, rows = 0, unreadable = 0, unknownModel = 0, unkeyed = 0;
    // One entry per API response, and the row kept is the one with the most
    // output. Every row repeats the same input and cache usage, but an early
    // row is a streaming partial: [measured 2026-09-30] 8 output tokens where
    // the final row of the same response said 549. "Keep the last row" is not
    // enough, because a resumed or subagent transcript copies rows into another
    // file, and 2,773 times in 7 days the partial copy was read after the final.
    const responses = new Map();

    for (const f of transcripts(PROJECTS)) {
        let st;
        try { st = fs.statSync(f); } catch { unreadable++; continue; }
        if (st.mtimeMs < mtimeFloor) { skipped++; continue; }
        files++;
        let text;
        try { text = fs.readFileSync(f, 'utf8'); } catch { unreadable++; continue; }
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            let j; try { j = JSON.parse(line); } catch { continue; }
            const u = j.message && j.message.usage;
            if (!u) continue;
            // Only rows inside the window count. The file-level mtime filter is a
            // speed optimisation; THIS is the correctness filter.
            const t = Date.parse(j.timestamp || j.message.timestamp || '');
            if (!t || t < wsMs) continue;

            rows++;
            const key = responseKey(j);
            if (!key) unkeyed++;
            const kept = key && responses.get(key);
            if (kept && (u.output_tokens || 0) < (kept.u.output_tokens || 0)) continue;
            responses.set(key || f + ':' + rows, { u, model: j.message.model || null });
        }
    }

    const byModel = new Map();
    let cost = 0;
    for (const { u, model } of responses.values()) {
        const { cost: c, known } = priceUsage(u, model);
        if (!known) unknownModel++;
        cost += c;
        const k = model || '(unknown)';
        byModel.set(k, (byModel.get(k) || 0) + c);
    }

    const population = {
        transcriptsRead: files, transcriptsSkippedByMtime: skipped,
        usageRowsInWindow: rows,
        responsesInWindow: responses.size,
        repeatedRows: rows - responses.size,
        rowsWithoutResponseId: unkeyed,
        unreadable, responsesPricedAtFallbackRate: unknownModel,
    };

    if (has('json')) {
        process.stdout.write(JSON.stringify({
            windowCost: cost,
            windowStart: ws.toISOString(),
            currency: 'USD',
            basis: 'list-price equivalent; NOT a subscription bill',
            // What one priced unit is. quota-tripwire.js stores this beside
            // every sample and calibration point and never mixes two measures:
            // a sum over rows reads 2.3x to 2.5x a sum over responses.
            measure: MEASURE,
            byModel: Object.fromEntries(byModel),
            population,
        }) + '\n');
        return;
    }

    console.log('QUOTA BURN — list-price equivalent, NOT a bill');
    console.log('  window opened : ' + ws.toISOString() + '  (Wed 02:00 local)');
    console.log('  window cost   : $' + cost.toFixed(2));
    console.log('  population    : ' + responses.size + ' API response(s) from ' + rows
        + ' usage row(s) in window (' + (rows - responses.size) + ' repeated a response, '
        + unkeyed + ' had no response id and count alone), ' + files
        + ' transcript(s) read, ' + skipped + ' skipped by mtime, ' + unreadable + ' unreadable');
    if (unknownModel) {
        console.log('  !! ' + unknownModel + ' response(s) had an unrecognised model and were priced at the');
        console.log('     HIGHEST published rate. Over-reporting is the safe direction for a tripwire.');
    }
    console.log('');
    for (const [m, c] of [...byModel.entries()].sort((a, b) => b[1] - a[1])) {
        console.log('  ' + String(m).padEnd(24) + ' $' + c.toFixed(2));
    }
}

// Behind require.main so work-cost.js can require the price table without
// running a window scan in its own process.
if (require.main === module) main();
module.exports = { priceUsage, ratesFor, windowStart, transcripts, responseKey };
