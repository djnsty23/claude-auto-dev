#!/usr/bin/env node
'use strict';
// A run that ended on the account's usage limit holds the next unattended launch.
// Every case drives the real CLIs (headless-worker.js, unattended-worker.js,
// brain-judge.js, blocker-report.js) over fixture ledgers, with a fake claude that
// drops a marker file, so "0 processes" counts what actually ran. The limit texts
// and every expected time are hand-written literals: they cannot move with the parser.
//
// THE RULE UNDER TEST, from usage-limit-hold.js: the hold lifts at the reset time the
// message states plus 2 minutes; with no readable reset, 60 minutes after the ending;
// a later ending can only extend it. Anything unparseable fails closed to 60 minutes.
//   H1  a launch during the hold starts no process, reserves nothing, adds no record,
//       on every launch path; a launch after it starts one; no hold means no delay
//   H1  a held task stays queued, counts no attempt and trips no breaker
//   H2  the lift time for each real message shape and each unreadable shape
//   H3  the hold prints in status, tick and blocker-report, and nothing prints without one
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '../plugins/autodev-core/scripts');
const HW = path.join(SCRIPTS, 'headless-worker.js');
const UW = path.join(SCRIPTS, 'unattended-worker.js');
const JUDGE = path.join(SCRIPTS, 'brain-judge.js');
const BLOCKERS = path.join(SCRIPTS, 'blocker-report.js');

let total = 0; let failed = 0;
function check(name, ok, detail = '') { total++; if (!ok) failed++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : `: ${String(detail).slice(0, 600)}`}`); }
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'limit-launch-hold-')));
const MIN = 60000;
const NO_RESET = "You've hit your usage limit";
const HOLD_LINE = /^launch hold: usage limit until \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/m;

/** One isolated home: its own config dir, ledgers, budget and markers. */
function scenario(name) {
    const home = path.join(scratch, name);
    const markers = path.join(home, 'markers');
    fs.mkdirSync(markers, { recursive: true });
    const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_TERMINAL_PROMPT: '0', AUTODEV_CAPACITY: 'off',
        AUTODEV_BUDGET_LEDGER: path.join(home, 'budget.json'), AUTODEV_GATE_LOCK_PATH: path.join(home, 'locks', 'full-gate.lock') };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.AUTODEV_HEADLESS;
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AUTODEV_ALLOW_PAID_KEY']) delete env[k];
    const autodev = path.join(home, '.claude', 'autodev');
    fs.mkdirSync(autodev, { recursive: true });
    const fake = (file, body) => { fs.writeFileSync(file, body); return file; };
    const marker = `require('fs').writeFileSync(require('path').join(${JSON.stringify(markers)}, 'run-' + process.pid), '');\n`;
    const okBin = fake(path.join(home, 'fake-ok.js'), marker
        + "const m = /the last line of (.+?) is `RESULT (\\S+) /.exec(process.argv[process.argv.indexOf('-p') + 1] || '');\n"
        + "if (m) { require('fs').mkdirSync(require('path').dirname(m[1]), { recursive: true }); require('fs').writeFileSync(m[1], 'did it\\nRESULT ' + m[2] + ' done: fake\\n'); }\n"
        + "console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'fine', usage: { input_tokens: 0, output_tokens: 0 } }));\n");
    const limitBin = fake(path.join(home, 'fake-limit.js'), marker
        + `console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, num_turns: 1, result: ${JSON.stringify(NO_RESET)}, usage: { input_tokens: 0, output_tokens: 0 } }));\nprocess.exitCode = 1;\n`);
    const promptFile = path.join(home, 'prompt.md');
    fs.writeFileSync(promptFile, 'Do the work.\n');
    const ledger = path.join(autodev, 'headless-workers.json');
    const cli = (script, args) => {
        const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let json = null;
        for (const candidate of [String(r.stdout).trim(), String(r.stdout).trim().split(/\r?\n/).pop()]) {
            try { json = JSON.parse(candidate); break; } catch { /* pretty, single-line or human output */ }
        }
        return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr), json, value: json && json.ok ? json.value : null, code: json && json.error ? json.error.code : null, message: json && json.error ? json.error.message : '' };
    };
    const start = (code, extra = [], bin = okBin) => cli(HW, ['start', '--code', code, '--prompt-file', promptFile, '--log', path.join(home, 'logs', `${code}.log`),
        '--report', path.join(home, 'reports', `${code}.md`), '--claude-bin', bin, '--ledger', ledger, '--cwd', home, '--dev', ...extra]);
    const runs = () => fs.readdirSync(markers).length;
    const records = () => { try { return JSON.parse(fs.readFileSync(ledger, 'utf8')).records; } catch { return []; } };
    const recOf = (code) => records().filter((r) => r.code === code).pop();
    const editLedger = (fn) => { const doc = JSON.parse(fs.readFileSync(ledger, 'utf8')); fn(doc.records); fs.writeFileSync(ledger, JSON.stringify(doc)); };
    const seed = (recs) => { if (!fs.existsSync(ledger)) fs.writeFileSync(ledger, JSON.stringify({ version: 1, records: [] })); editLedger((r) => r.push(...recs)); };
    const budgetRows = () => { try { return JSON.stringify(JSON.parse(fs.readFileSync(env.AUTODEV_BUDGET_LEDGER, 'utf8'))); } catch { return ''; } };
    /** The fake ran, and its supervisor wrote the exit line. A launch that never started times out here. */
    const waitExit = (code) => {
        for (let i = 0; i < 150; i++) {
            const log = path.join(home, 'logs', `${code}.log`);
            if (fs.existsSync(log) && /^CLAUDE_EXIT=/m.test(fs.readFileSync(log, 'utf8'))) return true;
            sleep(100);
        }
        return false;
    };
    return { home, env, autodev, ledger, okBin, limitBin, cli, start, runs, records, recOf, editLedger, seed, budgetRows, waitExit };
}

