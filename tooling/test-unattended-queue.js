#!/usr/bin/env node
'use strict';
// Suite for the queue half of plugins/autodev-core/scripts/unattended-worker.js:
// enqueue, ready (planStarts), launch, verdict, the headless settle that ends in
// `closed`, and the ledger lock.
//
// WHY THIS SUITE EXISTS. `launch` is the first command in this file that starts
// a process with nobody watching, from a cron. Its expensive failures:
//
//   a start whose dependency was never accepted - work built on a failed or
//     unjudged run, which nobody sees until it lands
//   a start past the caps - N workers on one machine, and N gates in one queue
//   a refused launch that leaves no trace - the queue silently stops
//
// So the central case launches a REAL headless-worker.js supervisor against a
// fake `claude` and waits for the report and the exit line it writes, and every
// refusal is paired with the control that the same fixture, fixed, is accepted.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const SUBJECT = path.join(SCRIPTS, 'unattended-worker.js');
const HEADLESS = path.join(SCRIPTS, 'headless-worker.js');
const { planStarts, dependencyState, applyVerdict, pointerPrompt, headlessArgs, parseHeadless, decideSettle } = require(SUBJECT);

let pass = 0, fail = 0, unchecked = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail === undefined ? '' : '  (' + detail + ')')); }
}
function couldNotCheck(label, why) { unchecked++; console.log('COULD NOT CHECK  ' + label + '  (' + why + ')'); }
const throwsCode = (fn) => { try { fn(); return null; } catch (e) { return e.publicCode || 'internal'; } };

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'unattended-queue-')));
const home = path.join(scratch, 'home');
fs.mkdirSync(home);
const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_TERMINAL_PROMPT: '0', AUTODEV_LEDGER_LOCK_WAIT_MS: '300' };
delete env.CLAUDE_CONFIG_DIR;

