#!/usr/bin/env node
'use strict';
// A worker that ends on the account's usage limit is named as that, not as a
// worker that left no report. Each case settles a planted record through the
// real headless-worker.js CLI, then ranks it through the real blocker-report.js
// CLI. No claude process runs. The wall texts are hand-written literals, copied
// from real worker logs, so they cannot shrink with the detector.
//   U1  a weekly-limit ending names the limit in its reason and blocker
//   U2  a session-limit ending is the same event
//   U3  control: a normal run with no limit keeps the "does not exist" reason
//   U4  control: a worker's closing message that quotes a limit is not a wall
//   U5  control: a limit met earlier in a run that later recovered is not a wall
//   U6  a limit ending with a report but no RESULT line keeps both facts
//   U7  blocker-report ranks limit runs as usage limit, and the control as unreported
//   U8  a limit reason with an unreadable log still ranks as usage limit
//   U9  a blocker sentence naming the limit ranks as usage limit, from a report and a stored blocker
//   U11 control: an unreadable log with no limit in its reason stays settled unreported
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const scripts = path.resolve(__dirname, '../plugins/autodev-core/scripts');
const worker = process.env.HEADLESS_WORKER_SUBJECT || path.join(scripts, 'headless-worker.js');
const report = process.env.BLOCKER_REPORT_SUBJECT || path.join(scripts, 'blocker-report.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-usage-limit-'));
const base = path.join(root, 'autodev');
const env = { ...process.env, AUTODEV_CAPACITY: 'off', AUTODEV_BUDGET_LEDGER: path.join(root, 'budget.json'),
    AUTODEV_GATE_LOCK_PATH: path.join(root, 'locks', 'full-gate.lock') };
