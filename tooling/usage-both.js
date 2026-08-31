#!/usr/bin/env node
// usage-both.js - what a delegation actually cost, on BOTH platforms.
//
// WHY, measured. On 2026-08-31 a session delegated work to the GPT companion
// and its own UI reported 21.5k tokens for the turn. The same delegation had
// consumed 6,440,736 input tokens on the OpenAI side, recorded only in
// ~/.codex/sessions and visible nowhere in the Claude client.
//
// The FIRST conclusion drawn from that was itself wrong, which is why the
// like-for-like block at the bottom exists. "300x more on the GPT side" came
// from comparing codex total input against the Claude client displayed number,
// which excludes cache reads. Counting both sides the same way inverts it: over
// a real 3h window this repo measured 2.67B Claude input against 19.5M GPT,
// i.e. Claude consuming ~137x MORE. Same data, opposite answer, because one
// side total was compared against the other side fresh-only.
//
// That is the billing form of a failure this repo keeps writing rules about:
// an artifact is authoritative about the layer it encodes and silent about
// every other one. The Claude counter is authoritative about the cost of
// ASKING and says nothing about the cost of the work.
//
// WHAT IT REPORTS
//
//   claude side   turns and tokens from this project's session transcripts
//   gpt side      input / cached / output from codex's own rollout logs
//
// WHAT IT IS NOT. Neither number is a bill. The Claude figures are transcript
// accounting, and the ChatGPT plan's quota formula is not public, so cached
// input almost certainly does not weigh what fresh input weighs. Treat these
// as RELATIVE attribution between two platforms, never as money.
//
// Usage:
//   node tooling/usage-both.js               last 24h
//   node tooling/usage-both.js --hours 6
//   node tooling/usage-both.js --selftest

const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const hoursArg = argv.indexOf('--hours');
const HOURS = hoursArg >= 0 ? parseFloat(argv[hoursArg + 1]) : 24;
const CUTOFF = Date.now() - HOURS * 3600 * 1000;

function walk(dir, out, depth) {
    if (depth > 6) return out;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out, depth + 1);
        else if (e.name.endsWith('.jsonl')) out.push(p);
    }
    return out;
}

function recent(files) {
    return files.filter((f) => {
        try { return fs.statSync(f).mtimeMs >= CUTOFF; } catch { return false; }
    });
}

// ---- GPT side: codex writes a usage row per turn into its rollout log -------
function gptSide() {
    const base = path.join(os.homedir(), '.codex', 'sessions');
    const files = recent(walk(base, [], 0));
    let input = 0;
    let cached = 0;
    let output = 0;
    const models = {};
    for (const f of files) {
        let last = null;
        let model = null;
        try {
            for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
                if (!line) continue;
                if (!model) {
                    const m = line.match(/"model":"(gpt-[\w.\-]+)"/);
                    if (m) model = m[1];
                }
                if (line.includes('"input_tokens"')) last = line;
            }
        } catch { continue; }
        if (model) models[model] = (models[model] || 0) + 1;
        if (!last) continue;
        try {
            const find = (o) => {
                if (o && typeof o === 'object') {
                    if ('input_tokens' in o) return o;
                    for (const v of Object.values(o)) { const r = find(v); if (r) return r; }
                }
                return null;
            };
            const u = find(JSON.parse(last)) || {};
            input += u.input_tokens || 0;
            cached += u.cached_input_tokens || 0;
            output += u.output_tokens || 0;
        } catch { /* skip */ }
    }
    return { sessions: files.length, input, cached, output, models };
}

// ---- Claude side: this project's own transcripts ---------------------------
function claudeSide() {
    const base = path.join(os.homedir(), '.claude', 'projects');
    const files = recent(walk(base, [], 0));
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let turns = 0;
    for (const f of files) {
        try {
            for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
                if (!line.includes('"usage"')) continue;
                let o;
                try { o = JSON.parse(line); } catch { continue; }
                const u = (o.message && o.message.usage) || o.usage;
                if (!u) continue;
                turns += 1;
                input += u.input_tokens || 0;
                output += u.output_tokens || 0;
                cacheRead += u.cache_read_input_tokens || 0;
            }
        } catch { /* skip */ }
    }
    return { sessions: files.length, turns, input, output, cacheRead };
}

if (argv.includes('--selftest')) {
    // The only thing worth asserting without a fixture corpus: both readers
    // return a shape, and a zero is distinguishable from a failure to look.
    const g = gptSide();
    const c = claudeSide();
    const ok = typeof g.input === 'number' && typeof c.turns === 'number';
    console.log((ok ? 'PASS' : 'FAIL') + '  both readers return a numeric shape');
    console.log('  gpt sessions in window: ' + g.sessions
        + '   claude transcripts in window: ' + c.sessions);
    console.log('  (a zero here means nothing was in the window, not that the probe failed)');
    process.exit(ok ? 0 : 1);
}

const n = (x) => x.toLocaleString('en-US');
const g = gptSide();
const c = claudeSide();

console.log('window: last ' + HOURS + 'h\n');
console.log('CLAUDE side  (cost of ASKING)');
console.log('  transcripts : ' + c.sessions + '   turns: ' + n(c.turns));
console.log('  input       : ' + n(c.input) + '   cache read: ' + n(c.cacheRead));
console.log('  output      : ' + n(c.output));
console.log('');
console.log('GPT side  (cost of the WORK, invisible in the Claude client)');
console.log('  sessions    : ' + g.sessions);
console.log('  input       : ' + n(g.input) + '   of which cached: ' + n(g.cached));
console.log('  output      : ' + n(g.output));
console.log('  models      : ' + (Object.entries(g.models)
    .sort((a, b) => b[1] - a[1]).map(([m, k]) => m + ' x' + k).join(', ') || '(none)'));
console.log('');
// LIKE FOR LIKE, and this is the whole point of the tool. codex reports
// input_tokens INCLUSIVE of its cached portion; the Claude transcript splits
// fresh input from cache reads into separate fields. Comparing codex total
// against Claude FRESH input is the mistake this probe exists to prevent - it
// inverts the answer by orders of magnitude.
const claudeTotalIn = c.input + c.cacheRead;
console.log('total input, like for like (fresh + cached on both sides)');
console.log('  claude : ' + n(claudeTotalIn));
console.log('  gpt    : ' + n(g.input));
if (claudeTotalIn > 0 && g.input > 0) {
    const bigger = claudeTotalIn >= g.input ? 'claude' : 'gpt';
    const factor = claudeTotalIn >= g.input
        ? claudeTotalIn / g.input : g.input / claudeTotalIn;
    console.log('  ' + bigger + ' consumed ' + factor.toFixed(1) + 'x more input in this window');
}
console.log('');
console.log('Neither column is a bill. Claude figures are transcript accounting;');
console.log('the ChatGPT plan quota formula is not public and cached input almost');
console.log('certainly does not weigh what fresh input weighs. Relative only.');
