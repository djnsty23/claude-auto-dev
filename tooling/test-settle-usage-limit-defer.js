#!/usr/bin/env node
'use strict';
// A worker that met the account usage limit before doing any work settles
// deferred, not unreported, so the task is requeued instead of failed and the
// launch hold keeps it parked until the reset. Each case settles a planted record
// through the real headless-worker.js CLI. No claude process runs.
//
// The fixture is the tail of a real nightly worker log `[measured 2026-11-16]`:
// a rate_limit_event, the synthetic assistant message, the result event and the
// supervisor's exit line. Session ids, uuids, the request id, the credential
// expiry and every hook and init line are removed. The `parent_tool_use_id` and
// `server_tool_use` keys are kept on purpose: they mention tool_use and are not
// tool calls, so a substring detector would read work where there was none.
//   D1  the 1-turn, 0-token limit ending settles deferred with blocker usage-limit
//   D2  that deferred record holds launches until 2 minutes after the stated reset
//   D3  reconcile turns a deferred settle into defer (requeue), not close
//   D4  control: a limit met mid-run, with tool calls, stays unreported
//   D5  control: num_turns 1 with a tool_use block stays unreported
//   D6  control: a limit ending with a report on disk stays unreported
//   D7  control: a limit ending with no num_turns stays unreported
//   D8  control: a 1-turn run that did not hit the limit stays unreported
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const scripts = path.resolve(__dirname, '../plugins/autodev-core/scripts');
const worker = process.env.HEADLESS_WORKER_SUBJECT || path.join(scripts, 'headless-worker.js');
const { limitHold } = require(path.join(path.dirname(worker), 'usage-limit-hold.js'));
const { closeDecision } = require(path.join(path.dirname(worker), 'worker-reconcile.js'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-usage-limit-defer-'));
const env = { ...process.env, AUTODEV_CAPACITY: 'off', AUTODEV_BUDGET_LEDGER: path.join(root, 'budget.json'),
    AUTODEV_GATE_LOCK_PATH: path.join(root, 'locks', 'full-gate.lock') };
let total = 0; let failed = 0;
function check(name, ok, detail = '') { total++; if (!ok) failed++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`); }
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };

// Hand-written literals copied from the real log, so they cannot shrink with the detector.
const WALL = "You've hit your weekly limit · resets Nov 18, 1am (Europe/Bucharest)";
const RATE = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1794956400,"rateLimitType":"seven_day","overageStatus":"rejected","isUsingOverage":false}}';
const SYNTHETIC = `{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","type":"message","usage":{"input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0}},"content":[{"type":"text","text":"${WALL}"}]},"parent_tool_use_id":null,"error":"rate_limit","is_api_error_message":true,"api_error_status":429,"api_error":"usage_limit_reached"}`;
const resultLine = (fields) => JSON.stringify({ duration_api_ms: 0, stop_reason: 'stop_sequence', total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 0 } }, terminal_reason: 'api_error',
    is_error: true, num_turns: 1, subtype: 'success', api_error_status: 429, api_error: 'usage_limit_reached', result: WALL, type: 'result', duration_ms: 682, ...fields });
const RESULT_1116 = resultLine({});
const TOOL_CALL = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"git status"}}]},"parent_tool_use_id":null}';
const TOOL_RESULT = '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"clean"}]},"parent_tool_use_id":null}';
const log = (...lines) => `${lines.join('\n')}\n\nCLAUDE_EXIT=1\n`;
// The 11-16 log was last written 2026-11-16T14:51:10Z. The reset it states is
// Nov 18 01:00 Bucharest, 2026-11-17T23:00Z, so the hold lifts at 23:02Z.
const ENDED = new Date('2026-11-16T14:51:10Z');

const ledger = path.join(root, 'headless-workers.json');
const deadPid = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
const records = [];
function plant(code, text, reportText = null) {
    const reportFile = path.join(root, code, 'REPORT.md');
    if (reportText !== null) write(reportFile, reportText);
    const logFile = path.join(root, `${code}.log`);
    write(logFile, text);
    fs.utimesSync(logFile, ENDED, ENDED);
    records.push({ code, startedAt: '2026-01-01T00:00:00Z', state: 'running', report: reportFile, log: logFile, pid: deadPid, cwd: root });
}
const settle = (code) => spawnSync(process.execPath, [worker, 'settle', '--code', code, '--ledger', ledger, '--unreported', '--json'], { env, encoding: 'utf8' });
const readLedger = () => JSON.parse(fs.readFileSync(ledger, 'utf8')).records;
const recOf = (code) => readLedger().find((r) => r.code === code);
try {
    plant('D1', log(RATE, SYNTHETIC, RESULT_1116));
    plant('D4', log(TOOL_CALL, TOOL_RESULT, RATE, SYNTHETIC, resultLine({ num_turns: 30 })));
    plant('D5', log(TOOL_CALL, TOOL_RESULT, RATE, SYNTHETIC, RESULT_1116));
    plant('D6', log(RATE, SYNTHETIC, RESULT_1116), 'A partial report with no result line.\n');
    const noTurns = JSON.parse(RESULT_1116); delete noTurns.num_turns;
    plant('D7', log(RATE, SYNTHETIC, JSON.stringify(noTurns)));
    plant('D8', log(resultLine({ is_error: false, result: 'Nothing to do.', api_error: undefined })));
    write(ledger, JSON.stringify({ version: 1, records }));
    const codes = records.map((r) => r.code);
    const runs = codes.map((c) => [c, settle(c)]);
    check(`all ${codes.length} planted runs settle, exit 0`, codes.length === 6 && runs.every(([, r]) => r.status === 0), runs.map(([c, r]) => `${c}:${r.status} ${r.stdout}${r.stderr}`).join(' '));

    const d1 = recOf('D1');
    const out = JSON.parse(runs[0][1].stdout || '{}').value || {};
    check('D1. the zero-work limit ending settles deferred', d1.result === 'deferred' && out.state === 'deferred', JSON.stringify(d1));
    check('D1. its blocker is usage-limit with the limit text', d1.blocker && d1.blocker.status === 'usage-limit' && d1.blocker.text === WALL, JSON.stringify(d1.blocker));
    check('D1. its reason names the limit and that no work was done', /account usage limit/.test(d1.reason) && d1.reason.includes(WALL) && /before doing any work/.test(d1.reason), d1.reason);

    // Only the deferred record, as the ledger holds it after settle.
    const only = [d1];
    const before = limitHold(only, null, Date.parse('2026-11-17T23:01:00Z'));
    const after = limitHold(only, null, Date.parse('2026-11-17T23:03:00Z'));
    check('D2. the deferred record holds launches before the reset', before && before.code === 'D1' && before.until === '2026-11-17T23:02:00.000Z', JSON.stringify(before));
    check('D2. the hold lifts after the reset', after === null, JSON.stringify(after));

    const d = closeDecision({ ...d1 });
    check('D3. reconcile defers a deferred settle instead of closing it', d.action === 'defer' && d.outcome === 'DEFERRED', JSON.stringify(d));

    const stays = (c, extra) => { const r = recOf(c); return r.result === 'unreported' && extra(r); };
    check('D4. control: a limit met mid-run with tool calls stays unreported', stays('D4', (r) => r.blocker.status === 'usage-limit'), JSON.stringify(recOf('D4')));
    check('D5. control: one turn with a tool_use block stays unreported', stays('D5', (r) => r.blocker.status === 'usage-limit'), JSON.stringify(recOf('D5')));
    check('D6. control: a limit ending with a report on disk stays unreported', stays('D6', (r) => /has no RESULT D6 line/.test(r.reason)), JSON.stringify(recOf('D6')));
    check('D7. control: a limit ending with no num_turns stays unreported', stays('D7', () => true), JSON.stringify(recOf('D7')));
    check('D8. control: a 1-turn run with no limit stays unreported', stays('D8', (r) => !/usage limit/.test(r.reason) && /does not exist/.test(r.reason)), JSON.stringify(recOf('D8')));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`settle-usage-limit-defer: ${total} checks, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
