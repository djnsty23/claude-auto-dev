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
 *        [--permission-mode <mode>] [--cwd <dir>] [--claude-bin <path>] [--ledger <file>] [--dry-run] [--dev]
 *   node headless-worker.js supervise --code <CODE> --log <file> --prompt-file <md> ...   (internal)
 *   node headless-worker.js status [--code <CODE>] [--ledger <file>] [--json]
 *   node headless-worker.js settle --code <CODE> [--lost] [--unreported] [--ledger <file>] [--json]
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
const claudePaths = require('./claude-paths.js');
const { spawn, spawnSync } = require('node:child_process');

const USAGE = [
    'Usage: node headless-worker.js start --code <CODE> --prompt-file <md> --log <file>',
    '            [--report <file>] [--config-dir <dir>] [--model <id>] [--effort <level>]',
    '            [--permission-mode <mode>] [--cwd <dir>] [--claude-bin <path>] [--ledger <file>] [--dry-run] [--dev]',
    '       node headless-worker.js supervise ... (internal: the detached child that owns claude)',
    '       node headless-worker.js status [--code <CODE>] [--ledger <file>] [--json]',
    '       node headless-worker.js settle --code <CODE> [--lost] [--unreported] [--ledger <file>] [--json]',
    '       node headless-worker.js selftest',
    'start: spawn a detached supervisor that runs `claude -p` and appends CLAUDE_EXIT=<code> to the log.',
    '       The caller may exit at once; the result is the report file plus that exit line.',
    '       --config-dir is an absolute path, ~ or ~/<name>. A bare relative name is refused, and so is',
    '       a directory that does not exist, before anything is spawned or recorded.',
    '       --effort is one of low|medium|high|xhigh|max, passed to claude as --effort <level>; omitted, argv has no --effort.',
    '       start refuses a script outside a plugin cache, because a worker started from a checkout runs code no',
    '       release shipped. --dev runs the checkout on purpose. Every record names the version and script that ran.',
    'status: two axes per record, process (running|exited|unknown) and result (none|done|stopped|failed|unparseable).',
    '        An unparseable report whose RESULT line names another code says so: RESULT line found for a different code.',
    '        A record started before this boot is unknown whatever its pid says; settled records leave after 7 days.',
    'settle: read the last RESULT <CODE> line of the report and mark the record settled.',
    'settle --lost: settle a record whose supervisor died without an exit line, as result lost. Refused unless',
    '        the record started before this boot, or its pid is dead with no exit line. A record with an exit line',
    '        takes plain settle. A lost record is its own result, never done, stopped or failed.',
    'settle --unreported: settle a record whose worker exited without a RESULT <CODE> line, as result unreported.',
    '        Refused while the log has no exit line (that is --lost), while the report has a RESULT line, and while',
    '        <report dir>/<CODE>/<report name> has one (a report written into the scratch dir: move it, then settle).',
    '        An unreported record is its own result, never done, stopped or failed.',
    'ask:    a worker asks by writing <report dir>/<CODE>/ask.json and keeps working. status shows ask=open',
    '        until answer.json lands beside it. No worker exits to ask.',
    'rerun:  a later record at the same code supersedes an earlier one. The earlier one reads ask=superseded, and',
    '        result=superseded with no exit from the log wherever it still shares the later run\'s report or log path.',
    'Not unattended-worker.js: that one composes scheduled-task calls and starts nothing.',
    `Default ledger: ${path.join('~', '.claude', 'autodev', 'headless-workers.json')}`,
].join('\n') + '\n';

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,23}$/;
const PROMPT_MAX = 8000;
const RESULT_STATES = ['done', 'stopped', 'failed'];
// What a SETTLED record's `result` field can hold: a RESULT line's state, or
// `lost` for a record settled by `settle --lost`, or `unreported` for one settled
// by `settle --unreported`. Kept apart from RESULT_STATES on purpose: neither is
// ever parsed from a report, so a worker cannot claim one.
const SETTLED_RESULTS = [...RESULT_STATES, 'lost', 'unreported'];
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

