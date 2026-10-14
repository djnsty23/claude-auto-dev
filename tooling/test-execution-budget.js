#!/usr/bin/env node
'use strict';
/**
 * test-execution-budget.js - the shared execution budget (execution-budget.js)
 * as headless-worker.js and brain-judge.js use it, driven through real child
 * processes.
 *
 * Prints one `ok <check>` or `FAIL <check>` line per check, then the verdict:
 *   runaway=STOPPED descendants=0 evidence=RETAINED shared_reservations=PASS same_attempt_restart=DENY
 * A field that did not hold prints what was seen instead (RUNNING, a count,
 * LOST, FAIL, ALLOWED). Exit 0 green, 1 red, 2 when a child produced no verdict.
 *
 * THE FAKE CLAUDE. A `.js` file that headless-worker runs through node. It
 * writes its pid to a pid file, spawns a grandchild that writes its own pid and
 * idles, then behaves as FAKE_MODE says: `wall` idles, `output` floods stdout,
 * `turns` prints assistant events with new message ids, `ok` prints a result
 * event with 3 turns and $0.12, `nousage` exits with no result event. Both carry
 * a self-exit timer, so a defect never leaves a process behind for long.
 *
 * THE GRANDCHILD ESCAPES ITS PARENT'S DEATH. On Windows, node puts a child spawned
 * without detached into a kill-on-close job, so the grandchild would die with the
 * fake whatever the stop did. It is spawned detached there, as a dev server or a
 * shell a real worker starts can be, and only a tree kill (taskkill /T) reaches
 * it. On POSIX it stays in the fake's process group, which the stop kills whole.
 *
 * runaway       each of wall, output and turns past its ceiling ends the run with
 *               BUDGET_STOP=<field> and a settled attempt that records the stop.
 * descendants   after those runs, how many of the fakes and grandchildren still live.
 * evidence      the stopped run's log keeps what the child wrote, the stop line and
 *               the exit line, and the ledger keeps the stop, the bytes and the log path.
 * shared        six real processes racing for a window with room for three get
 *               exactly three. A run with no usage is charged its whole reservation,
 *               a measured run its reported turns. Subscription cost is notional and
 *               never reaches the billed pool, an API-key run is billed. A judge
 *               (brain-judge judgeRecord) spends from the same window and is refused
 *               when the workers have used it.
 * restart       a second start under a used attempt id is refused and spawns
 *               nothing, and a supervisor launched by hand under a settled or a
 *               never-reserved id writes BUDGET_DENIED and never runs claude.
 *
 * Every temp root has a space in its name. HOME and USERPROFILE point into it,
 * so no default ledger is ever the real one. Every process the suite started is
 * killed by pid in the finally block.
 */
process.env.AUTODEV_CAPACITY = 'off';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const HW = path.join(SCRIPTS, 'headless-worker.js');
const BUDGET = path.join(SCRIPTS, 'execution-budget.js');
const JUDGE = path.join(SCRIPTS, 'brain-judge.js');
const budget = require(BUDGET);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'budget test-'));
const HOME = path.join(ROOT, 'home');
const FAKE = path.join(ROOT, 'fake claude.js');
const GRANDCHILD = path.join(ROOT, 'grandchild.js');
const FAKE_JUDGE = path.join(ROOT, 'fake judge.js');
const PROMPT = path.join(ROOT, 'prompt.md');
const END_MS = 20000;

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); };
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

