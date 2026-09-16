#!/usr/bin/env node
'use strict';
/**
 * headless-worker.js - dispatch a `claude -p` worker whose result arrives by
 * file, from a process that outlives the caller.
 *
 * WHY. A `claude -p` process exits the moment the model stops producing turns.
 * A Bash command it started with `run_in_background` keeps running, but the
 * completion notification has nobody to reach: the session that would have read
 * it is gone. So a headless worker cannot be told "run the gate in the
 * background and report when it ends". Two things follow, and this script owns
 * both:
 *
 *   1. The result travels by FILE plus an exit line. The worker writes a report
 *      file ending in `RESULT <CODE> done|stopped|failed: <sentence>`, and the
 *      log ends in `CLAUDE_EXIT=<code>` written by the supervisor, never by the
 *      worker, so a worker that dies mid-turn still leaves an exit line.
 *   2. The dispatch survives the caller exiting. `start` spawns a detached
 *      SUPERVISOR (this same file, `supervise`) that owns the claude child, and
 *      returns at once. The caller can be a session that ends seconds later.
 *
 * WHAT IT IS NOT. It is not `unattended-worker.js`. That script composes the
 * arguments for the scheduled-task MCP calls, keeps its own ledger under
 * `~/.claude/autodev/unattended-workers.json`, and starts nothing. This one
 * owns a real child process and keeps `~/.claude/autodev/headless-workers.json`.
 * Both have a `settle`; they settle different things. Do not merge the ledgers.
 *
 * THE CHILD INVOCATION IS OBSERVED, NOT DOCUMENTED. `claude -p <prompt>
 * --permission-mode <mode> --output-format stream-json --verbose` is an
 * invocation that worked on one machine when this was written. The suite proves
 * this script builds that argv and drives it through a FAKE binary; it cannot
 * prove the real CLI accepts those flags. Verify once by hand with a trivial
 * prompt before relying on it, and again after a CLI upgrade.
 *
 * FAKE BINARY CONVENTION. A `--claude-bin` ending in `.js` is run through the
 * current node executable (`process.execPath <file> ...`), so a suite can stand
 * in a script for the real binary without a shell or a shebang. Anything else
 * is spawned as given, with no shell. On Windows that means a `.cmd` shim is
 * not found by name; point `--claude-bin` at the `.exe`.
 *
 * Usage:
 *   node headless-worker.js start --code <CODE> --prompt-file <md> --log <file>
 *        [--report <file>] [--config-dir <dir>] [--model <id>] [--permission-mode <mode>]
 *        [--cwd <dir>] [--claude-bin <path>] [--ledger <file>] [--dry-run]
 *   node headless-worker.js supervise --code <CODE> --log <file> --prompt-file <md> ...   (internal)
 *   node headless-worker.js status [--code <CODE>] [--ledger <file>] [--json]
 *   node headless-worker.js settle --code <CODE> [--ledger <file>] [--json]
 *   node headless-worker.js selftest
 * Output: {"ok":true,"value":{...}} exit 0; {"ok":false,"error":{"code","message"}} exit 1.
 *
 * The prompt goes in argv. Windows caps a command line at 32767 characters, so
 * a prompt over PROMPT_MAX characters is refused before anything is spawned:
 * write a short pointer prompt that names a file to read.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const USAGE = [
    'Usage: node headless-worker.js start --code <CODE> --prompt-file <md> --log <file>',
    '            [--report <file>] [--config-dir <dir>] [--model <id>] [--permission-mode <mode>]',
    '            [--cwd <dir>] [--claude-bin <path>] [--ledger <file>] [--dry-run]',
    '       node headless-worker.js supervise ... (internal: the detached child that owns claude)',
    '       node headless-worker.js status [--code <CODE>] [--ledger <file>] [--json]',
    '       node headless-worker.js settle --code <CODE> [--ledger <file>] [--json]',
    '       node headless-worker.js selftest',
    'start: spawn a detached supervisor that runs `claude -p` and appends CLAUDE_EXIT=<code> to the log.',
    '       The caller may exit at once; the result is the report file plus that exit line.',
    'status: two axes per record, process (running|exited|unknown) and result (none|done|stopped|failed|unparseable).',
    'settle: read the last RESULT <CODE> line of the report and mark the record settled.',
    'Not unattended-worker.js: that one composes scheduled-task calls and starts nothing.',
    `Default ledger: ${path.join('~', '.claude', 'autodev', 'headless-workers.json')}`,
].join('\n') + '\n';

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,23}$/;
const PROMPT_MAX = 8000;
const RESULT_STATES = ['done', 'stopped', 'failed'];
const SCRUBBED_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];
const LOCK_STALE_MS = 60 * 1000;
const LOCK_WAIT_MS = 5000;
const EXIT_LINE_RE = /^CLAUDE_EXIT=(-?\d+)\s*$/m;

const HEADLESS_NOTE = 'HEADLESS: this process exits the moment the turn ends, so run every gate and long '
    + 'command in the FOREGROUND with the Bash timeout at its maximum, background nothing, and do not end '
    + 'the turn until the report file is complete and carries its RESULT line.';

function fault(code, message) { const e = new Error(message || code); e.publicCode = code; throw e; }

function parseArgs(argv) {
    const out = { _: [] };
    const flags = ['help', 'dry-run', 'json'];
    const known = ['_', ...flags, 'code', 'prompt-file', 'log', 'report', 'config-dir', 'model',
        'permission-mode', 'cwd', 'claude-bin', 'ledger'];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h' || a === 'help') { out.help = true; continue; }
        if (!a.startsWith('--')) { out._.push(a); continue; }
        const eq = a.indexOf('=');
        const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
        if (!known.includes(key)) fault('usage', `unknown flag --${key}`);
        if (Object.prototype.hasOwnProperty.call(out, key)) fault('usage', `--${key} given twice`);
        if (flags.includes(key)) { out[key] = true; continue; }
        const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (value === undefined || value === '') fault('usage', `--${key} needs a value`);
        out[key] = value;
    }
    return out;
}

function homeDir() { return process.env.USERPROFILE || process.env.HOME || os.homedir(); }
function defaultLedger() { return path.join(homeDir(), '.claude', 'autodev', 'headless-workers.json'); }
function defaultReport(log) { return log.replace(/\.[^./\\]+$/, '') + '.report.md'; }

function requireCode(opts) {
    if (!opts.code) fault('usage', '--code is required');
    if (!CODE_RE.test(opts.code)) fault('usage', `--code must match ${CODE_RE}`);
    return opts.code;
}

/** Synchronous sleep, so the lock wait below needs no event loop. */
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// ---------------------------------------------------------------- ledger
// Read-modify-write under an exclusive lock file, then tmp+rename. The final
// path is never opened for truncation, so a reader always sees a whole file.
// Copied from hooks/peer-send-ledger.js: an O_EXCL create, a stale timeout for
// a holder that died, and one retry after removing a stale lock.

