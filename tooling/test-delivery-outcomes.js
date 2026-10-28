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
        '--judge-dir', copy, '--sessions-dir', path.join(copy, 'no-sessions'), '--store', store, '--pr-facts', path.join(copy, 'prs.json'), '--now', expected.now, '--json'];
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

    // 5. Desktop side sessions, labelled by hand before the reader was written.
    //    [measured 2026-10-28] since 10-15 the work runs in side sessions, which
    //    no worker ledger records. The app's MERGED and CLOSED were never seen
    //    stale, every stale state was OPEN, so only OPEN asks the PR facts.
    const pr = (n) => `https://github.com/example-org/widget/pull/${n}`;
    const day = (iso) => Date.parse(iso);
    const sideDir = path.join(scratch, 'sessions');
    const org = path.join(sideDir, 'acct', 'org');
    fs.mkdirSync(org, { recursive: true });
    const spawned = { sessionId: 'local_parent', taskId: 'task_x', title: 'a brief' };
    const sess = (id, created, prs, from = spawned) => fs.writeFileSync(path.join(org, `local_${id}.json`),
        JSON.stringify({ sessionId: `local_${id}`, createdAt: day(created), ...(from ? { spawnedFrom: from } : {}), prs: prs.map(([n, state]) => ({ url: pr(n), state })) }));
    sess('a1', '2026-09-20T10:00:00Z', [[201, 'MERGED']]);
    sess('a2', '2026-09-30T10:00:00Z', [[202, 'MERGED']]);
    sess('a3', '2026-09-28T10:00:00Z', [[203, 'CLOSED'], [204, 'CLOSED']]);
    sess('a4', '2026-09-21T10:00:00Z', [[205, 'OPEN']]);
    sess('a5', '2026-09-20T10:00:00Z', [[206, 'MERGED']], null);
    sess('a6', '2026-09-20T10:00:00Z', []);
    sess('a7', '2026-09-22T10:00:00Z', [[207, 'CLOSED'], [208, 'MERGED']]);
    sess('a8', '2026-10-12T10:00:00Z', [[209, 'OPEN']]);
    fs.writeFileSync(path.join(org, 'local_deadbeef.json'), '{ not json');
    fs.writeFileSync(path.join(org, 'deleted_a9'), '{}');
    const sideFacts = {
        [pr(201)]: { state: 'MERGED', mergedAt: '2026-09-21T10:00:00Z' },
        [pr(202)]: { state: 'MERGED', mergedAt: '2026-10-01T10:00:00Z', revertedAt: '2026-10-03T10:00:00Z' },
        [pr(205)]: { state: 'MERGED', mergedAt: '2026-09-23T10:00:00Z' },
        [pr(208)]: { state: 'MERGED', mergedAt: '2026-09-24T10:00:00Z' },
        [pr(209)]: { state: 'OPEN', mergedAt: null },
    };
    const sideReader = (url) => sideFacts[url] || facts(url);
    const want = {
        'side:local_a1': { accepted: true, firstAttemptAccepted: true, standingDay7: true, status: 'standing' },
        'side:local_a2': { accepted: true, firstAttemptAccepted: true, standingDay7: false, status: 'not-standing' },
        'side:local_a3': { accepted: false, firstAttemptAccepted: false, standingDay7: false, status: 'abandoned' },
        'side:local_a4': { accepted: true, firstAttemptAccepted: true, standingDay7: true, status: 'standing' },
        'side:local_a7': { accepted: true, firstAttemptAccepted: true, standingDay7: true, status: 'standing' },
        'side:local_a8': { accepted: null, firstAttemptAccepted: null, standingDay7: null, status: 'unknown' },
    };
    const sideSrc = D.readSources({ ...paths(FIXTURE, null), sessionsDir: sideDir });
    check(sideSrc.sessions.state === 'read' && sideSrc.sessions.records.length === 8 && sideSrc.sessions.bad === 1,
        `side: ${sideSrc.sessions.records.length} record(s), ${sideSrc.sessions.bad} unreadable, expected 8 and 1`);
    const built = D.buildAttempts(sideSrc, new Map(), { prFacts: sideReader });
    check(built.side.spawned === 7 && built.side.tasks === 6 && built.side.noPr === 1, `side population ${JSON.stringify(built.side)}, expected 7 spawned, 6 tasks, 1 with no PR`);
    const sideOut = D.computeAll(built.byTask, { now: NOW, prFacts: sideReader });
    const sideIds = sideOut.filter((o) => o.taskId.startsWith('side:')).map((o) => o.taskId);
    check(sideIds.join() === Object.keys(want).join(), `side tasks ${sideIds.join()}, expected ${Object.keys(want).join()}`);
    for (const [id, w] of Object.entries(want)) {
        const got = sideOut.find((o) => o.taskId === id) || {};
        for (const [f, v] of Object.entries(w)) check(got[f] === v, `side ${id}.${f} = ${JSON.stringify(got[f])}, expected ${JSON.stringify(v)} (${got.reason})`);
        check(got.attempts === 1 && got.costUsd === null, `side ${id}: ${got.attempts} attempt(s), cost ${got.costUsd}, expected 1 and null`);
    }
    check(JSON.stringify((sideOut.find((o) => o.taskId === 'side:local_a7') || {}).prs) === JSON.stringify([pr(208)]),
        'a session that closed one PR and merged another stands on the merged one only');
    compareTasks('with side sessions', sideOut.filter((o) => !o.taskId.startsWith('side:')));
    const noFacts = D.computeAll(D.buildAttempts(sideSrc).byTask, { now: NOW, prFacts: () => null }).find((o) => o.taskId === 'side:local_a4');
    check(noFacts.accepted === null, `an OPEN PR with no PR facts leaves the task unknown, got ${noFacts.accepted}`);
    check(D.readSessions(path.join(scratch, 'none')).state === 'absent' && D.readSessions(undefined).state === 'not asked',
        'an absent sessions dir reads as absent, an unset one as not asked');
    check(D.desktopSessionsDir({ APPDATA: 'R' }, 'win32') === path.join('R', 'Claude', 'claude-code-sessions')
        && D.desktopSessionsDir({ HOME: 'H' }, 'darwin') === path.join('H', 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
        && D.desktopSessionsDir({ HOME: 'H' }, 'linux') === path.join('H', '.config', 'Claude', 'claude-code-sessions'), 'desktop sessions dir per platform');
    fs.writeFileSync(path.join(scratch, 'side-prs.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(FIXTURE, 'prs.json'), 'utf8')), ...sideFacts }));
    const sideCli = cli('sync', '--ledger', path.join(copy, 'unattended-workers.json'), '--headless-ledger', path.join(copy, 'headless-workers.json'),
        '--judge-dir', copy, '--sessions-dir', sideDir, '--store', path.join(scratch, 'side.jsonl'), '--pr-facts', path.join(scratch, 'side-prs.json'),
        '--now', expected.now);
    check(sideCli.status === 0 && sideCli.stdout.includes('side sessions read: 8 record(s), 1 unreadable, 7 spawned, 6 with a PR, 1 with none')
        && sideCli.stdout.includes('tasks=12 '), `side sync CLI: exit ${sideCli.status}, ${sideCli.stdout.trim().slice(0, 600)}`);

    // 6. The observer kills sync at 90 s, so PR facts stop after a budget. A fake clock moves
    //    one second per read: a 3.5 s budget answers three, the rest stay unread and not final,
    //    and the oldest task is the one asked. The next sync with no budget finishes the work.
    let tick = 0; const asked = [];
    const slow = (url) => { asked.push(url); return sideReader(url); };
    const cut = D.sync({ paths: { ...paths(FIXTURE, null), sessionsDir: sideDir, store: path.join(scratch, 'budget.jsonl') },
        now: NOW, prFacts: slow, budgetMs: 3500, clock: () => (tick += 1000) - 1000 });
    check(asked.length === 3 && /PR facts: 0 settled from budget\.pr-facts\.json, 3 asked, \d+ left unread after the 3\.5 s budget/.test(cut.population),
        `budget: ${asked.length} asked, population ${cut.population.split('; ').slice(-2).join('; ')}`);
    // The two OPEN side PRs are asked while attempts are built, then the oldest task with a merged PR.
    const order = [...D.buildAttempts(sideSrc, new Map(), { prFacts: sideReader }).byTask.entries()]
        .filter(([, l]) => l.some((a) => a.decision === 'accept' && a.prs && a.prs.length))
        .sort(([, a], [, b]) => (a[0].startedAt < b[0].startedAt ? -1 : 1));
    const oldestPrs = order[0][1].flatMap((a) => a.prs || []);
    check(asked[0] === pr(205) && asked[1] === pr(209) && oldestPrs.includes(asked[2]),
        `budget order: asked ${asked.join(' ')}, oldest task ${order[0][0]} holds ${oldestPrs.join(' ')}`);
    const cutUnread = cut.outcomes.filter((o) => o.accepted === true && o.standingDay7 === null).length;
    check(cutUnread >= 3, `budget: ${cutUnread} accepted task(s) left with day 7 unread, expected at least 3`);
    const full = D.sync({ paths: { ...paths(FIXTURE, null), sessionsDir: sideDir, store: path.join(scratch, 'budget.jsonl') }, now: NOW, prFacts: sideReader });
    check(!/left unread/.test(full.population) && full.summary === sideCli.stdout.split('\n').find((l) => l.startsWith('tasks=')),
        `after the cut, a full sync matches the uncut one: ${full.summary}`);
    // Settled answers persist beside the store: a merge older than the window and a closed PR.
    const cacheFile = path.join(scratch, 'budget.pr-facts.json');
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    check(cached[pr(201)] && cached[pr(205)] && !cached[pr(209)], `settled cache holds ${Object.keys(cached).length} PR(s), 201 and 205 but not the open 209`);
    // A fresh store beside that cache has no final outcome to reuse, so only the cache saves the asks.
    fs.copyFileSync(cacheFile, path.join(scratch, 'warm.pr-facts.json'));
    const warm = [];
    const warmRun = D.sync({ paths: { ...paths(FIXTURE, null), sessionsDir: sideDir, store: path.join(scratch, 'warm.jsonl') }, now: NOW,
        prFacts: (url) => { warm.push(url); return sideReader(url); } });
    check(!warm.some((u) => cached[u]) && warm.includes(pr(209)) && /PR facts: [1-9]\d* settled from/.test(warmRun.population),
        `a settled PR is never asked twice: asked ${warm.join(' ')}`);
    // A task inside its window, re-synced with the budget spent: the stored row stands, no churn.
    const young = path.join(scratch, 'young', 'acct', 'org');
    fs.mkdirSync(young, { recursive: true });
    fs.writeFileSync(path.join(young, 'local_b1.json'), JSON.stringify({ sessionId: 'local_b1', createdAt: day('2026-10-10T10:00:00Z'),
        spawnedFrom: spawned, prs: [{ url: pr(210), state: 'MERGED' }] }));
    const youngFacts = (url) => (url === pr(210) ? { state: 'MERGED', mergedAt: '2026-10-11T10:00:00Z' } : facts(url));
    const youngPaths = { ...paths(FIXTURE, null), sessionsDir: path.join(scratch, 'young'), store: path.join(scratch, 'young.jsonl') };
    const y1 = D.sync({ paths: youngPaths, now: NOW, prFacts: youngFacts });
    const y2 = D.sync({ paths: youngPaths, now: NOW, prFacts: youngFacts, budgetMs: 0 });
    const yo = y2.outcomes.find((o) => o.taskId === 'side:local_b1') || {};
    check(y1.appended > 0 && y2.appended === 0 && yo.status === 'accepted-day7-unknown' && !/unreadable/.test(yo.reason),
        `a budget-skipped read keeps the stored outcome: appended ${y2.appended}, ${yo.status}, ${yo.reason}`);
    fs.unlinkSync(cacheFile);
    const again = [];
    D.sync({ paths: { ...paths(FIXTURE, null), sessionsDir: sideDir, store: path.join(scratch, 'budget.jsonl') }, now: NOW,
        prFacts: (url) => { again.push(url); return sideReader(url); } });
    check(!again.includes(pr(205)) && again.includes(pr(209)),
        `an OPEN PR stored as merged is not asked again, a still-open one is: asked ${again.join(' ')}`);
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
