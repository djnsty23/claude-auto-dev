#!/usr/bin/env node
'use strict';
// test-delivery-outcomes.js - delivery-outcomes.js against a hand-labelled fixture.
//
// tooling/fixtures/delivery-outcomes/expected.json was written by hand BEFORE the
// script: six tasks, nine attempts, covering abandonment, retries, a reopen
// (outside the 7-day window), a revert (inside it) and one task landing through
// two PRs, plus a stray headless run that belongs to no task. Every field of
// every task is checked, not only the totals, so two offsetting errors cannot
// pass. Prints exactly one line, the computed summary; any mismatch goes to
// stderr and sets a nonzero exitCode.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SUBJECT = path.resolve(__dirname, '../plugins/autodev-core/scripts/delivery-outcomes.js');
const FIXTURE = path.resolve(__dirname, 'fixtures/delivery-outcomes');
const D = require(SUBJECT);
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'expected.json'), 'utf8'));
const NOW = Date.parse(expected.now);
const FIELDS = ['attempts', 'costUsd', 'firstAttemptAccepted', 'accepted', 'standingDay7', 'status'];
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };

function compareTasks(label, outcomes) {
    const byId = new Map(outcomes.map((o) => [o.taskId, o]));
    const want = Object.keys(expected.tasks);
    check(outcomes.length === want.length, `${label}: ${outcomes.length} task(s), expected ${want.length} (${outcomes.map((o) => o.taskId).join(',')})`);
    for (const id of want) {
        const got = byId.get(id);
        if (!got) { failures.push(`${label}: task ${id} missing`); continue; }
        for (const f of FIELDS) {
            check(got[f] === expected.tasks[id][f], `${label}: ${id}.${f} = ${JSON.stringify(got[f])}, expected ${JSON.stringify(expected.tasks[id][f])} (${expected.tasks[id].reason}; got reason: ${got.reason})`);
        }
    }
}

