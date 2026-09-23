#!/usr/bin/env node
'use strict';
// Tests for plugins/autodev-core/scripts/headless-worker.js, the dispatcher of
// a `claude -p` worker that outlives its caller.
// Run: node tooling/test-headless-worker.js
// Exit 0 all green, 1 on a red assertion, 2 when a child produced no verdict.
//
// EVERY CASE IS A SUBPROCESS RUN OF THE REAL SCRIPT, driven through
// spawn-budget's runBudgeted so a timeout is INDETERMINATE and never a red
// claim about the script. The script itself is required once, for its exported
// constants, and that load runs nothing.
//
// THE FAKE BINARY. `--claude-bin` names a `.js` file, which the script runs
// through process.execPath (its header states the convention). The fake prints
// one line to stdout and one to stderr, dumps its sorted env KEYS, its argv,
// optionally writes a report file, and exits with the code in FAKE_EXIT. It
// carries a hard self-exit timer so a defect can never leave a worker alive.
//
// THE POLL HAS THREE ENDINGS, NOT TWO. A `start` returns before the worker
// runs, so the suite polls the log. It stops on the CLAUDE_EXIT line (the
// answer), OR when the supervisor pid is dead with no such line (a verdict:
// the supervisor exited without writing it, which is exactly what planted
// defect PD1 does), OR at the budget with the supervisor still alive
// (INDETERMINATE: the machine did not finish, the code is not on trial). The
// second ending is what lets PD1 go RED rather than time out; the third is
// what keeps a slow box from being reported as a bug.
//
// EVERY SUPERVISOR PID IS KILLED BY PID in the finally block, never by
// pattern: a pattern kill matches every peer's run of the same command line.
// Pids come from what `start` printed AND from a scan of every log under
// ROOT (the fake prints its parent pid), so a supervisor spawned behind a
// refusal, which start never prints, is still tracked and the cleanup count
// is right.
//
// Every temp root has a SPACE in its name and every file is utf8 with \n.

const { classify, reason, runBudgeted, tally, exitCode } = require('./spawn-budget.js');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'headless-worker.js');
const { HEADLESS_NOTE, PROMPT_MAX } = require(SCRIPT);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hw test-'));
const HOME = path.join(ROOT, 'home');
const FAKE = path.join(ROOT, 'fake claude.js');
const PROMPT = path.join(ROOT, 'prompt.md');
const DEFAULT_LEDGER = path.join(HOME, '.claude', 'autodev', 'headless-workers.json');
const POLL_MS = 20000;

const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text.replace(/\r\n/g, '\n'), 'utf8');
};
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

fs.mkdirSync(HOME, { recursive: true });
write(PROMPT, 'Read the brief in brief.md and do what it says.\n');
write(FAKE, [
    "'use strict';",
    'setTimeout(() => process.exit(98), 15000);',
    "const fs = require('fs');",
    "process.stdout.write('FAKE-STDOUT-LINE\\n');",
    "process.stderr.write('FAKE-STDERR-LINE\\n');",
    "process.stdout.write('ENVKEYS=' + JSON.stringify(Object.keys(process.env).sort()) + '\\n');",
    "process.stdout.write('ARGV=' + JSON.stringify(process.argv.slice(2)) + '\\n');",
    "process.stdout.write('PPID=' + process.ppid + '\\n');",
    "if (process.env.FAKE_REPORT) fs.writeFileSync(process.env.FAKE_REPORT, process.env.FAKE_REPORT_TEXT || '', 'utf8');",
    'process.exit(Number(process.env.FAKE_EXIT || 0));',
].join('\n') + '\n');

let pass = 0;
let fail = 0;
let infra = 0;
const failures = [];
const indeterminate = [];
const supervisors = [];

