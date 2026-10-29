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
 *        [--plugin-dir <dir>] [--keep-tools <Artifact,Workflow|all>] [--profile <builder>]
 *        [--attempt-id <id>] [--budget-ledger <file>] [--secret <NAME,...>]
 *   node headless-worker.js supervise --code <CODE> --log <file> --prompt-file <md> ...   (internal)
 *   node headless-worker.js status [--code <CODE>] [--ledger <file>] [--json]
 *   node headless-worker.js settle --code <CODE> [--started-at <iso>] [--lost] [--unreported] [--ledger <file>] [--json]
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
const capacity = require('./capacity.js');
const budget = require('./execution-budget.js');
const profiles = require('./worker-profiles.js');
const authority = require('./worker-authority.js');
const { spawn, spawnSync } = require('node:child_process');

const USAGE = [
    'Usage: node headless-worker.js start --code <CODE> --prompt-file <md> --log <file>',
    '            [--report <file>] [--config-dir <dir>] [--model <id>] [--effort <level>]',
    '            [--permission-mode <mode>] [--cwd <dir>] [--claude-bin <path>] [--ledger <file>] [--dry-run] [--dev]',
    '            [--plugin-dir <dir>] [--keep-tools <Artifact,Workflow|all>] [--profile <builder>]',
    '            [--attempt-id <id>] [--budget-ledger <file>] [--secret <NAME,...>]',
    '       node headless-worker.js supervise ... (internal: the detached child that owns claude)',
    '       node headless-worker.js status [--code <CODE>] [--ledger <file>] [--json]',
    '       node headless-worker.js settle --code <CODE> [--started-at <iso>] [--lost] [--unreported] [--ledger <file>] [--json]',
    '       node headless-worker.js selftest',
    'start: spawn a detached supervisor that runs `claude -p` and appends CLAUDE_EXIT=<code> to the log.',
    '       The caller may exit at once; the result is the report file plus that exit line.',
    '       --config-dir is an absolute path, ~ or ~/<name>. A bare relative name is refused, and so is',
    '       a directory that does not exist, before anything is spawned or recorded.',
    '       --effort is one of low|medium|high|xhigh|max, passed to claude as --effort <level>; omitted, argv has no --effort.',
    '       --plugin-dir is passed to claude as --plugin-dir <dir>: a plugin, or a directory whose children are plugins.',
    '       The worker gets exactly its --profile (worker-profiles.js, default builder) as one --tools list. The Artifact',
    '       tools and Workflow join it only when the prompt names them or --keep-tools keeps them.',
    '       --attempt-id names the attempt reserved in the shared execution budget (execution-budget.js), default',
    '       <code>@<start time>. An id the budget has held before is refused as attempt-restart, and so is a',
    '       reservation past a window cap. The supervisor stops a child past its turn, wall or output ceiling with',
    '       its whole process tree, writes BUDGET_STOP=<field> to the kept log, and settles the attempt.',
    '       AUTHORITY (worker-authority.js): the worker runs in dontAsk mode under a PreToolUse guard fixed at launch.',
    '       --permission-mode bypassPermissions is refused. The child env is an allowlist plus the CLI login plus the',
    '       --secret names its --profile declares in worker-authority.json. Every other variable is dropped.',
    '       It must be a directory. A run that pins its plugins this way loads that tree, whatever the config dir installed.',
    '       start refuses a script outside a plugin cache, because a worker started from a checkout runs code no',
    '       release shipped. --dev runs the checkout on purpose. Every record names the version and script that ran.',
    'status: two axes per record, process (running|exited|unknown) and result (none|done|stopped|failed|unparseable).',
    '        An unparseable report whose RESULT line names another code says so: RESULT line found for a different code.',
    '        A record started before this boot is unknown whatever its pid says; settled records leave after 7 days.',
    'settle: read the last RESULT <CODE> line of the report and mark the record settled.',
    'settle --lost: settle a record whose supervisor died without an exit line, as result lost. Refused unless',
    '        the record started before this boot, or its pid is dead with no exit line. A record with an exit line',
    '        takes plain settle. A lost record is its own result, never done, stopped or failed. When a gate it ran',
    '        died with it, gateStep names the step that started and recorded no exit (gate-records.js step records).',
    'settle --unreported: settle a record whose worker exited without a RESULT <CODE> line, as result unreported.',
    '        Refused while the log has no exit line (that is --lost), while the report has a RESULT line, and while',
    '        <report dir>/<CODE>/<report name> has one (a report written into the scratch dir: move it, then settle).',
    '        A RESULT line naming a code started later in the ledger is that retry\'s word, and settles this record.',
    '        An unreported record is its own result, never done, stopped or failed.',
    'settle, auth-refused: an ended run whose LAST stream-json result event is a refused login (Not logged in,',
    '        Invalid API key, an expired OAuth token, subscription access disabled) settles, plain or --unreported,',
    '        as result auth-refused with that text as its reason, unless a report holds a RESULT line. It is its own',
    '        result, never done, stopped, failed or unreported: the worker never ran. status shows authRefused first.',
    'settle --started-at <iso>: settle exactly the record of that code with that startedAt. Refused as unknown-record',
    '        when no record matches and already-settled when it is settled. Without it, the newest unsettled record.',
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
// by `settle --unreported`, or `auth-refused` for a run whose login was refused.
// Kept apart from RESULT_STATES on purpose: none is ever parsed from a report,
// so a worker cannot claim one.
const SETTLED_RESULTS = [...RESULT_STATES, 'lost', 'unreported', 'auth-refused'];
// `[measured 2026-10-10]` two workers ran about 50 minutes, then every turn of
// `claude -p` ended in a stream-json `result` event whose text was the first
// pattern below, and the supervisor wrote CLAUDE_EXIT=1. They settled as plain
// unreported, nothing said the LOGIN was the cause, and the next queued worker
// would have started into the same refusal. A fresh `claude -p` answered the
// same in under 5 s. A run that could not run is not a worker that failed, so
// such a run settles as `auth-refused`. The other four are sibling shapes of the
// same failure `[stated 2026-10-10]`, not yet seen in a log here. Each pattern is
// anchored at the start of the result text: a worker's own summary that mentions
// a subscription or an API key in prose is not a refusal.
// `[measured 2026-10-11]` an expired login whose refresh also failed answers a
// `claude -p` with is_error, subtype `success`, $0 and the auth-failed text below.
const AUTH_REFUSAL_PATTERNS = [
    { id: 'auth-failed', re: /^Failed to authenticate\b/ },
    { id: 'subscription-disabled', re: /^Your organization has disabled Claude subscription access for Claude Code\b/ },
    { id: 'not-logged-in', re: /^Not logged in\b/ },
    { id: 'invalid-api-key', re: /^Invalid API key\b/ },
    { id: 'oauth-expired', re: /^OAuth token has expired\b/ },
    { id: 'run-login', re: /^Please run \/login\b/ },
];
const AUTH_REASON_MAX = 300;
// The settled results the harness writes, never a worker: each carries a reason.
const NOT_FROM_REPORT = SETTLED_RESULTS.filter((r) => !RESULT_STATES.includes(r));
const SCRUBBED_ENV = authority.SCRUBBED_ENV;
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
    + 'the turn until the report file is complete and carries its RESULT line. Pushing, opening a pull request and '
    + 'merging are refused here and are the coordinator\'s steps even when the brief asks for them: stop at a gated '
    + 'commit and put its head SHA and gate receipt in the report.';

// `[measured 2026-10-29]` 72 worker runs in a week left no line saying what slowed them,
// so the only blocker evidence was mined from free text. blocker-report.js ranks this
// line across every run, and the coordinator removes the top cause.
const BLOCKER_NOTE = 'BLOCKER: just above the RESULT line, write one line `BLOCKER: <what cost this run the most time, '
    + 'or stopped it, and what would have removed it>`, or `BLOCKER: none`. Name the concrete cause (a refused command, '
    + 'a gate wait, a flaky suite, a missing credential, an unclear brief), not a summary of the work.';

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
        + 'and never in the directory that holds the checkouts. Right after adding one, run '
        + `\`node "${path.join(__dirname, 'shared-install.js').replace(/\\/g, '/')}" link <worktree>\`: it hardlinks the main `
        + 'checkout\'s node_modules when the lockfiles match, and prints the `npm ci` to run where they do not. A bare clone is scratch too. Logs, diffs, exit '
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

// `[measured 2026-10-29]` four workers finished their work and settled unreported. In this
// permission mode the Write tool is refused for a report under ~/.claude, and the worker's
// heredoc fallbacks were denied when they ran a check in the same call. One form gets through
// both: a quoted heredoc in a call that runs nothing else (worker-authority.js stripDataHeredocs).
function reportWriteNote(report, scratchDir) {
    const slash = (p) => p.replace(/\\/g, '/');
    return `WRITING THE REPORT: the Write and Edit tools can be refused for ${slash(path.dirname(report))}. `
        + `Write the report, and ask.json, with one Bash call that does nothing else: \`cat > "${slash(report)}" <<'REPORT_EOF'\`, `
        + 'the text, then a line that is exactly `REPORT_EOF`. Keep the delimiter quoted, and check the file in a separate call: '
        + 'a node, a pipe or any command beyond cat, mkdir, ls, head, tail, wc or grep in the same call makes the guard read the text as commands. '
        + `${slash(scratchDir)} already exists, so the call needs no mkdir.`;
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

function installIntegrity(placement, o) {
    if (o.dev || !placement.installed) return { verdict: 'UNVERIFIED', code: 'dev', why: 'a --dev run is not checked against a release' };
    try {
        return require('./plugin-integrity.js').verifyInstall({ pluginRoot: path.join(path.dirname(placement.script), '..'), launcher: placement.script });
    } catch (e) {
        return { verdict: 'DENIED', code: 'integrity-unavailable', why: `plugin-integrity.js could not run: ${e.code || e.message}` };
    }
}

function integritySummary(r) {
    return { verdict: r.verdict, code: r.code, commit: r.commit || null, checked: r.checked || 0, launcher: r.launcher || null };
}

function fault(code, message) { const e = new Error(message || code); e.publicCode = code; throw e; }

function parseArgs(argv) {
    const out = { _: [] };
    const flags = ['help', 'dry-run', 'json', 'lost', 'unreported', 'dev'];
    const known = ['_', ...flags, 'code', 'started-at', 'prompt-file', 'log', 'report', 'config-dir', 'model', 'effort',
        'permission-mode', 'cwd', 'claude-bin', 'ledger', 'plugin-dir', 'keep-tools', 'profile', 'attempt-id', 'budget-ledger', 'secret'];
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

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
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
    if (code && report) notes.push(resultNote(code, report), BLOCKER_NOTE);
    if (report && scratchDir) notes.push(reportWriteNote(report, scratchDir));
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

/**
 * Tool families a headless worker starts without unless its prompt names them.
 * `[measured 2026-10-13]` on a 71.2k turn 1, one headless probe per arm: the
 * three Artifact tools cost 11.4k tokens and Workflow 2.0k, before the worker
 * reads a word of its brief. Desktop sessions keep them. A worker whose prompt
 * names a tool, or links a claude.ai artifact, keeps that family. `--keep-tools`
 * keeps one by name, or `all` keeps every one. The families live in
 * worker-profiles.js: the worker's whole tool set is its profile (--profile,
 * default builder) plus the families it keeps, passed as one --tools list, so a
 * tool a CLI release adds never reaches a worker unasked.
 */
const HEAVY_TOOLS = profiles.FAMILIES;

function parseKeepTools(value) {
    if (!value) return [];
    const names = value.split(',').map((n) => n.trim()).filter(Boolean);
    if (names.length === 1 && names[0] === 'all') return Object.keys(HEAVY_TOOLS);
    const unknown = names.filter((n) => !Object.prototype.hasOwnProperty.call(HEAVY_TOOLS, n));
    if (unknown.length || !names.length) fault('usage', `--keep-tools takes ${Object.keys(HEAVY_TOOLS).join(', ')} or all; got ${value}`);
    return [...new Set(names)];
}

/** The heavy families a text names. A caller that hands this script a pointer prompt passes them as --keep-tools. */
function namedTools(text) {
    return Object.entries(HEAVY_TOOLS).filter(([, spec]) => spec.named.test(text)).map(([family]) => family);
}

/** The tool names this worker starts without: every heavy family its prompt does not name and --keep-tools does not keep. */
function droppedTools(prompt, keepTools = []) {
    return Object.entries(HEAVY_TOOLS)
        .filter(([family, spec]) => !keepTools.includes(family) && !spec.named.test(prompt))
        .flatMap(([, spec]) => spec.tools);
}

/** The resolved tool profile for one worker: its kind's tools plus the families it keeps. */
function toolProfile(prompt, keepTools = [], kind = 'builder') {
    return profiles.resolve(kind, { prompt, keep: keepTools });
}

/** The authority one run carries: its kind's tools, write roots and declared secrets. */
function runAuthority({ prompt = '', keepTools = [], profile = 'builder', cwd = null, report = null, secrets = [] }) {
    return authority.resolveAuthority(profile, { tools: toolProfile(prompt, keepTools, profile).allowed, cwd, reportDir: report ? path.dirname(report) : null, secrets });
}

/**
 * The claude argv. The permission mode passes through authority.launchMode, which
 * refuses bypassPermissions, and the run's authority rides in --settings as a
 * PreToolUse guard. Nothing in the prompt changes either.
 */
function buildArgv({ claudeBin, prompt, model, effort, permissionMode, pluginDir = null, keepTools = [], profile = 'builder', cwd = null, report = null, secrets = [] }) {
    const auth = runAuthority({ prompt, keepTools, profile, cwd, report, secrets });
    const [, mode, ...guard] = authority.launchArgs(auth, permissionMode);
    return [claudeBin, '-p', prompt, ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []),
        ...(pluginDir ? ['--plugin-dir', pluginDir] : []),
        '--permission-mode', mode, '--output-format', 'stream-json', '--verbose',
        ...profiles.toolsArgs(toolProfile(prompt, keepTools, profile)), ...guard];
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
 * The child env, built from an allowlist (worker-authority.js childEnv): the OS
 * and network names, the harness's own non-secret settings, the CLI's login,
 * and the secrets the kind declares. Every other variable the caller has is
 * dropped, so a credential in the caller's environment never reaches a worker.
 * The harness variables a session would hand down are removed. An INHERITED
 * CLAUDE_CONFIG_DIR is removed too: a caller running under a second account
 * must name the config dir it wants the worker on.
 */
function buildEnv(base, { code, configDir, kind = 'builder', secrets = [] }) {
    const scrub = SCRUBBED_ENV.concat(configDir ? [] : ['CLAUDE_CONFIG_DIR']);
    const set = { AUTODEV_HEADLESS: '1', AUTODEV_WORKER_CODE: code };
    const c = authority.childEnv(base, { kind, secrets, configDir, set });
    const setNames = Object.keys(set).concat(configDir ? ['CLAUDE_CONFIG_DIR'] : []);
    return { env: c.env, set: setNames.sort(), deleted: c.deleted, scrubList: scrub.sort(), names: c.names, dropped: c.dropped, declared: c.declared };
}

function parseSecrets(value) { return value ? String(value).split(',').map((s) => s.trim()).filter(Boolean) : []; }

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
        pluginDir: opts['plugin-dir'] ? path.resolve(opts['plugin-dir']) : null,
        keepTools: parseKeepTools(opts['keep-tools']),
        profile: profiles.requireKind(opts.profile || 'builder'),
        attemptId: opts['attempt-id'] ? requireAttemptId(opts['attempt-id']) : null,
        budgetLedger: path.resolve(opts['budget-ledger'] || budget.ledgerPath()),
        permissionMode: authority.launchMode(opts['permission-mode']),
        secrets: authority.requireSecrets(profiles.requireKind(opts.profile || 'builder'), parseSecrets(opts.secret)),
        cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd(),
        claudeBin: resolveClaudeBin(opts['claude-bin'] || 'claude'),
        ledger: path.resolve(opts.ledger || defaultLedger()),
        dev: opts.dev === true,
    };
}

/**
 * The flags `start` hands its supervisor: the same options, spelled out.
 * `[measured 2026-09-28]` --report was missing, so the supervisor rebuilt the
 * default `<log>.report.md` and the RESULT note in the worker's prompt named that
 * file, while the record and settle read the --report path. 187 of 191 fleet
 * records passed a --report of their own.
 */
function supervisorFlags(o) {
    const flags = ['--code', o.code, '--log', o.log, '--report', o.report, '--prompt-file', o.promptFile,
        '--permission-mode', o.permissionMode, '--cwd', o.cwd, '--claude-bin', o.claudeBin];
    if (o.model) flags.push('--model', o.model);
    if (o.effort) flags.push('--effort', o.effort);
    if (o.configDir) flags.push('--config-dir', o.configDir);
    if (o.pluginDir) flags.push('--plugin-dir', o.pluginDir);
    if (o.keepTools.length) flags.push('--keep-tools', o.keepTools.join(','));
    if (o.profile !== 'builder') flags.push('--profile', o.profile);
    if (o.attemptId) flags.push('--attempt-id', o.attemptId);
    if (o.secrets.length) flags.push('--secret', o.secrets.join(','));
    flags.push('--budget-ledger', o.budgetLedger);
    return flags;
}

function requireAttemptId(v) {
    if (!budget.ATTEMPT_RE.test(v)) fault('usage', `--attempt-id must match ${budget.ATTEMPT_RE}`);
    return v;
}

/** The attempt a start reserves: --attempt-id when given, else one minted from the code and start time. */
function attemptIdFor(o, startedAt) { return o.attemptId || `${o.code}@${startedAt.replace(/[-:.]/g, '')}`; }

function start(opts) {
    const o = startOptions(opts);
    const placement = scriptPlacement();
    if (!placement.installed && !o.dev) {
        fault('not-installed', `${placement.script} is not inside a plugin cache, so a worker started from it runs code no release shipped. `
            + 'Run the installed copy under <config dir>/plugins/cache/, or pass --dev to run this checkout on purpose');
    }
    // A cache-shaped path is a name, not evidence. The installed copy must hash
    // to the commit installed_plugins.json names (plugin-integrity.js), or the
    // start is refused before anything is reserved or spawned.
    const integrity = installIntegrity(placement, o);
    if (integrity.verdict === 'DENIED') {
        fault('integrity-denied', `${placement.script} is in a plugin cache but does not match the release it claims: ${integrity.why}. `
            + 'Reinstall the plugin, or pass --dev to run this copy on purpose');
    }
    if (o.configDir) requireConfigDirExists(o.configDir);
    if (o.pluginDir && !isDir(o.pluginDir)) fault('plugin-dir-missing', `--plugin-dir resolved to ${o.pluginDir}, which is not a directory`);
    const prompt = readPrompt(o.promptFile, scratchDirFor(o), o);
    const argv = buildArgv({ claudeBin: o.claudeBin, prompt, model: o.model, effort: o.effort, permissionMode: o.permissionMode, pluginDir: o.pluginDir, keepTools: o.keepTools, profile: o.profile, cwd: o.cwd, report: o.report, secrets: o.secrets });
    const plan = buildEnv(process.env, { code: o.code, configDir: o.configDir, kind: o.profile, secrets: o.secrets });
    if (opts['dry-run']) {
        return {
            dryRun: true, code: o.code, argv, command: spawnPlan(argv).command,
            envSet: plan.set, envDeleted: plan.deleted, envScrubList: plan.scrubList, envNames: plan.names, envDropped: plan.dropped, secrets: plan.declared,
            authority: runAuthority({ prompt, keepTools: o.keepTools, profile: o.profile, cwd: o.cwd, report: o.report, secrets: o.secrets }),
            configDir: o.configDir, effort: o.effort, pluginDir: o.pluginDir, droppedTools: droppedTools(prompt, o.keepTools),
            profile: o.profile, tools: toolProfile(prompt, o.keepTools, o.profile).allowed,
            budget: { ceilings: budget.ceilingsFor('worker'), billing: budget.billingOf(plan.env), ledger: o.budgetLedger, attemptId: o.attemptId },
            script: placement.script, version: placement.version, installed: placement.installed, dev: o.dev, integrity: integritySummary(integrity),
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
        version: placement.version, script: placement.script, dev: !placement.installed, integrity: integritySummary(integrity),
        model: o.model, effort: o.effort, permissionMode: o.permissionMode, cwd: o.cwd, pluginDir: o.pluginDir, droppedTools: droppedTools(prompt, o.keepTools),
        profile: o.profile, tools: toolProfile(prompt, o.keepTools, o.profile).allowed, secrets: o.secrets, state: 'starting',
    };
    // BUDGET. The attempt is reserved in the shared execution budget inside the
    // ledger lock, after the code-active check and before anything moves or
    // spawns. A refusal (an attempt id used before, a window cap, an unreadable
    // config) leaves no record and no process. A start that fails after the
    // reservation cancels it, so it charges nothing and its id stays used.
    o.attemptId = attemptIdFor(o, record.startedAt);
    Object.assign(record, { attemptId: o.attemptId, budgetLedger: o.budgetLedger });
    const cancelBudget = (why) => budget.cancel(o.attemptId, why, { ledger: o.budgetLedger });
    const isReservation = (r) => r.code === o.code && r.state === 'starting' && r.startedAt === record.startedAt;
    withLedger(o.ledger, (ledger) => {
        if (ledger.records.some((r) => r.code === o.code && isUnsettled(r))) {
            fault('code-active', `${o.code} has an unsettled record in ${o.ledger}; settle it or pick another code`);
        }
        const b = budget.reserve({ attemptId: o.attemptId, kind: 'worker', billing: budget.billingOf(plan.env),
            account: o.configDir ? path.basename(o.configDir) : 'default', log: o.log, note: o.code }, { ledger: o.budgetLedger });
        if (!b.ok) fault(b.code === 'attempt-restart' ? 'attempt-restart' : 'budget-refused', `execution budget refused ${o.attemptId}: ${b.why}`);
        let moved;
        try { moved = moveAside(priorRunFiles(o), record.startedAt.replace(/[-:.]/g, '')); } catch (e) { cancelBudget('the earlier run files could not be moved aside'); throw e; }
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
        cancelBudget('the supervisor could not be spawned');
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
 *
 * BUDGET. The supervisor first marks its attempt running in the execution
 * budget (execution-budget.js begin). An attempt that is not reserved, or one
 * already running or settled, is a second launch of one attempt: it writes
 * BUDGET_DENIED=<why> and CLAUDE_EXIT=-1, and claude never starts. While the
 * child runs, a watchdog measures turns, wall time and output bytes against the
 * attempt's ceilings. The first one passed writes BUDGET_STOP=<field> limit=<n>
 * seen=<n> and stops the child with its whole process tree. The log is never
 * truncated, so everything the child wrote stays as evidence. On every way out
 * the attempt is settled: with the run's reported usage, or with its whole
 * reservation when it reported none, or cancelled when claude never started.
 *
 * CAPACITY. Immediately before the spawn, the supervisor reserves machine
 * capacity (capacity.js, class worker) in its own pid's name, since it lives as
 * long as the child. A deferral is written to the log as CAPACITY_WAIT=<why>
 * when its kind changes, and asked again every AUTODEV_CAPACITY_POLL_MS. One
 * still standing after AUTODEV_CAPACITY_WAIT_MS, or a tripped crash breaker,
 * ends the run with CAPACITY_DEFERRED=<why> and CLAUDE_EXIT=-1, and claude never
 * starts. The reservation is settled on every way out: the child's exit, a
 * spawn error, and this process exiting.
 */
function supervise(opts) {
    const o = startOptions(opts);
    const prompt = readPrompt(o.promptFile, scratchDirFor(o), o);
    const argv = buildArgv({ claudeBin: o.claudeBin, prompt, model: o.model, effort: o.effort, permissionMode: o.permissionMode, pluginDir: o.pluginDir, keepTools: o.keepTools, profile: o.profile, cwd: o.cwd, report: o.report, secrets: o.secrets });
    const { env } = buildEnv(process.env, { code: o.code, configDir: o.configDir, kind: o.profile, secrets: o.secrets });
    const plan = spawnPlan(argv);
    fs.mkdirSync(path.dirname(o.log), { recursive: true });
    // The worker may not be able to create it: a mkdir under ~/.claude is refused in its mode.
    fs.mkdirSync(scratchDirFor(o), { recursive: true });
    const fd = fs.openSync(o.log, 'a');
    let finished = false;
    let reservation = null;
    const settleCapacity = () => {
        if (!reservation) return;
        const id = reservation;
        reservation = null;
        capacity.release(id);
    };
    process.on('exit', settleCapacity);
    // The budget attempt: begun once begin() accepted it, launched once claude spawned.
    const run = { begun: false, launched: false, launchedAt: null, stop: null, watchdog: null, childPid: null, waiting: null };
    const settleBudget = (exit, reason) => {
        if (!run.begun) return;
        run.begun = false;
        if (run.watchdog) run.watchdog.stop();
        if (!run.launched) { budget.cancel(o.attemptId, reason, { ledger: o.budgetLedger }); return; }
        const m = run.watchdog ? run.watchdog.measure() : { outputBytes: null };
        budget.settle(o.attemptId, { usage: budget.usageFromLog(readText(o.log)), stop: run.stop, exit,
            outputBytes: m.outputBytes, wallMs: Date.now() - run.launchedAt,
            launchedAt: new Date(run.launchedAt).toISOString(), ledger: o.budgetLedger });
    };
    const finish = (lines, exitCode, budgetExit = null) => {
        if (finished) return;
        finished = true;
        settleCapacity();
        // The budget settles before the exit line lands, so a settle that reads the
        // exit line finds this attempt already settled, with its stop recorded.
        if (budgetExit === null) run.launched = false;
        try { settleBudget(budgetExit, lines[0]); } catch { /* the attempt stays open and keeps its whole reservation */ }
        try { fs.writeSync(fd, '\n' + lines.join('\n') + '\n'); } catch { /* the log is gone; nothing left to say */ }
        try { fs.closeSync(fd); } catch { /* already closed */ }
        process.exitCode = exitCode;
    };
    const launch = () => {
        let child;
        try {
            // POSIX: the child leads its own process group, so a budget stop reaches every descendant.
            child = spawn(plan.command, plan.args, { cwd: o.cwd, env, stdio: ['ignore', fd, fd], windowsHide: true, detached: process.platform !== 'win32' });
        } catch (e) {
            finish([`CLAUDE_SPAWN_ERROR=${e.code || e.message}`, 'CLAUDE_EXIT=-1'], 1);
            return { supervising: false, code: o.code };
        }
        child.on('error', (e) => finish([`CLAUDE_SPAWN_ERROR=${e.code || e.message}`, 'CLAUDE_EXIT=-1'], 1));
        child.on('exit', (code, signal) => {
            if (code === null) finish([`CLAUDE_SIGNAL=${signal}`, 'CLAUDE_EXIT=-1'], 1, -1);
            else finish([`CLAUDE_EXIT=${code}`], code === 0 ? 0 : 1, code);
        });
        if (child.pid) {
            run.childPid = child.pid;
            run.launched = true;
            run.launchedAt = Date.now();
            const held = budget.attemptOf(o.attemptId, { ledger: o.budgetLedger });
            run.watchdog = budget.watch({
                logFile: o.log, ceilings: (held && held.ceilings) || budget.ceilingsFor('worker'),
                onStop: (hit) => {
                    run.stop = { ...hit, at: new Date().toISOString() };
                    try { fs.writeSync(fd, `\nBUDGET_STOP=${hit.field} limit=${hit.limit} seen=${hit.seen}\n`); } catch { /* the log is gone */ }
                    run.stop.kill = budget.killTree(child.pid);
                },
            });
        }
        return { supervising: true, code: o.code, childPid: child.pid };
    };
    const since = Date.now();
    let said = null;
    const admitThenLaunch = () => {
        const c = capacity.admit({ cls: 'worker', path: o.cwd, note: o.code });
        if (c.admitted) { reservation = c.id; return launch(); }
        const kind = c.breaker ? 'breaker' : c.resuming ? 'resuming' : 'deferred';
        if (kind !== said) {
            said = kind;
            try { fs.writeSync(fd, `CAPACITY_WAIT=${c.why}\n`); } catch { /* the log is gone */ }
        }
        if (c.breaker || Date.now() - since >= capacity.waitMs()) {
            finish([`CAPACITY_DEFERRED=${c.why}`, 'CLAUDE_EXIT=-1'], 1);
            return { supervising: false, code: o.code, capacity: c.why };
        }
        run.waiting = setTimeout(admitThenLaunch, capacity.pollMs());
        return { supervising: true, code: o.code, capacity: c.why };
    };
    const b = o.attemptId ? budget.begin(o.attemptId, { pid: process.pid, ledger: o.budgetLedger })
        : { ok: false, code: 'unknown-attempt', why: 'no --attempt-id, so no reserved attempt to run under' };
    if (!b.ok) {
        finish([`BUDGET_DENIED=${b.code}: ${b.why}`, 'CLAUDE_EXIT=-1'], 1);
        return { supervising: false, code: o.code, budget: b.code };
    }
    run.begun = true;
    // POSIX: the child leads its own process group, so a SIGTERM aimed at this
    // supervisor (frontier's timeout, fleet-view's stop) reaches it only if passed on.
    if (process.platform !== 'win32') {
        process.once('SIGTERM', () => {
            if (run.childPid) { budget.killTree(run.childPid); return; }
            clearTimeout(run.waiting);
            finish(['CLAUDE_SIGNAL=SIGTERM', 'CLAUDE_EXIT=-1'], 1);
        });
    }
    return admitThenLaunch();
}

// ---------------------------------------------------------------- status
/** The number from the last CLAUDE_EXIT line of a log, or null. */
function exitCodeOf(logText) {
    let last = null;
    for (const m of String(logText).matchAll(new RegExp(EXIT_LINE_RE.source, 'gm'))) last = Number(m[1]);
    return last;
}

/**
 * `alive`, `dead` or `unknown` from a `process.kill(pid, 0)` error. ONLY ESRCH means dead:
 * EPERM is a process that exists and belongs to someone else, and a classifier
 * that reads it as dead would report a foreign worker as gone.
 */
function livenessFromError(err) {
    if (!err) return 'alive';
    return err.code === 'ESRCH' ? 'dead' : err.code === 'EPERM' ? 'alive' : 'unknown';
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
 * be read leaves the answer `unknown`. Retaining a record on uncertainty does
 * not prove that its supervisor is running.
 */
function supervisorLiveness(rec, { probe, image = pidImage } = {}) {
    const l = pidLiveness(rec.pid, probe);
    if (l !== 'alive') return l;
    const seen = image(rec.pid);
    return !seen ? 'unknown' : !isSupervisorImage(rec, seen) ? 'reused' : 'alive';
}

/** `{ id, text }` when a result event's text is a refused login, or null. */
function matchAuthRefusal(text) {
    if (typeof text !== 'string') return null;
    const t = text.trim();
    const hit = AUTH_REFUSAL_PATTERNS.find((p) => p.re.test(t));
    return hit ? { id: hit.id, text: t.slice(0, AUTH_REASON_MAX) } : null;
}

/**
 * The refusal in the LAST stream-json `result` event of a log, or null. Only the
 * last one counts: a run refused once that then worked is not refused. A line is
 * parsed only when it carries `"type":"result"` unescaped, so a long log is not
 * parsed whole, and a result quoted inside a message string never counts.
 */
function authRefusal(logText) {
    let last = null;
    for (const line of String(logText || '').split(/\r?\n/)) {
        if (!line.startsWith('{') || !line.includes('"type":"result"')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j && j.type === 'result') last = j;
    }
    return last ? matchAuthRefusal(last.result) : null;
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
    // An exited run not yet settled says whether its login was refused, so a
    // reader can tell "could not run" from "left no report" before settle does.
    const refusal = !settled && exit !== null && logText !== null ? authRefusal(logText) : null;
    return {
        code: rec.code, pid: rec.pid, startedAt: rec.startedAt, process: processState, exit,
        result, sentence, resultCodeFound, reportExists: reportText !== null, reportStale, misplacedReport: misplaced, settled, settledAs,
        version: rec.version || null, dev: rec.dev === true,
        lostReason: settledAs === 'lost' ? (rec.reason || null) : null,
        settleReason: NOT_FROM_REPORT.includes(settledAs) ? (rec.reason || null) : null,
        authRefused: refusal ? refusal.text : null,
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
            + `${r.misplacedReport ? ` (report written into the scratch dir: ${r.misplacedReport})` : ''} settled=${r.settled}${NOT_FROM_REPORT.includes(r.settledAs) ? ` settledAs=${r.settledAs} (${r.settleReason})` : ''}`
            + `${r.authRefused ? ` authRefused (${r.authRefused})` : ''}`
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

/**
 * Settle a record, then reconcile its budget attempt. A supervisor settles its
 * attempt itself on every way out, so this matters for one it never reached: a
 * supervisor killed by a reboot or a kill. Such an attempt is settled from the
 * log's reported usage, or charged its whole reservation when the log has none.
 */
function settle(opts) {
    const seen = {};
    const value = settleRecord(opts, seen);
    const rec = seen.rec;
    if (rec && rec.attemptId) {
        try {
            const r = budget.settle(rec.attemptId, { usage: budget.usageFromLog(readText(rec.log)), exit: Number.isInteger(rec.exit) ? rec.exit : null,
                reason: `settled by headless-worker settle as ${rec.result}`, ledger: rec.budgetLedger || budget.ledgerPath() });
            value.budget = r.ok ? { attemptId: rec.attemptId, state: r.attempt.state, already: Boolean(r.already), usageMissing: r.attempt.usageMissing === true }
                : { attemptId: rec.attemptId, error: r.code };
        } catch (e) { value.budget = { attemptId: rec.attemptId, error: e.code || e.message }; }
    }
    return value;
}

function settleRecord(opts, seen = {}) {
    const code = requireCode(opts);
    const file = path.resolve(opts.ledger || defaultLedger());
    return withLedger(file, (ledger) => {
        // --started-at names one run, so a caller holding an older record of a
        // reused code settles that run and never the newest one by accident.
        const at = opts['started-at'];
        if (at !== undefined && (typeof at !== 'string' || Number.isNaN(Date.parse(at)))) {
            fault('usage', '--started-at needs the record\'s startedAt, an ISO time');
        }
        let rec;
        if (at !== undefined) {
            rec = ledger.records.find((r) => r.code === code && r.startedAt === at);
            if (!rec) fault('unknown-record', `no record for ${code} started at ${at} in ${file}`);
            if (!isUnsettled(rec)) fault('already-settled', `the ${code} run started at ${at} is already settled`);
        } else {
            rec = ledger.records.filter((r) => r.code === code && isUnsettled(r)).pop();
            if (!rec) fault('unknown-code', `no unsettled record for ${code} in ${file}`);
        }
        seen.rec = rec;
        const logText = readText(rec.log);
        const exit = logText === null ? null : exitCodeOf(logText);
        if (opts.lost && opts.unreported) fault('usage', '--lost and --unreported name different endings: a worker with no exit line, and one that exited without a RESULT line. Pass one');
        if (opts.lost) return settleLost(rec, code, exit);
        // Read only once the run has ended: a refusal is a claim about how it ended.
        const refusal = exit === null ? null : authRefusal(logText);
        if (opts.unreported) return settleUnreported(rec, code, exit, refusal, ledger.records);
        if (exit === null) {
            fault('not-exited', `${rec.log} has no CLAUDE_EXIT line yet, so the worker is running or its supervisor never wrote one. `
                + 'A supervisor killed by a reboot or a kill never writes it, and settle --lost settles such a record once it is provably not running');
        }
        const reportText = readText(rec.report);
        // A stale report is an earlier run's word, so this run's refusal is still the answer.
        if (reportText !== null && writtenBefore(rec.report, rec.startedAt)) {
            if (refusal) return settleAuthRefused(rec, code, exit, refusal);
            fault('stale-report', staleHint(rec));
        }
        const parsed = reportText === null ? null : parseResult(reportText, code);
        if (!parsed) {
            const other = reportText === null ? null : otherResultCode(reportText, code);
            const moved = other ? null : misplacedReport(rec);
            // A RESULT line anywhere means the worker ran and wrote: that is corrected
            // or moved, never buried under a refusal.
            if (refusal && !other && !moved) return settleAuthRefused(rec, code, exit, refusal);
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

/**
 * The gate step a lost worker's tree died in, or null: the newest step record
 * (gate-records.js) for the worker's cwd that started after the worker did and
 * recorded no exit. Read from the full-gate lock's records, at
 * AUTODEV_GATE_LOCK_PATH when set. Never throws: a record nobody can read
 * leaves the settle as it was.
 */
function lostGateStep(rec, env = process.env) {
    try {
        if (!rec.cwd) return null;
        const records = require('./gate-records.js');
        const ident = require('./gate-identity.js');
        const base = path.resolve(env.AUTODEV_GATE_LOCK_PATH || path.join(os.homedir(), '.claude', 'autodev', 'locks', 'full-gate.lock'));
        const since = Date.parse(rec.startedAt || '');
        const hit = records.findOpenSteps(base, { worktree: ident.canonicalPath(rec.cwd), sinceMs: Number.isFinite(since) ? since : 0 })[0];
        return hit ? { runId: hit.runId, index: hit.index, of: hit.of, step: hit.step, pid: hit.pid, startUtc: hit.startUtc } : null;
    } catch { return null; }
}

/** `settle --lost` inside the ledger lock. Mutates `rec` only when the record is provably not running. */
function settleLost(rec, code, exit) {
    if (exit !== null) fault('not-lost', `${rec.log} has CLAUDE_EXIT=${exit}, so the worker ended and was not lost. Settle it without --lost`);
    const reason = lostReason(rec, bootAt());
    if (!reason) {
        fault('not-lost', `${code} has no exit line but is not provably stopped: it started after this boot and pid ${rec.pid} `
            + `${Number.isInteger(rec.pid) && rec.pid > 0 ? 'is not provably gone' : 'was never recorded'}. Wait for its exit line`);
    }
    // A report that did get written keeps its sentence, so what the worker said is not lost with it.
    const reportText = readText(rec.report);
    const parsed = reportText === null ? null : parseResult(reportText, code);
    // A gate the worker ran that died with it names the step it died in.
    const gateStep = lostGateStep(rec);
    const settledAt = new Date().toISOString();
    Object.assign(rec, {
        state: 'settled', result: 'lost', reason, sentence: parsed ? parsed.sentence : null,
        reportResult: parsed ? parsed.state : null, exit: null, settledAt, gateStep,
    });
    return { code, state: 'lost', reason, sentence: rec.sentence, reportResult: rec.reportResult, exit: null, report: rec.report, settledAt, gateStep };
}

/** The record started after rec under the code a report's RESULT line names, or null. */
function takenOverBy(rec, other, records) {
    const i = Array.isArray(records) ? records.indexOf(rec) : -1;
    const started = Date.parse(rec.startedAt || '');
    if (i < 0 || !Number.isFinite(started)) return null;
    return records.slice(i + 1).find((r) => r.code === other && Date.parse(r.startedAt || '') > started) || null;
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
function settleUnreported(rec, code, exit, refusal = null, records = []) {
    if (exit === null) {
        fault('not-exited', `${rec.log} has no CLAUDE_EXIT line, so the worker has not provably ended. `
            + 'settle --lost settles a record whose supervisor died without one');
    }
    const boot = bootAt();
    const started = Date.parse(rec.startedAt || '');
    const thisBoot = !(Number.isFinite(boot) && Number.isFinite(started) && started < boot);
    if (thisBoot && !['dead', 'reused'].includes(supervisorLiveness(rec))) {
        fault('still-running', `${rec.log} has an exit line, but the supervisor pid ${rec.pid} is not provably gone, so that line can belong to an `
            + 'earlier run appended to the same log. Settle once the supervisor has ended');
    }
    const reportText = readText(rec.report);
    if (reportText !== null && writtenBefore(rec.report, rec.startedAt)) {
        if (refusal) return settleAuthRefused(rec, code, exit, refusal);
        fault('stale-report', staleHint(rec));
    }
    if (reportText !== null && parseResult(reportText, code)) {
        fault('has-result', `${rec.report} has a RESULT ${code} line. Settle it without --unreported`);
    }
    const other = reportText === null ? null : otherResultCode(reportText, code);
    const moved = other ? null : misplacedReport(rec);
    if (moved) fault('misplaced-report', misplacedHint(moved, rec));
    // `[measured 2026-10-12]` four runs died with exit 1, and each retry, started
    // under a new code, wrote its RESULT line into the dead run's report. That line
    // is the retry's word, recorded on the retry's own record, and says nothing
    // about this run. Only a code started later in this ledger counts as a retry.
    const retry = other ? takenOverBy(rec, other, records) : null;
    if (other && !retry) {
        fault('no-result', `RESULT line found for a different code: ${rec.report} ends RESULT ${other}, and this record's code is ${code}. `
            + `Correct that line to RESULT ${code} done|stopped|failed: <sentence>, then settle again`);
    }
    if (refusal) return settleAuthRefused(rec, code, exit, refusal);
    const reason = retry
        ? `exited ${exit} with no RESULT ${code} line, and ${rec.report} was taken over by the later run ${retry.code} started ${retry.startedAt}`
        : reportText === null
        ? `exited ${exit} and ${rec.report} does not exist`
        : `exited ${exit} and ${rec.report} has no RESULT ${code} line`;
    const settledAt = new Date().toISOString();
    Object.assign(rec, { state: 'settled', result: 'unreported', reason, sentence: null, exit, settledAt });
    return { code, state: 'unreported', reason, sentence: null, exit, report: rec.report, settledAt };
}

/**
 * Settle an ended run whose last result event was a refused login, inside the
 * ledger lock. Its own result, never done, stopped, failed or unreported: the
 * worker never ran, so the brief is untouched, and a run started on the same
 * login meets the same refusal. The reason is the refusal text as claude printed it.
 */
function settleAuthRefused(rec, code, exit, refusal) {
    const settledAt = new Date().toISOString();
    Object.assign(rec, { state: 'settled', result: 'auth-refused', reason: refusal.text, authPattern: refusal.id, sentence: null, exit, settledAt });
    return { code, state: 'auth-refused', reason: refusal.text, pattern: refusal.id, sentence: null, exit, report: rec.report, settledAt };
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
    HEADLESS_NOTE, DENIED_NOTE, BLOCKER_NOTE, PROMPT_MAX, CODE_RE, placementNote, resultNote, scriptPlacement, otherResultCode, SCRUBBED_ENV, RETENTION_MS, SETTLED_RESULTS,
    AUTH_REFUSAL_PATTERNS, matchAuthRefusal, authRefusal, resolveConfigDir,
    askFiles, askNote, askState, scratchDirFor, priorRunFiles, moveAside, readLedger, settle, start,
    HEAVY_TOOLS, droppedTools, namedTools, parseKeepTools, toolProfile, attemptIdFor, supervise,
    parseArgs, composePrompt, buildArgv, buildEnv, runAuthority, parseSecrets, spawnPlan, resolveClaudeBin, exitCodeOf, parseResult,
    livenessFromError, pidLiveness, pidImage, isSupervisorImage, supervisorLiveness, bootAt, pruneSettled, laterRuns, recordStatus, lostReason, lostGateStep, run,
};
