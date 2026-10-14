#!/usr/bin/env node
'use strict';
// Suite for plugins/autodev-core/scripts/worker-reconcile.js and
// plugins/autodev-core/scripts/plugin-integrity.js, with the hold and unknown
// states they add to unattended-worker.js.
//
// WHY. A reserved headless attempt could end in a state nobody owned: an exited
// worker left `started`, a refused login closed as a failed task, a reboot read
// from a stale report, and a cache-shaped path accepted as installed code. This
// suite drives every ending through the real CLIs as subprocesses, on fixtures
// in a temp dir: no claude is launched and nothing is paid for. HOME,
// USERPROFILE and CLAUDE_CONFIG_DIR point into the temp dir, and the suite
// asserts that the real config dir gained nothing.
//
// It prints one `ok ` or `BAD` line per check and, last, exactly one line:
//   wrong_hash=DENIED exited=SETTLED auth_refused=HELD reboot_loss=UNKNOWN stale_success=REJECT
// A group whose checks do not all pass prints MISMATCH in its place, and the exit code is 1.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

// The real config dir, read before anything below points the environment elsewhere.
const REAL_CFG = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
const REAL_FILES = ['autodev/acceptance/index.jsonl', 'autodev/unattended-workers.json', 'autodev/headless-workers.json'].map((f) => path.join(REAL_CFG, f));
const REAL_RECONCILE = path.join(REAL_CFG, 'autodev', 'worker-reconcile');
const realReconcileBefore = fs.existsSync(REAL_RECONCILE);

const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-reconcile-')));
const HOME = path.join(ROOT, 'home');
const CFG = path.join(HOME, '.claude');
fs.mkdirSync(CFG, { recursive: true });
const NONCE = crypto.randomBytes(3).toString('hex');
const PROBE_OK = path.join(ROOT, 'probe-ok.json');
const PROBE_FULL = path.join(ROOT, 'probe-full.json');
const GIB = 1024 ** 3;
fs.writeFileSync(PROBE_OK, JSON.stringify({ diskFreeBytes: 900 * GIB, diskTotalBytes: 1000 * GIB, commitFreeBytes: 64 * GIB }));
fs.writeFileSync(PROBE_FULL, JSON.stringify({ diskFreeBytes: 1 * GIB, diskTotalBytes: 1000 * GIB, commitFreeBytes: 64 * GIB }));

// This process too: bj.writeVerdict below runs the receipt gate in-process.
Object.assign(process.env, {
    HOME, USERPROFILE: HOME, CLAUDE_CONFIG_DIR: CFG, GIT_TERMINAL_PROMPT: '0', AUTODEV_LEDGER_LOCK_WAIT_MS: '300',
    AUTODEV_GATE_LOCK_PATH: path.join(ROOT, 'locks', 'full-gate.lock'), AUTODEV_CAPACITY_PROBE_FILE: PROBE_OK,
});
delete process.env.AUTODEV_HEADLESS;
delete process.env.AUTODEV_CAPACITY;
const env = { ...process.env };

const SCRIPTS = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const WR = path.join(SCRIPTS, 'worker-reconcile.js');
const UW = path.join(SCRIPTS, 'unattended-worker.js');
const PI = path.join(SCRIPTS, 'plugin-integrity.js');
const bj = require(path.join(SCRIPTS, 'brain-judge.js'));
const acceptance = require(path.join(SCRIPTS, 'acceptance-receipt.js'));

const groups = { wrong_hash: [], exited: [], auth_refused: [], reboot_loss: [], stale_success: [] };
const LABEL = { wrong_hash: 'DENIED', exited: 'SETTLED', auth_refused: 'HELD', reboot_loss: 'UNKNOWN', stale_success: 'REJECT' };
let other = 0;
function check(group, name, ok, observed = '') {
    if (group) groups[group].push(!!ok); else if (!ok) other++;
    console.log(`${ok ? 'ok ' : 'BAD'}  ${group || 'isolation'}  ${name}${ok ? '' : `  (${String(observed).slice(0, 400)})`}`);
}