function check(label, ok, detail) {
    if (ok) pass++;
    else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

function indeterminateCase(label, why) {
    infra++;
    indeterminate.push(`${label} (${why})`);
    console.error(`infrastructure: ${label} produced no verdict (${why})`);
}

/**
 * The script as a subprocess. HOME is pinned under ROOT so the default ledger is never the real one.
 * `start` gets --dev, because the suite runs the checkout on purpose. Case 26 drives the refusal
 * without it, and an installed copy through `script`.
 */
function hw(args, env = {}, { dev = true, script = SCRIPT } = {}) {
    const argv = args[0] === 'start' && dev ? [...args, '--dev'] : args;
    const r = runBudgeted(process.execPath, [script, ...argv], {
        encoding: 'utf8',
        cwd: ROOT,
        env: { ...process.env, HOME, USERPROFILE: HOME, ...env },
        timeout: 20000,
        maxTimeout: 300000,
    });
    if (classify(r) === 'infrastructure') indeterminateCase('hw ' + args.slice(0, 2).join(' '), reason(r));
    let json = null;
    try { json = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { /* not every subcommand prints JSON */ }
    return { exit: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json, verdict: classify(r) === 'verdict' };
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

/** Start a worker through the fake and remember its supervisor for cleanup. */
function startFake(code, { exit = 0, report = null, reportText = '', extraArgs = [], env = {} } = {}) {
    const log = path.join(ROOT, code, 'worker.log');
    const ledger = path.join(ROOT, code, 'ledger.json');
    const res = hw(['start', '--code', code, '--prompt-file', PROMPT, '--log', log, '--claude-bin', FAKE, '--ledger', ledger, ...extraArgs], {
        FAKE_EXIT: String(exit), ...(report ? { FAKE_REPORT: report, FAKE_REPORT_TEXT: reportText } : {}), ...env,
    });
    const pid = res.json && res.json.ok ? res.json.value.supervisorPid : null;
    if (pid) supervisors.push(pid);
    return { res, log, ledger, pid, report: report || log.replace(/\.log$/, '.report.md') };
}

/**
 * Wait for the run to END. Returns { ending, text } where ending is
 * 'exit-line' | 'supervisor-dead' | 'timeout'. Only the third is not a verdict.
 */
function waitForEnd(log, pid) {
    const deadline = Date.now() + POLL_MS;
    for (;;) {
        let text = read(log);
        if (text !== null && /^CLAUDE_EXIT=-?\d+\s*$/m.test(text)) return { ending: 'exit-line', text };
        if (!pidAlive(pid)) {
            sleep(200);
            text = read(log);
            if (text !== null && /^CLAUDE_EXIT=-?\d+\s*$/m.test(text)) return { ending: 'exit-line', text };
            return { ending: 'supervisor-dead', text: text === null ? '' : text };
        }
        if (Date.now() > deadline) return { ending: 'timeout', text: text === null ? '' : text };
        sleep(100);
    }
}

/** Run a fake to completion; a timeout is INDETERMINATE and ends the case with null. */
function completeFake(label, code, opts) {
    const started = startFake(code, opts);
    if (!started.pid) {
        check(`${label}: start returned a supervisor pid`, false, started.res.stdout.slice(0, 200));
        return null;
    }
    const end = waitForEnd(started.log, started.pid);
    if (end.ending === 'timeout') {
        indeterminateCase(`${label}: the worker did not end within ${POLL_MS} ms`, 'supervisor still alive at the budget');
        return null;
    }
    return { ...started, ...end };
}

/**
 * Poll for `ms` and report whether the log ever appeared. A refused start
 * must spawn nothing, and the supervisor opens its log within its first
 * few hundred milliseconds, so a log that shows up during the poll is a
 * worker running behind a refusal.
 */
function logStaysAbsent(log, ms) {
    const deadline = Date.now() + ms;
    const t0 = Date.now();
    for (;;) {
        if (fs.existsSync(log)) return { absent: false, afterMs: Date.now() - t0 };
        if (Date.now() > deadline) return { absent: true, afterMs: null };
        sleep(100);
    }
}

/**
 * Every supervisor pid the logs under ROOT name, tracked unconditionally: the
 * fake prints its parent pid, which is the supervisor, so a supervisor that a
 * refused start spawned anyway is found here and killed in the finally block
 * even though start never printed it.
 */
function trackSupervisorsFromLogs(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { trackSupervisorsFromLogs(full); continue; }
        if (!/\.log$/.test(e.name)) continue;
        const m = (read(full) || '').match(/^PPID=(\d+)$/m);
        if (m && !supervisors.includes(Number(m[1]))) supervisors.push(Number(m[1]));
    }
}

const lastExitLine = (text) => { const m = String(text).match(/CLAUDE_EXIT=(-?\d+)\s*$/); return m ? Number(m[1]) : null; };
const envKeysOf = (text) => { const m = String(text).match(/^ENVKEYS=(\[.*\])$/m); return m ? JSON.parse(m[1]) : null; };

function synthRun(code, { logText, reportText, pid = 1 }) {
    const dir = path.join(ROOT, 'synth ' + code + ' ' + Math.random().toString(36).slice(2, 8));
    const log = path.join(dir, 'w.log');
    const report = path.join(dir, 'w.report.md');
    const ledger = path.join(dir, 'ledger.json');
    if (logText !== null && logText !== undefined) write(log, logText);
    if (reportText !== null && reportText !== undefined) write(report, reportText);
    write(ledger, JSON.stringify({ version: 1, records: [{ code, pid, startedAt: '2026-01-01T00:00:00.000Z', log, report, promptFile: PROMPT, configDir: null, model: null, permissionMode: 'default', state: 'running' }] }, null, 2) + '\n');
    return { ledger, log, report };
}

try {
    // 18. The whole cycle sits under a directory whose name carries a space.
    check('18. the temp root carries a space, so every path below exercises quoting', /\s/.test(ROOT) && FAKE.includes(' '), ROOT);

    // 1. --help: instant, no side effect.
    {
        const t0 = Date.now();
        const res = hw(['--help']);
        const ms = Date.now() - t0;
        check('1. --help exits 0 within 2 s and prints usage', res.exit === 0 && ms < 2000 && /Usage: node headless-worker\.js start/.test(res.stdout), `exit ${res.exit}, ${ms} ms`);
        const bare = hw([]);
        check('1. no subcommand prints usage and exits 0', bare.exit === 0 && /Usage:/.test(bare.stdout), `exit ${bare.exit}`);
        check('1. afterwards the default ledger path does not exist', !fs.existsSync(DEFAULT_LEDGER) && !fs.existsSync(path.dirname(DEFAULT_LEDGER)), DEFAULT_LEDGER);
        check('1. and the temp root holds only the fixtures', fs.readdirSync(ROOT).sort().join(',') === ['fake claude.js', 'home', 'prompt.md'].join(','), fs.readdirSync(ROOT).join(','));
    }

    // 2 and 3. start --dry-run.
    {
        const dir = path.join(ROOT, 'dry run');
        const log = path.join(dir, 'w.log');
        const ledger = path.join(dir, 'ledger.json');
        const res = hw(['start', '--code', 'DRY', '--prompt-file', PROMPT, '--log', log, '--claude-bin', FAKE, '--ledger', ledger, '--dry-run', '--model', 'a-model-id'],
            { CANARY_VALUE_FOR_THE_SUITE: 'canary-value-must-not-print', CLAUDECODE: '1' });
        const v = res.json && res.json.ok ? res.json.value : null;
        const argv = v ? v.argv : [];
        const promptArg = argv[argv.indexOf('-p') + 1] || '';
        check('2. dry-run exits 0 with ok:true', res.exit === 0 && !!v, res.stdout.slice(0, 200));
        check('2. argv carries -p, the prompt text, --permission-mode, --output-format stream-json and --verbose',
            argv.includes('-p') && promptArg.includes('Read the brief in brief.md')
            && argv[argv.indexOf('--permission-mode') + 1] === 'default'
            && argv[argv.indexOf('--output-format') + 1] === 'stream-json' && argv.includes('--verbose'),
            JSON.stringify(argv).slice(0, 200));
        check('2. --model given puts --model <id> in argv', argv[argv.indexOf('--model') + 1] === 'a-model-id');
        check('2. env KEYS name AUTODEV_HEADLESS and AUTODEV_WORKER_CODE, and CLAUDECODE is on the deleted list',
            !!v && v.envSet.includes('AUTODEV_HEADLESS') && v.envSet.includes('AUTODEV_WORKER_CODE') && v.envDeleted.includes('CLAUDECODE'),
            v ? JSON.stringify([v.envSet, v.envDeleted]) : '');
        check('2. no env VALUE reaches the output', !res.stdout.includes('canary-value-must-not-print'));
        check('2. afterwards no log, no ledger, no report and no directory exist', !fs.existsSync(dir) && !fs.existsSync(ledger) && !fs.existsSync(DEFAULT_LEDGER), dir);
        check('3. the HEADLESS_NOTE sentence is appended to the prompt argument',
            promptArg.endsWith(HEADLESS_NOTE + '\n') && /FOREGROUND/.test(HEADLESS_NOTE), promptArg.slice(-80));
        const noModel = hw(['start', '--code', 'DRY', '--prompt-file', PROMPT, '--log', log, '--claude-bin', FAKE, '--ledger', ledger, '--dry-run']);
        check('2. --model unset means no --model flag at all', noModel.json && !noModel.json.value.argv.includes('--model'));
        const badCode = hw(['start', '--code', 'bad code!', '--prompt-file', PROMPT, '--log', log, '--claude-bin', FAKE, '--ledger', ledger, '--dry-run']);
        check('a code outside the pattern is refused with code usage', badCode.exit === 1 && badCode.json && badCode.json.error.code === 'usage', badCode.stdout.slice(0, 120));
        // --prompt-file omitted: resolving '' is the cwd, a directory, so this used to read as an EISDIR under code internal.
        const noPrompt = hw(['start', '--code', 'NOPROMPT', '--log', log, '--claude-bin', FAKE, '--ledger', ledger]);
        check('2. --prompt-file omitted is refused with code usage naming the flag, not internal',
            noPrompt.exit === 1 && noPrompt.json && noPrompt.json.error.code === 'usage' && /--prompt-file/.test(noPrompt.json.error.message), noPrompt.stdout.slice(0, 160));
        check('2. and it spawned nothing: no log, no ledger', !fs.existsSync(log) && !fs.existsSync(ledger));
    }

    // 4, 7, 8 (omitted), 9, 13: one real run through the fake, exit 0, with a planted report.
    const t4 = completeFake('4', 'T4', { exit: 0, report: path.join(ROOT, 'T4', 'worker.report.md'), reportText: 'work notes\nRESULT T4 done: the fake finished its brief.\n', env: { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: path.join(ROOT, 'inherited config') } });
    if (t4) {
        check('4. the log ends with CLAUDE_EXIT=0', t4.ending === 'exit-line' && lastExitLine(t4.text) === 0, `${t4.ending}; tail ${JSON.stringify(t4.text.slice(-40))}`);
        check('4. the log carries the stdout line and the stderr line', t4.text.includes('FAKE-STDOUT-LINE') && t4.text.includes('FAKE-STDERR-LINE'));
        check('4. start returned before the worker ended (the record says running, the supervisor pid is numeric)',
            t4.res.json.value.record.state === 'running' && Number.isInteger(t4.pid));
        const keys = envKeysOf(t4.text) || [];
        check('7. CLAUDECODE and CLAUDE_CODE_ENTRYPOINT are ABSENT from the child env although the parent set them',
            keys.length > 0 && !keys.includes('CLAUDECODE') && !keys.includes('CLAUDE_CODE_ENTRYPOINT'), `${keys.length} keys`);
        check('7. AUTODEV_HEADLESS and AUTODEV_WORKER_CODE are present in the child env',
            keys.includes('AUTODEV_HEADLESS') && keys.includes('AUTODEV_WORKER_CODE'));
        check('8. --config-dir omitted: CLAUDE_CONFIG_DIR is absent from the child env although the parent carried one', !keys.includes('CLAUDE_CONFIG_DIR'));
        const argvLine = (t4.text.match(/^ARGV=(\[.*\])$/m) || [])[1];
        const argv = argvLine ? JSON.parse(argvLine) : [];
        check('4. the fake received the argv the script builds, through a real spawn',
            argv[0] === '-p' && argv[1].includes(HEADLESS_NOTE) && argv.includes('stream-json') && argv.includes('--verbose'), argvLine ? argvLine.slice(0, 80) : 'no ARGV line');
        check('4. the ledger record carries the supervisor pid and the fields of the contract',
            ['code', 'pid', 'startedAt', 'log', 'report', 'promptFile', 'configDir', 'model', 'permissionMode', 'state'].every((k) => k in t4.res.json.value.record)
            && t4.res.json.value.record.pid === t4.pid && t4.res.json.value.record.permissionMode === 'default');

        // 13. status --json after the run.
        const st = hw(['status', '--ledger', t4.ledger, '--json']);
        const rec = st.json && st.json.ok ? st.json.value.records.find((r) => r.code === 'T4') : null;
        check('13. status --json reports process exited, exit 0, result done, the sentence, unsettled',
            !!rec && rec.process === 'exited' && rec.exit === 0 && rec.result === 'done' && rec.settled === false
            && rec.sentence === 'the fake finished its brief.' && rec.reportExists === true, JSON.stringify(rec));
        check('13. status --json exits 0 and names the ledger and count in its population line',
            st.exit === 0 && st.json.value.population.includes(t4.ledger) && /1 record/.test(st.json.value.population), st.json ? st.json.value.population : '');
        const human = hw(['status', '--ledger', t4.ledger]);
        check('13. status without --json prints both axes on one line per record',
            human.exit === 0 && /T4 pid=\d+ process=exited exit=0 result=done settled=false/.test(human.stdout), human.stdout.slice(0, 160));

        // 9. settle.
        const settled = hw(['settle', '--code', 'T4', '--ledger', t4.ledger]);
        const sv = settled.json && settled.json.ok ? settled.json.value : null;
        check('9. settle returns ok, state done, the sentence and exit 0',
            settled.exit === 0 && !!sv && sv.state === 'done' && sv.sentence === 'the fake finished its brief.' && sv.exit === 0 && typeof sv.settledAt === 'string', settled.stdout.slice(0, 200));
        const after = JSON.parse(read(t4.ledger));
        check('9. the record is marked settled in the ledger', after.records[0].state === 'settled' && after.records[0].result === 'done');
        const again = hw(['settle', '--code', 'T4', '--ledger', t4.ledger]);
        check('9. a second settle finds no unsettled record', again.exit === 1 && again.json.error.code === 'unknown-code');
        const st2 = hw(['status', '--ledger', t4.ledger, '--json']);
        check('13. after settle, status shows settled true while process and result are unchanged',
            st2.json.value.records[0].settled === true && st2.json.value.records[0].process === 'exited' && st2.json.value.records[0].result === 'done');

        // 10. settle with the exit line stripped from THAT run's log, and the control on the real log.
        const stripped = t4.text.replace(/\nCLAUDE_EXIT=-?\d+\s*$/, '\n');
        check('10. control: the stripped log really lacks the exit line while the real one has it',
            !/CLAUDE_EXIT=/.test(stripped) && /CLAUDE_EXIT=0/.test(t4.text));
        const s10 = synthRun('T4', { logText: stripped, reportText: read(t4.report) });
        const notExited = hw(['settle', '--code', 'T4', '--ledger', s10.ledger]);
        check('10. settle while the log has no CLAUDE_EXIT exits 1 with code not-exited',
            notExited.exit === 1 && notExited.json && notExited.json.error.code === 'not-exited', notExited.stdout.slice(0, 160));
        const s10b = synthRun('T4', { logText: t4.text, reportText: read(t4.report) });
        const ok10 = hw(['settle', '--code', 'T4', '--ledger', s10b.ledger]);
        check('10. control: the same report settles once the log from the real run, with its exit line, is used',
            ok10.exit === 0 && ok10.json && ok10.json.ok && ok10.json.value.exit === 0, ok10.stdout.slice(0, 160));
    }

    // 5. exit code 7.
    const t5 = completeFake('5', 'T5', { exit: 7 });
    if (t5) {
        check('5. the log ends with CLAUDE_EXIT=7', t5.ending === 'exit-line' && lastExitLine(t5.text) === 7, `${t5.ending}; tail ${JSON.stringify(t5.text.slice(-40))}`);
        check('5. the report file does not exist when the fake wrote none, and status says result none',
            !fs.existsSync(t5.report) && hw(['status', '--ledger', t5.ledger, '--json']).json.value.records[0].result === 'none');
    }

    // 6. a binary that does not exist.
    {
        // startFake pins --claude-bin to the fake; this case needs a missing one, so it is driven directly.
        const missing = path.join(ROOT, 'no such dir', 'no-such-claude.exe');
        const log = path.join(ROOT, 'T6', 'worker.log');
        const ledger = path.join(ROOT, 'T6', 'ledger.json');
        const res = hw(['start', '--code', 'T6', '--prompt-file', PROMPT, '--log', log, '--claude-bin', missing, '--ledger', ledger]);
        const pid = res.json && res.json.ok ? res.json.value.supervisorPid : null;
        if (pid) supervisors.push(pid);
        if (!pid) check('6. start with a missing binary still returns a supervisor pid', false, res.stdout.slice(0, 200));
        else {
            const end = waitForEnd(log, pid);
            if (end.ending === 'timeout') indeterminateCase('6. the supervisor did not end', 'still alive at the budget');
            else {
                check('6. the log ends with CLAUDE_SPAWN_ERROR= then CLAUDE_EXIT=-1, so a poller is never stranded',
                    /CLAUDE_SPAWN_ERROR=\w+\nCLAUDE_EXIT=-1\s*$/.test(end.text), `${end.ending}; ${JSON.stringify(end.text.slice(-60))}`);
                const st = hw(['status', '--ledger', ledger, '--json']);
                check('6. status reads it as process exited with exit -1', st.json.value.records[0].process === 'exited' && st.json.value.records[0].exit === -1);
            }
        }
    }

    // 8. --config-dir given: present in the child, basename only in the ledger.
    {
        const cfg = path.join(ROOT, 'config dirs', 'worker-config');
        fs.mkdirSync(cfg, { recursive: true });
        const t8 = completeFake('8', 'T8', { extraArgs: ['--config-dir', cfg] });
        if (t8) {
            const keys = envKeysOf(t8.text) || [];
            check('8. --config-dir given: CLAUDE_CONFIG_DIR is present in the child env', keys.includes('CLAUDE_CONFIG_DIR'));
            const rec = JSON.parse(read(t8.ledger)).records[0];
            check('8. the ledger records only the basename of the config dir', rec.configDir === 'worker-config' && !rec.configDir.includes(path.sep), rec.configDir);
        }
    }

    // 11. a report with no RESULT line.
    {
        const s = synthRun('T11', { logText: 'noise\nCLAUDE_EXIT=0\n', reportText: 'notes only, no result line\n' });
        const r = hw(['settle', '--code', 'T11', '--ledger', s.ledger]);
        check('11. settle with a report that has no RESULT line exits 1 with code no-result', r.exit === 1 && r.json && r.json.error.code === 'no-result', r.stdout.slice(0, 160));
        const s2 = synthRun('T11', { logText: 'CLAUDE_EXIT=0\n', reportText: null });
        const r2 = hw(['settle', '--code', 'T11', '--ledger', s2.ledger]);
        check('11. settle with no report file at all is also no-result', r2.exit === 1 && r2.json && r2.json.error.code === 'no-result');
    }

    // 12. RESULT parsing.
    {
        const cases = [
            ['stopped', 'RESULT T12 stopped: blocked on a login.\n', 'stopped', 'blocked on a login.'],
            ['failed', 'RESULT T12 failed: the gate went red.\n', 'failed', 'the gate went red.'],
            ['last wins', 'RESULT T12 failed: first attempt.\nmore notes\nRESULT T12 done: second attempt landed.\n', 'done', 'second attempt landed.'],
        ];
        for (const [label, text, state, sentence] of cases) {
            const s = synthRun('T12', { logText: 'CLAUDE_EXIT=0\n', reportText: 'header\n' + text });
            const r = hw(['settle', '--code', 'T12', '--ledger', s.ledger]);
            check(`12. RESULT ${label} parses`, r.exit === 0 && r.json && r.json.ok && r.json.value.state === state && r.json.value.sentence === sentence, r.stdout.slice(0, 160));
        }
        const other = synthRun('T12', { logText: 'CLAUDE_EXIT=0\n', reportText: 'RESULT T12-OTHER done: a different worker.\nRESULT OTHER done: another one.\n' });
        const r = hw(['settle', '--code', 'T12', '--ledger', other.ledger]);
        check('12. known negative: a RESULT line naming a DIFFERENT code is ignored, so settle refuses no-result',
            r.exit === 1 && r.json && r.json.error.code === 'no-result', r.stdout.slice(0, 160));
        const noSentence = synthRun('T12', { logText: 'CLAUDE_EXIT=0\n', reportText: 'RESULT T12 done:\n' });
        const r3 = hw(['settle', '--code', 'T12', '--ledger', noSentence.ledger]);
        check('12. a RESULT line with no sentence does not parse', r3.exit === 1 && r3.json && r3.json.error.code === 'no-result');
    }

    // 13. liveness: synthetic records and the classifier.
    {
        const dead = runBudgeted(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8', timeout: 20000 });
        const deadPid = dead.pid;
        const dir = path.join(ROOT, 'liveness');
        const ledger = path.join(dir, 'ledger.json');
        // startedAt is NOW for the live records: a record started before this boot is unknown whatever its pid says.
        const boot = Date.now() - os.uptime() * 1000;
        const mk = (code, pid, startedAt = new Date().toISOString()) => ({ code, pid, startedAt, log: path.join(dir, code + '.log'), report: path.join(dir, code + '.report.md'), promptFile: PROMPT, configDir: null, model: null, permissionMode: 'default', state: 'running' });
        write(ledger, JSON.stringify({ version: 1, records: [mk('ALIVE', process.pid), mk('DEAD', deadPid), mk('PREBOOT', process.pid, new Date(boot - 3600 * 1000).toISOString())] }, null, 2) + '\n');
        const st = hw(['status', '--ledger', ledger, '--json']);
        const byCode = Object.fromEntries((st.json ? st.json.value.records : []).map((r) => [r.code, r]));
        check('13. a record whose pid is this suite reports process running', byCode.ALIVE && byCode.ALIVE.process === 'running' && byCode.ALIVE.exit === null, JSON.stringify(byCode.ALIVE));
        check('13. a record whose pid came from an exited child reports process unknown (no exit line, pid gone)',
            classify(dead) === 'verdict' && byCode.DEAD && byCode.DEAD.process === 'unknown', JSON.stringify(byCode.DEAD));
        check('13. a record started an hour BEFORE this boot reports process unknown although its pid (this suite) is alive',
            byCode.PREBOOT && byCode.PREBOOT.process === 'unknown' && byCode.ALIVE && byCode.ALIVE.process === 'running', JSON.stringify(byCode.PREBOOT));
        check('13. all report result none with no report file', byCode.ALIVE && byCode.ALIVE.result === 'none' && byCode.DEAD.result === 'none' && byCode.PREBOOT.result === 'none');
        const one = hw(['status', '--ledger', ledger, '--code', 'DEAD', '--json']);
        check('13. status --code narrows to that code and says so in the population line',
            one.json && one.json.value.records.length === 1 && /3 record\(s\), 1 for DEAD/.test(one.json.value.population), one.json ? one.json.value.population : '');
        const self = hw(['selftest']);
        const c = self.json && self.json.ok ? self.json.value.cases : {};
        check('13. the classifier reads ESRCH as dead and EPERM as ALIVE', self.exit === 0 && c.ESRCH === 'dead' && c.EPERM === 'alive' && c.esrch === 'dead' && c.eperm === 'alive', JSON.stringify(c));
    }

    // 14. status over a missing ledger and over an empty one.
    {
        const missing = hw(['status', '--ledger', path.join(ROOT, 'absent', 'ledger.json')]);
        check('14. status over a missing ledger prints could not read and exits 0', missing.exit === 0 && /^could not read /.test(missing.stdout) && !/0 record/.test(missing.stdout), missing.stdout.slice(0, 120));
        const emptyLedger = path.join(ROOT, 'empty', 'ledger.json');
        write(emptyLedger, '{"version":1,"records":[]}\n');
        const empty = hw(['status', '--ledger', emptyLedger]);
        check('14. status over an empty ledger prints a 0-record population line and exits 0', empty.exit === 0 && /: 0 record\(s\)/.test(empty.stdout) && !/could not read/.test(empty.stdout), empty.stdout.slice(0, 120));
        check('14. the two outputs differ', missing.stdout !== empty.stdout);
        const garbage = path.join(ROOT, 'garbage', 'ledger.json');
        write(garbage, '{not json\n');
        const g = hw(['status', '--ledger', garbage, '--json']);
        check('14. an unparseable ledger is could not read, never 0 records', g.exit === 0 && g.json && g.json.value.readable === false && /could not read/.test(g.json.value.population));
    }

    // 15. a prompt over the cap.
    {
        const long = path.join(ROOT, 'long', 'prompt.md');
        write(long, 'x'.repeat(PROMPT_MAX + 1) + '\n');
        const log = path.join(ROOT, 'long', 'w.log');
        const ledger = path.join(ROOT, 'long', 'ledger.json');
        const r = hw(['start', '--code', 'T15', '--prompt-file', long, '--log', log, '--claude-bin', FAKE, '--ledger', ledger]);
        check('15. a prompt of 8001 characters exits 1 with code prompt-too-long', r.exit === 1 && r.json && r.json.error.code === 'prompt-too-long' && /pointer prompt/.test(r.json.error.message), r.stdout.slice(0, 160));
        check('15. nothing was spawned: no log and no ledger record', !fs.existsSync(log) && !fs.existsSync(ledger));
    }

    // 16. the same code twice while unsettled.
    {
        const first = startFake('T16', { exit: 0 });
        check('16. the first start is accepted', first.res.exit === 0 && !!first.pid);
        const secondLog = path.join(ROOT, 'T16', 'second.log');
        const second = hw(['start', '--code', 'T16', '--prompt-file', PROMPT, '--log', secondLog, '--claude-bin', FAKE, '--ledger', first.ledger]);
        check('16. the second start with the same unsettled code exits 1 with code-active', second.exit === 1 && second.json && second.json.error.code === 'code-active', second.stdout.slice(0, 160));
        check('16. the ledger still holds exactly one T16 record', JSON.parse(read(first.ledger)).records.filter((r) => r.code === 'T16').length === 1);
        const absent16 = logStaysAbsent(secondLog, 2000);
        check('16. the refused start spawned nothing: its log does not exist and stays absent for 2 s',
            absent16.absent, absent16.absent ? '' : `the log appeared ${absent16.afterMs} ms after the refusal, so a worker runs untracked`);
        if (first.pid) waitForEnd(first.log, first.pid);
    }

    // 17. ten rapid starts: tmp+rename, never a truncating write.
    {
        const dir = path.join(ROOT, 'ten rapid');
        const ledger = path.join(dir, 'ledger.json');
        const pin = ledger + '.pin';
        const ident = (file) => { try { const s = fs.statSync(file, { bigint: true }); return `${s.dev}:${s.ino}`; } catch { return null; } };
        let ok = true;
        let identityChanged = 0;
        let inoUnsupported = false;
        let pinUnsupported = null;
        const details = [];
        const runs = [];
        for (let i = 0; i < 10; i++) {
            // PIN THE OLD FILE BEFORE THE START, or the comparison below reads
            // a reused inode number as "not replaced". A start writes the
            // ledger twice (reserve, then fill in the pid), and each write
            // renames a fresh .tmp over it. The first rename frees the old
            // inode, and ext4 hands a just-freed number to the next file it
            // creates, so the second .tmp can be born with the number the
            // ledger started with. [measured 2026-09-21] every ubuntu CI run
            // from 94a32b3 to 43cfd21 failed here, 9 of 10 (once 8), while
            // windows and macos passed on the same commits. A second hard link
            // keeps the old inode allocated, so its number cannot come back
            // while we compare. A truncating write is still caught: it writes
            // through the very inode the pin holds, so the two stay equal.
            const before = ident(ledger);
            let pinned = false;
            if (before) {
                try { fs.linkSync(ledger, pin); pinned = true; } catch (e) { pinUnsupported = e.code || e.message; }
            }
            const code = `RAPID-${i}`;
            const r = hw(['start', '--code', code, '--prompt-file', PROMPT, '--log', path.join(dir, code + '.log'), '--claude-bin', FAKE, '--ledger', ledger]);
            const pid = r.json && r.json.ok ? r.json.value.supervisorPid : null;
            if (pid) { supervisors.push(pid); runs.push({ log: path.join(dir, code + '.log'), pid }); }
            const after = ident(ledger);
            const old = pinned ? ident(pin) : before;
            if (pinned) fs.unlinkSync(pin);
            if (after && /:0$/.test(after)) inoUnsupported = true;
            if (old !== after) identityChanged++;
            let count = -1;
            try { count = JSON.parse(read(ledger)).records.length; } catch { count = -1; }
            const tmpLeft = fs.existsSync(ledger + '.tmp');
            const lockLeft = fs.existsSync(ledger + '.lock');
            if (r.exit !== 0 || tmpLeft || lockLeft || count !== i + 1) { ok = false; details.push(`#${i}: exit ${r.exit} tmp ${tmpLeft} lock ${lockLeft} count ${count}`); }
        }
        check('17. after each of ten rapid starts no .tmp and no .lock remain and the ledger parses with the expected count', ok, details.join(' | ') || `10 starts, ${JSON.parse(read(ledger)).records.length} records`);
        if (inoUnsupported) indeterminateCase('17. the ledger file was REPLACED on every write', 'this filesystem reports inode 0, so file identity cannot be observed');
        else if (pinUnsupported) indeterminateCase('17. the ledger file was REPLACED on every write', `a hard link to pin the old inode failed (${pinUnsupported}), and without one a reused inode number reads as no change`);
        else check('17. the ledger file was REPLACED on every write (its identity changed), never truncated in place', identityChanged === 10, `${identityChanged} of 10 writes changed the file identity`);
        for (const run of runs) waitForEnd(run.log, run.pid);

        // The lock itself. A FRESH lock held by another writer makes a start
        // wait its budget and refuse, writing nothing; a STALE one (its holder
        // died) is removed and the write proceeds.
        const lock = ledger + '.lock';
        const before = read(ledger);
        write(lock, '');
        const t0 = Date.now();
        const lockedLog = path.join(dir, 'locked.log');
        const held = hw(['start', '--code', 'LOCKED', '--prompt-file', PROMPT, '--log', lockedLog, '--claude-bin', FAKE, '--ledger', ledger]);
        const waited = Date.now() - t0;
        if (held.json && held.json.ok) supervisors.push(held.json.value.supervisorPid);
        check('17. a fresh lock held by another writer makes start wait and refuse with ledger-locked, and the ledger is untouched',
            held.exit === 1 && held.json && held.json.error.code === 'ledger-locked' && waited >= 4000 && read(ledger) === before && fs.existsSync(lock),
            `exit ${held.exit} after ${waited} ms, ${held.stdout.slice(0, 80)}`);
        const absentLocked = logStaysAbsent(lockedLog, 2000);
        check('17. the refused start spawned nothing: its log does not exist and stays absent for 2 s',
            absentLocked.absent, absentLocked.absent ? '' : `the log appeared ${absentLocked.afterMs} ms after the refusal, so a worker runs untracked`);
        const stale = new Date(Date.now() - 10 * 60 * 1000);
        fs.utimesSync(lock, stale, stale);
        const freed = hw(['start', '--code', 'STALE', '--prompt-file', PROMPT, '--log', path.join(dir, 'stale.log'), '--claude-bin', FAKE, '--ledger', ledger]);
        const stalePid = freed.json && freed.json.ok ? freed.json.value.supervisorPid : null;
        if (stalePid) supervisors.push(stalePid);
        check('17. a stale lock is removed and the start proceeds, leaving no lock behind',
            freed.exit === 0 && !!stalePid && !fs.existsSync(lock) && JSON.parse(read(ledger)).records.some((r) => r.code === 'STALE'),
            `exit ${freed.exit}, lock left ${fs.existsSync(lock)}`);
        if (stalePid) waitForEnd(path.join(dir, 'stale.log'), stalePid);
    }

    // 19. Retention: a locked write prunes settled records older than 7 days and keeps younger ones.
    {
        const dir = path.join(ROOT, 'retention');
        const ledger = path.join(dir, 'ledger.json');
        const day = 24 * 3600 * 1000;
        const settledRec = (code, ageMs) => ({ code, pid: 1, startedAt: new Date(Date.now() - ageMs - 60000).toISOString(), log: path.join(dir, code + '.log'), report: path.join(dir, code + '.report.md'), promptFile: PROMPT, configDir: null, model: null, permissionMode: 'default', state: 'settled', result: 'done', sentence: 'old.', exit: 0, settledAt: new Date(Date.now() - ageMs).toISOString() });
        const live = { code: 'T19', pid: 1, startedAt: new Date().toISOString(), log: path.join(dir, 'T19.log'), report: path.join(dir, 'T19.report.md'), promptFile: PROMPT, configDir: null, model: null, permissionMode: 'default', state: 'running' };
        write(live.log, 'CLAUDE_EXIT=0\n');
        write(live.report, 'RESULT T19 done: settled to trigger a write.\n');
        write(ledger, JSON.stringify({ version: 1, records: [settledRec('OLD8', 8 * day), settledRec('YOUNG6', 6 * day), live] }, null, 2) + '\n');
        const before = hw(['status', '--ledger', ledger, '--json']);
        check('19. control: before any write the ledger reads all three records', before.json && before.json.value.recordsRead === 3, before.json ? String(before.json.value.recordsRead) : '');
        const r = hw(['settle', '--code', 'T19', '--ledger', ledger]);
        const codes = JSON.parse(read(ledger)).records.map((x) => x.code).sort();
        check('19. a settle (a locked write) prunes the 8-day-old settled record and keeps the 6-day-old one',
            r.exit === 0 && codes.join(',') === ['T19', 'YOUNG6'].join(','), `exit ${r.exit}, records ${codes.join(',')}`);
    }

    // ------------------------------------------------------------ 20. a bare name on Windows
    // spawn() without a shell finds only .exe on PATH, and the npm global install
    // puts a .cmd shim there. Pure over an injected exists(), so it runs on every
    // platform and never spawns.
    {
        const { resolveClaudeBin } = require(SCRIPT);
        const exeDir = path.join(ROOT, 'bin exe');
        const shimDir = path.join(ROOT, 'npm shim');
        const bareDir = path.join(ROOT, 'nothing here');
        const present = new Set([
            path.join(exeDir, 'claude.exe'),
            path.join(shimDir, 'claude.cmd'),
            path.join(shimDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
        ]);
        const exists = (p) => present.has(p);
        const win = (pathEnv) => resolveClaudeBin('claude', { platform: 'win32', pathEnv, exists });
        check('20. a bare name resolves to <dir>/claude.exe when a PATH entry has it', win([bareDir, exeDir].join(path.delimiter)) === path.join(exeDir, 'claude.exe'), win([bareDir, exeDir].join(path.delimiter)));
        check('20. a PATH entry holding only the npm claude.cmd shim resolves to the .exe under its node_modules',
            win([bareDir, shimDir].join(path.delimiter)) === path.join(shimDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), win([bareDir, shimDir].join(path.delimiter)));
        check('20. the first PATH entry that resolves wins', win([shimDir, exeDir].join(path.delimiter)) === path.join(shimDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
        check('20. no candidate on PATH leaves the bare name unchanged, so the spawn error still reaches the log', win(bareDir) === 'claude', win(bareDir));
        const withSep = path.join(exeDir, 'claude');
        check('20. a name with a separator or an extension is never rewritten',
            resolveClaudeBin(withSep, { platform: 'win32', pathEnv: exeDir, exists }) === withSep
            && resolveClaudeBin('claude.cmd', { platform: 'win32', pathEnv: shimDir, exists }) === 'claude.cmd');
        check('20. on a non-Windows platform the name passes through untouched', resolveClaudeBin('claude', { platform: 'linux', pathEnv: exeDir, exists }) === 'claude');
    }

    // ------------------------------------------------------------ 21. --config-dir must name a directory that exists
    // `[measured 2026-09-21]` `--config-dir .claude-b` resolved against the
    // launcher's cwd, named nothing, and the worker died in 1 s with "Not
    // logged in". hw() runs with cwd ROOT and HOME pinned under ROOT, so a name
    // that exists under HOME and not under ROOT tells the two bases apart.
    {
        const dir = path.join(ROOT, 'T21');
        const name = 'cfg-b';
        fs.mkdirSync(path.join(HOME, name), { recursive: true });
        check('21. control: the name exists as a directory under HOME and not under the launcher cwd',
            fs.statSync(path.join(HOME, name)).isDirectory() && !fs.existsSync(path.join(ROOT, name)));
        const tryStart = (code, cfg, extra = []) => {
            const log = path.join(dir, code + '.log');
            const ledger = path.join(dir, code + '-ledger.json');
            const r = hw(['start', '--code', code, '--prompt-file', PROMPT, '--log', log, '--claude-bin', FAKE, '--ledger', ledger, '--config-dir', cfg, ...extra]);
            if (r.json && r.json.ok && r.json.value.supervisorPid) supervisors.push(r.json.value.supervisorPid);
            return { r, log, ledger, err: r.json && !r.json.ok ? r.json.error : { code: null, message: '' } };
        };

        const missing = path.join(ROOT, 'no such config');
        const m = tryStart('T21M', missing);
        check('21. a missing absolute --config-dir exits 1 with config-dir-missing, one line naming the resolved path and saying it does not exist',
            m.r.exit === 1 && m.err.code === 'config-dir-missing' && m.err.message.includes(missing)
            && /does not exist/.test(m.err.message) && !/\n/.test(m.err.message), m.r.stdout.slice(0, 200));
        const absentM = logStaysAbsent(m.log, 2000);
        check('21. and it recorded nothing and spawned nothing: no ledger, and the log stays absent for 2 s',
            !fs.existsSync(m.ledger) && absentM.absent, absentM.absent ? '' : `the log appeared ${absentM.afterMs} ms after the refusal`);

        const rel = tryStart('T21R', name);
        check('21. a bare relative name is refused with config-dir-relative, naming the ~/ spelling and the home path it would mean',
            rel.r.exit === 1 && rel.err.code === 'config-dir-relative' && rel.err.message.includes(`~/${name}`)
            && rel.err.message.includes(path.join(HOME, name)), rel.r.stdout.slice(0, 200));
        check('21. and it recorded nothing and spawned nothing', !fs.existsSync(rel.ledger) && !fs.existsSync(rel.log));

        const tilde = tryStart('T21T', `~/${name}`, ['--dry-run']);
        check('21. ~/<name> expands to the home directory, not the launcher cwd',
            tilde.r.exit === 0 && tilde.r.json.value.configDir === path.join(HOME, name) && tilde.r.json.value.envSet.includes('CLAUDE_CONFIG_DIR'),
            tilde.r.json && tilde.r.json.ok ? tilde.r.json.value.configDir : tilde.r.stdout.slice(0, 200));
        const bare = tryStart('T21H', '~', ['--dry-run']);
        check('21. a lone ~ is the home directory itself', bare.r.exit === 0 && bare.r.json.value.configDir === HOME,
            bare.r.json && bare.r.json.ok ? bare.r.json.value.configDir : bare.r.stdout.slice(0, 200));

        const tildeMissing = tryStart('T21N', '~/no-such-cfg');
        check('21. ~/<name> that does not exist is refused naming the expanded home path',
            tildeMissing.r.exit === 1 && tildeMissing.err.code === 'config-dir-missing' && tildeMissing.err.message.includes(path.join(HOME, 'no-such-cfg'))
            && !fs.existsSync(tildeMissing.ledger), tildeMissing.r.stdout.slice(0, 200));

        const file = path.join(dir, 'a file not a dir');
        write(file, 'x\n');
        const f = tryStart('T21F', file);
        check('21. a --config-dir that is a file is refused with config-dir-unusable, not a directory',
            f.r.exit === 1 && f.err.code === 'config-dir-unusable' && /not a directory/.test(f.err.message) && !fs.existsSync(f.ledger), f.r.stdout.slice(0, 200));

        const dryMissing = tryStart('T21D', missing, ['--dry-run']);
        check('21. --dry-run refuses a missing --config-dir too, so the preview matches the real start',
            dryMissing.r.exit === 1 && dryMissing.err.code === 'config-dir-missing', dryMissing.r.stdout.slice(0, 200));
    }

    // ------------------------------------------------------------ 22. --effort reaches claude, the supervisor and the ledger
    // The levels are the ones `claude --help` printed on 2.1.278 (2026-09-21),
    // written here as a literal rather than read from the script, so narrowing
    // the script's list turns this red instead of shrinking with it.
    {
        const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
        const dir = path.join(ROOT, 'T22');
        const log = path.join(dir, 'dry.log');
        const ledger = path.join(dir, 'dry-ledger.json');
        const dry = (extra) => hw(['start', '--code', 'T22', '--prompt-file', PROMPT, '--log', log, '--claude-bin', FAKE, '--ledger', ledger, '--dry-run', ...extra]);
        const wrong = LEVELS.filter((lvl) => {
            const r = dry(['--effort', lvl]);
            const argv = r.json && r.json.ok ? r.json.value.argv : [];
            return !(r.exit === 0 && argv[argv.indexOf('--effort') + 1] === lvl && argv.filter((a) => a === '--effort').length === 1 && r.json.value.effort === lvl);
        });
        check('22. every level claude --help lists is accepted and lands in argv as --effort <level>', wrong.length === 0, wrong.length ? `wrong: ${wrong.join(',')}` : `${LEVELS.length} of ${LEVELS.length}`);

        const none = dry([]);
        const noneArgv = none.json && none.json.ok ? none.json.value.argv : [];
        check('22. --effort omitted leaves argv exactly as it was before the flag existed',
            JSON.stringify([noneArgv[0], noneArgv[1], ...noneArgv.slice(3)]) === JSON.stringify([FAKE, '-p', '--permission-mode', 'default', '--output-format', 'stream-json', '--verbose'])
            && none.json.value.effort === null, JSON.stringify([noneArgv[0], noneArgv[1], ...noneArgv.slice(3)]));

        for (const bad of ['extreme', 'HIGH']) {
            const r = dry(['--effort', bad]);
            check(`22. --effort ${bad} is refused with code usage, naming the accepted levels`,
                r.exit === 1 && r.json && r.json.error.code === 'usage' && r.json.error.message.includes('low, medium, high, xhigh, max'), r.stdout.slice(0, 200));
        }
        check('22. the refusals and dry runs recorded and spawned nothing', !fs.existsSync(dir));

        const t22 = completeFake('22', 'T22R', { extraArgs: ['--effort', 'max'] });
        if (t22) {
            const argvLine = (t22.text.match(/^ARGV=(\[.*\])$/m) || [])[1];
            const argv = argvLine ? JSON.parse(argvLine) : [];
            check('22. the fake received --effort max through the supervisor, so the supervisor carried the flag',
                argv[argv.indexOf('--effort') + 1] === 'max', argvLine ? argvLine.slice(-120) : 'no ARGV line');
            const rec = JSON.parse(read(t22.ledger)).records[0];
            check('22. the ledger record carries effort max', rec.effort === 'max' && t22.res.json.value.record.effort === 'max', JSON.stringify(rec.effort));
            // The last real run in the file: let its supervisor finish exiting so
            // the cleanup line counts only supervisors a defect left behind.
            const until = Date.now() + 5000;
            while (pidAlive(t22.pid) && Date.now() < until) sleep(50);
        }
        if (t5) check('22. a record started without --effort carries effort null', JSON.parse(read(t5.ledger)).records[0].effort === null);
        const usage = hw(['--help']).stdout;
        check('22. the usage text lists --effort <level> and its five levels', usage.includes('[--effort <level>]') && usage.includes('low|medium|high|xhigh|max'));
    }

    // ------------------------------------------------------------ 23. the prompt names WHERE a worktree and scratch output go
    // `[measured 2026-09-22]` a brief that said "a new worktree" and `> f.log`
    // left the location to the worker, which put 12 worktrees and 37 scratch
    // files in the directory holding the checkouts. The scratch dir is derived
    // from --report, so the assertion uses a report path the log cannot imply.
    {
        const dir = path.join(ROOT, 'T23');
        const report = path.join(ROOT, 'T23 reports', 'T23.report.md');
        const r = hw(['start', '--code', 'T23', '--prompt-file', PROMPT, '--log', path.join(dir, 'T23.log'), '--report', report,
            '--claude-bin', FAKE, '--ledger', path.join(dir, 'ledger.json'), '--dry-run']);
        const v = r.json && r.json.ok ? r.json.value : null;
        const promptArg = v ? v.argv[v.argv.indexOf('-p') + 1] : '';
        const scratch = path.join(ROOT, 'T23 reports', 'T23');
        check('23. dry-run reports the scratch dir as <report dir>/<code>', !!v && v.scratchDir === scratch, v ? v.scratchDir : r.stdout.slice(0, 200));
        check('23. the prompt pins a worktree to <repo>/.claude/worktrees/<name>', promptArg.includes('<repo>/.claude/worktrees/<name>'), promptArg.slice(-400));
        check('23. the prompt names that scratch dir, in forward slashes', promptArg.includes(scratch.replace(/\\/g, '/')), promptArg.slice(-400));
        check('23. the placement note precedes the headless note, which still ends the prompt',
            promptArg.indexOf('PLACEMENT:') > 0 && promptArg.indexOf('PLACEMENT:') < promptArg.indexOf(HEADLESS_NOTE) && promptArg.endsWith(HEADLESS_NOTE + '\n'));
    }
    // ------------------------------------------------------------ 24. settle --lost
    // `[measured 2026-09-22]` four records on one machine could never settle:
    // a reboot killed their supervisors, so no log had a CLAUDE_EXIT line and
    // plain settle refused not-exited forever. --lost settles such a record as
    // result lost, and ONLY when it is provably not running.
    {
        const dir = path.join(ROOT, 'T24');
        const ledger = path.join(dir, 'ledger.json');
        const boot = Date.now() - os.uptime() * 1000;
        const preBoot = new Date(boot - 3600 * 1000).toISOString();
        const dead = runBudgeted(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8', timeout: 20000 });
        const deadPid = dead.pid;
        const mk = (code, pid, startedAt, { logText = 'stream noise, no exit line\n', reportText = null, state = 'running', extra = {} } = {}) => {
            const rec = { code, pid, startedAt, log: path.join(dir, code + '.log'), report: path.join(dir, code + '.report.md'), promptFile: PROMPT, configDir: null, model: null, permissionMode: 'default', state, ...extra };
            if (logText !== null) write(rec.log, logText);
            if (reportText !== null) write(rec.report, reportText);
            return rec;
        };
        const now = new Date().toISOString();
        const records = [
            mk('PREDEAD', deadPid, preBoot),
            mk('PREALIVE', process.pid, preBoot),
            mk('PREREPORT', deadPid, preBoot, { reportText: 'notes\nRESULT PREREPORT stopped: blocked before the reboot.\n' }),
            mk('POSTALIVE', process.pid, now),
            mk('POSTDEAD', deadPid, now),
            mk('POSTNOPID', null, now, { state: 'starting' }),
            mk('EXITED', deadPid, preBoot, { logText: 'noise\nCLAUDE_EXIT=0\n', reportText: 'RESULT EXITED done: it finished.\n' }),
            mk('OLDLOST', deadPid, new Date(Date.now() - 9 * 24 * 3600 * 1000).toISOString(), { state: 'settled', extra: { result: 'lost', reason: 'old', settledAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() } }),
        ];
        write(ledger, JSON.stringify({ version: 1, records }, null, 2) + '\n');
        const recOf = (code) => JSON.parse(read(ledger)).records.find((r) => r.code === code) || null;
        check('24. control: the dead pid came from an exited child and the pre-boot stamp precedes this boot',
            classify(dead) === 'verdict' && Number.isInteger(deadPid) && Date.parse(preBoot) < boot, `pid ${deadPid}, boot ${new Date(boot).toISOString()}`);
        const plain = hw(['settle', '--code', 'PREDEAD', '--ledger', ledger]);
        check('24. control: plain settle on a pre-boot record with no exit line still refuses not-exited and names --lost',
            plain.exit === 1 && plain.json && plain.json.error.code === 'not-exited' && /settle --lost/.test(plain.json.error.message), plain.stdout.slice(0, 200));

        const pre = hw(['settle', '--code', 'PREDEAD', '--lost', '--ledger', ledger]);
        const pv = pre.json && pre.json.ok ? pre.json.value : null;
        const preRec = recOf('PREDEAD');
        check('24. settle --lost settles a pre-boot record with no exit line as state lost, naming the boot in its reason',
            pre.exit === 0 && !!pv && pv.state === 'lost' && /before this boot/.test(pv.reason) && pv.exit === null && typeof pv.settledAt === 'string', pre.stdout.slice(0, 200));
        check('24. the ledger records it as settled with result lost, a reason and settledAt, never done, stopped or failed',
            !!preRec && preRec.state === 'settled' && preRec.result === 'lost' && typeof preRec.reason === 'string' && typeof preRec.settledAt === 'string', JSON.stringify(preRec).slice(0, 200));
        const preAlive = hw(['settle', '--code', 'PREALIVE', '--lost', '--ledger', ledger]);
        check('24. a pre-boot record settles --lost even when its pid is alive now, because a pid from before the boot names a stranger',
            preAlive.exit === 0 && preAlive.json && preAlive.json.ok && preAlive.json.value.state === 'lost', preAlive.stdout.slice(0, 200));
        const preReport = hw(['settle', '--code', 'PREREPORT', '--lost', '--ledger', ledger]);
        const prRec = recOf('PREREPORT');
        check('24. a lost record whose report has a RESULT line keeps its sentence and the report state, and is still result lost',
            preReport.exit === 0 && !!prRec && prRec.result === 'lost' && prRec.sentence === 'blocked before the reboot.' && prRec.reportResult === 'stopped', JSON.stringify(prRec).slice(0, 240));

        const postAlive = hw(['settle', '--code', 'POSTALIVE', '--lost', '--ledger', ledger]);
        check('24. settle --lost REFUSES a record started after this boot whose pid is alive, with not-lost, and leaves it unsettled',
            postAlive.exit === 1 && postAlive.json && !postAlive.json.ok && postAlive.json.error.code === 'not-lost' && recOf('POSTALIVE').state === 'running', postAlive.stdout.slice(0, 200));
        const postNoPid = hw(['settle', '--code', 'POSTNOPID', '--lost', '--ledger', ledger]);
        check('24. settle --lost refuses a post-boot record whose pid was never recorded, since nothing proves it stopped',
            postNoPid.exit === 1 && postNoPid.json && !postNoPid.json.ok && postNoPid.json.error.code === 'not-lost' && recOf('POSTNOPID').state === 'starting', postNoPid.stdout.slice(0, 200));
        const postDead = hw(['settle', '--code', 'POSTDEAD', '--lost', '--ledger', ledger]);
        check('24. settle --lost settles a post-boot record whose pid is dead, naming the dead pid in its reason',
            postDead.exit === 0 && postDead.json && postDead.json.ok && postDead.json.value.state === 'lost' && postDead.json.value.reason.includes(`pid ${deadPid} is dead`), postDead.stdout.slice(0, 200));

        const exited = hw(['settle', '--code', 'EXITED', '--lost', '--ledger', ledger]);
        check('24. settle --lost refuses a record that HAS an exit line, so an ended worker is never filed as lost',
            exited.exit === 1 && exited.json && !exited.json.ok && exited.json.error.code === 'not-lost' && /without --lost/.test(exited.json.error.message) && recOf('EXITED').state === 'running', exited.stdout.slice(0, 200));
        const exitedPlain = hw(['settle', '--code', 'EXITED', '--ledger', ledger]);
        check('24. and plain settle still takes that record down the existing path, as done',
            exitedPlain.exit === 0 && exitedPlain.json && exitedPlain.json.ok && exitedPlain.json.value.state === 'done' && recOf('EXITED').result === 'done', exitedPlain.stdout.slice(0, 200));

        const unknown = hw(['settle', '--code', 'NOSUCH', '--lost', '--ledger', ledger]);
        check('24. settle --lost on an unknown code refuses with unknown-code', unknown.exit === 1 && unknown.json && !unknown.json.ok && unknown.json.error.code === 'unknown-code', unknown.stdout.slice(0, 200));
        const again = hw(['settle', '--code', 'PREDEAD', '--lost', '--ledger', ledger]);
        check('24. a second settle --lost finds no unsettled record', again.exit === 1 && again.json && !again.json.ok && again.json.error.code === 'unknown-code');
        check('24. a lost record settled 8 days ago is pruned by a locked write like any settled one', recOf('OLDLOST') === null);

        const st = hw(['status', '--ledger', ledger, '--json']);
        const byCode = Object.fromEntries((st.json ? st.json.value.records : []).map((r) => [r.code, r]));
        check('24. status --json reports a lost record as settled true, settledAs lost, with its reason',
            !!byCode.PREDEAD && byCode.PREDEAD.settled === true && byCode.PREDEAD.settledAs === 'lost' && /before this boot/.test(byCode.PREDEAD.lostReason || ''), JSON.stringify(byCode.PREDEAD || null).slice(0, 240));
        check('24. status keeps the other results distinct: EXITED settledAs done, POSTALIVE unsettled with settledAs null',
            !!byCode.EXITED && byCode.EXITED.settledAs === 'done' && byCode.EXITED.lostReason === null && !!byCode.POSTALIVE && byCode.POSTALIVE.settled === false && byCode.POSTALIVE.settledAs === null);
        const human = hw(['status', '--ledger', ledger]).stdout;
        check('24. status without --json names a lost record as settledAs=lost with its reason',
            /PREDEAD pid=\d+ process=unknown exit=- result=none settled=true settledAs=lost \(started .* before this boot/.test(human) && !/EXITED[^\n]*settledAs=lost/.test(human), human.slice(0, 400));
        const usage = hw(['--help']).stdout;
        check('24. the usage text lists settle --lost and says when it refuses', usage.includes('settle --code <CODE> [--lost]') && /settle --lost: [\s\S]*Refused unless/.test(usage));
    }

    // ------------------------------------------------------------ 25. a worker asks by file and keeps working
    // `[measured 2026-09-22]` workers asked by exiting, so every question cost a
    // relaunch. The prompt must name ask.json and answer.json in the scratch
    // dir and forbid exiting to ask, and status must show the question as open
    // until answer.json lands, including when ask.json does not parse.
    {
        const dir = path.join(ROOT, 'T25');
        const report = path.join(dir, 'T25.report.md');
        const r = hw(['start', '--code', 'T25', '--prompt-file', PROMPT, '--log', path.join(dir, 'T25.log'), '--report', report,
            '--claude-bin', FAKE, '--ledger', path.join(dir, 'dry.json'), '--dry-run']);
        const v = r.json && r.json.ok ? r.json.value : null;
        const promptArg = v ? v.argv[v.argv.indexOf('-p') + 1] : '';
        const askFile = path.join(dir, 'T25', 'ask.json');
        const answerFile = path.join(dir, 'T25', 'answer.json');
        check('25. the prompt names ask.json and answer.json in the scratch dir',
            promptArg.includes(askFile.replace(/\\/g, '/')) && promptArg.includes(answerFile.replace(/\\/g, '/')), promptArg.slice(-900));
        check('25. the prompt forbids exiting to ask and says to keep working', /never exit to ask/.test(promptArg) && /Keep working on everything that does not depend on it/.test(promptArg));
        check('25. the prompt still fits under PROMPT_MAX with every note', promptArg.length < PROMPT_MAX, String(promptArg.length));

        const ledger = path.join(dir, 'ledger.json');
        write(ledger, JSON.stringify({ version: 1, records: [{ code: 'T25', pid: 0, startedAt: new Date().toISOString(), log: path.join(dir, 'T25.log'), report, state: 'running' }] }));
        const ask = () => { const s = hw(['status', '--ledger', ledger, '--json']); return s.json && s.json.ok ? s.json.value.records[0] : {}; };
        const none = ask();
        check('25. no ask.json reads as ask none', none.ask === 'none' && none.askFile === askFile, JSON.stringify(none).slice(0, 200));
        write(askFile, JSON.stringify({ question: 'Seeded data or production?', options: [{ label: 'Seeded (Recommended)' }] }));
        const open = ask();
        check('25. ask.json without answer.json reads as open, with the question', open.ask === 'open' && open.question === 'Seeded data or production?', JSON.stringify(open).slice(0, 200));
        check('25. the human status line shows ask=open', /ask=open/.test(hw(['status', '--ledger', ledger]).stdout));
        write(answerFile, JSON.stringify({ label: 'Seeded (Recommended)' }));
        check('25. answer.json beside it reads as answered', ask().ask === 'answered');
        fs.rmSync(answerFile);
        write(askFile, '{ not json');
        check('25. an ask.json that does not parse is unreadable, never none', ask().ask === 'unreadable');

        const real = startFake('T25B');
        if (real.pid) waitForEnd(real.log, real.pid);
        const rec = (JSON.parse(read(real.ledger) || '{"records":[]}').records || [])[0] || {};
        check('25. a started record carries the cwd the worker ran in', typeof rec.cwd === 'string' && path.resolve(rec.cwd) === path.resolve(ROOT), rec.cwd);
    }

    // 26. Workers run installed code. `[measured 2026-09-23]` after an install,
    // 11 of 12 workers ran this script from a worktree, and no record said so.
    {
        const dir = path.join(ROOT, 'T26');
        const ledger = path.join(dir, 'ledger.json');
        const log = path.join(dir, 'T26.log');
        const base = ['start', '--code', 'T26', '--prompt-file', PROMPT, '--log', log, '--claude-bin', FAKE, '--ledger', ledger];
        const refused = hw(base, {}, { dev: false });
        check('26. start from a checkout without --dev exits 1 with code not-installed and names --dev',
            refused.exit === 1 && !!refused.json && !refused.json.ok && refused.json.error.code === 'not-installed' && refused.json.error.message.includes('--dev'), refused.stdout.slice(0, 200));
        check('26. the refusal records nothing and spawns nothing', !fs.existsSync(ledger) && read(log) === null);
        const dryRefused = hw([...base, '--dry-run'], {}, { dev: false });
        check('26. the dry run refuses what the real start would', dryRefused.exit === 1 && !!dryRefused.json && !dryRefused.json.ok && dryRefused.json.error.code === 'not-installed');

        const repoVersion = JSON.parse(read(path.join(path.dirname(SCRIPT), '..', '.claude-plugin', 'plugin.json'))).version;
        const dry = hw([...base, '--dry-run']);
        const dv = dry.json && dry.json.ok ? dry.json.value : {};
        check('26. a --dev dry run names the checkout script, its version, installed=false and dev=true',
            dv.installed === false && dv.dev === true && dv.version === repoVersion && path.resolve(dv.script || '.') === SCRIPT, JSON.stringify({ installed: dv.installed, dev: dv.dev, version: dv.version }));

        // An installed copy: the same two files under <config>/plugins/cache/<marketplace>/autodev-core/<version>.
        const inst = path.join(ROOT, 'cfg', 'plugins', 'cache', 'autodev', 'autodev-core', '9.9.9');
        write(path.join(inst, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'autodev-core', version: '9.9.9' }));
        fs.mkdirSync(path.join(inst, 'scripts'), { recursive: true });
        for (const f of ['headless-worker.js', 'claude-paths.js']) fs.copyFileSync(path.join(path.dirname(SCRIPT), f), path.join(inst, 'scripts', f));
        const installed = hw([...base, '--dry-run'], {}, { dev: false, script: path.join(inst, 'scripts', 'headless-worker.js') });
        const iv = installed.json && installed.json.ok ? installed.json.value : {};
        check('26. the installed copy starts without --dev and names version 9.9.9',
            installed.exit === 0 && iv.installed === true && iv.dev === false && iv.version === '9.9.9', installed.stdout.slice(0, 200));

        const real = startFake('T26B');
        if (real.pid) waitForEnd(real.log, real.pid);
        const rec = (JSON.parse(read(real.ledger) || '{"records":[]}').records || [])[0] || {};
        check('26. a started record names the version and script that ran, and dev',
            rec.version === repoVersion && path.resolve(rec.script || '.') === SCRIPT && rec.dev === true, JSON.stringify({ version: rec.version, dev: rec.dev }));
        const st = hw(['status', '--ledger', real.ledger]);
        check('26. the status line names the version and (dev)', st.stdout.includes(`version=${repoVersion}(dev)`), st.stdout.slice(0, 240));
    }

    // 27. The ledger code travels into the prompt verbatim. `[measured 2026-09-23]`
    // reports ended `RESULT DESIGN done:` for the ledger code W2-DESIGN, because the
    // prompt said `RESULT <CODE>` and the worker picked a code of its own.
    {
        const dir = path.join(ROOT, 'T27');
        const report = path.join(dir, 'W2-DESIGN.report.md');
        const r = hw(['start', '--code', 'W2-DESIGN', '--prompt-file', PROMPT, '--log', path.join(dir, 'W2-DESIGN.log'), '--report', report,
            '--claude-bin', FAKE, '--ledger', path.join(dir, 'dry.json'), '--dry-run']);
        const v = r.json && r.json.ok ? r.json.value : null;
        const promptArg = v ? v.argv[v.argv.indexOf('-p') + 1] : '';
        check('27. the prompt names the report and its RESULT line with the exact ledger code',
            promptArg.includes('RESULT W2-DESIGN done|stopped|failed: <one sentence>') && promptArg.includes(report.replace(/\\/g, '/')), promptArg.slice(-1400));
        check('27. no placeholder code is left, and the ask note ends RESULT W2-DESIGN stopped',
            !/<CODE>/.test(promptArg) && promptArg.includes('RESULT W2-DESIGN stopped'));
        const denied = ['Production Deploy', 'Secret-Store Writes', 'Production Reads', 'Modify Shared Resources'];
        check('27. the prompt names the four classifier-denied action classes and a Release window, before the HEADLESS note',
            denied.every((c) => promptArg.includes(c)) && promptArg.indexOf('Release window') > 0
            && promptArg.indexOf('Release window') < promptArg.indexOf(HEADLESS_NOTE) && promptArg.endsWith(HEADLESS_NOTE + '\n'));
        check('27. the prompt still fits under PROMPT_MAX', promptArg.length < PROMPT_MAX, String(promptArg.length));
    }

    // 28. A RESULT line for another code is reported as that, not as a bare unparseable.
    {
        const s = synthRun('W2-DESIGN', { logText: 'CLAUDE_EXIT=0\n', reportText: 'notes\nRESULT DESIGN done: the design landed.\n' });
        const st = hw(['status', '--ledger', s.ledger, '--json']);
        const rec = st.json && st.json.ok ? st.json.value.records[0] : {};
        check('28. status keeps result unparseable and names the code it found',
            rec.result === 'unparseable' && rec.resultCodeFound === 'DESIGN', JSON.stringify(rec).slice(0, 200));
        check('28. the human status line says RESULT line found for a different code',
            /result=unparseable \(RESULT line found for a different code: DESIGN\)/.test(hw(['status', '--ledger', s.ledger]).stdout));
        const r = hw(['settle', '--code', 'W2-DESIGN', '--ledger', s.ledger]);
        check('28. settle refuses no-result and names the other code', r.exit === 1 && !!r.json && !r.json.ok && r.json.error.code === 'no-result'
            && /RESULT line found for a different code/.test(r.json.error.message) && r.json.error.message.includes('RESULT DESIGN'), r.stdout.slice(0, 260));
        const plain = synthRun('W2-PLAIN', { logText: 'CLAUDE_EXIT=0\n', reportText: 'no result line here\n' });
        const p = hw(['status', '--ledger', plain.ledger, '--json']);
        const prec = p.json && p.json.ok ? p.json.value.records[0] : {};
        check('28. a report with no RESULT line at all names no other code', prec.result === 'unparseable' && prec.resultCodeFound === null);
    }
} finally {
    // Kill by pid, never by pattern; a dead pid is the expected answer here.
    // The logs are scanned first so a supervisor that start never printed
    // (one spawned behind a refusal) is tracked and killed too.
    trackSupervisorsFromLogs(ROOT);
    let killed = 0;
    for (const pid of supervisors) { try { process.kill(pid); killed++; } catch { /* already gone */ } }
    sleep(300);
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* a handle may still be closing; leave it to the OS temp cleanup */ }
    console.log(`\ncleanup: ${supervisors.length} supervisor pid(s) tracked, ${killed} still alive at the end and killed by pid`);
}

console.log(`\n${tally(pass, fail, infra)}`);
console.log(`subject: ${path.relative(path.resolve(__dirname, '..'), SCRIPT)}, driven as a subprocess ${pass + fail} assertion(s) over 28 numbered cases; `
    + 'every worker ran through a fake binary under a temp root whose name carries a space.');
if (fail) console.log(`failed: ${failures.join(' | ')}`);
if (infra) console.log(`indeterminate: ${indeterminate.join(' | ')}`);
process.exitCode = exitCode(fail, infra);