function acquireLock(lock, nowMs) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try { return fs.openSync(lock, 'wx'); } catch (e) {
            if (!e || e.code !== 'EEXIST') return null;
        }
        let ageMs;
        try { ageMs = nowMs - fs.statSync(lock).mtimeMs; } catch { continue; }
        if (ageMs <= LOCK_STALE_MS) return null;
        try { fs.unlinkSync(lock); } catch { return null; }
    }
    return null;
}

function readLedger(file) {
    if (!fs.existsSync(file)) return { version: 1, records: [] };
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fault('ledger-unreadable', `${file}: ${e.message}`); }
    if (!parsed || !Array.isArray(parsed.records)) fault('ledger-unreadable', `${file}: no records array`);
    return parsed;
}

function writeLedgerFile(file, ledger) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
}

/** Lock, read, apply `fn(ledger)`, write, unlock. Returns what `fn` returned. */
function withLedger(file, fn) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = file + '.lock';
    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd = null;
    while (fd === null) {
        fd = acquireLock(lock, Date.now());
        if (fd === null) {
            if (Date.now() > deadline) fault('ledger-locked', `${lock} is held by another writer`);
            sleepMs(25);
        }
    }
    try {
        const ledger = readLedger(file);
        const value = fn(ledger);
        writeLedgerFile(file, ledger);
        return value;
    } finally {
        try { fs.closeSync(fd); } catch { /* already closed */ }
        try { fs.unlinkSync(lock); } catch { /* already gone */ }
    }
}

