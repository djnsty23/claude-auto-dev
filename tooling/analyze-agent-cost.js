#!/usr/bin/env node
// analyze-agent-cost.js — measure, from real session transcripts, where model
// spend actually concentrates and what an in-session subagent costs relative to
// the main thread that spawned it.
//
// Read-only. Answers the questions a model-placement decision turns on:
//   - does a growing context degrade latency, and by how much
//   - does prompt caching decay over a long session (measured: it does not)
//   - how much smaller is a subagent's context than its parent's
//
// WHY THIS EXISTS AS A COMMITTED TOOL
// The numbers move as usage shifts, and a placement rule written against stale
// measurements is worse than no rule. `~/.claude/CLAUDE.md` cites this command
// rather than hardcoding the figures.
//
// THE BUG THIS GUARDS AGAINST
// Subagents do NOT write into the parent transcript. They write to
//   <project>/<session-uuid>/subagents/agent-*.jsonl
// A one-level glob (`*/*.jsonl`) misses every one of them. The first version of
// this analysis did exactly that, found 0 subagent records across 362 subagent
// files, and reported "no subagents used" — a confident, plausible, completely
// wrong finding. So this script walks recursively AND refuses to print the
// headline ratio when the subagent set is empty, because on a machine with
// session history that means the walk is broken, not that nobody used subagents.
//
// Usage:
//   node tooling/analyze-agent-cost.js [mainSampleSize]
//   AGENT_COST_ROOT=<dir> node tooling/analyze-agent-cost.js   (for testing)
//
// Dollar figures are LIST-PRICE EQUIVALENTS for comparing surfaces against each
// other. Under a subscription they are not a bill.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const HOME = process.env.HOME || process.env.USERPROFILE;
const ROOT = process.env.AGENT_COST_ROOT
    || path.join(HOME, '.claude', 'projects');
const MAIN_SAMPLE = Number(process.argv[2] || 8);

// $/1M tokens. Keep in sync with the model table in the `claude-api` skill.
const PRICES = {
    'claude-fable-5': { in: 10, out: 50 }, 'claude-mythos-5': { in: 10, out: 50 },
    'claude-opus-5': { in: 5, out: 25 }, 'claude-opus-4-8': { in: 5, out: 25 },
    'claude-opus-4-7': { in: 5, out: 25 }, 'claude-opus-4-6': { in: 5, out: 25 },
    'claude-sonnet-5': { in: 3, out: 15 }, 'claude-sonnet-4-6': { in: 3, out: 15 },
    'claude-haiku-4-5': { in: 1, out: 5 },
};
// Cache reads bill ~0.1x base input; writes 1.25x (5m TTL) or 2x (1h TTL).
const READ_MULT = 0.1, W5_MULT = 1.25, W1H_MULT = 2.0;

const priceOf = (m) => (m && (PRICES[m]
    || PRICES[Object.keys(PRICES).find((k) => m.startsWith(k))])) || null;

const LAT_BUCKETS = [0, 25e3, 50e3, 100e3, 200e3, 400e3, Infinity];
const bucketLabel = (i) => {
    const k = (n) => (n === Infinity ? '∞' : Math.round(n / 1000) + 'k');
    return `${k(LAT_BUCKETS[i])}–${k(LAT_BUCKETS[i + 1])}`;
};

function blank() {
    return { files: 0, reqs: 0, in: 0, read: 0, w5: 0, w1h: 0, out: 0, cost: 0, prompts: [] };
}

function addUsage(bin, u, model) {
    const p = priceOf(model);
    const cc = u.cache_creation || {};
    const inTok = u.input_tokens || 0;
    const read = u.cache_read_input_tokens || 0;
    const w5 = cc.ephemeral_5m_input_tokens || 0;
    const w1h = cc.ephemeral_1h_input_tokens || 0;
    const out = u.output_tokens || 0;
    bin.reqs++; bin.in += inTok; bin.read += read; bin.w5 += w5; bin.w1h += w1h; bin.out += out;
    bin.prompts.push(inTok + read + (u.cache_creation_input_tokens || 0));
    if (p) {
        bin.cost += (inTok * p.in + read * p.in * READ_MULT + w5 * p.in * W5_MULT
            + w1h * p.in * W1H_MULT + out * p.out) / 1e6;
    }
}

