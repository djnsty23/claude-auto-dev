#!/usr/bin/env node
'use strict';

// A closed headless run goes back to work three ways, and each must fail closed.
//
//   L  requeue reads a capacity deferral from worker.log when the run record has
//      no blocker, and never from a real run's transcript
//   U  requeue --unreported takes a run that ran and left nothing, and refuses a
//      live process, commits past the base and a claimed slug
//   V  salvage marks a run succeeded only when its pushed branch and its report
//      are there, keeps the task id, and leaves the verdict to the coordinator
//   G  launch obeys the start switch whoever calls it: the board-requests routine
//      launches directly, and started a real run while the switch said dry
//
// Every case runs on fixtures in a temp dir with a real git origin. No claude runs.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const UW = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'unattended-worker.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'requeue-salvage-'));
const HOME = path.join(ROOT, 'home');
const env = {
    ...process.env, HOME, USERPROFILE: HOME, CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'), AUTODEV_CAPACITY: 'off', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.invalid',
};

let total = 0;
let failed = 0;
function check(name, ok, observed = '') {
    total++;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  (${String(observed).slice(0, 500)})`}`);
}
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const iso = (ms) => new Date(ms).toISOString();
const deadPid = () => spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
function g(cwd, ...args) {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return (r.stdout || '').trim();
}
function cli(args) {
    const r = spawnSync(process.execPath, [UW, ...args], { encoding: 'utf8', env, timeout: 120000, windowsHide: true });
    let json = null;
    try { json = JSON.parse((r.stdout || '').trim()); } catch { /* a crash */ }
    const code = (json && json.error && json.error.code) || ((r.stderr || '').match(/"code":"([a-z-]+)"/) || [])[1] || null;
    return { status: r.status, value: json && json.ok ? json.value : null, code, detail: (r.stdout || '').slice(0, 500) + (r.stderr || '').slice(0, 300) };
}

const world = path.join(ROOT, 'world');
const origin = path.join(ROOT, 'origin.git');
const repo = path.join(world, 'repo');
const ledger = path.join(world, 'unattended.json');
const headless = path.join(world, 'headless.json');
const switchFile = path.join(world, 'brain-judge', 'switch.json');
const rec = (id) => readJson(ledger).records.find((r) => r.taskId === id);

/** Commit one file on a new branch of the fixture repo, leaving main checked out. */
function branchWithCommit(branch, { push = false } = {}) {
    g(repo, 'switch', '-q', '-c', branch, 'origin/main');
    write(path.join(repo, 'docs', `${branch.replace(/\W/g, '-')}.md`), 'work\n');
    g(repo, 'add', 'docs');
    g(repo, 'commit', '-q', '-m', `work on ${branch}`);
    if (push) g(repo, 'push', '-q', 'origin', branch);
    const head = g(repo, 'rev-parse', 'HEAD');
    g(repo, 'switch', '-q', 'main');
    return head;
}

