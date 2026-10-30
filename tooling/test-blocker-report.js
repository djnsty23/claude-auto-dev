#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const scripts = path.resolve(__dirname, '../plugins/autodev-core/scripts');
const subject = process.env.BLOCKER_REPORT_SUBJECT || path.join(scripts, 'blocker-report.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-report-'));
const base = path.join(root, 'autodev');
let total = 0; let failed = 0;
function check(name, ok, detail = '') { total++; if (!ok) failed++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`); }
function write(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
const json = (file, value) => write(file, JSON.stringify(value));
const NOW = '2026-11-08T12:00:00Z';
const run = (extra = []) => spawnSync(process.execPath, [subject, '--base', base, '--now', NOW, ...extra], { encoding: 'utf8' });
const latest = () => JSON.parse(fs.readFileSync(path.join(base, 'blockers/latest.json'), 'utf8'));
const cause = (r, name) => r.ranked.find((c) => c.cause === name);
try {
    let r = run();
    check('absent ledgers are reported unread, not as zero blockers', r.status === 0 && /unread headless-workers\.json \(absent\)/.test(r.stdout), r.stdout + r.stderr);

    const rep = (name, text) => { const f = path.join(root, 'reports', `${name}.md`); write(f, text); return f; };
    const at = '2026-11-07T10:00:00Z';
    const headless = [
        // Owned by the unattended task below: counted once, with this result.
        { code: 'w-owned', startedAt: '2026-11-07T09:00:00Z', state: 'settled', settledAt: at, result: 'unreported', reason: 'exited 0 and REPORT.md does not exist', report: path.join(root, 'none.md') },
        { code: 'w-login', startedAt: '2026-11-07T09:01:00Z', state: 'settled', settledAt: at, result: 'auth-refused', reason: 'Failed to authenticate: OAuth session expired', report: path.join(root, 'none.md') },
        { code: 'w-stated', startedAt: '2026-11-07T09:02:00Z', state: 'settled', settledAt: at, result: 'done',
            report: rep('stated', 'Work.\nThe gate failed once.\nBLOCKER: the full gate waited 40 min in the queue behind two product gates\nRESULT w-stated done: x\n') },
        { code: 'w-none', startedAt: '2026-11-07T09:03:00Z', state: 'settled', settledAt: at, result: 'done',
            report: rep('none', 'All fine. The suite failed on a flaky timeout.\nBLOCKER: none\nRESULT w-none done: x\n') },
        { code: 'w-mined', startedAt: '2026-11-07T09:04:00Z', state: 'settled', settledAt: at, result: 'done',
            report: rep('mined', 'The worker guard denied copying the env file.\nThe permission classifier refused rm -rf .next.\nRESULT w-mined done: x\n') },
        { code: 'w-old', startedAt: '2026-10-01T09:00:00Z', state: 'settled', settledAt: '2026-10-01T10:00:00Z', result: 'unreported', reason: 'old', report: path.join(root, 'none.md') },
    ];
    json(path.join(base, 'headless-workers.json'), { version: 1, records: headless });
    json(path.join(base, 'unattended-workers.json'), { version: 1, records: [
        { taskId: 't-owned', startedAt: '2026-11-07T08:59:00Z', settledAt: at, runStatus: 'failed', settleReason: 'SETTLED: settled unreported',
            report: path.join(root, 'none.md'), headless: { code: 'w-owned', startedAt: '2026-11-07T09:00:00Z' } },
    ] });
    const lock = (name, arrival, admitted) => write(path.join(base, 'locks', name),
        `1\nwhat, lock taken\nclass product\nmeta ${JSON.stringify({ schema: 1, arrival, admittedUtc: admitted, cls: 'product' })}\n`);
    lock('full-gate.lock.released-0001', '2026-11-07T10:00:00Z', '2026-11-07T10:30:00Z');
    lock('full-gate-2.lock.released-0002', '2026-11-07T11:00:00Z', '2026-11-07T11:00:06Z');
    lock('merge-o__r.lock.released-0003', '2026-11-07T11:00:00Z', '2026-11-07T11:00:01Z');
    lock('full-gate.lock.released-0004', '2026-10-01T10:00:00Z', '2026-10-01T12:00:00Z');
    write(path.join(base, 'locks', 'full-gate.lock.released-0005'), '1\nno meta line\n');

    r = run();
    const l = latest();
    check('runs in the window, one per run across both ledgers', r.status === 0 && l.population.runs === 5, JSON.stringify(l.population) + r.stderr);
    check('an owned headless record lends its result to the task', cause(l, 'settled unreported')?.runs === 1 && !cause(l, 'settled failed'), JSON.stringify(l.ranked.map((c) => c.cause)));
    check('auth-refused is the login cause', cause(l, 'login refused')?.runs === 1);
    check('a stated BLOCKER is classified and counted as stated', cause(l, 'gate queue or capacity wait')?.stated === 1);
    check('a stated BLOCKER suppresses mining that report', !cause(l, 'flaky or failing test'), JSON.stringify(l.ranked));
    check('BLOCKER: none counts as stated with no cause', l.population.statedRuns === 2 && l.population.statedNone === 1, JSON.stringify(l.population));
    check('mined lines count one run per cause', cause(l, 'permission guard denied')?.runs === 1 && cause(l, 'permission guard denied')?.mined === 1);
    check('gate waits from released locks in the window', l.queue.gate.runs === 2 && l.queue.gate.max === 30 && l.queue.gate.over10 === 1, JSON.stringify(l.queue.gate));
    check('merge waits kept apart', l.queue.merge.runs === 1 && l.queue.merge.p90 === 0, JSON.stringify(l.queue.merge));
    check('summary names the top cause and the gate wait', /top .+ in 1 run\(s\); gate wait p50 \d/.test(r.stdout), r.stdout);
    run(); run();
    const hist = fs.readFileSync(path.join(base, 'blockers/history.jsonl'), 'utf8').trim().split('\n');
    check('one history row per day', hist.length === 1 && JSON.parse(hist[0]).day === '2026-11-08', hist.length);
    r = run(['--print', '--no-write']);
    check('--print lists examples', /the full gate waited 40 min/.test(r.stdout), r.stdout);
    check('--print quotes each example as worker-written data', /worker text: "the full gate waited 40 min[^"\n]*"/.test(r.stdout) && /worker-written text, quoted as data/.test(r.stdout), r.stdout);

    // A3: a report with no BLOCKER line, a done run with no report, and a
    // pre-worker failure the supervisor recorded each rank as their own cause.
    const a3 = path.join(root, 'a3');
    json(path.join(a3, 'unattended-workers.json'), { version: 1, records: [] });
    json(path.join(a3, 'headless-workers.json'), { version: 1, records: [
        { code: 'n1', startedAt: '2026-11-07T09:00:00Z', state: 'settled', settledAt: at, result: 'done', report: rep('n1', 'Work.\nRESULT n1 done: x\n') },
        { code: 'n2', startedAt: '2026-11-07T09:01:00Z', state: 'settled', settledAt: at, result: 'done', report: path.join(root, 'absent-n2.md') },
        { code: 'n3', startedAt: '2026-11-07T09:02:00Z', state: 'settled', settledAt: at, result: 'unreported', reason: 'exited -1 and REPORT.md does not exist',
            blocker: { status: 'supervisor', text: 'BUDGET_DENIED=unknown-attempt: no --attempt-id' }, report: path.join(root, 'absent-n3.md') },
    ] });
    r = spawnSync(process.execPath, [subject, '--base', a3, '--now', NOW], { encoding: 'utf8' });
    const a3l = JSON.parse(fs.readFileSync(path.join(a3, 'blockers/latest.json'), 'utf8'));
    check('A3. a report with no BLOCKER line ranks as blocker not stated', cause(a3l, 'blocker not stated')?.runs === 1, JSON.stringify(a3l.ranked));
    check('A3. a done run with no report ranks as report missing', cause(a3l, 'report missing')?.runs === 1, JSON.stringify(a3l.ranked));
    check('A3. a supervisor-recorded pre-worker failure ranks by its reason', cause(a3l, 'pre-worker failure (budget, capacity or spawn)')?.runs === 1, JSON.stringify(a3l.ranked));
    check('A3. the summary never says none found while evidence is missing', !/top none found/.test(r.stdout), r.stdout);

    // A4: valid JSON in the wrong shape is unreadable, never a clean zero.
    for (const [label, value] of [['{}', {}], ['{"records":null}', { records: null }], ['[null] records', { records: [null] }]]) {
        const d = path.join(root, `a4-${label.replace(/\W/g, '')}`);
        json(path.join(d, 'headless-workers.json'), value);
        json(path.join(d, 'unattended-workers.json'), { version: 1, records: [] });
        r = spawnSync(process.execPath, [subject, '--base', d, '--now', NOW], { encoding: 'utf8' });
        check(`A4. a ${label} ledger exits 2 and publishes nothing`, r.status === 2 && !fs.existsSync(path.join(d, 'blockers/latest.json')) && /invalid/.test(r.stderr),
            `exit ${r.status} ${r.stdout}${r.stderr}`);
    }

    write(path.join(base, 'unattended-workers.json'), '{not json');
    r = run();
    check('an unreadable ledger is exit 2, not a clean week', r.status === 2 && /could not read unattended-workers\.json/.test(r.stderr), r.stdout + r.stderr);
    r = run(['--days', '0']);
    check('a bad window is refused', r.status === 2);

    const hw = require(path.join(scripts, 'headless-worker.js'));
    const prompt = hw.composePrompt('Do the work.', path.join(root, 'scratch', 'W1'), { code: 'W1', report: path.join(root, 'W1.md') });
    check('every reported worker prompt asks for the BLOCKER line', prompt.includes(hw.BLOCKER_NOTE) && /BLOCKER: none/.test(hw.BLOCKER_NOTE));
    const br = require(subject);
    check('the line the prompt asks for parses as stated', br.statedBlocker('x\nBLOCKER: the gate queue waited 20 min\nRESULT W1 done: y').text === 'the gate queue waited 20 min');
    // A5: only a whole none marker is none.
    const poisoned = br.statedBlocker('BLOCKER: none of the tests ran because the gate queue waited 40 minutes\nRESULT W5 done: x');
    check('A5. a sentence starting with "none" is a stated blocker, not none', poisoned.stated && poisoned.text === 'none of the tests ran because the gate queue waited 40 minutes', JSON.stringify(poisoned));
    check('A5. whole none markers still read as none', ['none', 'None.', 'nothing', 'N/A', 'no blocker', '**none**'].every((t) => br.statedBlocker(`BLOCKER: ${t}`).text === null));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`blocker-report: ${total} checks, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
