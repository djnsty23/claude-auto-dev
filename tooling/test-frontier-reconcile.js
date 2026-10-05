#!/usr/bin/env node
'use strict';
// Bookkeeping recovery must not launch a worker, kill a reused pid, invent a
// result, or lose a queued experiment. Exercise the shipped CLI and refusals.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const subject = process.env.FRONTIER_RECONCILE_SUBJECT || path.join(__dirname, 'frontier', 'run.js');
const { reconcileBatch } = require(subject);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-reconcile-'));
const id = 'B-01010101';
let passed = 0, failed = 0;
function check(name, ok) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); ok ? passed++ : failed++; }
function fixture() {
    const dir = fs.mkdtempSync(path.join(root, 'case-'));
    const c = { data: path.join(dir, 'data'), work: path.join(dir, 'work') };
    fs.mkdirSync(path.join(c.data, 'batches'), { recursive: true });
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true });
    const loopPid = Number(dead.stdout.trim());
    const supervisor = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true });
    const supervisorPid = Number(supervisor.stdout.trim());
    const file = path.join(c.data, 'batches', `${id}.json`);
    const batch = { id, state: 'running', loopPid, account: 'fixture', items: [
        { task: 'T1', variant: 'V0', rep: 1, state: 'done', run: 'F-01010001-T1-V0-1', verdict: 'fail' },
        { task: 'T2', variant: 'V0', rep: 1, state: 'queued', run: null, verdict: null },
        { task: 'T3', variant: 'V0', rep: 1, state: 'running', run: 'F-01010002-T3-V0-1', verdict: null },
    ] };
    fs.writeFileSync(file, JSON.stringify(batch));
    const runDir = path.join(c.work, 'runs', batch.items[2].run);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ supervisorPid }));
    fs.writeFileSync(path.join(runDir, 'worker.log'), 'unfinished stream\n');
    return { c, file, batch, loopPid, runDir, snap: { ok: true, boot: { id: 'fixture-boot' }, procs: new Map() } };
}
function cli(fx, command = 'batch-reconcile', env = {}) {
    return spawnSync(process.execPath, [subject, command, '--batch', id, '--data', fx.c.data, '--work', fx.c.work],
        { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, ...env } });
}
function refused(name, fx, snap, code) {
    const before = fs.readFileSync(fx.file, 'utf8');
    let error;
    try { reconcileBatch(fx.c, id, { snap }); } catch (e) { error = e.publicCode; }
    check(`${name}: named refusal`, error === code);
    check(`${name}: batch unchanged`, fs.readFileSync(fx.file, 'utf8') === before);
    check(`${name}: mutex released`, !fs.existsSync(`${fx.file}.reconcile.lock`));
}
try {
    const fx = fixture();
    const originalQueue = JSON.stringify(fx.batch.items[1]);
    const r = cli(fx);
    check('dead loop: real CLI exits zero with parseable recovery', r.status === 0 && JSON.parse(r.stdout).ok);
    const b = JSON.parse(fs.readFileSync(fx.file, 'utf8'));
    check('dead loop: stalled, not running or completed', b.state === 'stalled');
    check('dead loop: every queued field survives', JSON.stringify(b.items[1]) === originalQueue);
    check('dead loop: earlier verdict survives', b.items[0].verdict === 'fail' && b.items[0].state === 'done');
    check('interrupted attempt: stable run id, no invented verdict', b.items[2].run === fx.batch.items[2].run && b.items[2].verdict === null);
    check('interrupted attempt: exact blocker and owner retained', b.items[2].pending.owner === 'frontier-runner' && /ungraded/.test(b.items[2].pending.blocker));
    check('interrupted attempt: no result row manufactured', !fs.existsSync(path.join(fx.c.data, 'runs.jsonl')));
    check('interrupted attempt: original stream preserved', fs.readFileSync(path.join(fx.runDir, 'worker.log'), 'utf8') === 'unfinished stream\n');
    const again = cli(fx);
    check('repeated reconciliation: queue and pending population unchanged', again.status === 0
        && JSON.stringify(JSON.parse(fs.readFileSync(fx.file, 'utf8')).items) === JSON.stringify(b.items));
    const resume = cli(fx, 'batch-resume');
    check('resume: pending is a refusal, not a worker launch', resume.status === 1 && JSON.parse(resume.stdout).error.code === 'pending-run');
    const done = fixture();
    fs.writeFileSync(path.join(done.c.data, 'runs.jsonl'), JSON.stringify({ run: done.batch.items[2].run, verdict: 'pass' }) + '\n');
    reconcileBatch(done.c, id, { snap: done.snap });
    const after = JSON.parse(fs.readFileSync(done.file, 'utf8'));
    check('recorded result: restored to done with its actual verdict', after.items[2].state === 'done' && after.items[2].verdict === 'pass');
    check('recorded result: queued work still keeps batch stalled', after.state === 'stalled' && after.recovery.pending.length === 0);
    const status = cli(fx, 'status');
    check('status: pending owner and blocker remain visible', status.status === 0
        && JSON.parse(status.stdout).value.batches[0].pending[0].owner === 'frontier-runner');
    const population = JSON.parse(status.stdout).value.batches[0];
    check('status: pending is not live, and item populations cross-foot', population.running === 0
        && population.done + population.queued + population.running + population.pending.length + population.skipped === fx.batch.items.length);
    const noToken = cli(done, 'batch-resume', { CLAUDE_CODE_OAUTH_TOKEN_FIXTURE: '' });
    check('resume: missing credential refused before any queued item is skipped', noToken.status === 1
        && JSON.parse(noToken.stdout).error.code === 'token-missing'
        && fs.readFileSync(done.file, 'utf8') === JSON.stringify(after, null, 2) + '\n');
    const finished = fixture();
    finished.batch.items[1].state = 'done'; finished.batch.items[1].verdict = 'fail';
    fs.writeFileSync(finished.file, JSON.stringify(finished.batch));
    fs.writeFileSync(path.join(finished.c.data, 'runs.jsonl'), JSON.stringify({ run: finished.batch.items[2].run, verdict: 'fail' }) + '\n');
    check('complete population: only recorded outcomes with no queue read done', reconcileBatch(finished.c, id, { snap: finished.snap }).state === 'done');
    const live = fixture();
    live.snap.procs.set(live.loopPid, { pid: live.loopPid });
    refused('live or reused loop', live, live.snap, 'loop-alive');
    const worker = fixture();
    const supervisorPid = worker.loopPid + 1;
    fs.writeFileSync(path.join(worker.runDir, 'run.json'), JSON.stringify({ supervisorPid }));
    worker.snap.procs.set(supervisorPid, { pid: supervisorPid });
    refused('live or reused supervisor', worker, worker.snap, 'worker-alive');
    const unknown = fixture();
    refused('unreadable process table', unknown, { ...unknown.snap, ok: false, why: 'probe failed' }, 'process-unchecked');
    const duplicate = fixture();
    const row = JSON.stringify({ run: duplicate.batch.items[2].run, verdict: 'pass' });
    fs.writeFileSync(path.join(duplicate.c.data, 'runs.jsonl'), row + '\n' + row + '\n');
    refused('duplicate outcomes', duplicate, duplicate.snap, 'result-conflict');
    const missing = fixture();
    fs.writeFileSync(path.join(missing.runDir, 'run.json'), '{}');
    refused('missing supervisor identity', missing, missing.snap, 'process-unchecked');
} finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