// `[measured 2026-09-23]` in one fleet's worker transcripts the auto-mode
// permission classifier refused four action classes: Production Deploy (19),
// Secret-Store Writes (9), Production Reads (8) and Modify Shared Resources (3).
// A worker that met one exited, and its relaunch met it again. Named up front,
// each becomes one line for a person to run in the next release window.
const DENIED_NOTE = 'DENIED UP FRONT: expect the permission classifier to refuse Production Deploy, Secret-Store Writes, '
    + 'Production Reads and Modify Shared Resources in this run. Do not attempt them and do not stop on them: list each one '
    + 'you need under a "Release window" heading in the report, with the exact command, and carry on with the rest.';

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

// `[measured 2026-09-22]` workers asked by exiting ("write the question into
// the report and stop"), so every question cost a relaunch and the context the
// worker had built. A launcher with a non-exiting ask.json/answer.json channel
// answered 11 of 11 questions without one. This is that channel: the files sit
// in the worker's scratch directory, which the placement note already names,
// and `status` reports an open question until answer.json lands.
function askFiles(scratchDir) {
    return { ask: path.join(scratchDir, 'ask.json'), answer: path.join(scratchDir, 'answer.json') };
}

function askNote(scratchDir, code = path.basename(scratchDir)) {
    const f = askFiles(scratchDir);
    const slash = (p) => p.replace(/\\/g, '/');
    return `ASKING: never exit to ask. When a decision needs a person, write ${slash(f.ask)} as JSON `
        + '{"question","header","asked","blocks","options":[{"label","detail"}]}, the option you would take first and marked (Recommended). '
        + `Keep working on everything that does not depend on it, and read ${slash(f.answer)} ({"label","note"}) between steps. `
        + `Only when nothing independent is left, record the open question in the report and end with RESULT ${code} stopped. `
        + 'Never guess the answer and never read silence as approval.';
}

// `[measured 2026-09-23]` reports ended `RESULT DESIGN done:` while the ledger
// code was `W2-DESIGN`, and the same for SWEEP: the prompt said `RESULT <CODE>`
// and each worker filled in a code of its own. parseResult anchors on the exact
// code, so both records read unparseable and could not be settled. The prompt
// now carries the ledger code verbatim.
function resultNote(code, report) {
    return `RESULT: the last line of ${report.replace(/\\/g, '/')} is \`RESULT ${code} done|stopped|failed: <one sentence>\`, `
        + `with the code exactly ${code}. Any other spelling of it reads as unparseable, and the run cannot be settled.`;
}

// `[measured 2026-09-23]` after an install, 11 of 12 workers ran this script
// from a worktree rather than the installed plugin: the launching session
// called the checkout it stood in. They ran code no release shipped, and no
// record said so. So start refuses a script outside a plugin cache unless
// --dev says that is intended, and every record names the version that ran.
function scriptPlacement(file = __filename) {
    const script = path.resolve(file);
    const installed = /\/plugins\/cache\//i.test(script.replace(/\\/g, '/'));
    let version = null;
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(script), '..', '.claude-plugin', 'plugin.json'), 'utf8'));
        version = typeof manifest.version === 'string' && manifest.version ? manifest.version : null;
    } catch { version = null; }
    return { script, installed, version };
}

function fault(code, message) { const e = new Error(message || code); e.publicCode = code; throw e; }