let total = 0; let failed = 0;
function check(name, ok, detail = '') { total++; if (!ok) failed++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`); }
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const event = (text, isError) => JSON.stringify({ type: 'result', subtype: 'success', is_error: isError, num_turns: 1, result: text });
const WEEKLY = "You've hit your weekly limit · resets Nov 11, 1am (Europe/Bucharest)";
const SESSION = "You've hit your session limit · resets 5:50am (Europe/Bucharest)";
const ledger = path.join(base, 'headless-workers.json');
// A pid that has provably exited: --unreported refuses a live supervisor.
const deadPid = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
const records = [];
function plant(code, log, reportText = null) {
    const reportFile = path.join(root, code, 'REPORT.md');
    if (reportText !== null) write(reportFile, reportText);
    const logFile = path.join(root, `${code}.log`);
    write(logFile, log);
    records.push({ code, startedAt: '2026-01-01T00:00:00Z', state: 'running', report: reportFile, log: logFile, pid: deadPid, cwd: root });
}
const settle = (code) => spawnSync(process.execPath, [worker, 'settle', '--code', code, '--ledger', ledger, '--unreported'], { env, encoding: 'utf8' });
const recOf = (code) => JSON.parse(fs.readFileSync(ledger, 'utf8')).records.find((r) => r.code === code);
try {
    plant('U1', `${event(WEEKLY, true)}\nCLAUDE_EXIT=1\n`);
    plant('U2', `${event(SESSION, true)}\nCLAUDE_EXIT=1\n`);
    plant('U3', `${event('All finished.', false)}\nCLAUDE_EXIT=0\n`);
    plant('U4', `${event("You've hit your weekly limit, the brief says, so I stopped early.", false)}\nCLAUDE_EXIT=0\n`);
    plant('U5', `${event(WEEKLY, true)}\n${event('Recovered and finished.', false)}\nCLAUDE_EXIT=0\n`);
    plant('U6', `${event(WEEKLY, true)}\nCLAUDE_EXIT=1\n`, 'A partial report with no result line.\n');
    write(ledger, JSON.stringify({ version: 1, records }));
    const settled = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6'].map((c) => [c, settle(c)]);
    check('every planted run settles, exit 0', settled.every(([, r]) => r.status === 0), settled.map(([c, r]) => `${c}:${r.status} ${r.stderr}`).join(' '));

    const u1 = recOf('U1');
    check('U1. a weekly-limit ending names the limit in its reason', u1.result === 'unreported' && u1.reason.includes(WEEKLY) && /account usage limit/.test(u1.reason) && /does not exist/.test(u1.reason), JSON.stringify(u1));
    check('U1. a weekly-limit ending records the limit as its blocker', u1.blocker.status === 'usage-limit' && u1.blocker.text === WEEKLY, JSON.stringify(u1.blocker));
    const u2 = recOf('U2');
    check('U2. a session-limit ending is the same event', u2.blocker.status === 'usage-limit' && u2.reason.includes(SESSION), JSON.stringify(u2));
    const noWall = (c) => { const r = recOf(c); return !/usage limit/.test(r.reason) && /does not exist/.test(r.reason) && r.blocker.status === 'unknown'; };
    check('U3. control: a normal run keeps the does-not-exist reason', noWall('U3'), JSON.stringify(recOf('U3')));
    check('U4. control: a closing message that quotes a limit is not a wall', noWall('U4'), JSON.stringify(recOf('U4')));
    check('U5. control: a limit met earlier in a recovered run is not a wall', noWall('U5'), JSON.stringify(recOf('U5')));
    const u6 = recOf('U6');
    check('U6. a limit ending with a partial report keeps both facts', u6.blocker.status === 'usage-limit' && /account usage limit/.test(u6.reason) && /has no RESULT U6 line/.test(u6.reason), JSON.stringify(u6));

    // Rank the settled ledger through the real CLI, in a window around these runs.
    const at = '2026-11-08T11:00:00Z';
    const ranked = JSON.parse(fs.readFileSync(ledger, 'utf8'));
    ranked.records.forEach((r) => { r.settledAt = at; });
    write(ledger, JSON.stringify(ranked));
    write(path.join(base, 'unattended-workers.json'), JSON.stringify({ version: 1, records: [] }));
    const rr = spawnSync(process.execPath, [report, '--base', base, '--now', '2026-11-08T12:00:00Z'], { encoding: 'utf8' });
    const latest = JSON.parse(fs.readFileSync(path.join(base, 'blockers/latest.json'), 'utf8'));
    const cause = (name) => latest.ranked.find((c) => c.cause === name);
    check('U7. the report ran over all six planted runs', rr.status === 0 && latest.population.runs === 6, `${rr.status} ${rr.stderr} ${JSON.stringify(latest.population)}`);
    check('U7. limit runs rank as usage limit', cause('usage limit')?.runs === 3, JSON.stringify(latest.ranked));
    check('U7. the three controls stay settled unreported', cause('settled unreported')?.runs === 3, JSON.stringify(latest.ranked));

    // The usage limit row of CLASSES has work only where the log cannot answer: every
    // run above has a readable log, so those cases rank the same with the row deleted.
    const base2 = path.join(root, 'autodev2');
    const absent = path.join(root, 'no-such-dir', 'gone.log');
    const reportOf = (name) => path.join(root, name, 'REPORT.md');
    write(reportOf('U9'), `A partial report.\nBLOCKER: ${WEEKLY}\nRESULT PARTIAL\n`);
    const row = (code, extra) => ({ code, startedAt: at, state: 'settled', settledAt: at, report: reportOf(code), ...extra });
    write(path.join(base2, 'headless-workers.json'), JSON.stringify({ version: 1, records: [
        row('U8', { result: 'unreported', log: absent, reason: 'the worker stopped at the account usage limit, and REPORT.md does not exist' }),
        row('U9', { result: 'partial', log: absent, reason: 'partial' }),
        row('U10', { result: 'done', log: absent, reason: 'done', blocker: { status: 'stated', text: WEEKLY } }),
        row('U11', { result: 'unreported', log: absent, reason: 'exited 1 and REPORT.md does not exist' }),
    ] }));
    write(path.join(base2, 'unattended-workers.json'), JSON.stringify({ version: 1, records: [] }));
    const r2 = spawnSync(process.execPath, [report, '--base', base2, '--now', '2026-11-08T12:00:00Z'], { encoding: 'utf8' });
    const second = JSON.parse(fs.readFileSync(path.join(base2, 'blockers/latest.json'), 'utf8'));
    const cause2 = (name) => second.ranked.find((c) => c.cause === name);
    check('U8. the second report ran over all four planted runs', r2.status === 0 && second.population.runs === 4, `${r2.status} ${r2.stderr} ${JSON.stringify(second.population)}`);
    check('U8. an unreadable log with a limit reason ranks as usage limit', cause2('usage limit')?.settled === 1, JSON.stringify(second.ranked));
    check('U9. a limit sentence classified from a report BLOCKER and a stated blocker ranks as usage limit', cause2('usage limit')?.stated === 2 && cause2('usage limit')?.runs === 3, JSON.stringify(second.ranked));
    check('U11. control: an unreadable log with no limit in its reason stays settled unreported', cause2('settled unreported')?.runs === 1, JSON.stringify(second.ranked));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`settle-usage-limit: ${total} checks, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
