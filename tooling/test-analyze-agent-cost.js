#!/usr/bin/env node
'use strict';
// Suite for analyze-agent-cost.js, the grader `npm run check:agent-cost` names
// for the Fable usage cap.
//
// THE DEFECT THIS GUARDS. [measured 2026-11-17] the PRICES table had no
// claude-fable-5-2 row, so every Fable 5.2 call cost $0 and a week of 2,179
// calls read as free. Three behaviours follow from it:
//   1. claude-fable-5-2 has a price, and a fixture call shows a non-zero cost.
//   2. a model with billable calls and no price is named under its own heading
//      and the run exits 1, so the next new model cannot hide the same way.
//   3. a non-numeric first argument (--help) prints usage and stops, instead of
//      running the whole analysis with NaN as the sample size.
//
// Hermetic on AGENT_COST_ROOT. The developer's own transcripts are never read.
//
// Run: node tooling/test-analyze-agent-cost.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, 'analyze-agent-cost.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cost-'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail ? '\n      -> ' + String(detail).slice(0, 400) : ''));
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

const call = (model, usage) => JSON.stringify({
    type: 'assistant', timestamp: '2026-11-17T10:00:00.000Z', message: { model, usage },
});

// A store with one main session and one subagent file, each holding the given
// rows. The subagent file must exist: with main sessions and zero subagents the
// subject refuses to report (exit 2), by design.
let n = 0;
function store(mainRows, subRows) {
    const dir = path.join(ROOT, 'store-' + (n++), 'proj');
    const session = 'sess-0001';
    fs.mkdirSync(path.join(dir, session, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, session + '.jsonl'), mainRows.join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, session, 'subagents', 'agent-1.jsonl'), subRows.join('\n') + '\n', 'utf8');
    return path.dirname(dir);
}

