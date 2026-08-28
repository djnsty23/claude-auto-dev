#!/usr/bin/env node
'use strict';
// Suite for quota-burn.js — the burn-rate source quota-tripwire.js reads.
//
// Two things matter more than the arithmetic. First, the CONTRACT: the tripwire
// parses `windowCost` (finite number) and `windowStart` (parseable date) out of
// `--json`, and rejects anything else as source-unparseable. Second, the
// DIRECTION of error: an unknown model must be priced HIGH, never skipped. A
// tripwire that under-reports stays silent through the wall; one that
// over-reports cries early, and only the first is dangerous.
//
// Hermetic on CLAUDE_CONFIG_DIR. The developer's own transcripts are never read.
//
// Run: node tooling/test-quota-burn.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'quota-burn.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-burn-'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail ? '\n      -> ' + String(detail).slice(0, 300) : ''));
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

let n = 0;
function fixture(rows) {
    const cfg = path.join(ROOT, 'cfg-' + (n++));
    const dir = path.join(cfg, 'projects', 'proj');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 't.jsonl'),
        rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    return cfg;
}

function run(cfg, argv) {
    const r = spawnSync(process.execPath, [SUBJECT].concat(argv || ['--json']), {
        encoding: 'utf8',
        env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: cfg }),
    });
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* null */ }
    return { r, j };
}

// A timestamp comfortably inside the current window, whenever the suite runs:
// the window opens Wed 02:00 local, so "an hour ago" is always inside it except
// in the first hour after a reset. Derive it from the subject's own windowStart
// rather than guessing, so the suite cannot fail on a Wednesday morning.
const wsProbe = run(fixture([]), ['--json']).j;
const insideWindow = new Date(Date.parse(wsProbe.windowStart) + 3600 * 1000).toISOString();
const beforeWindow = new Date(Date.parse(wsProbe.windowStart) - 3600 * 1000).toISOString();

const row = (usage, model = 'claude-opus-5', ts = insideWindow) =>
    ({ timestamp: ts, message: { model, usage } });

// ------------------------------------------------------------- the contract

{
    const { r, j } = run(fixture([row({ output_tokens: 1000000 })]));
    check('exits 0', r.status === 0, r.stderr);
    check('emits windowCost as a finite number',
        typeof j?.windowCost === 'number' && Number.isFinite(j.windowCost), JSON.stringify(j));
    check('emits a parseable windowStart', !!Date.parse(j?.windowStart || ''), j?.windowStart);
    check('says the basis is not a bill', /NOT a subscription bill/.test(j?.basis || ''), j?.basis);
    // 1M output tokens on Opus 5 at $25/MTok.
    check('output priced at the published rate', near(j.windowCost, 25), j.windowCost);
}

// -------------------------------------------------------- the window boundary

{
    const ws = new Date(Date.parse(wsProbe.windowStart));
    check('the window opens on a Wednesday', ws.getDay() === 3, ws.toString());
    check('and at 02:00 local', ws.getHours() === 2 && ws.getMinutes() === 0, ws.toString());
    check('and is in the past', ws.getTime() <= Date.now(), ws.toString());
    check('and within the last 7 days',
        Date.now() - ws.getTime() < 7 * 86400000 + 3600000, ws.toString());
}

{
    // THE CORRECTNESS FILTER. --days narrows the FILE scan by mtime; only the
    // per-row timestamp decides what counts. A row written before the window
    // opened must not be billed to it however recently the file was touched.
    const cfg = fixture([
        row({ output_tokens: 1000000 }, 'claude-opus-5', beforeWindow),
        row({ output_tokens: 1000000 }, 'claude-opus-5', insideWindow),
    ]);
    const { j } = run(cfg);
    check('a row before the window is excluded', near(j.windowCost, 25), j.windowCost);
    check('and the population counts only in-window rows',
        j.population.usageRowsInWindow === 1, JSON.stringify(j.population));
}

// ------------------------------------------------------------ cache pricing

{
    // read 0.1x, write 1.25x at 5m, 2x at 1h, against Opus 5 input at $5/MTok.
    const { j } = run(fixture([row({
        input_tokens: 1000000,                     // 1M * 5          = 5
        cache_read_input_tokens: 1000000,          // 1M * 5 * 0.1    = 0.5
        cache_creation_input_tokens: 2000000,      // total creation
        cache_creation: { ephemeral_1h_input_tokens: 1000000, ephemeral_5m_input_tokens: 1000000 },
    })]));                                          // 1h: 1M*5*2 = 10, 5m: 1M*5*1.25 = 6.25
    check('input, cache read, and both cache-write TTLs priced correctly',
        near(j.windowCost, 5 + 0.5 + 10 + 6.25, 1e-6), j.windowCost);
}