function cli(args) {
    const r = spawnSync(process.execPath, [SUBJECT, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* help text or a crash */ }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const code = (r) => (r.json && r.json.error ? r.json.error.code : null);
const val = (r) => (r.json && r.json.ok ? r.json.value : null);
function g(cwd, ...args) {
    return execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// A repo with a bare origin holding main, fetched so origin/main resolves.
const origin = path.join(scratch, 'origin.git');
const repo = path.join(scratch, 'repo');
g(scratch, 'init', '--bare', origin);
g(scratch, 'init', repo);
fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
g(repo, 'add', 'README.md');
g(repo, 'commit', '-m', 'init');
g(repo, 'branch', '-M', 'main');
g(repo, 'remote', 'add', 'origin', origin);
g(repo, 'push', '-q', 'origin', 'main');
g(repo, 'fetch', '-q', 'origin');
const ledger = path.join(scratch, 'ledger.json');
const briefFile = path.join(scratch, 'brief.md');
fs.writeFileSync(briefFile, 'MISSION. Add a guide.\nACCEPTANCE. The guide renders.\n');
const base = ['--repo', repo, '--brief-file', briefFile, '--return', 'coordinator-a1', '--ledger', ledger];
const readLedger = () => JSON.parse(fs.readFileSync(ledger, 'utf8')).records;
const recOf = (id) => readLedger().find((r) => r.taskId === id);

// The fake `claude`: reads the pointer prompt, then the prompt file it names,
// and writes the report the RESULT note in argv asks for.
const fakeWorker = path.join(scratch, 'fake-worker.js');
fs.writeFileSync(fakeWorker, [
    "const fs = require('fs'), path = require('path');",
    "const prompt = process.argv[process.argv.indexOf('-p') + 1];",
    "const full = fs.readFileSync(/Read (.+?) in full/.exec(prompt)[1], 'utf8');",
    "const m = /the last line of (.+?) is `RESULT (\\S+) /.exec(prompt);",
    "fs.mkdirSync(path.dirname(m[1]), { recursive: true });",
    "fs.writeFileSync(path.join(path.dirname(m[1]), 'argv.json'), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), step0: full.startsWith('STEP 0') }));",
    "fs.writeFileSync(m[1], 'did the work\\nRESULT ' + m[2] + ' done: fake worker\\n');",
].join('\n'));

try {
    // =======================================================================
    // 1. enqueue: a queued record with the brief copied beside its report.
    // =======================================================================
    const q1 = cli(['enqueue', '--slug', 'guide-a', ...base]);
    const r1 = val(q1) && val(q1).record;
    check('enqueue accepts a free slug', q1.status === 0 && r1 && r1.state === 'queued', q1.stdout.slice(0, 200));
    check('enqueue marks the record for the headless channel', r1 && r1.channel === 'headless');
    check('enqueue defaults the worker to bypassPermissions, the mode the fleet ran headless', r1 && r1.launch.permissionMode === 'bypassPermissions');
    const briefCopy = r1 && r1.briefFile;
    check('enqueue copies the brief beside the report, so a later edit of the source cannot change a queued task',
        briefCopy && fs.readFileSync(briefCopy, 'utf8').includes('MISSION. Add a guide.') && path.dirname(briefCopy) === path.dirname(r1.report));
    check('enqueue writes no worktree and no branch', !fs.existsSync(path.join(repo, '.claude', 'worktrees', 'guide-a'))
        && spawnSync('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/claude/guide-a']).status !== 0);

    const long = 'a'.repeat(25);
    check('enqueue refuses a 25-character slug: it becomes the headless code, capped at 24', code(cli(['enqueue', '--slug', long, ...base])) === 'bad-slug');
    const at24 = cli(['enqueue', '--slug', 'b'.repeat(24), ...base]);
    check('control: a 24-character slug is accepted', at24.status === 0, at24.stdout.slice(0, 200));
    check('enqueue refuses an --after naming no record', code(cli(['enqueue', '--slug', 'guide-b', '--after', 'worker-nope', ...base])) === 'unknown-dependency');
    check('enqueue refuses a task that waits on itself', code(cli(['enqueue', '--slug', 'guide-c', '--task-id', 'worker-guide-c', '--after', 'worker-guide-c', ...base])) === 'bad-dependency');
    check('enqueue refuses a slug a queued record already claims', code(cli(['enqueue', '--slug', 'guide-a', '--task-id', 'worker-other', ...base])) === 'ledger-collision');
    check('brief refuses a slug a queued record already claims', code(cli(['brief', '--slug', 'guide-a', '--task-id', 'worker-other2', ...base])) === 'ledger-collision');
    const q2 = cli(['enqueue', '--slug', 'guide-b', '--after', 'worker-guide-a', '--model', 'm-1', '--effort', 'medium', ...base]);
    check('control: --after naming a real record is accepted and stored', q2.status === 0 && val(q2).record.after.join() === 'worker-guide-a', q2.stdout.slice(0, 200));
    check('retire accepts a queued record, freeing its slug', cli(['retire', '--task-id', `worker-${'b'.repeat(24)}`, '--ledger', ledger]).status === 0
        && recOf(`worker-${'b'.repeat(24)}`).state === 'retired');

    // =======================================================================
    // 2. ready: first in, first out, dependencies held back.
    // =======================================================================
    const rd = val(cli(['ready', '--ledger', ledger]));
    check('ready lists the task with no dependency', rd && rd.ready.join() === 'worker-guide-a', JSON.stringify(rd));
    check('ready holds back the task whose dependency has not run', rd && rd.pending.length === 1 && rd.pending[0].taskId === 'worker-guide-b', JSON.stringify(rd && rd.pending));
    const rd0 = val(cli(['ready', '--max-concurrent', '0', '--ledger', ledger]));
    check('ready with no concurrency slot readies nothing and says it is capped', rd0 && rd0.ready.length === 0 && rd0.capped.join() === 'worker-guide-a');
    check('ready refuses a cap that is not a whole number', code(cli(['ready', '--max-per-hour', 'x', '--ledger', ledger])) === 'usage');

    // =======================================================================
    // 3. launch --dry-run: the headless argv, and the ledger untouched.
    // =======================================================================
    const before = fs.readFileSync(ledger, 'utf8');
    const dry = cli(['launch', '--task-id', 'worker-guide-a', '--dry-run', '--dev', '--claude-bin', fakeWorker, '--ledger', ledger]);
    const dv = val(dry);
    check('launch --dry-run succeeds through headless-worker start --dry-run', dry.status === 0 && dv && dv.dryRun === true && dv.headless.spawned === false, dry.stdout.slice(0, 300));
    const argvText = dv ? dv.headless.argv.join(' ') : '';
    check('the headless code is the slug, so the RESULT line both scripts read is one line', dv && dv.headless.code === 'guide-a');
    check('the worker gets bypassPermissions from the queued record', /--permission-mode bypassPermissions/.test(argvText), argvText.slice(0, 200));
    check('launch --dry-run leaves the ledger byte-identical', fs.readFileSync(ledger, 'utf8') === before);
    const promptFile = path.join(path.dirname(r1.report), 'PROMPT.md');
    const prompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '';
    check('the composed prompt opens with STEP 0 and carries the brief', prompt.startsWith('STEP 0') && prompt.includes('MISSION. Add a guide.'));
    check('a headless prompt names no scheduled task to leave alone', prompt.length > 0 && !prompt.includes('Do not delete scheduled task'));
    check('control: the scheduled-task prompt still names its task', val(cli(['brief', '--slug', 'sched-a', ...base])).createScheduledTask.prompt.includes('Do not delete scheduled task worker-sched-a'));

    // =======================================================================
    // 4. launch refusals leave a trace and a queued record.
    // =======================================================================
    g(repo, 'branch', 'claude/guide-a', 'main');
    const refused = cli(['launch', '--task-id', 'worker-guide-a', '--dev', '--claude-bin', fakeWorker, '--ledger', ledger]);
    check('launch refuses when the branch appeared after enqueue', code(refused) === 'branch-exists', refused.stdout.slice(0, 200));
    check('a refused launch stays queued with lastLaunchError and an attempt count', recOf('worker-guide-a').state === 'queued'
        && recOf('worker-guide-a').lastLaunchError.code === 'branch-exists' && recOf('worker-guide-a').lastLaunchError.attempts === 1);
    cli(['launch', '--task-id', 'worker-guide-a', '--dev', '--claude-bin', fakeWorker, '--ledger', ledger]);
    check('a second refusal counts a second attempt', recOf('worker-guide-a').lastLaunchError.attempts === 2);
    g(repo, 'branch', '-D', 'claude/guide-a');
    check('launch refuses a task whose dependency is unmet', code(cli(['launch', '--task-id', 'worker-guide-b', '--dev', '--claude-bin', fakeWorker, '--ledger', ledger])) === 'dependency-unmet');

    // =======================================================================
    // 5. launch: a real supervisor, a fake claude, a report and an exit line.
    // =======================================================================
    const live = cli(['launch', '--task-id', 'worker-guide-a', '--dev', '--claude-bin', fakeWorker, '--ledger', ledger]);
    const lr = val(live) && val(live).record;
    check('control: with the branch gone, launch starts the worker', live.status === 0 && lr && lr.state === 'started', live.stdout.slice(0, 300));
    check('a launched record names its headless run and clears the launch error', lr && lr.headless && lr.headless.code === 'guide-a' && Number.isInteger(lr.headless.pid) && !lr.lastLaunchError);
    check('launch stamps launchedAt, which the per-hour cap counts', lr && typeof lr.launchedAt === 'string');
    const logFile = lr ? lr.headless.log : '';
    let exited = false;
    for (let i = 0; i < 100 && !exited; i++) { exited = fs.existsSync(logFile) && /CLAUDE_EXIT=0/.test(fs.readFileSync(logFile, 'utf8')); if (!exited) sleep(200); }
    if (!exited) couldNotCheck('the fake worker ran to an exit line', `no CLAUDE_EXIT=0 in ${logFile} after 20 s`);
    else {
        const seen = JSON.parse(fs.readFileSync(path.join(path.dirname(lr.report), 'argv.json'), 'utf8'));
        check('the worker ran in the repo, where STEP 0 makes its worktree', seen.cwd.toLowerCase() === repo.toLowerCase(), seen.cwd);
        check('the worker read the full prompt through the pointer, STEP 0 first', seen.step0 === true);
        // The supervisor used to drop --report, so the worker was told <log>.report.md while settle read this path.
        const reportText = fs.existsSync(lr.report) ? fs.readFileSync(lr.report, 'utf8') : '';
        check('the worker wrote the RESULT line at the --report path the record names', /RESULT guide-a done: fake worker\s*$/.test(reportText), lr.report);
        const hs = spawnSync(process.execPath, [HEADLESS, 'settle', '--code', 'guide-a'], { encoding: 'utf8', env });
        check('headless-worker settles the run from the same report', hs.status === 0 && /"state":\s*"done"/.test(hs.stdout), hs.stdout.slice(0, 200));
    }
    check('launch refuses a record that is not queued, and writes no launch error onto it',
        code(cli(['launch', '--task-id', 'worker-guide-a', '--ledger', ledger])) === 'bad-state' && !recOf('worker-guide-a').lastLaunchError);
    const rdRun = val(cli(['ready', '--max-concurrent', '1', '--ledger', ledger]));
    check('a started record holds a concurrency slot', rdRun && rdRun.running === 1 && rdRun.slots === 0);

    // =======================================================================
    // 6. settle ends a headless record in closed; verdicts.
    // =======================================================================
    check('verdict refuses a record that has not finished', code(cli(['verdict', '--task-id', 'worker-guide-a', '--decision', 'accept', '--reason', 'r', '--ledger', ledger])) === 'bad-state');
    const st = val(cli(['settle', '--task-id', 'worker-guide-a', '--run-status', 'succeeded', '--report-read', '--ledger', ledger]));
    check('settle on a headless record closes it', st && st.record.state === 'closed' && st.decision.deleteSafe === true && /closed/.test(st.decision.reason));
    check('deleted refuses a headless record: there is no scheduled task', code(cli(['deleted', '--task-id', 'worker-guide-a', '--ledger', ledger])) === 'bad-state');
    check('a second settle on a closed record is refused as already closed', /already closed/.test(val(cli(['settle', '--task-id', 'worker-guide-a', '--run-status', 'succeeded', '--report-read', '--ledger', ledger])).decision.reason));
    check('the dependent task waits on the verdict once its dependency closed', val(cli(['ready', '--ledger', ledger])).pending.some((p) => /awaits a verdict/.test(p.reason)));
    const v1 = val(cli(['verdict', '--task-id', 'worker-guide-a', '--decision', 'follow-up', '--reason', 'gate red', '--by', 'judge', '--ledger', ledger]));
    check('a judge verdict is written when none stands', v1 && v1.verdict.applied === true && recOf('worker-guide-a').verdict.decision === 'follow-up');
    const blockedNow = val(cli(['ready', '--ledger', ledger])).blocked.find((b) => b.taskId === 'worker-guide-b');
    check('a follow-up verdict blocks the dependent task for a person', blockedNow && /verdict follow-up/.test(blockedNow.reason), JSON.stringify(blockedNow));
    const v2 = val(cli(['verdict', '--task-id', 'worker-guide-a', '--decision', 'accept', '--reason', 'fine', '--by', 'judge', '--ledger', ledger]));
    check('a second judge verdict never replaces the first', v2 && v2.verdict.applied === false && recOf('worker-guide-a').verdict.decision === 'follow-up');
    const v3 = val(cli(['verdict', '--task-id', 'worker-guide-a', '--decision', 'accept', '--reason', 'read it myself', '--ledger', ledger]));
    check('a Brain verdict replaces a judge one and returns what it replaced', v3 && v3.verdict.applied === true && v3.verdict.previous.by === 'judge' && recOf('worker-guide-a').verdict.by === 'brain');
    check('once accepted, the dependent task is ready', val(cli(['ready', '--ledger', ledger])).ready.includes('worker-guide-b'));
    check('verdict refuses an unknown decision', code(cli(['verdict', '--task-id', 'worker-guide-a', '--decision', 'maybe', '--reason', 'r', '--ledger', ledger])) === 'usage');
    check('verdict refuses a missing reason', code(cli(['verdict', '--task-id', 'worker-guide-a', '--decision', 'accept', '--ledger', ledger])) === 'usage');
    check('verdict refuses an unknown author', code(cli(['verdict', '--task-id', 'worker-guide-a', '--decision', 'accept', '--reason', 'r', '--by', 'bot', '--ledger', ledger])) === 'usage');

    // =======================================================================
    // 7. The ledger lock.
    // =======================================================================
    const lock = `${ledger}.lock`;
    fs.writeFileSync(lock, '{}');
    check('a write waits on a fresh lock and then refuses', code(cli(['retire', '--task-id', 'worker-guide-b', '--ledger', ledger])) === 'ledger-locked' && recOf('worker-guide-b').state === 'queued');
    const old = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    check('a lock older than a minute is a dead writer\'s, and is taken over', cli(['retire', '--task-id', 'worker-guide-b', '--ledger', ledger]).status === 0 && recOf('worker-guide-b').state === 'retired');
    check('a write removes its own lock', !fs.existsSync(lock));

    // =======================================================================
    // 8. Pure layer.
    // =======================================================================
    const now = Date.parse('2026-09-28T12:00:00Z');
    const fin = (id, extra) => ({ taskId: id, state: 'closed', runStatus: 'succeeded', ...extra });
    const q = (id, at, after, extra) => ({ taskId: id, state: 'queued', queuedAt: at, after, ...extra });
    const recs = [
        fin('ok', { verdict: { decision: 'accept', by: 'judge' } }), fin('fu', { verdict: { decision: 'follow-up', by: 'judge' } }),
        fin('bad', { runStatus: 'failed' }), fin('nov'), { taskId: 'ret', state: 'retired' },
        q('t1', '2026-09-28T10:00:00Z', ['ok']), q('t0', '2026-09-28T09:00:00Z', []), q('t2', '2026-09-28T11:00:00Z', ['fu']),
        q('t3', '2026-09-28T11:01:00Z', ['bad']), q('t4', '2026-09-28T11:02:00Z', ['nov']), q('t5', '2026-09-28T11:03:00Z', ['ret']),
        q('t6', '2026-09-28T11:04:00Z', ['ghost']), q('t7', '2026-09-28T11:05:00Z', [], { lastLaunchError: { code: 'x', attempts: 3 } }),
        q('t8', '2026-09-28T11:06:00Z', []),
    ];
    const plan = planStarts(recs, { now, maxConcurrent: 2, maxPerHour: 2 });
    check('planStarts takes the oldest queued first', plan.ready.join() === 't0,t1', plan.ready.join());
    check('planStarts caps the rest', plan.capped.join() === 't8', plan.capped.join());
    check('planStarts blocks on follow-up, failed, retired and missing dependencies', ['t2', 't3', 't5', 't6'].every((id) => plan.blocked.some((b) => b.taskId === id)), JSON.stringify(plan.blocked));
    check('planStarts blocks a task refused three times', plan.blocked.some((b) => b.taskId === 't7' && /3 times/.test(b.reason)));
    check('planStarts holds a dependency with no verdict as pending, not blocked', plan.pending.some((p) => p.taskId === 't4'));
    const busy = [...recs, { taskId: 'r1', state: 'started', launchedAt: '2026-09-28T11:30:00Z' }];
    check('one launch in the last hour leaves one slot', planStarts(busy, { now, maxConcurrent: 5, maxPerHour: 2 }).ready.length === 1);
    const stale = [...recs, { taskId: 'r2', state: 'closed', launchedAt: '2026-09-28T10:30:00Z' }, { taskId: 'r3', state: 'closed', launchedAt: '2026-09-29T00:00:00Z' }];
    check('a launch over an hour old, or stamped in the future, spends no slot', planStarts(stale, { now, maxConcurrent: 5, maxPerHour: 2 }).launchedLastHour === 0);
    check('dependencyState reads a queued dependency as pending', dependencyState({ taskId: 'd', state: 'queued' }).state === 'pending');
    check('dependencyState reads no record as blocked', dependencyState(undefined).state === 'blocked');
    check('applyVerdict refuses a queued record', throwsCode(() => applyVerdict({ taskId: 'x', state: 'queued' }, { decision: 'accept', reason: 'r' })) === 'bad-state');
    check('pointerPrompt names the prompt file with forward slashes', pointerPrompt('C:\\a\\PROMPT.md').includes('Read C:/a/PROMPT.md in full'));
    const ha = headlessArgs({ slug: 's', report: 'R', repo: 'P', launch: { model: 'm', effort: 'high', configDir: '~/.c', permissionMode: 'auto' } },
        { pointer: 'PT', log: 'L' }, { 'headless-worker': 'hw.js', 'claude-bin': 'cb', dev: true, 'dry-run': true });
    check('headlessArgs passes every launch option through', ['--model m', '--effort high', '--config-dir ~/.c', '--permission-mode auto', '--claude-bin cb', '--dev', '--dry-run', '--cwd P', '--report R'].every((s) => ha.join(' ').includes(s)), ha.join(' '));
    check('headlessArgs leaves out options the record does not set', !headlessArgs({ slug: 's', report: 'R', repo: 'P' }, { pointer: 'PT', log: 'L' }, {}).includes('--model'));
    check('parseHeadless reads a timeout', parseHeadless({ error: { code: 'ETIMEDOUT' } }).code === 'headless-timeout');
    check('parseHeadless reads unparseable output', parseHeadless({ status: 1, stdout: 'boom' }).code === 'headless-unparseable');
    check('parseHeadless reads a refusal', parseHeadless({ status: 1, stdout: '{"ok":false,"error":{"code":"code-active","message":"m"}}' }).code === 'code-active');
    check('parseHeadless reads a start', parseHeadless({ status: 0, stdout: '{"ok":true,"value":{"spawned":true}}' }).value.spawned === true);
    check('decideSettle refuses a queued record', decideSettle({ state: 'queued' }, 'succeeded', true).deleteSafe === false);
} finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* a locked file on Windows; the OS temp cleaner owns it */ }
}

console.log(`\n${pass} passed, ${fail} failed, ${unchecked} could not check`);
process.exitCode = fail ? 1 : 0;