function cli(script, args, extra = {}) {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, windowsHide: true });
    let json = null;
    const out = (r.stdout || '').trim();
    // One JSON document, printed on one line or pretty-printed.
    try { json = JSON.parse(out); } catch { try { json = JSON.parse(out.split('\n').pop()); } catch { /* a crash */ } }
    return { status: r.status, json, value: json && json.ok ? json.value : null, code: json && json.error ? json.error.code : null,
        detail: (r.stdout || '').slice(0, 600) + (r.stderr || '').slice(0, 300) };
}

function g(cwd, ...args) {
    return execFileSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false',
        '-c', 'core.hooksPath=' + path.join(ROOT, 'no-hooks'), ...args], { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const iso = (t) => new Date(t).toISOString();
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
const IMAGE = path.basename(process.execPath).toLowerCase();
const children = [];

/** One isolated world per group: its own unattended and headless ledgers and state dirs. */
function world(name) {
    const dir = path.join(ROOT, name);
    fs.mkdirSync(dir, { recursive: true });
    const w = { dir, ledger: path.join(dir, 'unattended.json'), headless: path.join(dir, 'headless.json'), state: path.join(dir, 'reconcile'), judge: path.join(dir, 'judge') };
    write(w.ledger, JSON.stringify({ version: 1, records: [] }));
    write(w.headless, JSON.stringify({ version: 1, records: [] }));
    w.tick = (more = [], extra = {}) => cli(WR, ['tick', '--ledger', w.ledger, '--headless-ledger', w.headless, '--state-dir', w.state, '--judge-state-dir', w.judge, ...more], extra);
    w.rec = (id) => readJson(w.ledger).records.find((r) => r.taskId === id);
    w.run = (code) => readJson(w.headless).records.filter((r) => r.code === code).pop();
    w.outcome = (t, id) => ((t.value && t.value.outcomes) || []).find((o) => o.taskId === id) || {};
    return w;
}

/**
 * A reserved attempt: a headless run record and the started unattended record
 * that launched it. `h` overrides the headless record, `r` the unattended one.
 */
function attempt(w, code, { startedAt = iso(Date.now() - 1000), h = {}, r = {}, log = null, report = null } = {}) {
    const logFile = path.join(w.dir, code, 'worker.log');
    const reportFile = path.join(w.dir, code, 'REPORT.md');
    write(logFile, log === null ? 'worker started\n' : log);
    if (report !== null) write(reportFile, report);
    const hl = readJson(w.headless);
    hl.records.push({ code, pid: deadPid(), supervisorImage: IMAGE, startedAt, log: logFile, report: reportFile, configDir: null, state: 'running', ...h });
    write(w.headless, JSON.stringify(hl, null, 2));
    const taskId = `worker-${code}`;
    const ul = readJson(w.ledger);
    ul.records.push({ taskId, slug: code, repo: w.dir, branch: `claude/${code}`, state: 'started', channel: 'headless', startedAt, launchedAt: startedAt,
        attemptId: crypto.randomUUID(), report: reportFile, launch: { model: null, effort: null, permissionMode: 'bypassPermissions', configDir: null },
        headless: { code, startedAt, ledger: w.headless, version: 'test', keepTools: [] }, ...r });
    write(w.ledger, JSON.stringify(ul, null, 2));
    return { taskId, code, log: logFile, report: reportFile, startedAt };
}

/** A cache-shaped copy recorded the way Claude Code records an install. */
function recordInstall(cfg, inst) {
    const [mkt, plugin, version] = inst.split(/[\\/]+/).slice(-3);
    const clone = path.join(cfg, 'plugins', 'marketplaces', mkt);
    fs.mkdirSync(clone, { recursive: true });
    g(clone, 'init', '-q');
    write(path.join(clone, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: mkt, plugins: [{ name: plugin, source: `./plugins/${plugin}` }] }));
    fs.cpSync(inst, path.join(clone, 'plugins', plugin), { recursive: true });
    g(clone, 'add', '-A');
    g(clone, 'commit', '-q', '-m', 'fixture release');
    const commit = g(clone, 'rev-parse', 'HEAD');
    write(path.join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [`${plugin}@${mkt}`]: [{ scope: 'user', installPath: inst, version, gitCommitSha: commit }] } }));
    return commit;
}

