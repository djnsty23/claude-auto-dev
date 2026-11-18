#!/usr/bin/env node
// test-usage-both.js - usage-both counts each response once, advisor calls included.
//
// An advisor call is a usage.iterations[] entry of type advisor_message. Every
// content-block row of a response repeats the full usage, iterations included,
// so a reader that counts per row multiplies the advisor by the row count. The
// top-level usage leaves the advisor out, so a reader that ignores iterations
// misses it entirely. The fixture plants both shapes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'usage-both.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-both-'));
const failures = [];
let passed = 0;
function check(name, ok, detail) {
    if (ok) passed += 1;
    else failures.push(name + (detail ? '  (' + detail + ')' : ''));
}

const advisorIt = { type: 'advisor_message', model: 'claude-fable-5-2',
    input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000 };
const execIt = { type: 'message', input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300 };
const usage = (withAdvisor, out = 20) => ({ input_tokens: 10, output_tokens: out,
    cache_read_input_tokens: 300, iterations: withAdvisor ? [execIt, advisorIt] : [execIt] });
const row = (id, req, u) => JSON.stringify({ type: 'assistant', requestId: req,
    message: { id, model: 'claude-opus-5-5', usage: u } });

const rows = [
    // One response written as three rows: two repeat the advisor, the last lacks
    // it and carries the final output count, which is the one that counts.
    row('msg_a', 'req_a', usage(true)),
    row('msg_a', 'req_a', usage(true)),
    row('msg_a', 'req_a', usage(false, 50)),
    // A second response with its own advisor call.
    row('msg_b', 'req_b', usage(true)),
    // A response with no advisor at all.
    row('msg_c', 'req_c', usage(false)),
    // Two rows with neither id: each counts alone.
    JSON.stringify({ type: 'assistant', message: { usage: usage(false) } }),
    JSON.stringify({ type: 'assistant', message: { usage: usage(false) } }),
];
const proj = path.join(ROOT, '.claude', 'projects', 'fixture');
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, 'session.jsonl'), rows.join('\n') + '\n');

const env = { ...process.env, HOME: ROOT, USERPROFILE: ROOT };
const r = spawnSync(process.execPath, [SCRIPT, '--hours', '1'],
    { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
const out = r.stdout || '';
const num = (re) => { const m = out.match(re); return m ? Number(m[1].replace(/,/g, '')) : NaN; };

check('exits 0', r.status === 0, 'status ' + r.status + ' ' + (r.stderr || '').slice(0, 200));
// 7 rows, 5 responses: msg_a, msg_b, msg_c and the two rows with no id.
check('one turn per response, not per row', num(/turns: ([\d,]+)/) === 5, 'turns ' + num(/turns: ([\d,]+)/));

// Two advisor calls, one per response, never one per row.
check('advisor calls counted once per response', num(/advisor\s+: ([\d,]+) calls/) === 2,
    'calls ' + num(/advisor\s+: ([\d,]+) calls/));
check('advisor input counted once per response', num(/advisor\s+: [\d,]+ calls, input ([\d,]+)/) === 2000);

// Executor, once per response: 5 x (10 in, 300 cache), output 50 (msg_a's last
// row) + 4 x 20. Per row it would read 70 in, 2,100 cache, 160 out.
// Advisor: 2 x (1000, 200, 5000).
check('Claude input: executor once per response plus the advisor',
    num(/ {2}input {7}: ([\d,]+)/) === 50 + 2000, 'input ' + num(/ {2}input {7}: ([\d,]+)/));
check('Claude cache read: executor once per response plus the advisor',
    num(/cache read: ([\d,]+)/) === 1500 + 10000, 'cache ' + num(/cache read: ([\d,]+)/));
check('Claude output: the last row of a response, plus the advisor',
    num(/ {2}output {6}: ([\d,]+)/) === 130 + 400, 'output ' + num(/ {2}output {6}: ([\d,]+)/));
check('like-for-like total includes the advisor', num(/ {2}claude : ([\d,]+)/) === 2050 + 11500,
    'claude ' + num(/ {2}claude : ([\d,]+)/));

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* leave it */ }

const total = passed + failures.length;
if (failures.length) {
    console.error(`usage-both: ${passed}/${total} passed, ${failures.length} FAILED\n`);
    for (const f of failures) console.error('  x ' + f);
    process.exitCode = 1;
} else {
    console.log(`usage-both: ${passed}/${total} passed, each response and its advisor calls counted once`);
}