fs.mkdirSync(HOME, { recursive: true });
write(PROMPT, 'Read the brief in brief.md and do what it says.\n');
write(GRANDCHILD, [
    "'use strict';",
    'setTimeout(() => process.exit(0), 30000);',
    "require('fs').appendFileSync(process.argv[2], 'grandchild ' + process.pid + '\\n');",
    'setInterval(() => {}, 1000);',
].join('\n') + '\n');
write(FAKE, [
    "'use strict';",
    'setTimeout(() => process.exit(97), 30000);',
    "const fs = require('fs');",
    "const { spawn } = require('child_process');",
    'const pids = process.env.FAKE_PIDS;',
    "if (pids) fs.appendFileSync(pids, 'child ' + process.pid + '\\n');",
    `if (pids) spawn(process.execPath, [${JSON.stringify(GRANDCHILD)}, pids], { stdio: 'ignore', windowsHide: true, detached: ${process.platform === 'win32'} });`,
    "process.stdout.write('FAKE-BEGIN pid=' + process.pid + '\\n');",
    "const mode = process.env.FAKE_MODE || 'ok';",
    "if (mode === 'ok') { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 3, total_cost_usd: 0.12 }) + '\\n'); setTimeout(() => process.exit(0), 300); }",
    "else if (mode === 'nousage') setTimeout(() => process.exit(0), 300);",
    "else if (mode === 'output') setInterval(() => process.stdout.write('FLOOD ' + 'x'.repeat(4000) + '\\n'), 10);",
    "else if (mode === 'turns') { let n = 0; setInterval(() => process.stdout.write(JSON.stringify({ type: 'assistant', message: { id: 'msg_' + (++n), content: [] } }) + '\\n'), 40); }",
    "else setInterval(() => {}, 1000);",
].join('\n') + '\n');
write(FAKE_JUDGE, [
    "'use strict';",
    "const fs = require('fs');",
    "if (process.env.FAKE_JUDGE_MARK) fs.writeFileSync(process.env.FAKE_JUDGE_MARK, String(process.pid));",
    "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.03 }) + '\\n');",
].join('\n') + '\n');

let failed = 0;
let infra = 0;
const started = [];
function check(name, ok, detail) {
    if (!ok) failed++;
    console.log(`${ok ? 'ok' : 'FAIL'} ${name}${!ok && detail ? `  (${detail})` : ''}`);
    return Boolean(ok);
}
function config(name, worker, window = {}) {
    const file = path.join(ROOT, 'config', `${name}.json`);
    write(file, JSON.stringify({ kinds: { worker, judge: { maxTurns: 4 } }, window }));
    return file;
}
function baseEnv(extra) {
    const env = { ...process.env, HOME, USERPROFILE: HOME, AUTODEV_CAPACITY: 'off', AUTODEV_BUDGET_POLL_MS: '50', ...extra };
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_USE_VERTEX;
    return { ...env, ...extra };
}
function node(args, env, timeout = 60000) {
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT, env, timeout, windowsHide: true });
    if (r.error) { infra++; console.error(`infrastructure: node ${path.basename(args[0])} ${args[1] || ''} produced no verdict (${r.error.code || r.error.message})`); }
    let json = null;
    try { json = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); } catch { json = null; }
    return { exit: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

/** One worker run through `headless-worker start --dev`. */
function startRun(code, { mode, configFile, attemptId = null, env = {}, ledger = path.join(ROOT, 'budget.json') }) {
    const dir = path.join(ROOT, code);
    const log = path.join(dir, `${code}.log`);
    const pids = path.join(dir, 'pids.txt');
    fs.mkdirSync(dir, { recursive: true });
    const args = [HW, 'start', '--code', code, '--prompt-file', PROMPT, '--log', log, '--claude-bin', FAKE,
        '--ledger', path.join(dir, 'workers.json'), '--budget-ledger', ledger, '--dev', ...(attemptId ? ['--attempt-id', attemptId] : [])];
    const r = node(args, baseEnv({ AUTODEV_BUDGET_CONFIG: configFile, FAKE_MODE: mode, FAKE_PIDS: pids, ...env }));
    const value = r.json && r.json.ok ? r.json.value : null;
    const sup = value ? value.supervisorPid : null;
    if (sup) started.push(sup);
    return { r, value, sup, log, pids, dir, ledger, attemptId: value ? value.record.attemptId : null };
}
function waitForEnd(run, ms = END_MS) {
    const deadline = Date.now() + ms;
    for (;;) {
        const text = read(run.log);
        if (text !== null && /^CLAUDE_EXIT=-?\d+\s*$/m.test(text)) return { ended: true, text };
        if (run.sup && !pidAlive(run.sup)) { sleep(200); const t = read(run.log) || ''; return { ended: /^CLAUDE_EXIT=-?\d+\s*$/m.test(t), text: t }; }
        if (Date.now() > deadline) return { ended: false, text: text || '' };
        sleep(50);
    }
}
function pidsOf(run) {
    const out = [];
    for (const line of (read(run.pids) || '').split('\n')) {
        const m = line.match(/^(child|grandchild) (\d+)$/);
        if (m) { out.push({ role: m[1], pid: Number(m[2]) }); started.push(Number(m[2])); }
    }
    return out;
}
function aliveAfter(pids, ms = 3000) {
    const deadline = Date.now() + ms;
    for (;;) {
        const alive = pids.filter((p) => pidAlive(p.pid));
        if (!alive.length || Date.now() > deadline) return alive;
        sleep(100);
    }
}
const ledgerAttempt = (file, id) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).attempts[id] || null; } catch { return null; } };