function isUnsettled(rec) { return rec.state !== 'settled'; }

// ---------------------------------------------------------------- the child
function composePrompt(text) { return text.replace(/\s+$/, '') + '\n\n' + HEADLESS_NOTE + '\n'; }

function readPrompt(file) {
    if (!file) fault('usage', '--prompt-file is required');
    if (!fs.existsSync(file)) fault('prompt-missing', `${file} does not exist`);
    const prompt = composePrompt(fs.readFileSync(file, 'utf8'));
    if (prompt.length > PROMPT_MAX) {
        fault('prompt-too-long', `the prompt is ${prompt.length} characters after the headless note and the cap is ${PROMPT_MAX}: `
            + 'it travels in argv, so write a short pointer prompt that names a file to read');
    }
    return prompt;
}

function buildArgv({ claudeBin, prompt, model, permissionMode }) {
    return [claudeBin, '-p', prompt, ...(model ? ['--model', model] : []),
        '--permission-mode', permissionMode, '--output-format', 'stream-json', '--verbose'];
}

/** The executable and arguments spawn() receives for an argv whose head may be a .js file. */
function spawnPlan(argv) {
    if (/\.js$/i.test(argv[0])) return { command: process.execPath, args: argv.slice() };
    return { command: argv[0], args: argv.slice(1) };
}

/**
 * The child env: the parent's, minus the harness variables a session would
 * hand down, plus the two headless markers, plus CLAUDE_CONFIG_DIR when asked.
 * An INHERITED CLAUDE_CONFIG_DIR is scrubbed too: a caller running under a
 * second account must name the config dir it wants the worker on, or the
 * worker runs on the default one. Nothing about the account travels silently.
 */
function buildEnv(base, { code, configDir }) {
    const env = Object.assign({}, base);
    const deleted = [];
    const scrub = SCRUBBED_ENV.concat(configDir ? [] : ['CLAUDE_CONFIG_DIR']);
    for (const k of scrub) if (k in env) { delete env[k]; deleted.push(k); }
    env.AUTODEV_HEADLESS = '1';
    env.AUTODEV_WORKER_CODE = code;
    const set = ['AUTODEV_HEADLESS', 'AUTODEV_WORKER_CODE'];
    if (configDir) { env.CLAUDE_CONFIG_DIR = configDir; set.push('CLAUDE_CONFIG_DIR'); }
    return { env, set: set.sort(), deleted: deleted.sort(), scrubList: scrub.sort() };
}

function startOptions(opts) {
    const code = requireCode(opts);
    if (!opts.log) fault('usage', '--log is required');
    const log = path.resolve(opts.log);
    return {
        code,
        log,
        report: path.resolve(opts.report || defaultReport(log)),
        promptFile: path.resolve(opts['prompt-file'] || ''),
        configDir: opts['config-dir'] ? path.resolve(opts['config-dir']) : null,
        model: opts.model || null,
        permissionMode: opts['permission-mode'] || 'default',
        cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd(),
        claudeBin: opts['claude-bin'] || 'claude',
        ledger: path.resolve(opts.ledger || defaultLedger()),
    };
}