function parseArgs(argv) {
    const out = { _: [] };
    const flags = ['help', 'dry-run', 'json', 'lost', 'unreported', 'dev'];
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
function defaultLedger() { return path.join(claudePaths.configDir(), 'autodev', 'headless-workers.json'); }
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
function composePrompt(text, scratchDir, { code = null, report = null } = {}) {
    const notes = [];
    if (scratchDir) notes.push(placementNote(scratchDir), askNote(scratchDir, code || path.basename(scratchDir)));
    if (code && report) notes.push(resultNote(code, report));
    notes.push(DENIED_NOTE, HEADLESS_NOTE);
    return text.replace(/\s+$/, '') + '\n\n' + notes.join('\n\n') + '\n';
}

/** Where a worker's scratch output belongs: a directory named for its code, beside its report. */
function scratchDirFor(o) { return path.join(path.dirname(o.report), o.code); }

// `[measured 2026-09-24]` two workers finished done, PRs green, and wrote
// REPORT.md into their scratch dir, one level below the ledger's report path.
// Their prompts named the scratch dir and not the report file. The ledger read
// the empty path, so both looked like workers that left no report, and settle
// --unreported would have filed two finished PRs as unreported. So settle looks
// in that one place, names the file, and never settles past it.
/** The report file under the record's scratch dir, when it carries this code's RESULT line. */
function misplacedReport(rec) {
    if (!rec.report || !rec.code) return null;
    const alt = path.join(scratchDirFor(rec), path.basename(rec.report));
    if (path.resolve(alt) === path.resolve(rec.report)) return null;
    const text = readText(alt);
    if (text === null || writtenBefore(alt, rec.startedAt)) return null;
    return parseResult(text, rec.code) ? alt : null;
}

function misplacedHint(moved, rec) {
    return `${moved} has a RESULT ${rec.code} line: the worker wrote its report into its scratch dir. `
        + `Move that file to ${rec.report}, then settle again`;
}

/** True when the file was last written more than a second before the run started: it belongs to an earlier run. */
function writtenBefore(file, startedAt) {
    const t = Date.parse(startedAt || '');
    if (!Number.isFinite(t)) return false;
    try { return fs.statSync(file).mtimeMs < t - 1000; } catch { return false; }
}

function staleHint(rec) {
    let at = 'earlier';
    try { at = new Date(fs.statSync(rec.report).mtimeMs).toISOString(); } catch { /* gone since the check */ }
    return `${rec.report} was last written at ${at}, before this run started at ${rec.startedAt}, so its RESULT line `
        + 'belongs to an earlier run of the same code. Wait for this run to write its own report, or move the old one aside and settle again';
}

// `[measured 2026-09-24]` a rerun at the same code appended to the previous
// run's log and found its report. ACCESS-ALL and BLOG read "exited, stopped"
// from their first runs while the reruns worked, a cap that counted reports
// let three workers run against a limit of one, and a plain settle would have
// filed each live worker under the previous run's result. So start moves the
// previous run's files aside before it spawns, and the settled records that
// named them follow the files.
/** The files an earlier run of this code left where the new run will write, in a fixed order. */
function priorRunFiles(o) {
    const scratch = scratchDirFor(o);
    const ask = askFiles(scratch);
    const all = [o.log, o.report, path.join(scratch, path.basename(o.report)), ask.ask, ask.answer].map((p) => path.resolve(p));
    return all.filter((p, i) => all.indexOf(p) === i && fs.existsSync(p));
}

function asideName(file, stamp) {
    const ext = path.extname(file);
    return path.join(path.dirname(file), `${path.basename(file, ext)}.prev-${stamp}${ext}`);
}

/** Rename each file aside, all or none: a failure puts back what already moved and refuses the start. */
function moveAside(files, stamp) {
    const moved = [];
    try {
        for (const from of files) { const to = asideName(from, stamp); fs.renameSync(from, to); moved.push({ from, to }); }
    } catch (e) {
        for (const m of moved.reverse()) { try { fs.renameSync(m.to, m.from); } catch { /* reported below */ } }
        fault('move-aside-failed', `could not move an earlier run's files aside before starting (${e.code || e.message}). `
            + `Nothing was started. Files: ${files.join(', ')}`);
    }
    return moved;
}

function readPrompt(file, scratchDir, o = {}) {
    if (!file) fault('usage', '--prompt-file is required');
    if (!fs.existsSync(file)) fault('prompt-missing', `${file} does not exist`);
    const prompt = composePrompt(fs.readFileSync(file, 'utf8'), scratchDir, { code: o.code, report: o.report });
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
        dev: opts.dev === true,
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
    const placement = scriptPlacement();
    if (!placement.installed && !o.dev) {
        fault('not-installed', `${placement.script} is not inside a plugin cache, so a worker started from it runs code no release shipped. `
            + 'Run the installed copy under <config dir>/plugins/cache/, or pass --dev to run this checkout on purpose');
    }
    if (o.configDir) requireConfigDirExists(o.configDir);
    const prompt = readPrompt(o.promptFile, scratchDirFor(o), o);
    const argv = buildArgv({ claudeBin: o.claudeBin, prompt, model: o.model, effort: o.effort, permissionMode: o.permissionMode });
    const plan = buildEnv(process.env, { code: o.code, configDir: o.configDir });
    if (opts['dry-run']) {
        return {
            dryRun: true, code: o.code, argv, command: spawnPlan(argv).command,
            envSet: plan.set, envDeleted: plan.deleted, envScrubList: plan.scrubList,
            configDir: o.configDir, effort: o.effort,
            script: placement.script, version: placement.version, installed: placement.installed, dev: o.dev,
            log: o.log, report: o.report, scratchDir: scratchDirFor(o), ledger: o.ledger, cwd: o.cwd, spawned: false,
            wouldMoveAside: priorRunFiles(o),
        };
    }
    // RESERVE, THEN SPAWN, THEN FILL IN. The code is reserved inside the lock
    // before anything is spawned, so a refusal (ledger-locked, or a code that
    // gained an unsettled record meanwhile) exits 1 with NO process running.
    // The order used to be spawn first and write second, and a refusal in the
    // write left a real worker running that no ledger named.
    const record = {
        code: o.code, pid: null, supervisorImage: path.basename(process.execPath).toLowerCase(), startedAt: new Date().toISOString(),
        log: o.log, report: o.report, promptFile: o.promptFile,
        configDir: o.configDir ? path.basename(o.configDir) : null,
        version: placement.version, script: placement.script, dev: !placement.installed,
        model: o.model, effort: o.effort, permissionMode: o.permissionMode, cwd: o.cwd, state: 'starting',
    };
    const isReservation = (r) => r.code === o.code && r.state === 'starting' && r.startedAt === record.startedAt;
    withLedger(o.ledger, (ledger) => {
        if (ledger.records.some((r) => r.code === o.code && isUnsettled(r))) {
            fault('code-active', `${o.code} has an unsettled record in ${o.ledger}; settle it or pick another code`);
        }
        const moved = moveAside(priorRunFiles(o), record.startedAt.replace(/[-:.]/g, ''));
        const to = new Map(moved.map((m) => [m.from, m.to]));
        for (const r of ledger.records) {
            if (r.code !== o.code) continue;
            for (const k of ['log', 'report']) if (r[k] && to.has(path.resolve(r[k]))) r[k] = to.get(path.resolve(r[k]));
        }
        if (moved.length) record.movedAside = moved.map((m) => m.to);
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
    const prompt = readPrompt(o.promptFile, scratchDirFor(o), o);
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

/**
 * The image holding a pid, lowercased and without a directory, or null when it
 * cannot be read. `[measured 2026-09-24]` a supervisor pid, 62756, had died and
 * been reused by msedgewebview2.exe within the same boot, so kill(pid, 0)
 * answered alive and the ledger kept the worker as running.
 */
function pidImage(pid, run = spawnSync, platform = process.platform) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
        if (platform === 'win32') {
            const r = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
            if (!r || r.status !== 0) return null;
            const m = String(r.stdout).match(/^"([^"]+)","(\d+)"/m);
            return m && Number(m[2]) === pid ? m[1].toLowerCase() : null;
        }
        const r = run('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 5000 });
        if (!r || r.status !== 0) return null;
        const t = String(r.stdout).trim();
        return t ? path.basename(t).toLowerCase() : null;
    } catch {
        return null;
    }
}

/** The image a record's supervisor was started as. A record written before the field existed ran node. */
function isSupervisorImage(rec, seen) {
    const want = String((rec && rec.supervisorImage) || '').toLowerCase();
    return want ? seen === want : /^node(?:\.exe)?$/.test(seen);
}

/**
 * `alive`, `dead` or `reused` for a record's supervisor pid. `reused` is a pid
 * that answers kill(pid, 0) while another image holds it. An image that cannot
 * be read leaves the answer `alive`: not knowing is not proof the supervisor
 * is gone.
 */
function supervisorLiveness(rec, { probe, image = pidImage } = {}) {
    const l = pidLiveness(rec.pid, probe);
    if (l !== 'alive') return l;
    const seen = image(rec.pid);
    return seen && !isSupervisorImage(rec, seen) ? 'reused' : 'alive';
}

/** The LAST `RESULT <code> <state>: <sentence>` line for this exact code, or null. */
function parseResult(reportText, code) {
    const re = new RegExp(`^RESULT\\s+${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(${RESULT_STATES.join('|')}):\\s*(.+)$`, 'gm');
    let last = null;
    for (const m of String(reportText).matchAll(re)) last = { state: m[1], sentence: m[2].trim() };
    return last;
}

/** The code on the last well-formed RESULT line that names a DIFFERENT code, or null. */
function otherResultCode(reportText, code) {
    const re = new RegExp(`^RESULT\\s+(\\S+)\\s+(?:${RESULT_STATES.join('|')}):`, 'gm');
    let last = null;
    for (const m of String(reportText).matchAll(re)) if (m[1] !== code) last = m[1];
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
 * process as this worker, running, forever. Within this boot, a pid that
 * another image now holds is `unknown` for the same reason.
 */
/**
 * The records after this one in the ledger at the same code and scratch dir.
 * Every run at one code shares the scratch dir, so the ask.json there is the
 * latest run's. A run from before start moved files aside can also share its
 * log and report path with the later run. `[measured 2026-09-24]` 17 of 182
 * live records had a later run at their code. All 17 shared its report path,
 * and 15 shared its log. Without `records` nothing is superseded.
 */
function laterRuns(rec, records) {
    const i = Array.isArray(records) ? records.indexOf(rec) : -1;
    if (i < 0 || !rec.report || !rec.code) return [];
    const scratch = path.resolve(scratchDirFor(rec));
    return records.slice(i + 1).filter((r) => r.code === rec.code && r.report && path.resolve(scratchDirFor(r)) === scratch);
}

function recordStatus(rec, boot = bootAt(), image = pidImage, records = null) {
    // A file a later run shares is that run's, so it says nothing about this
    // one. A settled record keeps the exit settle read while the log was its own.
    const later = laterRuns(rec, records);
    const shared = (k) => later.some((l) => l[k] && rec[k] && path.resolve(l[k]) === path.resolve(rec[k]));
    const ownLog = shared('log') ? null : rec.log;
    const ownReport = shared('report') ? null : rec.report;
    const logText = ownLog === null ? null : readText(ownLog);
    const exit = logText !== null ? exitCodeOf(logText) : (ownLog === null && Number.isInteger(rec.exit) ? rec.exit : null);
    const started = Date.parse(rec.startedAt || '');
    let processState;
    if (exit !== null) processState = 'exited';
    else if (ownLog === null) processState = 'unknown';
    else if (Number.isFinite(boot) && Number.isFinite(started) && started < boot) processState = 'unknown';
    else processState = supervisorLiveness(rec, { image }) === 'alive' ? 'running' : 'unknown';
    const reportText = ownReport === null ? null : readText(ownReport);
    let result = ownReport === null ? 'superseded' : 'none';
    let sentence = null;
    let resultCodeFound = null;
    const reportStale = reportText !== null && writtenBefore(rec.report, rec.startedAt);
    if (reportStale) result = 'stale';
    else if (reportText !== null) {
        const parsed = parseResult(reportText, rec.code);
        result = parsed ? parsed.state : 'unparseable';
        sentence = parsed ? parsed.sentence : null;
        resultCodeFound = parsed ? null : otherResultCode(reportText, rec.code);
    }
    const misplaced = result === 'none' || result === 'stale' || (result === 'unparseable' && !resultCodeFound) ? misplacedReport(rec) : null;
    // The settled axis says HOW the record was settled, read from the ledger,
    // because `result` above is the report's word and a lost record's report
    // usually has none. A settled value outside SETTLED_RESULTS surfaces as
    // itself rather than being folded into a known one.
    const settled = rec.state === 'settled';
    const settledAs = settled ? (SETTLED_RESULTS.includes(rec.result) ? rec.result : `unrecognised:${rec.result}`) : null;
    return {
        code: rec.code, pid: rec.pid, startedAt: rec.startedAt, process: processState, exit,
        result, sentence, resultCodeFound, reportExists: reportText !== null, reportStale, misplacedReport: misplaced, settled, settledAs,
        version: rec.version || null, dev: rec.dev === true,
        lostReason: settledAs === 'lost' ? (rec.reason || null) : null,
        settleReason: settledAs === 'lost' || settledAs === 'unreported' ? (rec.reason || null) : null,
        log: ownLog, report: ownReport, cwd: rec.cwd || null,
        supersededBy: later.length ? later[later.length - 1].startedAt || null : null,
        ...(later.length ? { ask: 'superseded', question: null, askFile: null, answerFile: null } : askState(rec)),
    };
}

/**
 * The question channel for one record: `open` while ask.json exists without
 * answer.json, `answered` once both do, `none` otherwise. An ask.json that does
 * not parse is still a question somebody asked (`unreadable`), never silence.
 */
function askState(rec) {
    if (!rec.report || !rec.code) return { ask: 'none', question: null, askFile: null, answerFile: null };
    const f = askFiles(scratchDirFor({ report: rec.report, code: rec.code }));
    const askText = readText(f.ask);
    if (askText === null) return { ask: 'none', question: null, askFile: f.ask, answerFile: f.answer };
    let question = null;
    try { question = String(JSON.parse(askText).question || '') || null; } catch { question = null; }
    const answered = readText(f.answer) !== null;
    return { ask: answered ? 'answered' : (question === null ? 'unreadable' : 'open'), question, askFile: f.ask, answerFile: f.answer };
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
    const records = ledger.records.filter((r) => !opts.code || r.code === opts.code).map((r) => recordStatus(r, boot, undefined, ledger.records));
    const population = `${file}: ${ledger.records.length} record(s)${opts.code ? `, ${records.length} for ${opts.code}` : ''}`;
    return { ledger: file, readable: true, recordsRead: ledger.records.length, population, records };
}

function statusLines(value) {
    const lines = [value.population];
    for (const r of value.records) {
        lines.push(`${r.code} pid=${r.pid} process=${r.process} exit=${r.exit === null ? '-' : r.exit} `
            + `result=${r.result}${r.resultCodeFound ? ` (RESULT line found for a different code: ${r.resultCodeFound})` : ''}`
            + `${r.misplacedReport ? ` (report written into the scratch dir: ${r.misplacedReport})` : ''} settled=${r.settled}${r.settledAs === 'lost' || r.settledAs === 'unreported' ? ` settledAs=${r.settledAs} (${r.settleReason})` : ''}`
            + `${r.ask !== 'none' ? ` ask=${r.ask}` : ''}${r.supersededBy ? ` supersededBy=${r.supersededBy}` : ''} version=${r.version || '-'}${r.dev ? '(dev)' : ''}${r.sentence ? ` : ${r.sentence}` : ''}`);
    }
    return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- settle
/**
 * Why a record with no exit line is provably not running, or null when it is
 * not provable. Three proofs, in order. A record started before this boot: the
 * reboot killed its supervisor, and its pid may now name a stranger, so the pid
 * is not consulted. A record started after this boot whose pid is dead: the
 * supervisor is gone without writing its line. A pid that another image now
 * holds: the supervisor is gone and its pid was reused. Anything else, including
 * an alive pid whose image cannot be read and a pid that was never recorded, is
 * not proof. The pid is the
 * SUPERVISOR's, so a claude child that outlived a killed supervisor is not
 * seen by the second proof. The first proof is the one that covers a reboot.
 */
function lostReason(rec, boot, liveness = pidLiveness, image = pidImage) {
    const started = Date.parse(rec.startedAt || '');
    if (Number.isFinite(boot) && Number.isFinite(started) && started < boot) {
        return `started ${rec.startedAt}, before this boot at ${new Date(boot).toISOString()}, and the log has no exit line`;
    }
    if (!Number.isInteger(rec.pid) || rec.pid <= 0) return null;
    if (liveness(rec.pid) === 'dead') return `pid ${rec.pid} is dead and the log has no exit line`;
    const seen = image(rec.pid);
    if (seen && !isSupervisorImage(rec, seen)) {
        return `pid ${rec.pid} is now ${seen}, not the supervisor (${rec.supervisorImage || 'node'}), and the log has no exit line`;
    }
    return null;
}

function settle(opts) {
    const code = requireCode(opts);
    const file = path.resolve(opts.ledger || defaultLedger());
    return withLedger(file, (ledger) => {
        const rec = ledger.records.filter((r) => r.code === code && isUnsettled(r)).pop();
        if (!rec) fault('unknown-code', `no unsettled record for ${code} in ${file}`);
        const logText = readText(rec.log);
        const exit = logText === null ? null : exitCodeOf(logText);
        if (opts.lost && opts.unreported) fault('usage', '--lost and --unreported name different endings: a worker with no exit line, and one that exited without a RESULT line. Pass one');
        if (opts.lost) return settleLost(rec, code, exit);
        if (opts.unreported) return settleUnreported(rec, code, exit);
        if (exit === null) {
            fault('not-exited', `${rec.log} has no CLAUDE_EXIT line yet, so the worker is running or its supervisor never wrote one. `
                + 'A supervisor killed by a reboot or a kill never writes it, and settle --lost settles such a record once it is provably not running');
        }
        const reportText = readText(rec.report);
        if (reportText !== null && writtenBefore(rec.report, rec.startedAt)) fault('stale-report', staleHint(rec));
        const parsed = reportText === null ? null : parseResult(reportText, code);
        if (!parsed) {
            const other = reportText === null ? null : otherResultCode(reportText, code);
            const moved = other ? null : misplacedReport(rec);
            fault('no-result', (reportText === null
                ? `${rec.report} does not exist`
                : other
                    ? `RESULT line found for a different code: ${rec.report} ends RESULT ${other}, and this record's code is ${code}. `
                        + `Correct that line to RESULT ${code} done|stopped|failed: <sentence>, then settle again`
                    : `${rec.report} has no line matching RESULT ${code} done|stopped|failed: <sentence>`)
                + (other ? '' : moved ? `. ${misplacedHint(moved, rec)}` : '. If the worker ended without one, settle --unreported records that it left none'));
        }
        const settledAt = new Date().toISOString();
        Object.assign(rec, { state: 'settled', result: parsed.state, sentence: parsed.sentence, exit, settledAt });
        return { code, state: parsed.state, sentence: parsed.sentence, exit, report: rec.report, settledAt };
    });
}

/** `settle --lost` inside the ledger lock. Mutates `rec` only when the record is provably not running. */
function settleLost(rec, code, exit) {
    if (exit !== null) fault('not-lost', `${rec.log} has CLAUDE_EXIT=${exit}, so the worker ended and was not lost. Settle it without --lost`);
    const reason = lostReason(rec, bootAt());
    if (!reason) {
        fault('not-lost', `${code} has no exit line but is not provably stopped: it started after this boot and pid ${rec.pid} `
            + `${Number.isInteger(rec.pid) && rec.pid > 0 ? 'is alive' : 'was never recorded'}. Wait for its exit line`);
    }
    // A report that did get written keeps its sentence, so what the worker said is not lost with it.
    const reportText = readText(rec.report);
    const parsed = reportText === null ? null : parseResult(reportText, code);
    const settledAt = new Date().toISOString();
    Object.assign(rec, {
        state: 'settled', result: 'lost', reason, sentence: parsed ? parsed.sentence : null,
        reportResult: parsed ? parsed.state : null, exit: null, settledAt,
    });
    return { code, state: 'lost', reason, sentence: rec.sentence, reportResult: rec.reportResult, exit: null, report: rec.report, settledAt };
}

/**
 * `settle --unreported` inside the ledger lock. `[measured 2026-09-24]` two
 * workers stopped on a full disk (ENOSPC), exited 0 and could not write their
 * report. --lost refused them (they have an exit line) and plain settle refused
 * them (no RESULT line), so each record stayed `running` and `start` refused
 * its code as code-active for good. This settles such a record as its own
 * result. It never guesses a worker's word: a report with a RESULT line for this
 * code takes plain settle, and one naming another code must be corrected first.
 */
function settleUnreported(rec, code, exit) {
    if (exit === null) {
        fault('not-exited', `${rec.log} has no CLAUDE_EXIT line, so the worker has not provably ended. `
            + 'settle --lost settles a record whose supervisor died without one');
    }
    const boot = bootAt();
    const started = Date.parse(rec.startedAt || '');
    const thisBoot = !(Number.isFinite(boot) && Number.isFinite(started) && started < boot);
    if (thisBoot && supervisorLiveness(rec) === 'alive') {
        fault('still-running', `${rec.log} has an exit line, but the supervisor pid ${rec.pid} is alive, so that line can belong to an `
            + 'earlier run appended to the same log. Settle once the supervisor has ended');
    }
    const reportText = readText(rec.report);
    if (reportText !== null && writtenBefore(rec.report, rec.startedAt)) fault('stale-report', staleHint(rec));
    if (reportText !== null && parseResult(reportText, code)) {
        fault('has-result', `${rec.report} has a RESULT ${code} line. Settle it without --unreported`);
    }
    const other = reportText === null ? null : otherResultCode(reportText, code);
    const moved = other ? null : misplacedReport(rec);
    if (moved) fault('misplaced-report', misplacedHint(moved, rec));
    if (other) {
        fault('no-result', `RESULT line found for a different code: ${rec.report} ends RESULT ${other}, and this record's code is ${code}. `
            + `Correct that line to RESULT ${code} done|stopped|failed: <sentence>, then settle again`);
    }
    const reason = reportText === null
        ? `exited ${exit} and ${rec.report} does not exist`
        : `exited ${exit} and ${rec.report} has no RESULT ${code} line`;
    const settledAt = new Date().toISOString();
    Object.assign(rec, { state: 'settled', result: 'unreported', reason, sentence: null, exit, settledAt });
    return { code, state: 'unreported', reason, sentence: null, exit, report: rec.report, settledAt };
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
        ownImage: pidImage(process.pid),
    };
    const ok = cases.noError === 'alive' && cases.ESRCH === 'dead' && cases.EPERM === 'alive'
        && cases.ownPid === 'alive' && cases.eperm === 'alive' && cases.esrch === 'dead' && cases.notAPid === 'dead'
        && (cases.ownImage === null ? process.platform !== 'win32' : isSupervisorImage({ supervisorImage: path.basename(process.execPath) }, cases.ownImage));
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
    HEADLESS_NOTE, DENIED_NOTE, PROMPT_MAX, CODE_RE, placementNote, resultNote, scriptPlacement, otherResultCode, SCRUBBED_ENV, RETENTION_MS, SETTLED_RESULTS,
    askFiles, askNote, askState, scratchDirFor, priorRunFiles, moveAside, readLedger, settle, start,
    parseArgs, composePrompt, buildArgv, buildEnv, spawnPlan, resolveClaudeBin, exitCodeOf, parseResult,
    livenessFromError, pidLiveness, pidImage, isSupervisorImage, supervisorLiveness, bootAt, pruneSettled, laterRuns, recordStatus, lostReason, run,
};
