#!/usr/bin/env node
'use strict';
// headless-worker.js settle records a structured blocker on every ending, so a
// run that states none, or never reached the model, cannot drop out of
// blocker-report.js's ranking. Each case settles a planted record through the
// real CLI; no claude process runs.
//   S1  a RESULT report with no BLOCKER line settles as blocker not-stated
//   S2  a stated BLOCKER is persisted with its text, and BLOCKER: none as none
//   S3  a pre-worker failure (BUDGET_DENIED, no report) settles --unreported
//       with the supervisor's line as its blocker
//   S4  a missing BLOCKER line never strands the record: it settles, exit 0
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const scripts = path.resolve(__dirname, '../plugins/autodev-core/scripts');
const subject = process.env.HEADLESS_WORKER_SUBJECT || path.join(scripts, 'headless-worker.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-blocker-'));
const env = { ...process.env, AUTODEV_CAPACITY: 'off', AUTODEV_BUDGET_LEDGER: path.join(root, 'budget.json'),
    AUTODEV_GATE_LOCK_PATH: path.join(root, 'locks', 'full-gate.lock') };
let total = 0; let failed = 0;
function check(name, ok, detail = '') { total++; if (!ok) failed++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`); }
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const ledger = path.join(root, 'headless-workers.json');
// A pid that has provably exited: --unreported refuses a live supervisor.
const deadPid = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
const records = [];
function plant(code, { report = null, log, pid = process.pid }) {
    const reportFile = path.join(root, `${code}.md`);
    if (report !== null) write(reportFile, report);
    const logFile = path.join(root, `${code}.log`);
    write(logFile, log);
    records.push({ code, startedAt: '2026-01-01T00:00:00Z', state: 'running', report: reportFile, log: logFile, pid, cwd: root });
}
const settle = (code, extra = []) => spawnSync(process.execPath, [subject, 'settle', '--code', code, '--ledger', ledger, ...extra], { env, encoding: 'utf8' });
const recOf = (code) => JSON.parse(fs.readFileSync(ledger, 'utf8')).records.find((r) => r.code === code);
try {
    plant('S1', { report: 'Work done.\nRESULT S1 done: shipped\n', log: 'CLAUDE_EXIT=0\n' });
    plant('S2A', { report: 'Work.\nBLOCKER: the gate queue waited 40 minutes\nRESULT S2A done: shipped\n', log: 'CLAUDE_EXIT=0\n' });
    plant('S2B', { report: 'Work.\nBLOCKER: none\nRESULT S2B done: shipped\n', log: 'CLAUDE_EXIT=0\n' });
    plant('S3', { log: 'BUDGET_DENIED=unknown-attempt: no --attempt-id, so no reserved attempt to run under\nCLAUDE_EXIT=-1\n', pid: deadPid });
    fs.writeFileSync(ledger, JSON.stringify({ version: 1, records }));

    let r = settle('S1');
    check('S4. a report with no BLOCKER line still settles (exit 0)', r.status === 0 && recOf('S1').state === 'settled', r.stdout + r.stderr);
    check('S1. a report with no BLOCKER line records blocker not-stated', recOf('S1').blocker && recOf('S1').blocker.status === 'not-stated', JSON.stringify(recOf('S1').blocker));
    settle('S2A'); settle('S2B');
    check('S2. a stated BLOCKER is persisted with its text', recOf('S2A').blocker && recOf('S2A').blocker.status === 'stated' && recOf('S2A').blocker.text === 'the gate queue waited 40 minutes', JSON.stringify(recOf('S2A').blocker));
    check('S2. BLOCKER: none is persisted as none', recOf('S2B').blocker && recOf('S2B').blocker.status === 'none', JSON.stringify(recOf('S2B').blocker));
    r = settle('S3', ['--unreported']);
    const s3 = recOf('S3');
    check('S3. a pre-worker failure settles unreported with the supervisor line as its blocker', r.status === 0 && s3.result === 'unreported'
        && s3.blocker && s3.blocker.status === 'supervisor' && /^BUDGET_DENIED=unknown-attempt/.test(s3.blocker.text), `exit ${r.status} ${r.stderr} ${JSON.stringify(s3)}`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`settle-blocker: ${total} checks, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