try {
    // ============================================================ wrong_hash
    {
        const icfg = path.join(ROOT, 'install-cfg');
        const inst = path.join(icfg, 'plugins', 'cache', 'fixture-mkt', 'autodev-core', '1.0.0');
        write(path.join(inst, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'autodev-core', version: '1.0.0' }));
        for (const f of ['headless-worker.js', 'claude-paths.js', 'capacity.js', 'gate-records.js', 'plugin-integrity.js', 'execution-budget.js', 'worker-profiles.js', 'ledger-lock.js', 'gate-identity.js']) {
            write(path.join(inst, 'scripts', f), fs.readFileSync(path.join(SCRIPTS, f)));
        }
        const launcher = path.join(inst, 'scripts', 'headless-worker.js');
        const integ = (more = []) => cli(PI, ['verify', '--plugin-root', inst, '--launcher', launcher, ...more]);
        const prompt = path.join(ROOT, 'prompt.md');
        write(prompt, 'Do nothing.\n');
        const startLedger = path.join(ROOT, 'install-start', 'ledger.json');
        const dryStart = () => cli(launcher, ['start', '--code', `wh-${NONCE}`, '--prompt-file', prompt, '--log', path.join(ROOT, 'install-start', 'w.log'),
            '--claude-bin', process.execPath, '--ledger', startLedger, '--dry-run']);
        const parse = (r) => r.json || {};

        const unrecorded = parse(integ());
        check('wrong_hash', 'a cache-shaped path with no install record is DENIED: a path is a name, not evidence', unrecorded.verdict === 'DENIED' && unrecorded.code === 'no-install-record', JSON.stringify(unrecorded));
        const s0 = dryStart();
        check('wrong_hash', 'start from that copy is refused integrity-denied, without --dev', s0.status === 1 && s0.code === 'integrity-denied', s0.detail);

        const commit = recordInstall(icfg, inst);
        const good = parse(integ());
        check('wrong_hash', 'control: the copy that hashes to the recorded commit is ALLOWED, launcher hash included',
            good.verdict === 'ALLOWED' && good.commit === commit && good.launcher && good.launcher.expected && good.launcher.expected === good.launcher.actual, JSON.stringify(good));
        const s1 = dryStart();
        check('wrong_hash', 'control: start --dry-run from the verified copy passes and records the verdict', s1.status === 0 && s1.value && s1.value.integrity && s1.value.integrity.verdict === 'ALLOWED', s1.detail);

        const original = fs.readFileSync(launcher);
        fs.writeFileSync(launcher, Buffer.concat([original, Buffer.from('\n// one more line\n')]));
        const tampered = parse(integ());
        check('wrong_hash', 'a changed launcher is DENIED, naming its expected and actual hashes',
            tampered.verdict === 'DENIED' && tampered.code === 'hash-mismatch' && tampered.launcher && tampered.launcher.expected !== tampered.launcher.actual
                && (tampered.mismatched || []).includes('scripts/headless-worker.js'), JSON.stringify(tampered));
        const s2 = dryStart();
        check('wrong_hash', 'start from the changed copy is refused before launch, and nothing is reserved', s2.status === 1 && s2.code === 'integrity-denied' && !fs.existsSync(startLedger), s2.detail);
        fs.writeFileSync(launcher, original);

        write(path.join(inst, 'scripts', 'planted.js'), 'module.exports = 1;\n');
        const extra = parse(integ());
        check('wrong_hash', 'a file the release does not ship is DENIED', extra.verdict === 'DENIED' && (extra.extras || []).includes('scripts/planted.js'), JSON.stringify(extra));
        fs.rmSync(path.join(inst, 'scripts', 'planted.js'));
        write(path.join(inst, '.in_use', '1234'), '');
        const marker = parse(integ());
        check('wrong_hash', 'control: the .in_use marker Claude Code writes is not code, and stays ALLOWED', marker.verdict === 'ALLOWED', JSON.stringify(marker));

        const idx = readJson(path.join(icfg, 'plugins', 'installed_plugins.json'));
        const key = Object.keys(idx.plugins)[0];
        idx.plugins[key][0].gitCommitSha = 'f'.repeat(40);
        write(path.join(icfg, 'plugins', 'installed_plugins.json'), JSON.stringify(idx));
        const wrongCommit = parse(integ());
        check('wrong_hash', 'a record naming a commit the clone does not hold is DENIED', wrongCommit.verdict === 'DENIED' && wrongCommit.code === 'commit-missing', JSON.stringify(wrongCommit));
    }

    // ============================================================ exited
    {
        const w = world('exited');
        // A repo whose result branch passes its one criterion, so verify has work.
        const repo = path.join(w.dir, 'repo');
        g(w.dir, 'init', '-q', repo);
        write(path.join(repo, 'sum.js'), "console.log(1 + 2 === 3 ? 'sum ok' : 'sum wrong');\n");
        g(repo, 'add', '.');
        g(repo, 'commit', '-q', '-m', 'init');
        const brief = ['MISSION. Keep the sum right.', '', '## Acceptance criteria', '- AC1: the sum prints ok', '  check: node sum.js', '  expect: /^sum ok$/', ''].join('\n');
        const briefFile = path.join(w.dir, 'BRIEF.md');
        write(briefFile, brief);
        const code = `e1-${NONCE}`;
        g(repo, 'branch', `claude/${code}`, 'main');

        const supervisor = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
        children.push(supervisor);
        const a = attempt(w, code, { h: { pid: supervisor.pid }, r: { repo, briefFile, briefSha256: sha(brief) } });
        const t1 = w.tick(['--live', '--wait']);
        check('exited', 'tick 1: a live supervisor with no exit line is PENDING and the record stays started',
            w.outcome(t1, a.taskId).outcome === 'PENDING' && w.rec(a.taskId).state === 'started' && w.run(code).state === 'running', t1.detail);

        write(a.report, `did the work\nRESULT ${code} done: the sum holds.\n`);
        fs.appendFileSync(a.log, 'CLAUDE_EXIT=0\n');
        supervisor.kill();
        const t2 = w.tick(['--live', '--wait']);
        const r2 = w.rec(a.taskId);
        check('exited', 'tick 2: the exited worker is SETTLED and closed succeeded within two ticks',
            w.outcome(t2, a.taskId).outcome === 'SETTLED' && r2.state === 'closed' && r2.runStatus === 'succeeded' && w.run(code).state === 'settled' && w.run(code).result === 'done', t2.detail);
        const rows = fs.existsSync(path.join(w.state, 'verify.jsonl')) ? fs.readFileSync(path.join(w.state, 'verify.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
        const vrow = rows.find((x) => x.taskId === a.taskId) || {};
        check('exited', 'the same tick ran verify outside the worker, and it completed', vrow.ok === true && vrow.complete === true && vrow.attemptId === r2.attemptId, JSON.stringify(vrow));
        const index = acceptance.readIndex(acceptance.stateDir());
        check('exited', 'the receipt exists in the acceptance index for this task and attempt',
            !index.error && index.rows.some((x) => x.taskId === a.taskId && x.attemptId === r2.attemptId), JSON.stringify(index).slice(0, 300));
        const gate = acceptance.gate(r2);
        check('exited', 'the receipt gate now passes for the record', gate.ok === true, JSON.stringify(gate));
        const v = bj.writeVerdict({ ledger: w.ledger }, a.taskId, 'accept', 'the report reads done and the receipt is complete');
        check('exited', 'a later judge accept is applied, not escalated for receipt-missing',
            v.applied === true && !v.decision && w.rec(a.taskId).verdict.decision === 'accept' && w.rec(a.taskId).verdict.by === 'judge', JSON.stringify(v));

        // Control: the same accept with no verify behind it escalates, so the case above is the receipt's doing.
        const cw = world('exited-control');
        const cc = `c1-${NONCE}`;
        g(repo, 'branch', `claude/${cc}`, 'main');
        const ca = attempt(cw, cc, { r: { repo, briefFile, briefSha256: sha(brief), state: 'closed', runStatus: 'succeeded' } });
        write(ca.report, `RESULT ${cc} done: x.\n`);
        const cv = bj.writeVerdict({ ledger: cw.ledger }, ca.taskId, 'accept', 'the report reads done');
        check('exited', 'control: an accept with no verify is escalated for receipt-missing', cv.decision === 'escalate' && /receipt-missing/.test(cv.note || ''), JSON.stringify(cv));

        // The CLI's own success event and the supervisor's exit line, with no report: never success.
        const hcode = `e2-${NONCE}`;
        const harness = [JSON.stringify({ type: 'system', subtype: 'init' }), JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' }), 'CLAUDE_EXIT=0', ''].join('\n');
        const hb = attempt(w, hcode, { log: harness });
        // A harness-written settled record that says done, with no report behind it.
        const scode = `e3-${NONCE}`;
        const sb = attempt(w, scode, { log: 'CLAUDE_EXIT=0\n', h: { state: 'settled', result: 'done', exit: 0, sentence: 'harness says done', settledAt: iso(Date.now()) } });
        const t3 = w.tick(['--live', '--wait']);
        check('exited', 'a success result event and CLAUDE_EXIT=0 with no report settle unreported and close failed, never succeeded',
            w.outcome(t3, hb.taskId).outcome === 'SETTLED' && w.rec(hb.taskId).runStatus === 'failed' && w.run(hcode).result === 'unreported', JSON.stringify(w.outcome(t3, hb.taskId)));
        check('exited', 'a settled "done" the worker never wrote is REJECTED: the harness receipt does not impersonate success',
            w.outcome(t3, sb.taskId).outcome === 'REJECT' && w.rec(sb.taskId).runStatus === 'failed' && /not the worker's word/.test(w.rec(sb.taskId).settleReason || ''), JSON.stringify(w.outcome(t3, sb.taskId)));

        const inWorker = w.tick(['--live', '--wait'], { AUTODEV_HEADLESS: '1' });
        check('exited', 'inside a headless worker the reconciler refuses, so a worker cannot verify itself', inWorker.status === 1 && inWorker.code === 'reconciler-in-worker', inWorker.detail);

        // Capacity: verify reserves class verify, and a full disk defers it with no receipt.
        const dw = world('exited-capacity');
        const dc = `e4-${NONCE}`;
        g(repo, 'branch', `claude/${dc}`, 'main');
        const da = attempt(dw, dc, { log: 'CLAUDE_EXIT=0\n', report: `RESULT ${dc} done: x.\n`, r: { repo, briefFile, briefSha256: sha(brief) } });
        const td = dw.tick(['--live', '--wait'], { AUTODEV_CAPACITY_PROBE_FILE: PROBE_FULL, AUTODEV_GATE_LOCK_PATH: path.join(ROOT, 'locks-full', 'full-gate.lock') });
        const drow = ((td.value && td.value.verify && td.value.verify.verified) || [])[0] || {};
        check('exited', 'control: verify runs under capacity admission, and a full disk defers it with no receipt',
            dw.rec(da.taskId).runStatus === 'succeeded' && /^capacity: /.test(drow.deferred || '') && !acceptance.readIndex(acceptance.stateDir()).rows.some((x) => x.taskId === da.taskId), JSON.stringify(td.value && td.value.verify));
        // The clock's form: a live tick without --wait hands verify to a detached child and returns.
        const tc = dw.tick(['--live']);
        const hasReceipt = () => acceptance.readIndex(acceptance.stateDir()).rows.some((x) => x.taskId === da.taskId);
        for (let i = 0; i < 300 && !hasReceipt(); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        check('exited', 'the clock form returns at once with verify in a detached child, which records the receipt',
            tc.status === 0 && tc.value.verify.spawned === true && hasReceipt(), JSON.stringify(tc.value && tc.value.verify));
    }

    // ============================================================ auth_refused
    {
        const w = world('auth');
        const INCIDENT = 'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';
        const code = `a1-${NONCE}`;
        const log = [JSON.stringify({ type: 'system', subtype: 'init' }), JSON.stringify({ type: 'result', is_error: true, result: INCIDENT }), 'CLAUDE_EXIT=1', ''].join('\n');
        const a = attempt(w, code, { log });
        const t1 = w.tick(['--live', '--wait']);
        const r1 = w.rec(a.taskId);
        check('auth_refused', 'a refused login is HELD: the record waits in held with the attempt in its history',
            w.outcome(t1, a.taskId).outcome === 'HELD' && r1.state === 'held' && w.run(code).result === 'auth-refused'
                && Array.isArray(r1.attempts) && r1.attempts.length === 1 && r1.attempts[0].outcome === 'auth-refused', JSON.stringify(w.outcome(t1, a.taskId)));
        check('auth_refused', 'it is not counted as a failure of the task: no runStatus, no launch error, no verdict',
            r1.runStatus === undefined && r1.lastLaunchError === undefined && r1.verdict === undefined, JSON.stringify({ runStatus: r1.runStatus, lastLaunchError: r1.lastLaunchError }));
        const ready = cli(UW, ['ready', '--ledger', w.ledger]);
        check('auth_refused', 'a held record is never ready to start', ready.value && !ready.value.ready.includes(a.taskId), ready.detail);
        const t2 = w.tick(['--live', '--wait']);
        check('auth_refused', 'with no passing probe the next tick keeps it held: never retried blind',
            w.rec(a.taskId).state === 'held' && ((t2.value && t2.value.released) || []).some((x) => x.taskId === a.taskId && x.outcome === 'HELD'), JSON.stringify(t2.value && t2.value.released));
        write(path.join(w.judge, 'probes.jsonl'), JSON.stringify({ at: iso(Date.now() + 1000), passed: true, configDir: null }) + '\n');
        const t3 = w.tick(['--live', '--wait']);
        check('auth_refused', 'once a probe passes on that login the record returns to queued',
            w.rec(a.taskId).state === 'queued' && ((t3.value && t3.value.released) || []).some((x) => x.taskId === a.taskId && x.outcome === 'RELEASE'), JSON.stringify(t3.value && t3.value.released));
    }

    // ============================================================ reboot_loss
    {
        const w = world('reboot');
        const boot = Date.now() - os.uptime() * 1000;
        const code = `r1-${NONCE}`;
        // Started before this boot, no exit line, and a pid that answers alive now (this process): a reused pid.
        const a = attempt(w, code, { startedAt: iso(boot - 3600 * 1000), h: { pid: process.pid }, report: `RESULT ${code} done: it says it finished.\n` });
        const t = w.tick(['--live', '--wait']);
        const r = w.rec(a.taskId);
        check('reboot_loss', 'a run started before this boot with no exit line reads UNKNOWN, even with a done report and a live pid',
            w.outcome(t, a.taskId).outcome === 'UNKNOWN' && r.state === 'closed' && r.runStatus === 'unknown' && w.run(code).result === 'lost', JSON.stringify(w.outcome(t, a.taskId)));
        const code2 = `r2-${NONCE}`;
        const b = attempt(w, code2, { report: `RESULT ${code2} done: also says it finished.\n` });
        const t2 = w.tick(['--live', '--wait']);
        check('reboot_loss', 'a supervisor that died this boot without an exit line reads UNKNOWN, never success',
            w.outcome(t2, b.taskId).outcome === 'UNKNOWN' && w.rec(b.taskId).runStatus === 'unknown', JSON.stringify(w.outcome(t2, b.taskId)));
        check('reboot_loss', 'an unknown run is not handed to verify', !((t2.value && t2.value.verify && t2.value.verify.pending) > 0), JSON.stringify(t2.value && t2.value.verify));
    }

    // ============================================================ stale_success
    {
        const w = world('stale');
        const code = `s1-${NONCE}`;
        const a = attempt(w, code, { log: 'CLAUDE_EXIT=0\n', report: `RESULT ${code} done: an older attempt finished.\n` });
        const old = new Date(Date.now() - 3600 * 1000);
        fs.utimesSync(a.report, old, old);
        const t = w.tick(['--live', '--wait']);
        const r = w.rec(a.taskId);
        check('stale_success', 'a report written before the attempt started is REJECTED and the task closes failed',
            w.outcome(t, a.taskId).outcome === 'REJECT' && r.state === 'closed' && r.runStatus === 'failed' && w.run(code).result === 'unreported', JSON.stringify(w.outcome(t, a.taskId)));
        check('stale_success', 'the stale report is moved aside, not deleted', fs.readdirSync(path.dirname(a.report)).some((f) => /^REPORT\.stale-.*\.md$/.test(f)));

        // An attempt with no run of its own, beside an older run's success at the same code.
        const code2 = `s2-${NONCE}`;
        const older = iso(Date.now() - 2 * 3600 * 1000);
        const hl = readJson(w.headless);
        hl.records.push({ code: code2, pid: deadPid(), supervisorImage: IMAGE, startedAt: older, log: path.join(w.dir, 'old.log'), report: path.join(w.dir, 'old.md'),
            state: 'settled', result: 'done', exit: 0, sentence: 'the old attempt', settledAt: iso(Date.now() - 3600 * 1000) });
        write(w.headless, JSON.stringify(hl, null, 2));
        const now2 = iso(Date.now());
        const ul = readJson(w.ledger);
        ul.records.push({ taskId: `worker-${code2}`, slug: code2, repo: w.dir, state: 'started', channel: 'headless', startedAt: now2, launchedAt: now2, attemptId: crypto.randomUUID(),
            headless: { code: code2, startedAt: now2, ledger: w.headless } });
        write(w.ledger, JSON.stringify(ul, null, 2));
        const t2 = w.tick(['--live', '--wait']);
        const r2 = w.rec(`worker-${code2}`);
        check('stale_success', 'an older attempt\'s success never closes a newer attempt as succeeded: REJECT, unknown',
            w.outcome(t2, `worker-${code2}`).outcome === 'REJECT' && r2.state === 'closed' && r2.runStatus === 'unknown', JSON.stringify(w.outcome(t2, `worker-${code2}`)));

        // A settled done whose report predates the attempt: the success rule reads the files, not the ledger.
        const code3 = `s3-${NONCE}`;
        const c = attempt(w, code3, { log: 'CLAUDE_EXIT=0\n', report: `RESULT ${code3} done: older.\n`, h: { state: 'settled', result: 'done', exit: 0, settledAt: iso(Date.now()) } });
        fs.utimesSync(c.report, old, old);
        const t3 = w.tick(['--live', '--wait']);
        check('stale_success', 'a settled done backed only by an older report is REJECTED',
            w.outcome(t3, c.taskId).outcome === 'REJECT' && w.rec(c.taskId).runStatus === 'failed', JSON.stringify(w.outcome(t3, c.taskId)));

        const dry = world('stale-dry');
        const d = attempt(dry, `s4-${NONCE}`, { log: 'CLAUDE_EXIT=0\n' });
        const td = dry.tick([]);
        check('stale_success', 'control: a dry tick writes nothing', td.status === 0 && dry.rec(d.taskId).state === 'started' && dry.run(`s4-${NONCE}`).state === 'running', td.detail);
    }

    // ============================================================ isolation
    const leaked = REAL_FILES.filter((f) => { try { return fs.readFileSync(f, 'utf8').includes(NONCE); } catch { return false; } });
    check(null, 'the real config dir gained no fixture record: acceptance index, unattended and headless ledgers', leaked.length === 0, leaked.join(', '));
    check(null, 'the real config dir gained no worker-reconcile state', fs.existsSync(REAL_RECONCILE) === realReconcileBefore);
    check(null, 'every config path the suite used resolved inside its temp root',
        acceptance.stateDir().startsWith(ROOT) && require(path.join(SCRIPTS, 'claude-paths.js')).configDir().startsWith(ROOT) && !REAL_CFG.startsWith(ROOT), acceptance.stateDir());
} catch (e) {
    other++;
    console.log(`BAD  crashed  ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
} finally {
    for (const c of children) { try { c.kill(); } catch { /* gone */ } }
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* a locked file on Windows; the OS temp cleaner owns it */ }
}

const parts = Object.keys(groups).map((k) => `${k}=${groups[k].length && groups[k].every(Boolean) ? LABEL[k] : 'MISMATCH'}`);
const allOk = parts.every((p) => !p.endsWith('=MISMATCH')) && other === 0;
process.exitCode = allOk ? 0 : 1;
console.log(parts.join(' '));