function paths(dir, store) {
    return { ledger: path.join(dir, 'unattended-workers.json'), headlessLedger: path.join(dir, 'headless-workers.json'), judgeDir: dir, store };
}
const facts = D.fileFacts(path.join(FIXTURE, 'prs.json'));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-outcomes-'));
let summary = '(not computed)';
try {
    // 1. In process, every field of every task, then the totals.
    const src = D.readSources(paths(FIXTURE, null));
    const { byTask, unmatched } = D.buildAttempts(src);
    const outcomes = D.computeAll(byTask, { now: NOW, prFacts: facts });
    compareTasks('compute', outcomes);
    check(unmatched === 1, `unmatched headless runs = ${unmatched}, expected 1 (golf)`);
    summary = D.summaryLine(D.counts(outcomes));
    check(summary === expected.summary, `summary "${summary}" != expected "${expected.summary}"`);

    // 2. The CLI end to end on a copy, then durability after scratch retention removes the logs.
    const copy = path.join(scratch, 'fixture');
    fs.cpSync(FIXTURE, copy, { recursive: true });
    const store = path.join(scratch, 'state', 'delivery', 'outcomes.jsonl');
    const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(scratch, 'profile') };
    const cli = (...args) => {
        const r = spawnSync(process.execPath, [SUBJECT, ...args], { encoding: 'utf8', env, timeout: 30000, windowsHide: true });
        let json = null; try { json = JSON.parse(r.stdout); } catch { /* text mode or a crash: the caller checks */ }
        return { status: r.status, stdout: r.stdout, json };
    };
    const syncArgs = ['sync', '--ledger', path.join(copy, 'unattended-workers.json'), '--headless-ledger', path.join(copy, 'headless-workers.json'),
        '--judge-dir', copy, '--store', store, '--pr-facts', path.join(copy, 'prs.json'), '--now', expected.now, '--json'];
    const s1 = cli(...syncArgs);
    check(s1.status === 0 && s1.json && s1.json.summary === expected.summary, `sync 1: exit ${s1.status}, ${s1.stdout.trim().slice(0, 300)}`);
    if (s1.json) { compareTasks('sync 1', s1.json.outcomes); check(s1.json.appended === 15, `sync 1 appended ${s1.json.appended}, expected 15 (9 attempts + 6 outcomes)`); }
    const s2 = cli(...syncArgs);
    check(s2.json && s2.json.appended === 0, `sync 2 on unchanged input appended ${s2.json && s2.json.appended}, expected 0`);
    for (const f of fs.readdirSync(path.join(copy, 'logs'))) fs.rmSync(path.join(copy, 'logs', f));
    const s3 = cli(...syncArgs);
    check(s3.json && s3.json.summary === expected.summary, `sync 3 after the logs were removed: ${s3.stdout.trim().slice(0, 300)}`);
    if (s3.json) compareTasks('sync 3 (logs removed)', s3.json.outcomes);
    const rep = cli('report', '--store', store, '--json');
    check(rep.status === 0 && rep.json && rep.json.summary === expected.summary, `report: exit ${rep.status}, ${rep.stdout.trim().slice(0, 300)}`);
    if (rep.json) compareTasks('report', rep.json.outcomes);
    const text = cli('report', '--store', store);
    check(/^population: 6 task outcome\(s\), 9 attempt\(s\)/.test(text.stdout) && text.stdout.includes(expected.summary)
        && text.stdout.includes('$1.52 per accepted task (4 accepted)'), `report text: ${text.stdout.trim()}`);
    const FV = require('../plugins/autodev-core/scripts/fleet-view.js');
    const line = FV.deliverySummary({ autodev: path.join(scratch, 'state') });
    check(line === `delivery: ${expected.summary} (6 task outcome(s) in ${store})`, `fleet-view delivery line: ${line}`);
    check(FV.deliverySummary({ autodev: path.join(scratch, 'no-state') }) === null, 'fleet-view prints no delivery line without a store');
    check(FV.listLines({ sources: [], rows: [], window: 'w', delivery: line }).split('\n')[0] === line, 'fleet-view list does not print the delivery line');
    const missing = cli('report', '--store', path.join(scratch, 'none.jsonl'));
    check(missing.status === 2 && /COULD NOT READ/.test(missing.stdout), `report on an absent store: exit ${missing.status}, ${missing.stdout.trim()}`);
    const help = cli('--help');
    check(help.status === 0 && /^usage: /.test(help.stdout), `--help: exit ${help.status}`);
    check(!fs.existsSync(path.join(scratch, 'profile')), 'the CLI wrote into the profile dir although every path was given');

    // 3. The window edges the frozen fixture cannot show at once.
    const reopenedEarly = (url) => (url.endsWith('/105') ? { ...facts(url), reopenedAt: '2026-09-29T10:00:00.000Z' } : facts(url));
    const delta = D.computeAll(byTask, { now: NOW, prFacts: reopenedEarly }).find((o) => o.taskId === 'delta');
    check(delta.standingDay7 === false, `a reopen 3 days after merge must break standing, got ${delta.standingDay7}`);
    const early = D.computeAll(byTask, { now: Date.parse('2026-09-28T12:00:00.000Z'), prFacts: facts });
    const at = (id) => early.find((o) => o.taskId === id);
    check(at('delta').standingDay7 === null, `2 days after merge standing is not yet known, got ${at('delta').standingDay7}`);
    check(at('charlie').standingDay7 === false, `a revert inside the window is decisive before the window ends, got ${at('charlie').standingDay7}`);
    const quiet = D.computeAll(byTask, { now: Date.parse('2026-09-14T12:00:00.000Z'), prFacts: facts }).find((o) => o.taskId === 'echo');
    check(quiet.accepted === null && quiet.status === 'unknown', `3 quiet days is not abandonment, got ${quiet.accepted}/${quiet.status}`);
    const unread = D.computeAll(byTask, { now: NOW, prFacts: () => null }).find((o) => o.taskId === 'alpha');
    check(unread.accepted === true && unread.standingDay7 === null, `unreadable PR facts leave standing unknown, got ${unread.standingDay7}`);

    // 4. The gh reader parses what GitHub returns and fails to null.
    const gh = (status, doc, error) => () => ({ status, stdout: JSON.stringify(doc), error });
    const doc = { data: { repository: { pullRequest: { state: 'MERGED', mergedAt: '2026-09-22T10:00:00Z',
        closingIssuesReferences: { nodes: [{ timelineItems: { nodes: [{ createdAt: '2026-09-01T00:00:00Z' }, { createdAt: '2026-09-25T00:00:00Z' }] } }] } } },
    search: { nodes: [{ mergedAt: '2026-09-24T10:00:00Z' }] } } };
    const g = D.ghPrFacts('https://github.com/example-org/widget/pull/104', { run: gh(0, doc) });
    check(g && g.state === 'MERGED' && g.revertedAt === '2026-09-24T10:00:00.000Z' && g.reopenedAt === '2026-09-25T00:00:00.000Z',
        `gh parse: ${JSON.stringify(g)}`);
    check(D.ghPrFacts('https://github.com/example-org/widget/pull/104', { run: gh(1, doc) }) === null, 'gh nonzero exit must read as null');
    check(D.ghPrFacts('https://github.com/example-org/widget/pull/104', { run: gh(null, {}, new Error('ETIMEDOUT')) }) === null, 'gh timeout must read as null');
    check(D.ghPrFacts('not a pr url', { run: gh(0, doc) }) === null, 'a non-PR url must read as null');
} catch (e) {
    failures.push(`threw: ${e.stack || e.message}`);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(summary);
if (failures.length) {
    process.stderr.write(`FAIL ${failures.length} check(s):\n${failures.map((f) => `  ${f}`).join('\n')}\n`);
    process.exitCode = 1;
}