/** The flags `start` hands its supervisor: the same options, spelled out. */
function supervisorFlags(o) {
    const flags = ['--code', o.code, '--log', o.log, '--prompt-file', o.promptFile,
        '--permission-mode', o.permissionMode, '--cwd', o.cwd, '--claude-bin', o.claudeBin];
    if (o.model) flags.push('--model', o.model);
    if (o.configDir) flags.push('--config-dir', o.configDir);
    return flags;
}

function start(opts) {
    const o = startOptions(opts);
    const prompt = readPrompt(o.promptFile);
    const argv = buildArgv({ claudeBin: o.claudeBin, prompt, model: o.model, permissionMode: o.permissionMode });
    const plan = buildEnv(process.env, { code: o.code, configDir: o.configDir });
    if (opts['dry-run']) {
        return {
            dryRun: true, code: o.code, argv, command: spawnPlan(argv).command,
            envSet: plan.set, envDeleted: plan.deleted, envScrubList: plan.scrubList,
            log: o.log, report: o.report, ledger: o.ledger, cwd: o.cwd, spawned: false,
        };
    }
    // RESERVE, THEN SPAWN, THEN FILL IN. The code is reserved inside the lock
    // before anything is spawned, so a refusal (ledger-locked, or a code that
    // gained an unsettled record meanwhile) exits 1 with NO process running.
    // The order used to be spawn first and write second, and a refusal in the
    // write left a real worker running that no ledger named.
    const record = {
        code: o.code, pid: null, startedAt: new Date().toISOString(),
        log: o.log, report: o.report, promptFile: o.promptFile,
        configDir: o.configDir ? path.basename(o.configDir) : null,
        model: o.model, permissionMode: o.permissionMode, state: 'starting',
    };
    const isReservation = (r) => r.code === o.code && r.state === 'starting' && r.startedAt === record.startedAt;
    withLedger(o.ledger, (ledger) => {
        if (ledger.records.some((r) => r.code === o.code && isUnsettled(r))) {
            fault('code-active', `${o.code} has an unsettled record in ${o.ledger}; settle it or pick another code`);
        }
        ledger.records.push(record);
    });
    let child;
    try {
        child = spawn(process.execPath, [__filename, 'supervise', ...supervisorFlags(o)],
            { detached: true, stdio: 'ignore', windowsHide: true, env: plan.env });
    } catch (e) {
        withLedger(o.ledger, (ledger) => { ledger.records = ledger.records.filter((r) => !isReservation(r)); });
        fault('spawn-failed', `could not spawn the supervisor: ${e.code || e.message}`);
    }
    child.on('error', () => { /* the supervisor could not be started; the record keeps whatever pid spawn assigned */ });
    child.unref();
    Object.assign(record, { pid: child.pid || null, state: 'running' });
    withLedger(o.ledger, (ledger) => {
        const rec = ledger.records.find(isReservation);
        if (rec) Object.assign(rec, { pid: record.pid, state: 'running' });
        else ledger.records.push(record);
    });
    return { ledger: o.ledger, record, supervisorPid: child.pid, spawned: true };
}

/**
 * The detached child. It owns the claude process and writes the one line the
 * worker itself cannot: how the process ended. A child that never started
 * (missing binary, EACCES) gets a CLAUDE_SPAWN_ERROR line and an exit of -1,
 * so a poller is never left waiting on a process that does not exist.
 */