function run(root, argv) {
    const r = spawnSync(process.execPath, [SUBJECT].concat(argv || []), {
        encoding: 'utf8',
        env: Object.assign({}, process.env, { AGENT_COST_ROOT: root }),
        windowsHide: true,
        timeout: 30000,
    });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// The "list-price cost $X" line of the named section.
function sectionCost(out, heading) {
    const i = out.indexOf(heading);
    if (i < 0) return null;
    const m = /list-price cost\s+\$([0-9.]+)/.exec(out.slice(i));
    return m ? Number(m[1]) : null;
}

const M = 1e6;
// Input as well as output, so the main/subagent prompt ratio is not 0/0.
const opus = call('claude-opus-5-5', { input_tokens: 1000, output_tokens: M });

// ------------------------------------------------------------ 1. Fable 5.2 row

{
    const { priceOf } = require(SUBJECT);
    const p = priceOf('claude-fable-5-2');
    check('priceOf claims claude-fable-5-2 at $8 / $40 / $0.20 read',
        p && p.in === 8 && p.out === 40 && p.read === 0.20, JSON.stringify(p));
    check('and a dated claude-fable-5-2 id takes the same row',
        priceOf('claude-fable-5-2-20261101') === p, JSON.stringify(priceOf('claude-fable-5-2-20261101')));
}

{
    // AC3: one Fable 5.2 call with 1M output tokens is $40 on the main thread.
    const root = store([call('claude-fable-5-2', { output_tokens: M })], [opus]);
    const r = run(root);
    const cost = sectionCost(r.out, '=== MAIN THREAD');
    check('a claude-fable-5-2 main-thread call costs $40.00, not $0', cost !== null && near(cost, 40, 1e-6),
        `cost=${cost} exit=${r.code}\n${r.out}${r.err}`);
    check('and the run exits 0 with no unpriced heading', r.code === 0 && !r.out.includes('UNPRICED'),
        `exit=${r.code}\n${r.out}`);
}

// ------------------------------------------------------- 2. unpriced is visible

{
    const root = store(
        [call('claude-opus-9-9', { output_tokens: 100 }), call('claude-opus-9-9', { input_tokens: 5 })],
        [opus, call('claude-sonnet-9-9', { output_tokens: 7 })]);
    const r = run(root);
    check('an unpriced model with calls exits 1', r.code === 1, `exit=${r.code}\n${r.out}${r.err}`);
    const at = r.out.indexOf('=== UNPRICED MODELS');
    const tail = at < 0 ? '' : r.out.slice(at);
    check('under an UNPRICED MODELS heading', at >= 0, r.out);
    check('naming each unpriced id with its call count, main and subagent alike',
        /claude-opus-9-9\s+2 calls/.test(tail) && /claude-sonnet-9-9\s+1 calls/.test(tail), tail);
    check('and never listing a priced model there', !tail.includes('claude-opus-5-5'), tail);
}

{
    // Claude Code writes "<synthetic>" rows with all-zero usage. They cost $0
    // under any price, so they must not fail the run on a real store.
    const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const root = store([opus, call('<synthetic>', zero)], [opus]);
    const r = run(root);
    check('a zero-token <synthetic> row is not flagged unpriced', r.code === 0 && !r.out.includes('UNPRICED'),
        `exit=${r.code}\n${r.out}`);
}

// ------------------------------------------------------------ 3. argument guard

{
    const root = store([opus], [opus]);
    const help = run(root, ['--help']);
    check('--help prints usage and exits 0', help.code === 0 && /Usage: /.test(help.out),
        `exit=${help.code}\n${help.out}${help.err}`);
    check('--help does not run the analysis', !help.out.includes('agent-cost —') && !help.out.includes('sampling'),
        help.out);

    for (const bad of ['abc', '0', '-3', '2.5']) {
        const r = run(root, [bad]);
        check(`a first argument of ${JSON.stringify(bad)} prints usage on stderr and exits 2`,
            r.code === 2 && /Usage: /.test(r.err) && !r.out.includes('agent-cost —'),
            `exit=${r.code}\n${r.out}${r.err}`);
    }

    const ok = run(root, ['3']);
    check('a positive integer still runs the analysis with that sample size',
        ok.code === 0 && /sampling\s+: 1 largest main sessions/.test(ok.out) && !/sampling.*NaN/.test(ok.out),
        `exit=${ok.code}\n${ok.out}`);
    const dflt = run(root);
    check('no argument still runs with the default', dflt.code === 0 && dflt.out.includes('agent-cost —'),
        `exit=${dflt.code}\n${dflt.out}`);
}

// ------------------------------------------------- advisor iterations

{
    // The executor row is Opus 5.5 with 1M output ($20). Its advisor call is a
    // usage.iterations[] entry on Fable 5.2 with 1M output ($40), not in the
    // top-level usage. The "message" iteration repeats the top level.
    const top = { input_tokens: 1000, output_tokens: M };
    const usage = Object.assign({}, top, { iterations: [
        Object.assign({ type: 'message' }, top),
        { type: 'advisor_message', model: 'claude-fable-5-2', input_tokens: 0, output_tokens: M },
    ] });
    const root = store([call('claude-opus-5-5', usage)], [opus]);
    const r = run(root);
    const main = sectionCost(r.out, '=== MAIN THREAD');
    const side = sectionCost(r.out, '=== IN-SESSION SUBAGENTS');
    check('an advisor_message iteration adds its own model\'s price to the section cost',
        main !== null && side !== null && near(main - side, 40, 0.01), r.out);
    check('the advisor call is reported on its own line and not as an executor call',
        /files \/ calls\s+1 \/ 1/.test(r.out) && /advisor calls\s+1, \$40\.00 of the cost above \(claude-fable-5-2=1\)/.test(r.out),
        r.out);
    check('a priced advisor model leaves the run at exit 0', r.code === 0, `exit=${r.code}\n${r.err}`);

    const unknown = store([call('claude-opus-5-5', { input_tokens: 1000, output_tokens: M, iterations: [
        { type: 'advisor_message', model: 'claude-advisor-9', input_tokens: 0, output_tokens: M },
    ] })], [opus]);
    const u = run(unknown);
    check('an unpriced advisor model is named under UNPRICED MODELS and exits 1',
        u.code === 1 && /claude-advisor-9 \(advisor\)\s+1 calls/.test(u.out), `exit=${u.code}\n${u.out}`);
}

// -------------------------------------------------------------------- report

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* leave it */ }

const total = passed + failures.length;
if (failures.length) {
    console.error(`analyze-agent-cost: ${passed}/${total} passed, ${failures.length} FAILED\n`);
    for (const f of failures) console.error('  x ' + f);
    process.exitCode = 1;
} else {
    console.log(`analyze-agent-cost: ${passed}/${total} passed: claude-fable-5-2 priced, unpriced models named with exit 1, and a non-numeric argument stops at usage`);
}