function main() {
    const fields = { runaway: 'STOPPED', descendants: 0, evidence: 'RETAINED', shared_reservations: 'PASS', same_attempt_restart: 'DENY' };

    // ------------------------------------------------ runaway, descendants, evidence
    const ceilings = {
        wall: { maxTurns: 500, wallMs: 1500, outputBytes: 64 * 1024 * 1024, maxUsd: 40 },
        output: { maxTurns: 500, wallMs: 15000, outputBytes: 200 * 1024, maxUsd: 40 },
        turns: { maxTurns: 5, wallMs: 15000, outputBytes: 64 * 1024 * 1024, maxUsd: 40 },
    };
    const notStopped = [];
    let alive = 0;
    const lost = [];
    for (const field of ['wall', 'output', 'turns']) {
        const run = startRun(`RUN-${field}`, { mode: field, configFile: config(`run-${field}`, ceilings[field]), ledger: path.join(ROOT, `run-${field}.json`) });
        if (!check(`runaway ${field}: start reserved an attempt and spawned a supervisor`, run.sup && run.attemptId, run.r.stdout.slice(0, 300))) { notStopped.push(field); continue; }
        const end = waitForEnd(run);
        const a = ledgerAttempt(run.ledger, run.attemptId);
        const stopLine = new RegExp(`^BUDGET_STOP=${field} limit=\\d+ seen=\\d+$`, 'm').test(end.text);
        const stopped = check(`runaway ${field}: the run ended with BUDGET_STOP=${field} and a settled attempt recording it`,
            end.ended && stopLine && a && a.state === 'settled' && a.stop && a.stop.field === field && a.stop.kill && a.stop.kill.ok === true,
            `ended=${end.ended} stopLine=${stopLine} attempt=${JSON.stringify(a && { state: a.state, stop: a.stop })}`);
        if (!stopped) notStopped.push(field);
        const pids = pidsOf(run);
        check(`descendants ${field}: the fake and its grandchild both wrote their pids`, pids.some((p) => p.role === 'child') && pids.some((p) => p.role === 'grandchild'), JSON.stringify(pids));
        const left = aliveAfter(pids);
        alive += left.length;
        check(`descendants ${field}: no process of the stopped tree is alive`, left.length === 0, JSON.stringify(left));
        const after = end.text.slice(end.text.search(/^BUDGET_STOP=/m));
        const kept = /^FAKE-BEGIN pid=\d+$/m.test(end.text) && stopLine && /^CLAUDE_(EXIT|SIGNAL)=/m.test(after)
            && (field !== 'output' || /^FLOOD x+$/m.test(end.text)) && (field !== 'turns' || /"id":"msg_5"/.test(end.text));
        const recorded = a && a.log === run.log && typeof a.outputBytes === 'number' && a.outputBytes > 0 && a.usageMissing === true
            && a.charged && a.charged.turns === a.reserved.turns && typeof a.wallMs === 'number';
        if (!check(`evidence ${field}: the log keeps the child's output, the stop line and the exit line after it`, kept, JSON.stringify(end.text.slice(0, 120) + ' ... ' + end.text.slice(-200)))) lost.push(field);
        if (!check(`evidence ${field}: the ledger keeps the log path, bytes, wall time and the whole reservation as the charge`, recorded,
            JSON.stringify(a && { log: a.log, outputBytes: a.outputBytes, usageMissing: a.usageMissing, charged: a.charged, reserved: a.reserved }))) lost.push(field);
    }
    if (notStopped.length) fields.runaway = `RUNNING(${notStopped.join(',')})`;
    fields.descendants = alive;
    if (lost.length) fields.evidence = `LOST(${[...new Set(lost)].join(',')})`;

    // ------------------------------------------------ shared reservations
    const sharedFails = [];
    {
        // Six real processes race for a subscription window with room for three.
        const cfg = config('race', { maxTurns: 100 }, { subscriptionTurns: 300 });
        const ledger = path.join(ROOT, 'race.json');
        const reserver = path.join(ROOT, 'reserver.js');
        write(reserver, [
            "'use strict';",
            `const b = require(${JSON.stringify(BUDGET)});`,
            "const r = b.reserve({ attemptId: process.argv[2], kind: 'worker', billing: 'subscription' });",
            'process.stdout.write(JSON.stringify({ ok: r.ok, code: r.code || null }) + "\\n");',
        ].join('\n') + '\n');
        const env = baseEnv({ AUTODEV_BUDGET_CONFIG: cfg, AUTODEV_BUDGET_LEDGER: ledger });
        const results = [];
        let done = 0;
        const kids = [];
        for (let i = 0; i < 6; i++) {
            const k = spawn(process.execPath, [reserver, `race-${i}`], { env, cwd: ROOT, windowsHide: true });
            started.push(k.pid);
            let out = '';
            k.stdout.on('data', (d) => { out += d; });
            k.on('close', () => { try { results.push(JSON.parse(out.trim())); } catch { results.push({ ok: null, code: 'unparsed' }); } done++; });
            kids.push(k);
        }
        return new Promise((resolve) => {
            const t0 = Date.now();
            const wait = () => {
                if (done < 6 && Date.now() - t0 < 30000) { setTimeout(wait, 50); return; }
                const won = results.filter((r) => r.ok === true).length;
                const refused = results.filter((r) => r.code === 'window-exhausted').length;
                let held = -1;
                try { held = Object.keys(JSON.parse(fs.readFileSync(ledger, 'utf8')).attempts).length; } catch { held = -1; }
                if (!check('shared: six processes racing for a window with room for three get exactly three, the rest window-exhausted',
                    done === 6 && won === 3 && refused === 3 && held === 3, `done=${done} won=${won} refused=${refused} held=${held} ${JSON.stringify(results)}`)) sharedFails.push('race');
                resolve(after());
            };
            wait();
        });

        function after() {
            // The race's window is full: a judge must be refused from the same pool and spawn nothing.
            const mark = path.join(ROOT, 'judge-ran.txt');
            const driver = path.join(ROOT, 'judge driver.js');
            write(driver, [
                "'use strict';",
                `const bj = require(${JSON.stringify(JUDGE)});`,
                'const dir = process.argv[2];',
                `const r = bj.judgeRecord({ taskId: 'J1' }, { judgeBin: ${JSON.stringify(FAKE_JUDGE)}, cwd: dir, reportsDir: dir });`,
                'process.stdout.write(JSON.stringify(r) + "\\n");',
            ].join('\n') + '\n');
            const judgeFull = node([driver, path.join(ROOT, 'judge-full')], { ...env, FAKE_JUDGE_MARK: mark });
            const jf = judgeFull.json;
            if (!check('shared: a judge on the worker-filled window is refused as window-exhausted and spawns nothing',
                jf && jf.ok === false && jf.budget === 'window-exhausted' && !fs.existsSync(mark), judgeFull.stdout.slice(0, 300) + judgeFull.stderr.slice(0, 300))) sharedFails.push('judge-refused');
            // With room, the judge spends from the same pool, charged what it reported.
            const roomLedger = path.join(ROOT, 'judge-room.json');
            const judgeRoom = node([driver, path.join(ROOT, 'judge-room')], { ...env, AUTODEV_BUDGET_LEDGER: roomLedger, FAKE_JUDGE_MARK: mark });
            const jr = judgeRoom.json;
            const ja = jr && jr.attemptId ? ledgerAttempt(roomLedger, jr.attemptId) : null;
            if (!check('shared: a judge with room reserves a judge attempt in the shared ledger and is charged its reported 2 turns',
                fs.existsSync(mark) && ja && ja.kind === 'judge' && ja.state === 'settled' && ja.charged.turns === 2 && ja.usageMissing === false
                    && budget.poolOf(ja) === 'subscription:default', JSON.stringify(ja) + judgeRoom.stderr.slice(0, 200))) sharedFails.push('judge-shares');

            // A run that reports no usage is charged its whole reservation.
            const cfgU = config('usage', { maxTurns: 50, wallMs: 15000 });
            const nousage = startRun('USE-none', { mode: 'nousage', configFile: cfgU, ledger: path.join(ROOT, 'usage.json') });
            waitForEnd(nousage);
            const an = nousage.attemptId ? ledgerAttempt(nousage.ledger, nousage.attemptId) : null;
            if (!check('shared: a worker that reported no usage is charged its whole reservation (50 turns), never zero',
                an && an.state === 'settled' && an.usageMissing === true && an.charged.turns === 50 && an.reserved.turns === 50, JSON.stringify(an))) sharedFails.push('missing-usage');
            aliveAfter(pidsOf(nousage));
            // A measured subscription run is charged its turns, and its cost stays notional.
            const measured = startRun('USE-ok', { mode: 'ok', configFile: cfgU, ledger: path.join(ROOT, 'usage.json') });
            waitForEnd(measured);
            const am = measured.attemptId ? ledgerAttempt(measured.ledger, measured.attemptId) : null;
            if (!check('shared: a measured subscription run is charged its 3 turns, with $0.12 notional and $0 billed',
                am && am.state === 'settled' && am.billing === 'subscription' && am.usageMissing === false && am.charged.turns === 3 && am.charged.usd === 0 && am.notionalUsd === 0.12,
                JSON.stringify(am))) sharedFails.push('measured');
            aliveAfter(pidsOf(measured));
            // An API-key run is billed, in the api pool only.
            const billed = startRun('USE-api', { mode: 'ok', configFile: cfgU, ledger: path.join(ROOT, 'usage.json'), env: { ANTHROPIC_API_KEY: 'placeholder-not-a-key' } });
            waitForEnd(billed);
            const ab = billed.attemptId ? ledgerAttempt(billed.ledger, billed.attemptId) : null;
            aliveAfter(pidsOf(billed));
            const s = budget.status({ env: { AUTODEV_BUDGET_LEDGER: path.join(ROOT, 'usage.json'), AUTODEV_BUDGET_CONFIG: cfgU } });
            const pools = s.ok ? s.pools : {};
            if (!check('shared: an API-key run is billed $0.12 in the api pool, and the subscription pool holds no dollars',
                ab && ab.billing === 'api' && ab.charged.usd === 0.12 && pools.api && pools.api.usd === 0.12
                    && pools['subscription:default'] && pools['subscription:default'].usd === 0 && pools['subscription:default'].turns === 53,
                JSON.stringify({ ab: ab && { billing: ab.billing, charged: ab.charged }, pools }))) sharedFails.push('billed-separate');
            if (sharedFails.length) fields.shared_reservations = `FAIL(${sharedFails.join(',')})`;
            restart();
            return fields;
        }

        function restart() {
            const allowed = [];
            const cfgR = config('restart', { maxTurns: 50, wallMs: 15000 });
            const ledger = path.join(ROOT, 'restart.json');
            const first = startRun('RS-1', { mode: 'ok', configFile: cfgR, attemptId: 'fixed-attempt-1', ledger });
            const e1 = first.sup ? waitForEnd(first) : { ended: false };
            aliveAfter(pidsOf(first));
            const a1 = ledgerAttempt(ledger, 'fixed-attempt-1');
            check('restart: control, the first start under fixed-attempt-1 ran and settled', e1.ended && a1 && a1.state === 'settled', JSON.stringify(a1));
            // A second start under the same attempt id, with a new worker code.
            const second = startRun('RS-2', { mode: 'ok', configFile: cfgR, attemptId: 'fixed-attempt-1', ledger });
            sleep(1500);
            const refusedStart = second.r.exit === 1 && second.r.json && second.r.json.error && second.r.json.error.code === 'attempt-restart'
                && !second.sup && !fs.existsSync(second.log) && !fs.existsSync(second.pids);
            if (!check('restart: a second start under a used attempt id is refused as attempt-restart and spawns nothing', refusedStart,
                second.r.stdout.slice(0, 300))) allowed.push('start');
            const a1b = ledgerAttempt(ledger, 'fixed-attempt-1');
            check('restart: the refused start left the settled attempt unchanged', a1b && JSON.stringify(a1b) === JSON.stringify(a1), JSON.stringify(a1b));
            // A supervisor launched by hand under the settled id, then under an id never reserved.
            for (const [label, id, code] of [['a settled', 'fixed-attempt-1', 'attempt-restart'], ['a never-reserved', 'never-reserved-1', 'unknown-attempt']]) {
                const dir = path.join(ROOT, `RS-sup-${code}`);
                const log = path.join(dir, 'sup.log');
                const pids = path.join(dir, 'pids.txt');
                fs.mkdirSync(dir, { recursive: true });
                const r = node([HW, 'supervise', '--code', 'RS-SUP', '--prompt-file', PROMPT, '--log', log, '--claude-bin', FAKE,
                    '--ledger', path.join(dir, 'workers.json'), '--budget-ledger', ledger, '--attempt-id', id],
                baseEnv({ AUTODEV_BUDGET_CONFIG: cfgR, FAKE_MODE: 'ok', FAKE_PIDS: pids }));
                const text = read(log) || '';
                if (!check(`restart: a supervisor under ${label} attempt id writes BUDGET_DENIED=${code} and CLAUDE_EXIT=-1, and claude never runs`,
                    new RegExp(`^BUDGET_DENIED=${code}: `, 'm').test(text) && /^CLAUDE_EXIT=-1\s*$/m.test(text) && !/FAKE-BEGIN/.test(text) && !fs.existsSync(pids),
                    `exit=${r.exit} log=${JSON.stringify(text.slice(-200))}`)) allowed.push(code);
            }
            if (allowed.length) fields.same_attempt_restart = `ALLOWED(${allowed.join(',')})`;
        }
    }
}

function cleanup() {
    for (const pid of [...new Set(started)]) {
        if (!pidAlive(pid)) continue;
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a temp dir left behind is not a verdict */ }
}

Promise.resolve()
    .then(main)
    .then((fields) => {
        console.log(`runaway=${fields.runaway} descendants=${fields.descendants} evidence=${fields.evidence} shared_reservations=${fields.shared_reservations} same_attempt_restart=${fields.same_attempt_restart}`);
        process.exitCode = infra ? 2 : failed ? 1 : 0;
    })
    .catch((e) => { console.error(`test-execution-budget: ${e.stack || e.message}`); process.exitCode = 2; })
    .finally(cleanup);