/** A settled run that ended on the limit, as settle writes it. */
const wall = (code, text, endedAt, configDir = null) => ({ code, startedAt: new Date(Date.parse(endedAt) - MIN).toISOString(), state: 'settled', result: 'unreported', reason: 'x', exit: 1, settledAt: endedAt,
    blocker: { status: 'usage-limit', text }, usageLimit: { text, endedAt }, report: 'none.md', configDir });

try {
    // ------------------------------------------------------------ headless-worker start
    const s = scenario('start');
    const ago = (m) => new Date(Date.now() - m * MIN).toISOString();

    const free = Date.now();
    const noHold = s.start('free-1');
    const freeMs = Date.now() - free;
    check('non-defect: with no hold a launch starts and is not delayed', noHold.status === 0 && noHold.value.spawned === true && s.waitExit('free-1') && freeMs < 30000, `${noHold.status} ${noHold.stdout} ${freeMs}ms`);
    check('non-defect: a run that ended normally sets no hold', s.cli(HW, ['status', '--ledger', s.ledger]).stdout.search(/launch hold/) === -1);

    // The limit really happens: a real supervisor over a fake claude that ends on it.
    const hit = s.start('hit-1', [], s.limitBin);
    check('fixture: the real supervisor ran a run that ended on the limit', hit.status === 0 && s.waitExit('hit-1'), hit.stdout + hit.stderr);
    const runsAtWall = s.runs();
    check('fixture: two real runs so far', runsAtWall === 2, runsAtWall);

    const budgetBefore = s.budgetRows();
    const before = s.records().length;
    const early = s.start('during-unsettled');
    sleep(1200);
    check('H1. an ended run nobody settled yet holds the next start', early.status === 1 && early.code === 'usage-limit-hold', early.stdout + early.stderr);
    check('H1. the refusal names the line and the ending', /launch hold: usage limit until /.test(early.message) && /hit-1/.test(early.message) && early.message.includes(NO_RESET), early.message);
    check('H1. a held start reserves no budget, adds no record', s.budgetRows() === budgetBefore && s.records().length === before, `${s.records().length} vs ${before}`);

    let settled = null;
    for (let i = 0; i < 50; i++) {
        settled = s.cli(HW, ['settle', '--code', 'hit-1', '--ledger', s.ledger, '--unreported']);
        if (settled.status === 0) break;
        sleep(100);
    }
    const stamped = s.recOf('hit-1');
    check('H1. settle stamps the ending and when it happened', settled.status === 0 && stamped.usageLimit && stamped.usageLimit.text === NO_RESET && Date.now() - Date.parse(stamped.usageLimit.endedAt) < 5 * MIN, JSON.stringify(stamped));

    const during = s.start('during-settled');
    sleep(1200);
    check('H1. a settled limit ending holds the next start', during.status === 1 && during.code === 'usage-limit-hold', during.stdout);
    const duringProcesses = s.runs() - runsAtWall;
    check('H1. deny: during the hold no process started', duringProcesses === 0, duringProcesses);

    const status = s.cli(HW, ['status', '--ledger', s.ledger]);
    check('H3. status prints the hold line once', HOLD_LINE.test(status.stdout) && status.stdout.match(/launch hold/g).length === 1, status.stdout.slice(0, 400));
    const statusJson = s.cli(HW, ['status', '--ledger', s.ledger, '--json']);
    check('H3. status --json carries the hold', statusJson.value && statusJson.value.launchHolds.length === 1 && statusJson.value.launchHolds[0].code === 'hit-1', statusJson.stdout.slice(0, 300));

    // The 60 minute rule, from both sides, by moving the ending and nothing else.
    s.editLedger((r) => { r.find((x) => x.code === 'hit-1').usageLimit.endedAt = ago(58); });
    check('H2. with no readable reset, 58 minutes after the ending still holds', s.start('during-58').code === 'usage-limit-hold');
    check('H2. held 58 minutes on: still no process', s.runs() === runsAtWall, s.runs());
    s.editLedger((r) => { r.find((x) => x.code === 'hit-1').usageLimit.endedAt = ago(61); });
    const after = s.start('after-61');
    check('H1. deny: 61 minutes after the ending a launch starts', after.status === 0 && after.value.spawned === true && s.waitExit('after-61'), after.stdout + after.stderr);
    const afterProcesses = s.runs() - runsAtWall;
    check('H1. deny: after the hold exactly one process started', afterProcesses === 1, afterProcesses);
    console.log(`hold-deny: during hold ${duringProcesses} processes, after hold ${afterProcesses} process`);
    check('H3. no hold prints nothing in status', !/launch hold/.test(s.cli(HW, ['status', '--ledger', s.ledger]).stdout));

    // A stated reset outranks the 60 minutes, in both directions.
    const zoneTime = (at) => { const d = new Date(at); const h = d.getUTCHours(); return `${(h % 12) || 12}:${String(d.getUTCMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`; };
    const resetIn = (m) => `You've hit your session limit · resets ${zoneTime(Date.now() + m * MIN)} (UTC)`;
    s.editLedger((r) => { r.push(wall('late-reset', resetIn(90), ago(61))); });
    check('H2. a reset 90 minutes away still holds 61 minutes after the ending', s.start('during-reset').code === 'usage-limit-hold');
    s.editLedger((r) => { const x = r.find((c) => c.code === 'late-reset'); x.usageLimit.text = x.blocker.text = resetIn(-3); x.usageLimit.endedAt = ago(5); });
    const soon = s.start('after-reset');
    check('H2. a reset 3 minutes ago lifts the hold 5 minutes after the ending, well inside 60', soon.status === 0 && s.waitExit('after-reset'), soon.stdout + soon.stderr);

    const over = scenario('override');
    over.seed([wall('w', NO_RESET, new Date().toISOString())]);
    const forced = over.start('forced', ['--hold-override', 'bought more usage']);
    check('H1. --hold-override starts this one run and records why', forced.status === 0 && over.waitExit('forced') && over.recOf('forced').holdOverride.reason === 'bought more usage', forced.stdout);

    // Controls: the shapes that are not a limit ending.
    const ctl = scenario('controls');
    const logFile = (name, text) => { const f = path.join(ctl.home, `${name}.log`); fs.writeFileSync(f, text); return f; };
    const ev = (text, isError) => JSON.stringify({ type: 'result', is_error: isError, result: text });
    const unsettled = (code, log) => ({ code, startedAt: ago(5), state: 'running', pid: 1, log, report: 'r.md' });
    ctl.seed([
        unsettled('quoted', logFile('quoted', `${ev("You've hit your weekly limit, the brief says.", false)}\nCLAUDE_EXIT=0\n`)),
        unsettled('recovered', logFile('recovered', `${ev(NO_RESET, true)}\n${ev('Recovered.', false)}\nCLAUDE_EXIT=0\n`)),
        unsettled('no-exit', logFile('no-exit', `${ev(NO_RESET, true)}\n`)),
        unsettled('unreadable', path.join(ctl.home, 'absent.log')),
        { code: 'plain', startedAt: ago(5), state: 'settled', result: 'unreported', reason: 'exited 1', exit: 1, settledAt: ago(4), blocker: { status: 'unknown' }, report: 'r.md' },
    ]);
    const ctlStart = ctl.start('control-1');
    check('non-defect: a quoted limit, a recovered limit, a run still going, an unreadable log and a plain failure set no hold', ctlStart.status === 0 && ctl.waitExit('control-1'), ctlStart.stdout + ctlStart.stderr);

    // One config dir is one login.
    const cfg = scenario('config');
    const acct = path.join(cfg.home, 'acct-b');
    fs.mkdirSync(acct);
    cfg.seed([wall('w', NO_RESET, new Date().toISOString(), 'acct-b')]);
    const other = cfg.start('default-login');
    check('H1. a limit on another login does not hold this one', other.status === 0 && cfg.waitExit('default-login'), other.stdout);
    const same = cfg.start('same-login', ['--config-dir', acct]);
    check('H1. a limit on this login holds it', same.code === 'usage-limit-hold', same.stdout);
    const heldLine = cfg.cli(HW, ['status', '--ledger', cfg.ledger]).stdout;
    check('H3. a hold on a named login says which', /launch hold: usage limit until \S+ \(config dir acct-b\)/.test(heldLine), heldLine.slice(0, 300));

    // ------------------------------------------------------------ the unattended ledger
    const g = (cwd, env, ...args) => execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const origin = path.join(scratch, 'origin.git');
    const repo = path.join(scratch, 'repo');
    g(scratch, process.env, 'init', '--bare', origin);
    g(scratch, process.env, 'init', repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
    g(repo, process.env, 'add', 'README.md');
    g(repo, process.env, 'commit', '-m', 'init');
    g(repo, process.env, 'branch', '-M', 'main');
    g(repo, process.env, 'remote', 'add', 'origin', origin);
    g(repo, process.env, 'push', '-q', 'origin', 'main');
    g(repo, process.env, 'fetch', '-q', 'origin');
    const briefFile = path.join(scratch, 'brief.md');
    fs.writeFileSync(briefFile, 'MISSION. Add a guide.\n## Acceptance criteria\n- AC1: the readme is tracked\n  check: git ls-files --error-unmatch README.md\nLAST ASK. Open a pull request.\n');

    const u = scenario('launch');
    const uwLedger = path.join(u.autodev, 'unattended-workers.json');
    const uwRec = (id) => JSON.parse(fs.readFileSync(uwLedger, 'utf8')).records.find((r) => r.taskId === id);
    const q = u.cli(UW, ['enqueue', '--repo', repo, '--slug', 'launch-a', '--brief-file', briefFile, '--return', 'brain', '--ledger', uwLedger]);
    check('fixture: enqueue', q.status === 0, q.stdout + q.stderr);
    u.seed([wall('w', NO_RESET, ago(1))]);
    const launchArgs = ['launch', '--task-id', 'worker-launch-a', '--ledger', uwLedger, '--claude-bin', u.okBin, '--dev'];
    const refusals = [1, 2, 3, 4].map(() => u.cli(UW, launchArgs));
    sleep(1200);
    check('H1. unattended launch during the hold exits 1 with the hold code', refusals.every((r) => r.status === 1 && r.code === 'usage-limit-hold'), refusals[0].stdout);
    check('H1. four refused launches started no process', u.runs() === 0, u.runs());
    const heldRec = uwRec('worker-launch-a');
    check('H1. a held task is left queued', heldRec.state === 'queued', heldRec.state);
    check('H1. a held launch counts no attempt, four times over', heldRec.lastLaunchError.attempts === 0 && heldRec.lastLaunchError.transient === true, JSON.stringify(heldRec.lastLaunchError));
    u.editLedger((r) => { r[0].usageLimit.endedAt = ago(61); });
    const uAfter = u.cli(UW, launchArgs);
    check('H1. the same task launches after the hold, one process', uAfter.status === 0 && uAfter.value.record.state === 'started' && waitLog(uAfter.value.record.headless.log) && u.runs() === 1, uAfter.stdout + uAfter.stderr);

    // ------------------------------------------------------------ the unattended tick
    const t = scenario('tick');
    const tLedger = path.join(t.autodev, 'unattended-workers.json');
    const tRec = (id) => JSON.parse(fs.readFileSync(tLedger, 'utf8')).records.find((r) => r.taskId === id);
    const clockDir = path.join(t.autodev, 'brain-clock');
    fs.mkdirSync(clockDir, { recursive: true });
    fs.writeFileSync(path.join(clockDir, 'passes.jsonl'), ['ok', 'ok', 'ok'].map((x) => JSON.stringify({ status: x, at: new Date().toISOString() })).join('\n') + '\n');
    const judgeSeen = path.join(t.home, 'judge-ran');
    const fakeJudge = path.join(t.home, 'fake-judge.js');
    fs.writeFileSync(fakeJudge, `let i=''; process.stdin.on('data',(d)=>{i+=d}).on('end',()=>{ require('fs').writeFileSync(${JSON.stringify(judgeSeen)}, 'ran');
process.stdout.write(JSON.stringify({ type:'result', is_error:false, num_turns:1, total_cost_usd:0.01, structured_output:{ decision:'follow-up', reason:'fake', evidence:['e1'] } })); });\n`);
    const tick = (extra = []) => t.cli(JUDGE, ['tick', '--live', '--dev', '--worker-bin', t.okBin, '--judge-bin', fakeJudge, ...extra]);
    const startsRows = () => { try { return fs.readFileSync(path.join(t.autodev, 'brain-judge', 'starts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    const enqueue = (slug) => t.cli(UW, ['enqueue', '--repo', repo, '--slug', slug, '--brief-file', briefFile, '--return', 'brain', '--ledger', tLedger]);
    enqueue('tick-a');
    t.cli(JUDGE, ['switch', '--judge', 'live', '--start', 'live']);
    const t0 = tick();
    const startedA = tRec('worker-tick-a');
    check('fixture: the tick started the first task', t0.status === 0 && startedA.state === 'started', t0.stdout + t0.stderr);
    check('fixture: its fake worker finished', waitLog(startedA.headless.log), startedA.headless.log);
    let settledA = null;
    for (let i = 0; i < 50; i++) {
        settledA = t.cli(HW, ['settle', '--code', 'tick-a', '--ledger', t.ledger]);
        if (settledA.status === 0) break;
        sleep(100);
    }
    check('fixture: its run settled done', settledA.status === 0 && t.recOf('tick-a').result === 'done', settledA.stdout + settledA.stderr);

    t.seed([wall('w', NO_RESET, ago(1))]);
    enqueue('tick-b');
    const heldTicks = [tick(), tick()];
    sleep(1200);
    const heldLines = heldTicks[0].value ? heldTicks[0].value.lines : [];
    check('H3. tick prints the hold line for start', heldLines.some((l) => /^start \(live\): held, nothing starts: launch hold: usage limit until \S+$/.test(l)), heldLines.join(' | ') + heldTicks[0].stderr);
    check('H1. tick holds its judge too: the finished run is not judged', heldLines.some((l) => /^judge \(live\): held: launch hold: usage limit until /.test(l)) && !fs.existsSync(judgeSeen), heldLines.join(' | '));
    check('H1. the tick started no process during the hold', t.runs() === 1, t.runs());
    const tb = tRec('worker-tick-b');
    check('H1. a tick-held task stays queued with no launch error', tb.state === 'queued' && !tb.lastLaunchError, JSON.stringify(tb));
    check('H1. a tick-held task is no failed launch', startsRows().every((r) => r.ok !== false && r.taskId !== 'worker-tick-b') && heldTicks.every((x) => !(x.value.events || []).some((e) => e.type === 'judge.launch-refused')), JSON.stringify(startsRows()));
    check('H1. two held ticks open no breaker', heldTicks.every((x) => x.value.lines.every((l) => !/BREAKER/.test(l))), heldTicks[1].stdout.slice(0, 400));

    t.editLedger((r) => { r.find((x) => x.code === 'w').usageLimit.endedAt = ago(61); });
    const tAfter = tick();
    check('H1. after the hold the tick judges again', fs.existsSync(judgeSeen), tAfter.value && tAfter.value.lines.join(' | '));
    check('H1. after the hold the tick starts the queued task, one more process', tRec('worker-tick-b').state === 'started' && waitLog(tRec('worker-tick-b').headless.log) && t.runs() === 2, `${tRec('worker-tick-b').state} ${t.runs()}`);
    check('H3. tick prints no hold once it lifted', !tAfter.value.lines.some((l) => /launch hold/.test(l)), tAfter.value.lines.join(' | '));

    // The race: the plan read no hold, and a run met the limit before the launch reached headless-worker.
    // Its own home, because the per-hour start cap would stop a third launch before it got this far.
    const race = scenario('race');
    const raceLedger = path.join(race.autodev, 'unattended-workers.json');
    const raceClock = path.join(race.autodev, 'brain-clock');
    fs.mkdirSync(raceClock, { recursive: true });
    fs.writeFileSync(path.join(raceClock, 'passes.jsonl'), ['ok', 'ok', 'ok'].map((x) => JSON.stringify({ status: x, at: new Date().toISOString() })).join('\n') + '\n');
    const racing = path.join(race.home, 'racing-hw.js');
    fs.writeFileSync(racing, "console.log(JSON.stringify({ ok: false, error: { code: 'usage-limit-hold', message: 'launch hold: usage limit until 2099-01-01T00:00:00.000Z' } }));\nprocess.exitCode = 1;\n");
    race.cli(UW, ['enqueue', '--repo', repo, '--slug', 'race-a', '--brief-file', briefFile, '--return', 'brain', '--ledger', raceLedger]);
    race.cli(JUDGE, ['switch', '--judge', 'live', '--start', 'live']);
    const raced = race.cli(JUDGE, ['tick', '--live', '--dev', '--worker-bin', race.okBin, '--headless-worker', racing]);
    const raceLines = raced.value ? raced.value.lines : [];
    const tc = JSON.parse(fs.readFileSync(raceLedger, 'utf8')).records.find((r) => r.taskId === 'worker-race-a');
    let raceStarts = '';
    try { raceStarts = fs.readFileSync(path.join(race.autodev, 'brain-judge', 'starts.jsonl'), 'utf8'); } catch { /* no launch was logged, which is the expected case */ }
    check('H1. the race reached the launch and printed the hold', raceLines.some((l) => /^start \(live\): worker-race-a held: /.test(l)), raceLines.join(' | ') + raced.stderr);
    check('H1. a hold that appears after the plan is no failed launch', tc.state === 'queued' && raceStarts === '' && !(raced.value.events || []).some((e) => e.type === 'judge.launch-refused'), `${tc.state} ${raceStarts}`);
    check('H1. that race counts no attempt', tc.lastLaunchError && tc.lastLaunchError.attempts === 0 && tc.lastLaunchError.transient === true, JSON.stringify(tc.lastLaunchError));
    check('H1. that race started no process', race.runs() === 0, race.runs());

    // ------------------------------------------------------------ the lift time, every shape, one CLI run
    const b = scenario('table');
    const SESSION_530 = "You've hit your session limit · resets 5:30am (Europe/Bucharest)";
    const WEEKLY_NOV = "You've hit your weekly limit · resets Nov 11, 1am (Europe/Bucharest)";
    const WEEKLY_8PM = "You've hit your weekly limit · resets 8pm (Europe/Bucharest)";
    const SESSION_520 = "You've hit your session limit · resets 5:20pm (Europe/Bucharest)";
    const WEEKLY = "You've hit your weekly limit";
    const TABLE = [
        ['same-day', SESSION_530, '2026-11-10T02:00:00.000Z', '2026-11-10T03:32:00.000Z'],
        ['next-day', SESSION_530, '2026-11-10T04:00:00.000Z', '2026-11-11T03:32:00.000Z'],
        ['dated', WEEKLY_NOV, '2026-11-09T00:07:07.000Z', '2026-11-10T23:02:00.000Z'],
        ['summer-offset', WEEKLY_8PM, '2026-09-23T20:49:11.000Z', '2026-09-24T17:02:00.000Z'],
        ['minutes-pm', SESSION_520, '2026-10-08T12:26:04.000Z', '2026-10-08T14:22:00.000Z'],
        ['noon', `${WEEKLY} · resets 12pm (UTC)`, '2026-06-01T08:00:00.000Z', '2026-06-01T12:02:00.000Z'],
        ['midnight', `${WEEKLY} · resets 12am (UTC)`, '2026-06-01T08:00:00.000Z', '2026-06-02T00:02:00.000Z'],
        ['year-roll', `${WEEKLY} · resets Jan 2, 1am (UTC)`, '2026-12-31T12:00:00.000Z', '2027-01-02T01:02:00.000Z'],
        ['repeated-hour-takes-later', "You've hit your session limit · resets 3:30am (Europe/Bucharest)", '2026-10-24T22:00:00.000Z', '2026-10-25T01:32:00.000Z'],
        ['no-reset', NO_RESET, '2026-11-10T02:00:00.000Z', '2026-11-10T03:00:00.000Z'],
        ['unknown-zone', `${WEEKLY} · resets 5:30am (Mars/Base)`, '2026-11-10T02:00:00.000Z', '2026-11-10T03:00:00.000Z'],
        ['no-zone', `${WEEKLY} · resets 5:30am`, '2026-11-10T02:00:00.000Z', '2026-11-10T03:00:00.000Z'],
        ['words', `${WEEKLY} · resets soon (UTC)`, '2026-11-10T02:00:00.000Z', '2026-11-10T03:00:00.000Z'],
        ['hour-13', `${WEEKLY} · resets 13pm (UTC)`, '2026-11-10T02:00:00.000Z', '2026-11-10T03:00:00.000Z'],
        ['minute-61', `${WEEKLY} · resets 5:61am (UTC)`, '2026-11-10T02:00:00.000Z', '2026-11-10T03:00:00.000Z'],
        ['no-such-date', `${WEEKLY} · resets Feb 30, 1am (UTC)`, '2026-02-10T02:00:00.000Z', '2026-02-10T03:00:00.000Z'],
        ['no-such-month', `${WEEKLY} · resets Foo 3, 1am (UTC)`, '2026-11-10T02:00:00.000Z', '2026-11-10T03:00:00.000Z'],
        ['skipped-hour', "You've hit your session limit · resets 3:30am (Europe/Bucharest)", '2027-03-28T00:00:00.000Z', '2027-03-28T01:00:00.000Z'],
        ['date-past', `${WEEKLY} · resets Nov 1, 1am (UTC)`, '2026-11-10T02:00:00.000Z', '2026-11-10T03:00:00.000Z'],
        ['date-too-far', `${WEEKLY} · resets Dec 25, 1am (UTC)`, '2026-11-10T02:00:00.000Z', '2026-11-10T03:00:00.000Z'],
    ];
    const recs = TABLE.map(([id, text, ended]) => wall(`t-${id}`, text, ended, id));
    // A later ending extends, and an earlier lift never shortens.
    recs.push(wall('e1', SESSION_530, '2026-11-10T03:00:00.000Z', 'extends'), wall('e2', NO_RESET, '2026-11-10T03:10:00.000Z', 'extends'));
    recs.push(wall('s1', WEEKLY_NOV, '2026-11-09T00:07:07.000Z', 'no-shorten'), wall('s2', NO_RESET, '2026-11-09T01:00:00.000Z', 'no-shorten'));
    // Written by a settle that had no usageLimit stamp: the blocker and settle time are all there is.
    recs.push({ code: 'old', startedAt: '2026-11-10T01:00:00.000Z', state: 'settled', result: 'unreported', exit: 1, settledAt: '2026-11-10T02:00:00.000Z', blocker: { status: 'usage-limit', text: SESSION_530 }, report: 'r.md', configDir: 'legacy' });
    b.seed(recs);
    fs.writeFileSync(path.join(b.autodev, 'unattended-workers.json'), JSON.stringify({ version: 1, records: [] }));
    const rr = b.cli(BLOCKERS, ['--base', b.autodev, '--now', '2026-01-15T00:00:00Z', '--no-write']);
    const printed = new Map([...rr.stdout.matchAll(/^launch hold: usage limit until (\S+) \(config dir (\S+)\)$/gm)].map((m) => [m[2], m[1]]));
    check('H2. the table is the population: every case printed a hold', rr.status === 0 && printed.size === TABLE.length + 3, `${printed.size} of ${TABLE.length + 3}: ${rr.stdout.slice(0, 400)} ${rr.stderr}`);
    for (const [id, text, , until] of TABLE) check(`H2. ${id}: ${text.replace(/^.*limit/, 'limit')}`, printed.get(id) === until, `got ${printed.get(id)}, want ${until}`);
    check('H2. a later run on the limit extends the hold', printed.get('extends') === '2026-11-10T04:10:00.000Z', printed.get('extends'));
    check('H2. a later run with an earlier lift does not shorten it', printed.get('no-shorten') === '2026-11-10T23:02:00.000Z', printed.get('no-shorten'));
    check('H2. a record with no ending stamp counts from its settle time', printed.get('legacy') === '2026-11-10T03:32:00.000Z', printed.get('legacy'));

    const rOff = b.cli(BLOCKERS, ['--base', b.autodev, '--now', '2028-01-01T00:00:00Z', '--no-write', '--print']);
    check('H3. blocker-report prints nothing once every hold has lifted', rOff.status === 0 && !/launch hold/.test(rOff.stdout) && /blockers:/.test(rOff.stdout), rOff.stdout.slice(0, 300) + rOff.stderr);
    const rWrite = b.cli(BLOCKERS, ['--base', b.autodev, '--now', '2026-11-10T03:00:00Z']);
    const latest = JSON.parse(fs.readFileSync(path.join(b.autodev, 'blockers', 'latest.json'), 'utf8'));
    check('H3. blocker-report writes the live holds beside the ranking', rWrite.status === 0 && Array.isArray(latest.launchHolds) && latest.launchHolds.some((h) => h.configDir === 'extends'), JSON.stringify(latest.launchHolds || null).slice(0, 300));
} finally {
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a supervisor still releasing a handle: the OS temp dir clears it */ }
}

/** The fake ran, and its supervisor wrote the exit line. */
function waitLog(log) {
    for (let i = 0; i < 150; i++) {
        if (fs.existsSync(log) && /^CLAUDE_EXIT=/m.test(fs.readFileSync(log, 'utf8'))) return true;
        sleep(100);
    }
    return false;
}

console.log(`limit-launch-hold: ${total} checks, ${failed} failed`);
process.exitCode = failed || total < 60 ? 1 : 0;