function supervise(opts) {
    const o = startOptions(opts);
    const prompt = readPrompt(o.promptFile);
    const argv = buildArgv({ claudeBin: o.claudeBin, prompt, model: o.model, permissionMode: o.permissionMode });
    const { env } = buildEnv(process.env, { code: o.code, configDir: o.configDir });
    const plan = spawnPlan(argv);
    fs.mkdirSync(path.dirname(o.log), { recursive: true });
    const fd = fs.openSync(o.log, 'a');
    let finished = false;
    const finish = (lines, exitCode) => {
        if (finished) return;
        finished = true;
        try { fs.writeSync(fd, '\n' + lines.join('\n') + '\n'); } catch { /* the log is gone; nothing left to say */ }
        try { fs.closeSync(fd); } catch { /* already closed */ }
        process.exitCode = exitCode;
    };
    let child;
    try {
        child = spawn(plan.command, plan.args, { cwd: o.cwd, env, stdio: ['ignore', fd, fd], windowsHide: true });
    } catch (e) {
        finish([`CLAUDE_SPAWN_ERROR=${e.code || e.message}`, 'CLAUDE_EXIT=-1'], 1);
        return { supervising: false, code: o.code };
    }
    child.on('error', (e) => finish([`CLAUDE_SPAWN_ERROR=${e.code || e.message}`, 'CLAUDE_EXIT=-1'], 1));
    child.on('exit', (code, signal) => {
        if (code === null) finish([`CLAUDE_SIGNAL=${signal}`, 'CLAUDE_EXIT=-1'], 1);
        else finish([`CLAUDE_EXIT=${code}`], code === 0 ? 0 : 1);
    });
    return { supervising: true, code: o.code, childPid: child.pid };
}

// ---------------------------------------------------------------- status
/** The number from the last CLAUDE_EXIT line of a log, or null. */
function exitCodeOf(logText) {
    let last = null;
    for (const m of String(logText).matchAll(new RegExp(EXIT_LINE_RE.source, 'gm'))) last = Number(m[1]);
    return last;
}

/**
 * `alive` or `dead` from a `process.kill(pid, 0)` error. ONLY ESRCH means dead:
 * EPERM is a process that exists and belongs to someone else, and a classifier
 * that reads it as dead would report a foreign worker as gone.
 */
function livenessFromError(err) {
    if (!err) return 'alive';
    return err.code === 'ESRCH' ? 'dead' : 'alive';
}

function pidLiveness(pid, probe) {
    if (!Number.isInteger(pid) || pid <= 0) return 'dead';
    try { (probe || process.kill)(pid, 0); return 'alive'; } catch (e) { return livenessFromError(e); }
}

/** The LAST `RESULT <code> <state>: <sentence>` line for this exact code, or null. */
function parseResult(reportText, code) {
    const re = new RegExp(`^RESULT\\s+${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(${RESULT_STATES.join('|')}):\\s*(.+)$`, 'gm');
    let last = null;
    for (const m of String(reportText).matchAll(re)) last = { state: m[1], sentence: m[2].trim() };
    return last;
}