// Recursive — a one-level glob is the documented failure mode above.
function walk(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.name.endsWith('.jsonl')) out.push(full);
    }
}

const MAIN = blank(), SIDE = blank();
const mainModels = {}, sideModels = {};
const latency = LAT_BUCKETS.slice(0, -1).map(() => []);
const decile = Array.from({ length: 10 }, () => ({ read: 0, write: 0, reqs: 0 }));

async function scan(file, bin, models, collectTiming) {
    const rl = readline.createInterface({
        input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity,
    });
    let prevTs = null;
    const rows = [];
    for await (const line of rl) {
        if (!line || line[0] !== '{') { prevTs = null; continue; }
        let o;
        try { o = JSON.parse(line); } catch { prevTs = null; continue; }
        const ts = o.timestamp ? Date.parse(o.timestamp) : null;
        const u = o.message && o.message.usage;
        if (!u || o.type !== 'assistant') { if (ts) prevTs = ts; continue; }

        addUsage(bin, u, o.message.model);
        models[o.message.model] = (models[o.message.model] || 0) + 1;
        const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)
            + (u.cache_creation_input_tokens || 0);

        if (collectTiming) {
            // Latency proxy: the gap from the previous record — a tool result or
            // user turn that had already completed — to this assistant record.
            if (prevTs && ts && ts > prevTs) {
                const dt = (ts - prevTs) / 1000;
                if (dt > 0 && dt < 600) {          // drop idle gaps between sessions
                    const bi = LAT_BUCKETS.findIndex((_, i) =>
                        prompt >= LAT_BUCKETS[i] && prompt < LAT_BUCKETS[i + 1]);
                    if (bi >= 0 && bi < latency.length) latency[bi].push(dt);
                }
            }
            rows.push({ read: u.cache_read_input_tokens || 0,
                write: u.cache_creation_input_tokens || 0 });
        }
        if (ts) prevTs = ts;
    }
    if (collectTiming) {
        rows.forEach((r, i) => {
            const d = Math.min(9, Math.floor((i / Math.max(1, rows.length)) * 10));
            decile[d].read += r.read; decile[d].write += r.write; decile[d].reqs++;
        });
    }
    bin.files++;
}

const med = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const fmt = (n) => Math.round(n).toLocaleString('en-US');