{
    // The 1h multiplier is 2x, not 1.25x. Getting this wrong understates a long
    // session badly, and this fleet runs on the 1-hour TTL.
    const oneHour = run(fixture([row({
        cache_creation_input_tokens: 1000000,
        cache_creation: { ephemeral_1h_input_tokens: 1000000 },
    })])).j.windowCost;
    const fiveMin = run(fixture([row({
        cache_creation_input_tokens: 1000000,
        cache_creation: { ephemeral_5m_input_tokens: 1000000 },
    })])).j.windowCost;
    check('a 1h cache write costs 2x input', near(oneHour, 10, 1e-6), oneHour);
    check('a 5m cache write costs 1.25x input', near(fiveMin, 6.25, 1e-6), fiveMin);
    check('and the two differ', oneHour > fiveMin);
}

{
    // No TTL split at all: the total is priced at the cheaper 5m rate, which is
    // the only assumption the data supports.
    const { j } = run(fixture([row({ cache_creation_input_tokens: 1000000 })]));
    check('creation with no TTL split falls back to the 5m rate',
        near(j.windowCost, 6.25, 1e-6), j.windowCost);
}

// ------------------------------------------------- the direction of error

{
    // THE ASSERTION THAT MATTERS MOST. An unrecognised model must be priced at
    // the highest published rate — never skipped, never zero. Under-reporting is
    // how a tripwire stays silent through the wall it exists to warn about.
    const { j } = run(fixture([row({ output_tokens: 1000000 }, 'claude-something-unreleased')]));
    check('an unknown model is priced, not skipped', j.windowCost > 0, j.windowCost);
    check('and at the HIGHEST published rate, not the cheapest',
        near(j.windowCost, 50), j.windowCost);
    check('and the fallback is counted in the population',
        j.population.rowsPricedAtFallbackRate === 1, JSON.stringify(j.population));
}

{
    const { j } = run(fixture([row({ output_tokens: 1000000 }, 'claude-sonnet-5')]));
    check('a cheaper known model uses its own rate', near(j.windowCost, 10), j.windowCost);
}

{
    // Fast mode is the same model at premium rates. Pricing it as standard
    // under-reports, which is the dangerous direction.
    const { j } = run(fixture([row({ output_tokens: 1000000, speed: 'fast' }, 'claude-opus-5')]));
    check('fast mode is priced at its premium rate', near(j.windowCost, 50), j.windowCost);
}

// ---------------------------------------------------------- degenerate input

{
    const { r, j } = run(fixture([]));
    check('an empty transcript yields a real zero, not a crash',
        r.status === 0 && j.windowCost === 0, r.stderr);
    check('and reports the population it scanned',
        j.population && typeof j.population.usageRowsInWindow === 'number', JSON.stringify(j?.population));
}

{
    const cfg = fixture([row({ output_tokens: 1000000 })]);
    fs.appendFileSync(path.join(cfg, 'projects', 'proj', 't.jsonl'), '{ torn\n', 'utf8');
    const { j } = run(cfg);
    check('a torn line is skipped and the rest still priced', near(j.windowCost, 25), j.windowCost);
}

{
    // No projects directory at all. Zero is honest here — there are no
    // transcripts — and it must not throw.
    const cfg = path.join(ROOT, 'empty-cfg');
    fs.mkdirSync(cfg, { recursive: true });
    const { r, j } = run(cfg);
    check('a missing projects directory exits 0 with zero cost',
        r.status === 0 && j.windowCost === 0, r.stderr);
}

{
    // A row with no usage block is not a priced row.
    const cfg = fixture([{ timestamp: insideWindow, message: { model: 'claude-opus-5' } }]);
    const { j } = run(cfg);
    check('a row without usage is ignored', j.windowCost === 0 && j.population.usageRowsInWindow === 0,
        JSON.stringify(j.population));
}

// -------------------------------------------------------------------- report

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* leave it */ }

const total = passed + failures.length;
if (failures.length) {
    console.error(`quota-burn: ${passed}/${total} passed, ${failures.length} FAILED\n`);
    for (const f of failures) console.error('  x ' + f);
    process.exit(1);
}
console.log(`quota-burn: ${passed}/${total} passed — the tripwire contract, the Wed 02:00 window, cache TTL rates, and pricing an unknown model HIGH`);