/** A closed headless record, its settled run and the worker.log it left, plus a queued dependant. */
function closedRun(slug, { result = 'unreported', blocker = null, log = 'a real transcript\nCLAUDE_EXIT=0\n', pid = null, report = null } = {}) {
    const startedAt = iso(Date.now() - 60000);
    const dir = path.join(world, 'reports', slug);
    const logFile = path.join(dir, 'worker.log');
    const reportFile = path.join(dir, 'REPORT.md');
    write(logFile, log);
    if (report !== null) write(reportFile, report);
    const hl = readJson(headless);
    hl.records.push({ code: slug, pid: pid || deadPid(), startedAt, log: logFile, report: reportFile, state: 'settled', result, exit: 0, blocker });
    write(headless, JSON.stringify(hl, null, 2));
    const ul = readJson(ledger);
    ul.records.push({
        taskId: `worker-${slug}`, slug, repo, branch: `claude/${slug}`, base: 'origin/main', worktree: path.join(repo, '.claude', 'worktrees', slug), report: reportFile,
        state: 'closed', channel: 'headless', queuedAt: iso(Date.now() - 120000), startedAt, launchedAt: startedAt, attemptId: `a-${slug}`,
        headless: { code: slug, pid: pid || deadPid(), startedAt, ledger: headless, log: logFile }, runStatus: 'failed', settledAt: startedAt, settleReason: 'SETTLED: settled unreported',
        verdict: { decision: 'escalate', reason: 'the worker left no report', by: 'judge', at: startedAt },
    });
    ul.records.push({ taskId: `worker-${slug}-next`, slug: `${slug}-next`, repo, state: 'queued', channel: 'headless', queuedAt: iso(Date.now()), after: [`worker-${slug}`] });
    write(ledger, JSON.stringify(ul, null, 2));
    return `worker-${slug}`;
}
const dep = (id) => {
    const r = cli(['ready', '--ledger', ledger, '--max-per-hour', '99', '--max-concurrent', '99']);
    const v = r.value || {};
    if ((v.ready || []).includes(`${id}-next`)) return { state: 'ready', reason: '' };
    const p = (v.pending || []).find((x) => x.taskId === `${id}-next`);
    if (p) return { state: 'pending', reason: p.reason };
    const b = (v.blocked || []).find((x) => x.taskId === `${id}-next`);
    return b ? { state: 'blocked', reason: b.reason } : { state: 'absent', reason: r.detail };
};
const unchanged = (id, before) => JSON.stringify(rec(id)) === before;
const DEFERRED_LOG = 'CAPACITY_WAIT=crash breaker tripped\n\nCAPACITY_DEFERRED=crash breaker tripped for worker\nCLAUDE_EXIT=-1\n';

