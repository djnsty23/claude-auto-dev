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

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
const val = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const CFG = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
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

    let files = 0, skipped = 0, rows = 0, unreadable = 0, unknownModel = 0;
    const byModel = new Map();
    let cost = 0;

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
            const model = j.message.model || null;
            const { rates, known } = ratesFor(model, u.speed);
            if (!known) unknownModel++;

            const cc = u.cache_creation || {};
            const w1h = cc.ephemeral_1h_input_tokens || 0;
            // Any creation not attributed to the 1h bucket is priced at the 5m
            // rate. When the split is absent entirely, cache_creation_input_tokens
            // is the total and all of it lands here — the cheaper assumption, and
            // the only one the data supports.
            const w5m = Math.max(0, (u.cache_creation_input_tokens || 0) - w1h)
                || (cc.ephemeral_5m_input_tokens || 0);

            const c = (
                (u.input_tokens || 0) * rates.in
                + (u.cache_read_input_tokens || 0) * rates.in * CACHE_READ_MULT
                + w5m * rates.in * CACHE_WRITE_5M_MULT
                + w1h * rates.in * CACHE_WRITE_1H_MULT
                + (u.output_tokens || 0) * rates.out
            ) / 1e6;

            cost += c;
            const k = model || '(unknown)';
            byModel.set(k, (byModel.get(k) || 0) + c);
        }
    }

    const population = {
        transcriptsRead: files, transcriptsSkippedByMtime: skipped,
        usageRowsInWindow: rows, unreadable, rowsPricedAtFallbackRate: unknownModel,
    };

    if (has('json')) {
        process.stdout.write(JSON.stringify({
            windowCost: cost,
            windowStart: ws.toISOString(),
            currency: 'USD',
            basis: 'list-price equivalent; NOT a subscription bill',
            byModel: Object.fromEntries(byModel),
            population,
        }) + '\n');
        return;
    }

    console.log('QUOTA BURN — list-price equivalent, NOT a bill');
    console.log('  window opened : ' + ws.toISOString() + '  (Wed 02:00 local)');
    console.log('  window cost   : $' + cost.toFixed(2));
    console.log('  population    : ' + rows + ' usage row(s) in window, from ' + files
        + ' transcript(s) read, ' + skipped + ' skipped by mtime, ' + unreadable + ' unreadable');
    if (unknownModel) {
        console.log('  !! ' + unknownModel + ' row(s) had an unrecognised model and were priced at the');
        console.log('     HIGHEST published rate. Over-reporting is the safe direction for a tripwire.');
    }
    console.log('');
    for (const [m, c] of [...byModel.entries()].sort((a, b) => b[1] - a[1])) {
        console.log('  ' + String(m).padEnd(24) + ' $' + c.toFixed(2));
    }
}

main();