(async () => {
    if (!fs.existsSync(ROOT)) {
        console.error(`\nNo transcript store at ${ROOT}`);
        console.error('Set AGENT_COST_ROOT to point at one.\n');
        process.exit(2);
    }

    const all = [];
    walk(ROOT, all);
    const isSub = (f) => f.includes(`${path.sep}subagents${path.sep}`);
    const subs = all.filter(isSub).map((f) => ({ f, s: fs.statSync(f).size }));
    const mains = all.filter((f) => !isSub(f))
        .map((f) => ({ f, s: fs.statSync(f).size })).sort((a, b) => b.s - a.s);

    // POPULATION FIRST. A verdict with no denominator is indistinguishable from
    // a walk that found nothing.
    console.log(`\nagent-cost — ${ROOT}`);
    console.log(`  transcripts found : ${all.length} total — ${mains.length} main, ${subs.length} subagent`);
    console.log(`  bytes on disk     : ${(mains.reduce((s, x) => s + x.s, 0) / 1e9).toFixed(2)} GB main, ${(subs.reduce((s, x) => s + x.s, 0) / 1e6).toFixed(0)} MB subagent`);
    console.log(`  sampling          : ${Math.min(MAIN_SAMPLE, mains.length)} largest main sessions, ALL ${subs.length} subagent files`);
    console.log(`  prices            : list-price equivalents, ${Object.keys(PRICES).length} models in table\n`);

    // THE GUARD. Zero subagent files on a machine that HAS main transcripts means
    // the recursive walk is broken — that is exactly the bug this tool documents.
    if (mains.length > 0 && subs.length === 0) {
        console.error('REFUSING TO REPORT: found main transcripts but zero subagent files.');
        console.error('');
        console.error('Subagents live at <project>/<session-uuid>/subagents/agent-*.jsonl.');
        console.error('Zero of them alongside real main sessions almost always means the');
        console.error('directory walk stopped too shallow, not that no subagent ever ran.');
        console.error('Verify with:  find "$ROOT" -path "*/subagents/*" -name "*.jsonl" | head');
        console.error('');
        process.exit(2);
    }

    for (const { f } of mains.slice(0, MAIN_SAMPLE)) await scan(f, MAIN, mainModels, true);
    for (const { f } of subs) await scan(f, SIDE, sideModels, false);

    console.log('=== LATENCY vs PROMPT SIZE ===');
    console.log('prompt tokens        n      p50      p90      p99');
    let shown = 0;
    latency.forEach((arr, i) => {
        if (arr.length < 20) return;
        shown++;
        console.log(`${bucketLabel(i).padEnd(14)} ${String(arr.length).padStart(8)}  ${pct(arr, 50).toFixed(1).padStart(6)}s  ${pct(arr, 90).toFixed(1).padStart(6)}s  ${pct(arr, 99).toFixed(1).padStart(6)}s`);
    });
    if (!shown) console.log('  (no bucket reached 20 samples — sample more sessions)');

    console.log('\n=== CACHE BEHAVIOUR ACROSS SESSION LIFETIME ===');
    console.log('decile   calls     cache-read     cache-write   read share');
    decile.forEach((d, i) => {
        const tot = d.read + d.write;
        const share = tot ? ((d.read / tot) * 100).toFixed(1) + '%' : '—';
        console.log(`  ${String(i + 1).padStart(2)}    ${String(d.reqs).padStart(6)}  ${fmt(d.read).padStart(14)}  ${fmt(d.write).padStart(14)}  ${share.padStart(9)}`);
    });
    console.log('  A flat read share from decile 1 to 10 means long sessions do NOT');
    console.log('  degrade caching — cost tracks prompt SIZE, not session age.');

    const report = (name, b, models) => {
        if (!b.reqs) { console.log(`\n=== ${name} ===\n  no model calls found`); return null; }
        const prompt = b.in + b.read + b.w5 + b.w1h;
        const outCost = Object.entries(models).reduce((s, [m, n]) => {
            const p = priceOf(m); return s + (p ? (b.out / b.reqs) * n * p.out / 1e6 : 0);
        }, 0);
        console.log(`\n=== ${name} ===`);
        console.log(`  files / calls     ${fmt(b.files)} / ${fmt(b.reqs)}`);
        console.log(`  median prompt     ${fmt(med(b.prompts))} tokens`);
        console.log(`  mean prompt       ${fmt(prompt / b.reqs)} tokens`);
        console.log(`  mean output       ${fmt(b.out / b.reqs)} tokens`);
        console.log(`  cache-read share  ${((b.read / Math.max(1, prompt)) * 100).toFixed(1)}%`);
        console.log(`  list-price cost   $${b.cost.toFixed(2)} ($${(b.cost / b.reqs).toFixed(4)}/call)`);
        console.log(`  output % of cost  ${((outCost / Math.max(0.0001, b.cost)) * 100).toFixed(0)}%`);
        console.log(`  models            ${Object.entries(models).sort((a, c) => c[1] - a[1]).map(([m, n]) => `${m}=${fmt(n)}`).join(', ')}`);
        return { prompt: prompt / b.reqs, perCall: b.cost / b.reqs };
    };

    const m = report(`MAIN THREAD (${Math.min(MAIN_SAMPLE, mains.length)} largest sessions)`, MAIN, mainModels);
    const s = report(`IN-SESSION SUBAGENTS (all ${subs.length} files)`, SIDE, sideModels);

    if (m && s) {
        console.log('\n=== THE RATIO THAT DECIDES MODEL PLACEMENT ===');
        console.log(`  main prompt/call      ${fmt(m.prompt)} tokens`);
        console.log(`  subagent prompt/call  ${fmt(s.prompt)} tokens`);
        console.log(`  subagent context is   ${(m.prompt / s.prompt).toFixed(1)}x smaller`);
        console.log(`  cost/call             main $${m.perCall.toFixed(4)} vs subagent $${s.perCall.toFixed(4)} (${(m.perCall / s.perCall).toFixed(1)}x)`);
        console.log('');
        console.log('  Read with the output%-of-cost figures above: when cost is input-dominated,');
        console.log('  a 2x-priced model belongs on the SMALL-context surface, not the main loop.');
    }
    console.log('');
})();
