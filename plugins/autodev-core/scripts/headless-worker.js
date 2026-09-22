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
 * prompt before relying on it, and again after a CLI upgrade. `--effort` and
 * its values were read from `claude --help` on 2.1.278 (see EFFORT_LEVELS).
 *
 * FAKE BINARY CONVENTION. A `--claude-bin` ending in `.js` is run through the
 * current node executable (`process.execPath <file> ...`), so a suite can stand
 * in a script for the real binary without a shell or a shebang. Anything else
 * is spawned as given, with no shell. On Windows a bare name is first resolved
 * to an `.exe` on PATH or to the npm shim's executable (see resolveClaudeBin);
 * a `.cmd` shim itself is never spawned.
 *
 * Usage:
 *   node headless-worker.js start --code <CODE> --prompt-file <md> --log <file>
 *        [--report <file>] [--config-dir <dir>] [--model <id>] [--effort <level>]
 *        [--permission-mode <mode>] [--cwd <dir>] [--claude-bin <path>] [--ledger <file>] [--dry-run]
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
    '            [--report <file>] [--config-dir <dir>] [--model <id>] [--effort <level>]',
    '            [--permission-mode <mode>] [--cwd <dir>] [--claude-bin <path>] [--ledger <file>] [--dry-run]',
    '       node headless-worker.js supervise ... (internal: the detached child that owns claude)',
    '       node headless-worker.js status [--code <CODE>] [--ledger <file>] [--json]',
    '       node headless-worker.js settle --code <CODE> [--ledger <file>] [--json]',
    '       node headless-worker.js selftest',
    'start: spawn a detached supervisor that runs `claude -p` and appends CLAUDE_EXIT=<code> to the log.',
    '       The caller may exit at once; the result is the report file plus that exit line.',
    '       --config-dir is an absolute path, ~ or ~/<name>. A bare relative name is refused, and so is',
    '       a directory that does not exist, before anything is spawned or recorded.',
    '       --effort is one of low|medium|high|xhigh|max, passed to claude as --effort <level>; omitted, argv has no --effort.',
    'status: two axes per record, process (running|exited|unknown) and result (none|done|stopped|failed|unparseable).',
    '        A record started before this boot is unknown whatever its pid says; settled records leave after 7 days.',
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
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const EXIT_LINE_RE = /^CLAUDE_EXIT=(-?\d+)\s*$/m;
// `[measured 2026-09-21]` claude 2.1.278 `--help`: "--effort <level>  Effort
// level for the current session (low, medium, high, xhigh, max)". A value
// outside this list is refused here, before a worker dies on it after spawning.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

const HEADLESS_NOTE = 'HEADLESS: this process exits the moment the turn ends, so run every gate and long '
    + 'command in the FOREGROUND with the Bash timeout at its maximum, background nothing, and do not end '
    + 'the turn until the report file is complete and carries its RESULT line.';

// `[measured 2026-09-22]` briefs said "a new worktree" and `cmd > f.log` without
// saying WHERE, so workers resolved both against whatever directory they stood
// in: 12 worktrees landed as siblings in the directory holding the checkouts
// (`../<repo>-<topic>`, `<code root>/<topic>`), and one worker wrote 37
// log, diff and exit files straight into it. A location the prompt does not
// name is a location the worker invents, so every prompt names both.
function placementNote(scratchDir) {
    return 'PLACEMENT: a git worktree goes INSIDE its repo, at <repo>/.claude/worktrees/<name> '
        + '(`git -C <repo> worktree add .claude/worktrees/<name> -b <branch> origin/main`), never beside the repo '
        + 'and never in the directory that holds the checkouts. A bare clone is scratch too. Logs, diffs, exit '
        + `files and every other scratch output go under ${scratchDir.replace(/\\/g, '/')}, never in a checkout's parent directory.`;
}

function fault(code, message) { const e = new Error(message || code); e.publicCode = code; throw e; }