const children = [];
try {
    fs.mkdirSync(world, { recursive: true });
    spawnSync('git', ['init', '-q', '--bare', origin], { env, windowsHide: true });
    spawnSync('git', ['init', '-q', '-b', 'main', repo], { env, windowsHide: true });
    g(repo, 'remote', 'add', 'origin', origin);
    write(path.join(repo, 'README.md'), 'fixture\n');
    g(repo, 'add', 'README.md');
    g(repo, 'commit', '-q', '-m', 'init');
    g(repo, 'push', '-q', 'origin', 'main');
    g(repo, 'fetch', '-q', 'origin');
    write(ledger, JSON.stringify({ version: 1, records: [] }));
    write(headless, JSON.stringify({ version: 1, records: [] }));

    // ------------------------------------------------------------ L
    const l1 = closedRun('l1', { log: DEFERRED_LOG });
    const rqL1 = cli(['requeue', '--task-id', l1, '--reason', 'turned away', '--ledger', ledger]);
    const l1r = rec(l1);
    const l1a = (l1r.attempts || []).pop() || {};
    check('L1. requeue reads a deferral from worker.log when the run record has no blocker', rqL1.status === 0 && l1r.state === 'queued' && l1a.outcome === 'capacity-deferred'
        && /^CAPACITY_DEFERRED=/.test(l1a.reason) && l1r.taskId === l1, rqL1.detail);
    const l2 = closedRun('l2', { log: `{"text":"the log quotes\\nCAPACITY_DEFERRED=x"}\nsaid: CAPACITY_DEFERRED=x\nCLAUDE_EXIT=0\n` });
    const rqL2 = cli(['requeue', '--task-id', l2, '--reason', 'x', '--ledger', ledger]);
    check('L2. control: a run that started and only quotes the marker is not a deferral', rqL2.code === 'not-deferred', rqL2.detail);
    const l3 = closedRun('l3', { log: `CAPACITY_DEFERRED=x\nCLAUDE_EXIT=-1\n${'y'.repeat(70 * 1024)}\n` });
    const rqL3 = cli(['requeue', '--task-id', l3, '--reason', 'x', '--ledger', ledger]);
    check('L3. control: a transcript over the size bound is never read as a deferral', rqL3.code === 'not-deferred', rqL3.detail);
    const l4 = closedRun('l4', { log: 'CAPACITY_DEFERRED=x\nCLAUDE_EXIT=0\n' });
    const rqL4 = cli(['requeue', '--task-id', l4, '--reason', 'x', '--ledger', ledger]);
    check('L4. control: a marker with claude exit 0 is not a deferral', rqL4.code === 'not-deferred', rqL4.detail);

    // ------------------------------------------------------------ U
    const u1 = closedRun('u1');
    branchWithCommit('claude/u1');
    const u1Before = JSON.stringify(rec(u1));
    const rqU1 = cli(['requeue', '--task-id', u1, '--reason', 'try', '--ledger', ledger]);
    check('U1. plant: a real-work unreported run without --unreported is refused', rqU1.code === 'not-deferred' && unchanged(u1, u1Before), rqU1.detail);
    const rqU2 = cli(['requeue', '--task-id', u1, '--reason', 'try', '--unreported', '--ledger', ledger]);
    check('U2. --unreported still refuses a run with commits past its base, and writes nothing', rqU2.code === 'unmerged-branch' && unchanged(u1, u1Before), rqU2.detail);

    const u3 = closedRun('u3');
    const rqU3 = cli(['requeue', '--task-id', u3, '--reason', 'it left nothing', '--unreported', '--ledger', ledger]);
    const u3r = rec(u3);
    const u3a = (u3r.attempts || []).pop() || {};
    check('U3. --unreported returns an empty unreported run to queued, its verdict in history', rqU3.status === 0 && u3r.state === 'queued' && u3r.verdict === undefined
        && u3a.outcome === 'unreported' && u3a.closed.verdict.decision === 'escalate', rqU3.detail);
    check('U3. its task id stands, so the dependant still resolves', u3r.taskId === u3 && dep(u3).state === 'pending', JSON.stringify(dep(u3)));

    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
    children.push(sleeper);
    const u4 = closedRun('u4', { pid: sleeper.pid });
    const u4Before = JSON.stringify(rec(u4));
    const rqU4 = cli(['requeue', '--task-id', u4, '--reason', 'x', '--unreported', '--ledger', ledger]);
    check('U4. a live process refuses requeue', rqU4.code === 'live-process' && unchanged(u4, u4Before), rqU4.detail);

    const u5 = closedRun('u5');
    g(repo, 'branch', 'claude/u5', 'origin/main');
    const rqU5 = cli(['requeue', '--task-id', u5, '--reason', 'x', '--unreported', '--ledger', ledger]);
    check('U5. an empty branch still claims the slug, because launch would refuse it', rqU5.code === 'branch-exists', rqU5.detail);

    const u6 = closedRun('u6', { log: DEFERRED_LOG });
    branchWithCommit('claude/u6');
    const rqU6 = cli(['requeue', '--task-id', u6, '--reason', 'x', '--ledger', ledger]);
    check('U6. the same refusals hold for a deferred run', rqU6.code === 'unmerged-branch', rqU6.detail);

    const u7 = closedRun('u7');
    g(repo, 'remote', 'set-url', 'origin', path.join(ROOT, 'nowhere.git'));
    const rqU7 = cli(['requeue', '--task-id', u7, '--reason', 'x', '--unreported', '--ledger', ledger]);
    g(repo, 'remote', 'set-url', 'origin', origin);
    check('U7. an unreachable origin refuses instead of guessing free', rqU7.code === 'origin-unreadable', rqU7.detail);

    // ------------------------------------------------------------ V
    const v1 = closedRun('v1', { report: 'salvaged\n\nRESULT v1 done: the ledger is committed\n' });
    const head = branchWithCommit('claude/v1', { push: true });
    g(repo, 'fetch', '-q', 'origin');
    const before = dep(v1);
    check('V1. before salvage the dependant is blocked by the failed run', before.state === 'blocked' && /failed/.test(before.reason), JSON.stringify(before));
    const sv = cli(['salvage', '--task-id', v1, '--reason', 'the branch holds the grill', '--ledger', ledger]);
    const v1r = rec(v1);
    const v1a = (v1r.attempts || []).pop() || {};
    check('V1. salvage marks it succeeded and keeps the task id, attempt and old close', sv.status === 0 && v1r.state === 'closed' && v1r.runStatus === 'succeeded' && v1r.taskId === v1
        && v1r.attemptId === 'a-v1' && v1r.salvaged.head === head && v1a.outcome === 'salvaged' && v1a.closed.verdict.decision === 'escalate' && /^SALVAGED: /.test(v1r.settleReason), sv.detail);
    const after1 = dep(v1);
    check('V2. salvage writes no verdict: the dependant waits for one', v1r.verdict === undefined && after1.state === 'pending' && /awaits a verdict/.test(after1.reason), JSON.stringify(after1));
    const judgeAccept = cli(['verdict', '--task-id', v1, '--decision', 'accept', '--reason', 'x', '--by', 'judge', '--ledger', ledger]);
    check('V3. a judge cannot accept it past the receipt gate', judgeAccept.status !== 0 && !rec(v1).verdict, judgeAccept.detail);
    const accept = cli(['verdict', '--task-id', v1, '--decision', 'accept', '--reason', 'gate rerun exit 0', '--by', 'brain', '--accept-without-receipt', 'stage gate rerun', '--ledger', ledger]);
    check('V4. after a coordinator accept the dependant is ready', accept.status === 0 && dep(v1).state === 'ready', accept.detail + JSON.stringify(dep(v1)));
    const again = cli(['salvage', '--task-id', v1, '--reason', 'again', '--ledger', ledger]);
    check('V5. a succeeded record is not salvaged again', again.code === 'bad-state', again.detail);

    const refusals = [
        ['no-commits', 'v-empty', {}, () => {}],
        ['branch-unpushed', 'v-local', { report: 'RESULT v-local done: x\n' }, () => branchWithCommit('claude/v-local')],
        ['report-missing', 'v-noreport', {}, () => branchWithCommit('claude/v-noreport', { push: true })],
        ['report-missing', 'v-stopped', { report: 'RESULT v-stopped stopped: x\n' }, () => branchWithCommit('claude/v-stopped', { push: true })],
        ['report-missing', 'v-notlast', { report: 'RESULT v-notlast done: x\nmore text\n' }, () => branchWithCommit('claude/v-notlast', { push: true })],
        ['not-salvageable', 'v-deferred', { log: DEFERRED_LOG, report: 'RESULT v-deferred done: x\n' }, () => branchWithCommit('claude/v-deferred', { push: true })],
        ['not-salvageable', 'v-exit1', { result: 'failed', report: 'RESULT v-exit1 done: x\n' }, () => branchWithCommit('claude/v-exit1', { push: true })],
    ];
    for (const [want, slug, shape, setup] of refusals) {
        const id = closedRun(slug, shape);
        setup();
        const bytes = JSON.stringify(rec(id));
        const r = cli(['salvage', '--task-id', id, '--reason', 'x', '--ledger', ledger]);
        check(`V6. salvage of ${slug} is refused with ${want}, and writes nothing`, r.code === want && unchanged(id, bytes), r.detail);
    }
    const vd = closedRun('v-diverged', { report: 'RESULT v-diverged done: x\n' });
    branchWithCommit('claude/v-diverged', { push: true });
    g(repo, 'switch', '-q', 'claude/v-diverged');
    write(path.join(repo, 'extra.md'), 'more\n');
    g(repo, 'add', 'extra.md');
    g(repo, 'commit', '-q', '-m', 'local only');
    g(repo, 'switch', '-q', 'main');
    const rd = cli(['salvage', '--task-id', vd, '--reason', 'x', '--ledger', ledger]);
    check('V7. a local head that differs from origin refuses', rd.code === 'branch-diverged', rd.detail);
    const vw = closedRun('v-dirty', { report: 'RESULT v-dirty done: x\n' });
    branchWithCommit('claude/v-dirty', { push: true });
    const wt = path.join(repo, '.claude', 'worktrees', 'v-dirty');
    g(repo, 'worktree', 'add', '-q', wt, 'claude/v-dirty');
    write(path.join(wt, 'uncommitted.md'), 'x\n');
    const rw = cli(['salvage', '--task-id', vw, '--reason', 'x', '--ledger', ledger]);
    check('V8. uncommitted work in its worktree refuses', rw.code === 'worktree-dirty', rw.detail);

    // ------------------------------------------------------------ G
    // The fake supervisor leaves a marker, so a refusal is proved before anything spawned.
    const marker = path.join(world, 'spawned.txt');
    const fakeHeadless = path.join(world, 'fake-headless.js');
    write(fakeHeadless, `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x');\nconsole.log(JSON.stringify({ ok: true, value: { supervisorPid: 4242, ledger: ${JSON.stringify(headless)}, record: { startedAt: new Date().toISOString(), version: 'test' } } }));\n`);
    const gl = path.join(world, 'gate', 'unattended.json');
    const gs = path.join(world, 'gate', 'brain-judge', 'switch.json');
    write(gl, JSON.stringify({ version: 1, records: [] }));
    const brief = path.join(world, 'brief.md');
    write(brief, '# Task\n\n## Acceptance criteria\n\n- AC1: it runs\n  check: node --version\n  expect: v\n');
    const POPULATION = 5;
    const ids = [];
    for (let i = 0; i < POPULATION; i++) {
        const q = cli(['enqueue', '--repo', repo, '--slug', `g${i}`, '--brief-file', brief, '--return', 'test', '--ledger', gl]);
        if (q.status !== 0) throw new Error(`enqueue g${i}: ${q.detail}`);
        ids.push(q.value.record.taskId);
    }
    const launch = (id, ...extra) => cli(['launch', '--task-id', id, '--dev', '--headless-worker', fakeHeadless, '--claude-bin', fakeHeadless, ...extra, '--ledger', gl]);
    const started = () => readJson(gl).records.filter((r) => r.state === 'started').length;
    const spawned = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').length : 0);

    for (const [mode, body] of [['dry', JSON.stringify({ start: 'dry' })], ['off', JSON.stringify({ start: 'off' })], ['an unreadable file', '{ not json'], ['a missing start key', JSON.stringify({ judge: 'live' })]]) {
        write(gs, body);
        const bytes = fs.readFileSync(gl, 'utf8');
        const results = ids.map((id) => launch(id));
        const refused = results.filter((r) => r.code === 'start-not-live').length;
        console.log(`     population: ${ids.length} queued, switch ${mode}: ${refused} refused, ${started()} started, ${spawned()} spawned`);
        check(`G1. plant: with ${mode} launch starts nothing across all ${ids.length} queued tasks and writes nothing`, refused === ids.length && started() === 0 && spawned() === 0 && fs.readFileSync(gl, 'utf8') === bytes, results[0].detail);
    }
    write(gs, JSON.stringify({ start: 'dry' }));
    const rd2 = cli(['ready', '--ledger', gl, '--max-per-hour', '99', '--max-concurrent', '99']);
    check('G2. ready names the switch beside what it lists', rd2.value && rd2.value.startSwitch === 'dry' && rd2.value.ready.length === POPULATION, rd2.detail);
    const dryRun = cli(['launch', '--task-id', ids[0], '--dry-run', '--dev', '--claude-bin', fakeHeadless, '--ledger', gl]);
    check('G3. --dry-run starts nothing, so the switch does not refuse it', dryRun.code !== 'start-not-live', dryRun.detail);

    const ov = launch(ids[0], '--start-override', 'operator test');
    const ovr = readJson(gl).records.find((r) => r.taskId === ids[0]);
    check('G4. --start-override starts that one task and stores the reason', ov.status === 0 && ovr.state === 'started' && ovr.startOverride.reason === 'operator test' && ovr.startOverride.switch === 'dry' && started() === 1, ov.detail);

    write(gs, JSON.stringify({ start: 'live' }));
    const live = launch(ids[1]);
    const liver = readJson(gl).records.find((r) => r.taskId === ids[1]);
    check('G5. control: with the switch live the same call starts it, with no override stored', live.status === 0 && liver.state === 'started' && liver.startOverride === undefined, live.detail);
    fs.rmSync(gs);
    const none = launch(ids[2]);
    check('G6. control: with no switch file there is nothing to obey', none.status === 0, none.detail);
    check('G7. the three starts each reached the supervisor once', spawned() === 3, String(spawned()));
} catch (e) {
    failed++;
    console.log(`FAIL crashed  ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
} finally {
    for (const c of children) { try { c.kill(); } catch { /* gone */ } }
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* a locked file on Windows; the OS temp cleaner owns it */ }
}
console.log(`requeue-salvage: ${total} checks, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