function readText(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** Two axes for one record: how the process stands, and what the report says. */
function recordStatus(rec) {
    const logText = readText(rec.log);
    const exit = logText === null ? null : exitCodeOf(logText);
    let processState;
    if (exit !== null) processState = 'exited';
    else processState = pidLiveness(rec.pid) === 'alive' ? 'running' : 'unknown';
    const reportText = readText(rec.report);
    let result = 'none';
    let sentence = null;
    if (reportText !== null) {
        const parsed = parseResult(reportText, rec.code);
        result = parsed ? parsed.state : 'unparseable';
        sentence = parsed ? parsed.sentence : null;
    }
    return {
        code: rec.code, pid: rec.pid, startedAt: rec.startedAt, process: processState, exit,
        result, sentence, reportExists: reportText !== null, settled: rec.state === 'settled',
        log: rec.log, report: rec.report,
    };
}

function status(opts) {
    if (opts.code) requireCode(opts);
    const file = path.resolve(opts.ledger || defaultLedger());
    let ledger;
    try {
        if (!fs.existsSync(file)) fault('ledger-unreadable', `${file}: does not exist`);
        ledger = readLedger(file);
    } catch (e) {
        return { ledger: file, readable: false, population: `could not read ${file}: ${e.message}`, records: [] };
    }
    const records = ledger.records.filter((r) => !opts.code || r.code === opts.code).map(recordStatus);
    const population = `${file}: ${ledger.records.length} record(s)${opts.code ? `, ${records.length} for ${opts.code}` : ''}`;
    return { ledger: file, readable: true, recordsRead: ledger.records.length, population, records };
}

function statusLines(value) {
    const lines = [value.population];
    for (const r of value.records) {
        lines.push(`${r.code} pid=${r.pid} process=${r.process} exit=${r.exit === null ? '-' : r.exit} `
            + `result=${r.result} settled=${r.settled}${r.sentence ? ` : ${r.sentence}` : ''}`);
    }
    return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- settle
function settle(opts) {
    const code = requireCode(opts);
    const file = path.resolve(opts.ledger || defaultLedger());
    return withLedger(file, (ledger) => {
        const rec = ledger.records.filter((r) => r.code === code && isUnsettled(r)).pop();
        if (!rec) fault('unknown-code', `no unsettled record for ${code} in ${file}`);
        const logText = readText(rec.log);
        const exit = logText === null ? null : exitCodeOf(logText);
        if (exit === null) fault('not-exited', `${rec.log} has no CLAUDE_EXIT line yet; the worker is running or its supervisor never wrote one`);
        const reportText = readText(rec.report);
        const parsed = reportText === null ? null : parseResult(reportText, code);
        if (!parsed) {
            fault('no-result', reportText === null
                ? `${rec.report} does not exist`
                : `${rec.report} has no line matching RESULT ${code} done|stopped|failed: <sentence>`);
        }
        const settledAt = new Date().toISOString();
        Object.assign(rec, { state: 'settled', result: parsed.state, sentence: parsed.sentence, exit, settledAt });
        return { code, state: parsed.state, sentence: parsed.sentence, exit, report: rec.report, settledAt };
    });
}

/** The liveness classifier over the shapes a real kill(pid, 0) can return. */
function selftest() {
    const cases = {
        noError: livenessFromError(null),
        ESRCH: livenessFromError({ code: 'ESRCH' }),
        EPERM: livenessFromError({ code: 'EPERM' }),
        ownPid: pidLiveness(process.pid),
        eperm: pidLiveness(process.pid, () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }),
        esrch: pidLiveness(process.pid, () => { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }),
        notAPid: pidLiveness(0),
    };
    const ok = cases.noError === 'alive' && cases.ESRCH === 'dead' && cases.EPERM === 'alive'
        && cases.ownPid === 'alive' && cases.eperm === 'alive' && cases.esrch === 'dead' && cases.notAPid === 'dead';
    if (!ok) fault('selftest-failed', JSON.stringify(cases));
    return { selftest: 'pass', cases };
}

function run(argv) {
    const opts = parseArgs(argv);
    if (opts.help || opts._.length === 0) return { help: true };
    const cmd = opts._[0];
    if (cmd === 'start') return start(opts);
    if (cmd === 'supervise') return supervise(opts);
    if (cmd === 'status') return status(opts);
    if (cmd === 'settle') return settle(opts);
    if (cmd === 'selftest') return selftest();
    fault('usage', `unknown command ${cmd}`);
}

if (require.main === module) {
    try {
        const cmd = process.argv[2];
        const value = run(process.argv.slice(2));
        if (value.help) process.stdout.write(USAGE);
        else if (cmd === 'status' && !process.argv.includes('--json')) process.stdout.write(statusLines(value));
        else process.stdout.write(JSON.stringify({ ok: true, value }) + '\n');
        if (process.exitCode === undefined) process.exitCode = 0;
    } catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: { code: e.publicCode || 'internal', message: e.message } }) + '\n');
        process.exitCode = 1;
    }
}

module.exports = {
    HEADLESS_NOTE, PROMPT_MAX, CODE_RE, SCRUBBED_ENV,
    parseArgs, composePrompt, buildArgv, buildEnv, spawnPlan, exitCodeOf, parseResult,
    livenessFromError, pidLiveness, recordStatus, run,
};