function parseArgs(argv) {
    const out = { _: [] };
    const flags = ['help', 'dry-run', 'json'];
    const known = ['_', ...flags, 'code', 'prompt-file', 'log', 'report', 'config-dir', 'model', 'effort',
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

/**
 * Drop settled records older than RETENTION_MS, by their settledAt (or
 * startedAt for a hand-written one). Only settled records go: an unsettled
 * record is a claim about a worker somebody has not read yet, whatever its
 * age. Returns how many were removed. Runs inside every locked write, so the
 * ledger is pruned by the traffic that grows it and never by a reader.
 */
function pruneSettled(ledger, nowMs) {
    const before = ledger.records.length;
    ledger.records = ledger.records.filter((r) => {
        if (r.state !== 'settled') return true;
        const t = Date.parse(r.settledAt || r.startedAt || '');
        return !Number.isFinite(t) || nowMs - t <= RETENTION_MS;
    });
    return before - ledger.records.length;
}

/** Lock, read, prune, apply `fn(ledger)`, write, unlock. Returns what `fn` returned. */
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
        pruneSettled(ledger, Date.now());
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
function composePrompt(text, scratchDir) {
    const placement = scratchDir ? placementNote(scratchDir) + '\n\n' : '';
    return text.replace(/\s+$/, '') + '\n\n' + placement + HEADLESS_NOTE + '\n';
}

/** Where a worker's scratch output belongs: a directory named for its code, beside its report. */
function scratchDirFor(o) { return path.join(path.dirname(o.report), o.code); }

function readPrompt(file, scratchDir) {
    if (!file) fault('usage', '--prompt-file is required');
    if (!fs.existsSync(file)) fault('prompt-missing', `${file} does not exist`);
    const prompt = composePrompt(fs.readFileSync(file, 'utf8'), scratchDir);
    if (prompt.length > PROMPT_MAX) {
        fault('prompt-too-long', `the prompt is ${prompt.length} characters after the placement and headless notes and the cap is ${PROMPT_MAX}: `
            + 'it travels in argv, so write a short pointer prompt that names a file to read');
    }
    return prompt;
}

function buildArgv({ claudeBin, prompt, model, effort, permissionMode }) {
    return [claudeBin, '-p', prompt, ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []),
        '--permission-mode', permissionMode, '--output-format', 'stream-json', '--verbose'];
}

function requireEffort(value) {
    if (!EFFORT_LEVELS.includes(value)) fault('usage', `--effort must be one of ${EFFORT_LEVELS.join(', ')}, the levels claude --help lists; got ${value}`);
    return value;
}

/**
 * --config-dir picks the ACCOUNT a worker runs as, so its meaning must not
 * depend on where the launcher stands. `~` and `~/...` expand to the home
 * directory and an absolute path is taken as given. A bare relative name is
 * refused: `[measured 2026-09-21]` `--config-dir .claude-b` resolved against
 * the launcher's cwd, named a directory that did not exist, and the worker
 * died in 1 s with "Not logged in". Three bases were plausible for that name
 * (the launcher's cwd, --cwd, home), and a guessed account is worse than a
 * refusal that prints the spelling that works.
 */
function resolveConfigDir(raw) {
    const tilde = /^~(?:[\\/](.*))?$/.exec(raw);
    if (tilde) return path.resolve(homeDir(), tilde[1] || '');
    if (path.isAbsolute(raw)) return path.resolve(raw);
    fault('config-dir-relative', `--config-dir ${raw} is relative, so its meaning would depend on the launcher's cwd; `
        + `pass ~/${raw} for ${path.join(homeDir(), raw)}, or an absolute path`);
}

/**
 * Called by `start` only, dry run included, so the preview refuses what the
 * real start would. Never by the supervisor: its stdio is ignored, so a throw
 * there would end it with no CLAUDE_EXIT line for a poller to read.
 */
function requireConfigDirExists(dir) {
    let st;
    try { st = fs.statSync(dir); } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') fault('config-dir-missing', `--config-dir resolved to ${dir}, which does not exist, so a worker started there has no login`);
        fault('config-dir-unusable', `--config-dir resolved to ${dir}, which could not be read (${e.code || e.message})`);
    }
    if (!st.isDirectory()) fault('config-dir-unusable', `--config-dir resolved to ${dir}, which is not a directory`);
}

/**
 * A bare binary name on Windows. spawn() without a shell resolves PATH for
 * `.exe` only, and the npm global install puts a `claude.cmd` shim on PATH
 * whose real executable sits beside it under `node_modules`. `[measured
 * 2026-09-16]` `--claude-bin claude` on such a machine logged
 * CLAUDE_SPAWN_ERROR=ENOENT while the `.exe` two directories down ran fine.
 * So a bare name is resolved here: `<dir>/<name>.exe` on any PATH entry, then
 * the npm shim layout `<dir>/node_modules/@anthropic-ai/claude-code/bin/<name>.exe`
 * next to a `<dir>/<name>.cmd`. Anything with a separator or an extension, and
 * every other platform, comes back unchanged; an unresolved name still spawns
 * as given and surfaces in the log as before.
 */
function resolveClaudeBin(name, { platform = process.platform, pathEnv = process.env.PATH || process.env.Path || '', exists = fs.existsSync } = {}) {
    if (platform !== 'win32') return name;
    if (!name || /[\\/]/.test(name) || path.extname(name)) return name;
    for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
        const exe = path.join(dir, name + '.exe');
        if (exists(exe)) return exe;
        const shim = path.join(dir, name + '.cmd');
        if (!exists(shim)) continue;
        const npmExe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', name + '.exe');
        if (exists(npmExe)) return npmExe;
    }
    return name;
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
    // Checked before path.resolve: resolving an empty string yields the cwd,
    // which exists and is a directory, so the omission used to surface as an
    // EISDIR read reported under code internal instead of usage.
    if (!opts['prompt-file']) fault('usage', '--prompt-file is required');
    const log = path.resolve(opts.log);
    return {
        code,
        log,
        report: path.resolve(opts.report || defaultReport(log)),
        promptFile: path.resolve(opts['prompt-file']),
        configDir: opts['config-dir'] ? resolveConfigDir(opts['config-dir']) : null,
        model: opts.model || null,
        effort: opts.effort ? requireEffort(opts.effort) : null,
        permissionMode: opts['permission-mode'] || 'default',
        cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd(),
        claudeBin: resolveClaudeBin(opts['claude-bin'] || 'claude'),
        ledger: path.resolve(opts.ledger || defaultLedger()),
    };
}

/** The flags `start` hands its supervisor: the same options, spelled out. */
function supervisorFlags(o) {
    const flags = ['--code', o.code, '--log', o.log, '--prompt-file', o.promptFile,
        '--permission-mode', o.permissionMode, '--cwd', o.cwd, '--claude-bin', o.claudeBin];
    if (o.model) flags.push('--model', o.model);
    if (o.effort) flags.push('--effort', o.effort);
    if (o.configDir) flags.push('--config-dir', o.configDir);
    return flags;
}

function start(opts) {
    const o = startOptions(opts);
    if (o.configDir) requireConfigDirExists(o.configDir);
    const prompt = readPrompt(o.promptFile, scratchDirFor(o));
    const argv = buildArgv({ claudeBin: o.claudeBin, prompt, model: o.model, effort: o.effort, permissionMode: o.permissionMode });
    const plan = buildEnv(process.env, { code: o.code, configDir: o.configDir });
    if (opts['dry-run']) {
        return {
            dryRun: true, code: o.code, argv, command: spawnPlan(argv).command,
            envSet: plan.set, envDeleted: plan.deleted, envScrubList: plan.scrubList,
            configDir: o.configDir, effort: o.effort,
            log: o.log, report: o.report, scratchDir: scratchDirFor(o), ledger: o.ledger, cwd: o.cwd, spawned: false,
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
        model: o.model, effort: o.effort, permissionMode: o.permissionMode, state: 'starting',
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
    const prompt = readPrompt(o.promptFile, scratchDirFor(o));
    const argv = buildArgv({ claudeBin: o.claudeBin, prompt, model: o.model, effort: o.effort, permissionMode: o.permissionMode });
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

/** Epoch ms of the current boot, the test fleet-registry.js uses. A record started before it cannot be running. */
function bootAt() { return Date.now() - os.uptime() * 1000; }

/**
 * Two axes for one record: how the process stands, and what the report says.
 * A record whose startedAt precedes this boot is `unknown` whatever the pid
 * says: a pid is reused after a reboot, and a supervisor the reboot killed
 * never wrote its exit line, so the pid alone would report a stranger's
 * process as this worker, running, forever.
 */
function recordStatus(rec, boot = bootAt()) {
    const logText = readText(rec.log);
    const exit = logText === null ? null : exitCodeOf(logText);
    const started = Date.parse(rec.startedAt || '');
    let processState;
    if (exit !== null) processState = 'exited';
    else if (Number.isFinite(boot) && Number.isFinite(started) && started < boot) processState = 'unknown';
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
    const boot = bootAt();
    const records = ledger.records.filter((r) => !opts.code || r.code === opts.code).map((r) => recordStatus(r, boot));
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
    HEADLESS_NOTE, PROMPT_MAX, CODE_RE, placementNote, SCRUBBED_ENV, RETENTION_MS,
    parseArgs, composePrompt, buildArgv, buildEnv, spawnPlan, resolveClaudeBin, exitCodeOf, parseResult,
    livenessFromError, pidLiveness, bootAt, pruneSettled, recordStatus, run,
};
