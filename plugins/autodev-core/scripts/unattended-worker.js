#!/usr/bin/env node
'use strict';
/**
 * unattended-worker.js - start a worker session with no click, through an ad-hoc
 * scheduled task, without letting it work in a shared checkout.
 *
 * WHY. A desktop chip needs a person to click it, so it cannot start work while
 * nobody is watching. `create_scheduled_task` with no schedule, followed by
 * `run_scheduled_task`, starts a new session within seconds and asks nobody.
 * `[measured 2026-09-14]` two properties of that run make it dangerous to use
 * by hand:
 *
 *   1. The run opens in the creating session's ORIGIN checkout: the main tree
 *      of the coordinator's repo, on its default branch, where other sessions
 *      commit. A brief that forgets to make its own worktree edits that tree.
 *   2. Deleting the task ARCHIVES its run session. Delete it while the worker
 *      is still going and its transcript leaves the default session list, so
 *      the result is effectively lost. Never delete it and the task list fills
 *      with one-off runs.
 *
 * WHAT IT DOES. The MCP calls stay with the coordinator, because a Node script
 * cannot make them. This script owns what the calls get wrong:
 *
 *   brief   checks the target repo, the slug, the base ref, and that neither the
 *           worktree path, the local branch, the origin branch nor an active
 *           ledger record already claims the slug. It then composes the task
 *           prompt with STEP 0 first: fetch, `git worktree add`, cd, and an
 *           assertion that the session is inside that worktree, then the
 *           per-command `cd` prefix every later command starts with. The brief
 *           body follows, then a return instruction. Output: the arguments for
 *           `create_scheduled_task`. Records the task as `composed`.
 *   record  after `run_scheduled_task`, stores the run's session id (`started`).
 *   settle  decides whether `delete_scheduled_task` is safe: never while the run
 *           is `running`, and never before the coordinator has read the result.
 *   deleted records that the task was deleted (`deleted`).
 *   retire  closes a record that never ran (`retired`). Only a `composed` record
 *           qualifies: `settle` refuses one and `deleted` needs `settled`, so
 *           without this a task composed and then never run kept its slug and
 *           task id claimed for ever. [measured 2026-09-16] a real record sat
 *           `composed` after the coordinator chose not to run it. A started
 *           record has a session behind it and must go through settle.
 *   status  prints every ledger record, how many were read, and how many of
 *           the records that ran carry the version they ran on.
 *
 * VERSION. `brief`, `record` and `settle` each stamp the plugin version of the
 * code that ran them, read the way headless-worker.js reads it, plus `dev` when
 * that code sits outside a plugin cache. [measured 2026-09-28] 50 of 50 records
 * carried no version, so nobody could tell which release a worker ran.
 *
 * THE QUEUE (the headless channel). `[measured 2026-09-28]` nothing unattended
 * can drive the scheduled-task path: a headless `claude -p` has no
 * scheduled-tasks tools, and an unattended scheduled run is refused
 * `run_scheduled_task`. So work that must start while nobody watches is queued
 * here and started as a headless worker through headless-worker.js, by whatever
 * cron runs `launch` (brain-judge.js, from the Brain clock).
 *
 *   enqueue records a brief as `queued`: the slug (at most 24 characters, since
 *           it becomes the headless code), a copy of the brief under the task's
 *           scratch directory, the launch options and any `--after` tasks.
 *   ready   lists which queued tasks may start now (planStarts): every
 *           dependency finished, succeeded and was accepted by a verdict, and
 *           the concurrency and per-hour caps leave a slot.
 *   launch  runs the brief checks again, composes the same STEP 0 prompt, and
 *           calls `headless-worker.js start` with a pointer prompt, because the
 *           prompt travels in argv. Success is `started` on channel headless.
 *           A refusal leaves the record queued with lastLaunchError.
 *   verdict records accept, follow-up or escalate for a finished task. A judge
 *           verdict never replaces an existing one; the Brain's or the operator's does.
 *   settle  on a headless record ends in `closed`: no scheduled task exists, so
 *           there is nothing for `deleted` to record.
 *
 * PINS. `brief` and `enqueue` take `--pin <path>[,<path>...]`, repo-relative
 * acceptance tests the worker must not change. The record stores each path with
 * its blob sha at the base (`pins`, `pinBase`), `launch` re-reads them at the
 * base the worker starts from, and the prompt names them. `verdict --decision
 * accept` then compares those blobs against the result head: `--head <sha>` when
 * given, else the local branch and its origin copy. Any pin edited or deleted
 * refuses with pin-changed; no head to read refuses with pin-unchecked, never a
 * pass. `--allow-pin-change "<reason>"` overrides and the reason is stored on
 * the verdict beside the pinCheck it overrode. follow-up and escalate are never
 * refused. brain-judge.js writes through this command, so a judge accept meets
 * the same check.
 *
 * WHAT IT IS NOT. Only `launch` starts anything. It deletes nothing and
 * verifies no result. A `started` record means a session id or a supervisor
 * pid was returned, not that step 0 passed.
 *
 * Usage:
 *   node unattended-worker.js brief --repo <dir> --slug <topic> --brief-file <md> --return <address>
 *        [--pin <path>[,<path>]] [--report <file>]   (default ~/.claude/autodev/reports/<task id>/REPORT.md)
 *        [--base origin/main] [--task-id <id>] [--title <text>] [--ledger <file>]
 *   node unattended-worker.js record --task-id <id> --session <local_uuid> [--ledger <file>]
 *   node unattended-worker.js settle --task-id <id> --run-status running|succeeded|failed [--report-read] [--ledger <file>]
 *   node unattended-worker.js deleted --task-id <id> [--ledger <file>]
 *   node unattended-worker.js retire --task-id <id> [--reason <text>] [--ledger <file>]
 *   node unattended-worker.js status [--task-id <id>] [--ledger <file>]
 *   node unattended-worker.js enqueue --repo <dir> --slug <topic> --brief-file <md> --return <address>
 *        [--after <task id>[,<task id>]] [--pin <path>[,<path>]] [--base origin/main] [--task-id <id>] [--title <text>]
 *        [--model <id>] [--effort <level>] [--permission-mode <mode>] [--config-dir <dir>] [--ledger <file>]
 *   node unattended-worker.js ready [--max-concurrent 2] [--max-per-hour 2] [--ledger <file>]
 *   node unattended-worker.js launch --task-id <id> [--dry-run] [--headless-worker <file>] [--claude-bin <path>] [--dev] [--ledger <file>]
 *   node unattended-worker.js verdict --task-id <id> --decision accept|follow-up|escalate --reason <text> [--by judge|brain|operator]
 *        [--head <sha>] [--allow-pin-change <reason>] [--ledger <file>]
 * Output: {"ok":true,"value":{...}} exit 0; {"ok":false,"error":{"code","message"}} exit 1.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const claudePaths = require('./claude-paths.js');
const { scriptPlacement, readLedger: readHeadlessLedger } = require('./headless-worker.js');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// STEP 0 links the new worktree's node_modules to the main checkout's. The path
// is this install's own copy, so the prompt names a script that exists.
const SHARED_INSTALL = path.join(__dirname, 'shared-install.js');

const USAGE = [
    'Usage: node unattended-worker.js brief --repo <dir> --slug <topic> --brief-file <md> --return <address> [--pin <path>[,<path>]] [--report <file>] [--base origin/main] [--task-id <id>] [--title <text>] [--ledger <file>]',
    '       node unattended-worker.js record --task-id <id> --session <local_uuid> [--ledger <file>]',
    '       node unattended-worker.js settle --task-id <id> --run-status running|succeeded|failed [--report-read] [--ledger <file>]',
    '       node unattended-worker.js deleted --task-id <id> [--ledger <file>]',
    '       node unattended-worker.js retire --task-id <id> [--reason <text>] [--ledger <file>]',
    '       node unattended-worker.js status [--task-id <id>] [--ledger <file>]',
    'brief: refuse a slug already claimed (worktree path, local branch, origin branch, active ledger record),',
    '       then print create_scheduled_task arguments whose prompt opens with git worktree add.',
    'settle: delete_scheduled_task archives the run session, so it is safe only once the run has ended',
    '       AND its result was read (--report-read).',
    '       node unattended-worker.js enqueue --repo <dir> --slug <topic> --brief-file <md> --return <address> [--after <id>[,<id>]] [--pin <path>[,<path>]]',
    '            [--base origin/main] [--task-id <id>] [--title <text>] [--model <id>] [--effort <level>] [--permission-mode <mode>] [--config-dir <dir>] [--ledger <file>]',
    '       node unattended-worker.js ready [--max-concurrent 2] [--max-per-hour 2] [--ledger <file>]',
    '       node unattended-worker.js launch --task-id <id> [--dry-run] [--headless-worker <file>] [--claude-bin <path>] [--dev] [--ledger <file>]',
    '       node unattended-worker.js verdict --task-id <id> --decision accept|follow-up|escalate --reason <text> [--by judge|brain|operator]',
    '            [--head <sha>] [--allow-pin-change <reason>] [--ledger <file>]',
    'retire: close a composed or queued record whose task never ran, freeing its slug and task id.',
    'enqueue: queue a brief for the headless channel. The slug is at most 24 characters: it becomes the headless code.',
    'ready: queued tasks whose dependencies were accepted, within the concurrency and per-hour caps.',
    'launch: the only command that starts anything. It re-runs the brief checks and calls headless-worker.js start.',
    'verdict: a judge verdict never replaces an existing one; --by brain or operator does.',
    '--pin: repo-relative acceptance tests stored with their blob at the base. accept is refused (pin-changed) when one',
    '       differs or is gone at the result head (--head, else the branch locally or on origin), and refused',
    '       (pin-unchecked) when no head can be read. --allow-pin-change "<reason>" overrides and stores the reason.',
    '       follow-up and escalate are never refused.',
    'The scheduled-task path starts nothing and deletes nothing: the coordinator makes those MCP calls.',
    `Default ledger: ${path.join('~', '.claude', 'autodev', 'unattended-workers.json')}`,
].join('\n') + '\n';

const ACTIVE = ['queued', 'composed', 'started', 'settled'];
// A record that ran and ended: the states a verdict and a dependency can read.
const FINISHED = ['settled', 'closed', 'deleted'];
const RUN_STATUSES = ['running', 'succeeded', 'failed'];
const DECISIONS = ['accept', 'follow-up', 'escalate'];
const VERDICT_BY = ['judge', 'brain', 'operator'];
const SLUG = /^[a-z0-9][a-z0-9-]{1,48}$/;
// headless-worker.js CODE_RE caps a code at 24 characters, and the slug is the code.
const HEADLESS_SLUG_MAX = 24;
const SESSION = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOUR_MS = 60 * 60 * 1000;
const LAUNCH_TIMEOUT_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;
// launch holds the lock across an ls-remote and the supervisor start, up to about
// 95 s. A stale threshold under that let a second writer take a live lock over, and
// launch then wrote its older copy of the ledger on top.
const LOCK_STALE_MS = 5 * 60 * 1000;
// A suite sets AUTODEV_LEDGER_LOCK_WAIT_MS to see a refusal without waiting the full ten seconds.
const LOCK_WAIT_MS = Number(process.env.AUTODEV_LEDGER_LOCK_WAIT_MS) || 10 * 1000;
// A queued task whose launch was refused this many times stays queued for a person.
const MAX_LAUNCH_ATTEMPTS = 3;
// Refusals a later tick can clear with no person. They are logged, never counted.
const TRANSIENT_LAUNCH_CODES = ['fetch-failed', 'origin-unreadable', 'git-unavailable', 'ledger-locked'];

function fault(code, message) { const e = new Error(message || code); e.publicCode = code; throw e; }

function parseArgs(argv) {
    const out = { _: [] };
    const flags = ['help', 'report-read', 'dry-run', 'dev'];
    const known = ['_', ...flags, 'repo', 'slug', 'brief-file', 'return', 'report', 'base', 'task-id', 'title', 'ledger', 'session', 'run-status', 'reason',
        'after', 'model', 'effort', 'permission-mode', 'config-dir', 'headless-worker', 'claude-bin', 'decision', 'by', 'max-concurrent', 'max-per-hour',
        'pin', 'allow-pin-change', 'head'];
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

// Forward slashes on every host: git and Git Bash accept them on Windows, and a
// backslash inside a prompt is read as an escape by the shell that runs it.
const slashes = (p) => p.replace(/\\/g, '/');
const sameDir = (a, b) => {
    const norm = (p) => slashes(path.resolve(p)).replace(/\/+$/, '');
    return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

function git(repo, args, timeoutMs) {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    // A timed-out git is a failed step the caller reports, not a missing git.
    if (r.error && r.error.code === 'ETIMEDOUT') return { status: null, stdout: '', stderr: `timed out after ${timeoutMs} ms` };
    if (r.error) fault('git-unavailable', r.error.message);
    return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function defaultLedger() { return path.join(claudePaths.configDir(), 'autodev', 'unattended-workers.json'); }

function readLedger(file) {
    if (!fs.existsSync(file)) return { version: 1, records: [] };
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fault('ledger-unreadable', `${file}: ${e.message}`); }
    if (!parsed || !Array.isArray(parsed.records)) fault('ledger-unreadable', `${file}: no records array`);
    return parsed;
}

function writeLedger(file, ledger) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(ledger, null, 2) + '\n');
    fs.renameSync(temp, file);
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/**
 * Every write holds `<ledger>.lock`. Before the queue, one coordinator wrote this
 * ledger by hand. Now the Brain clock's launch and a Brain turn's enqueue can land
 * in the same second, and a read-modify-write without a lock loses one of them.
 * A lock older than LOCK_STALE_MS is a dead writer's, and is taken over.
 */
function withLock(ledgerFile, fn) {
    const lock = `${ledgerFile}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    const token = crypto.randomUUID();
    for (;;) {
        try {
            fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }), { flag: 'wx' });
            break;
        } catch (e) {
            if (e.code !== 'EEXIST') fault('ledger-locked', `${lock}: ${e.code || e.message}`);
            let age = null;
            try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { age = null; }
            if (age !== null && age > LOCK_STALE_MS) { try { fs.unlinkSync(lock); } catch { /* another writer took it over first */ } continue; }
            if (Date.now() > deadline) fault('ledger-locked', `${lock} is held by another writer; try again`);
            sleepMs(50);
        }
    }
    try { return fn(); } finally {
        // Release only our own lock: one taken over as stale belongs to its new writer.
        try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).token === token) fs.unlinkSync(lock); } catch { /* gone or not ours */ }
    }
}

function findRecord(ledger, taskId) {
    const rec = ledger.records.find((r) => r.taskId === taskId);
    if (!rec) fault('unknown-task', `no ledger record for task ${taskId}`);
    return rec;
}

/**
 * The prompt a scheduled run receives. STEP 0 comes first because the run opens
 * in a shared checkout, and every later instruction assumes the worktree exists.
 *
 * The `cd` in STEP 0 holds for that one shell call and no longer. The host
 * resets the Bash working directory to the checkout the session opened in
 * between calls ([measured 2026-09-16] "Shell cwd was reset" four times in one
 * unattended run), so a worker that trusted STEP 0 ran its next `git commit` in
 * the shared main tree. Hence the per-command prefix below: every later command
 * starts with `cd "<worktree>" && `, and the worker re-reads the toplevel in the
 * same command before a commit, push or merge.
 */
function composePrompt({ repo, worktree, branch, base, taskId, returnTo, report, slug, body, scratch, channel, pins }) {
    const r = slashes(repo), w = slashes(worktree);
    const rep = slashes(report || path.join(scratch || os.tmpdir(), 'REPORT.md'));
    const code = slug || taskId;
    return [
        'STEP 0. Do this before anything else. This session opened in a checkout other sessions share.',
        '```bash',
        `git -C "${r}" fetch origin`,
        `git -C "${r}" worktree add "${w}" -b "${branch}" ${base}`,
        `cd "${w}"`,
        `test "$(git rev-parse --show-toplevel)" = "${w}" || { echo "STEP 0 FAILED: not inside ${w}"; exit 1; }`,
        `node "${slashes(SHARED_INSTALL)}" link "${w}" || true`,
        '```',
        `Work ONLY inside ${w}, on branch ${branch}. Do not edit, commit, check out or stash in the checkout this session opened in.`,
        'The `link` line gives the worktree the main checkout\'s node_modules as hardlinks when the lockfiles match, in seconds and with no extra disk. Where it prints `run: ... npm ci`, that directory needs its own install: run exactly that before building. Before any install of your own in a shared tree, run the `unshare` command the install guard names.',
        `Every later shell command starts with \`cd "${w}" && \`: the shell's working directory is reset to the checkout this session opened in between commands, so a bare command after STEP 0 runs in the shared checkout. Before any commit, push or merge, print \`git rev-parse --show-toplevel\` in the same command and check it says ${w}.`,
        `If STEP 0 fails, do no other work: write the failing command and its output to ${rep}, then stop. An unattended run cannot use SendMessage.`,
        `Any further worktree goes at ${r}/.claude/worktrees/<name>, never beside the repo.${scratch ? ` Logs, diffs, exit files and other scratch output go under ${slashes(scratch)}, never in the directory that holds the checkouts.` : ''}`,
        ...(pins && pins.length ? [`PINNED ACCEPTANCE TESTS: ${pins.map((p) => p.path).join(', ')}. Do not edit, rename or delete them: an accept verdict is refused when any of them differs on ${branch} from ${base}. If one is wrong, say so in the report instead of changing it.`] : []),
        '',
        body.trim(),
        '',
        `WHEN DONE OR BLOCKED, write one report to ${rep} for ${returnTo}: the commits, each verification command with what it printed, and what remains. Its LAST line is exactly \`RESULT ${code} done|stopped|failed: <one line>\`. An unattended run cannot use SendMessage, so the file is the only return channel.`,
        // [measured 2026-09-26] a worker ended its turn on a question. Nobody
        // watches an unattended session, so it sat idle with no RESULT line
        // and read as still running until a coordinator opened it by hand.
        `Never end your turn with a question: nobody is watching this session to answer it. When you need a decision, write the report with its last line \`RESULT ${code} stopped: <the question and the options>\`, then end.`,
        // A headless run has no scheduled task behind it, so the line would name one that does not exist.
        ...(channel === 'headless' ? [] : [`Do not delete scheduled task ${taskId}. Deleting it archives this session; the coordinator deletes it after reading your report.`]),
        '',
    ].join('\n');
}

/** Whether delete_scheduled_task is safe for a record, given the run's status. */
function decideSettle(record, runStatus, reportRead) {
    if (!RUN_STATUSES.includes(runStatus)) fault('usage', `--run-status must be one of ${RUN_STATUSES.join(', ')}`);
    if (record.state === 'composed') return { deleteSafe: false, reason: 'no run recorded: run_scheduled_task, then record its session id' };
    if (record.state === 'queued') return { deleteSafe: false, reason: 'queued and never launched: there is no run to settle' };
    if (record.state === 'deleted') return { deleteSafe: false, reason: 'already deleted' };
    if (record.state === 'closed') return { deleteSafe: false, reason: 'already closed' };
    if (record.state === 'retired') return { deleteSafe: false, reason: 'retired before it ran: there is no run to settle' };
    if (runStatus === 'running') return { deleteSafe: false, reason: 'the run is still going, and deleting the task archives its session' };
    if (!reportRead) return { deleteSafe: false, reason: `the run ${runStatus} but its result was not read: read list_events for ${record.sessionId}, then pass --report-read` };
    return { deleteSafe: true, reason: `the run ${runStatus} and its result was read` };
}

function resolveRepo(raw) {
    let repo;
    try { repo = fs.realpathSync.native(raw); } catch { fault('not-a-repo', `${raw} does not exist`); }
    const top = git(repo, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0 || !sameDir(top.stdout, repo)) fault('not-a-repo', `${repo} is not the top of a git work tree`);
    return repo;
}

function checkBase(base) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base)) fault('bad-base', `base ${base} is not a plain ref name`);
    return base;
}

function readBrief(file) {
    const body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fault('brief-missing', `${file} does not exist`);
    if (!body.trim()) fault('brief-empty', `${file} is empty`);
    return body;
}

/**
 * PINNED ACCEPTANCE TESTS. A brief names the test files that decide whether the
 * work is done, and the record keeps each one's blob sha at the base. A worker
 * that edits the test to get green still reports green, and a judge reading the
 * report accepts it, so `verdict --decision accept` compares those blobs against
 * the worker's result head and refuses on any difference or deletion.
 */
function resolvePins(raw, repo, base) {
    if (raw === undefined) return {};
    const paths = String(raw).split(',').map((s) => slashes(s.trim())).filter(Boolean);
    if (!paths.length) fault('bad-pin', '--pin needs at least one repo-relative path');
    const baseSha = git(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
    if (baseSha.status !== 0) fault('base-unresolved', `${base} does not resolve in ${repo}, so the pinned tests cannot be read there; fetch first`);
    const pins = [];
    for (const p of [...new Set(paths)]) {
        if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.split('/').some((seg) => seg === '..' || seg === '.')) {
            fault('bad-pin', `pin ${p} must be a plain repo-relative path`);
        }
        const blob = git(repo, ['rev-parse', '--verify', '--quiet', `${baseSha.stdout}:${p}`]);
        const type = blob.status === 0 ? git(repo, ['cat-file', '-t', blob.stdout]).stdout : '';
        if (type !== 'blob') fault('pin-missing', `pin ${p} is not a file at ${base} (${baseSha.stdout.slice(0, 12)})`);
        pins.push({ path: p, blob: blob.stdout });
    }
    return { pins, pinBase: baseSha.stdout };
}

/**
 * The commits that can stand for the worker's result: a --head the caller names,
 * else the local branch and its origin copy. The branch can be gone locally and
 * still pushed, so an origin branch git has not fetched yet is fetched once.
 */
function resultHeads(rec, explicit) {
    const commit = (ref) => { const r = git(rec.repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return r.status === 0 ? r.stdout : null; };
    if (explicit) {
        const sha = commit(explicit);
        if (!sha) fault('bad-head', `--head ${explicit} is not a commit in ${rec.repo}`);
        return [{ sha, source: 'flag' }];
    }
    const local = () => [
        { sha: commit(`refs/heads/${rec.branch}`), source: 'local branch' },
        { sha: commit(`refs/remotes/origin/${rec.branch}`), source: 'origin branch' },
    ].filter((h) => h.sha);
    let heads = local();
    if (!heads.length) {
        git(rec.repo, ['fetch', '--quiet', 'origin', `+refs/heads/${rec.branch}:refs/remotes/origin/${rec.branch}`], FETCH_TIMEOUT_MS);
        heads = local();
    }
    return heads;
}

/** unchanged, changed (with each path and why) or unchecked (no head to read). */
function checkPins(rec, explicitHead) {
    const pins = rec.pins || [];
    let heads;
    try { heads = resultHeads(rec, explicitHead); } catch (e) { if (e.publicCode === 'bad-head') throw e; heads = []; }
    if (!heads.length) {
        return { state: 'unchecked', base: rec.pinBase || null, head: null, headSource: null, changed: [],
            why: `could not check the pinned tests: no result head for ${rec.branch} locally or on origin` };
    }
    const changed = [];
    for (const h of heads) {
        for (const p of pins) {
            const now = git(rec.repo, ['rev-parse', '--verify', '--quiet', `${h.sha}:${p.path}`]);
            const blob = now.status === 0 ? now.stdout : null;
            if (blob !== p.blob && !changed.some((c) => c.path === p.path)) changed.push({ path: p.path, head: h.sha, how: blob ? 'edited' : 'deleted' });
        }
    }
    return { state: changed.length ? 'changed' : 'unchanged', base: rec.pinBase || null, head: heads[0].sha, headSource: heads[0].source,
        heads: heads.map((h) => ({ sha: h.sha, source: h.source })), checked: pins.length, changed };
}

/**
 * Run before an accept is written. follow-up and escalate never reach it. Returns
 * what to store on the verdict, or faults pin-changed / pin-unchecked unless the
 * caller gave --allow-pin-change with a reason.
 */
function gatePins(rec, { decision, allow, head }) {
    if (allow !== undefined && decision !== 'accept') fault('usage', '--allow-pin-change applies only to --decision accept');
    if (decision !== 'accept' || !Array.isArray(rec.pins) || !rec.pins.length) return null;
    const pc = checkPins(rec, head);
    if (pc.state === 'unchanged' || allow !== undefined) return { pinCheck: pc, ...(allow !== undefined ? { allowPinChange: String(allow).slice(0, 2000) } : {}) };
    const override = 'pass --allow-pin-change "<reason>" to accept anyway';
    if (pc.state === 'unchecked') fault('pin-unchecked', `${pc.why}; name it with --head <sha> or ${override}`);
    const list = pc.changed.map((c) => `${c.path} (${c.how})`).join(', ');
    fault('pin-changed', `pinned test(s) changed between base ${String(pc.base).slice(0, 12)} and head ${pc.changed[0].head.slice(0, 12)}: ${list}; ${override}`);
}

/**
 * Nothing already claims the slug: not the worktree path, the local branch, the
 * origin branch, nor another active ledger record. `self` is the task being
 * launched, whose own queued record is not a claim against itself.
 */
function checkUnclaimed(repo, slug, taskId, ledger, self = null) {
    const branch = `claude/${slug}`;
    const worktree = path.join(repo, '.claude', 'worktrees', slug);
    if (fs.existsSync(worktree)) fault('worktree-exists', `${worktree} already exists`);
    if (git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0) fault('branch-exists', `local branch ${branch} already exists`);
    // Exit 2 is the only answer that means absent. Anything else, including an
    // unreachable origin, is treated as a claim, because a guessed "free" is the
    // expensive mistake: two sessions pushing one branch.
    const remote = git(repo, ['ls-remote', '--exit-code', '--heads', 'origin', branch], FETCH_TIMEOUT_MS);
    if (remote.status === 0) fault('remote-branch-exists', `origin already has ${branch}`);
    if (remote.status !== 2) fault('origin-unreadable', `ls-remote origin exited ${remote.status}: ${remote.stderr}`);
    checkLedgerFree(ledger, repo, slug, taskId, self);
    return { branch, worktree };
}

function checkLedgerFree(ledger, repo, slug, taskId, self = null) {
    const active = ledger.records.filter((r) => ACTIVE.includes(r.state) && r.taskId !== self);
    if (active.some((r) => r.taskId === taskId)) fault('task-id-in-use', `task ${taskId} has an active ledger record`);
    if (active.some((r) => sameDir(r.repo, repo) && r.slug === slug)) fault('ledger-collision', `slug ${slug} is active for ${repo}`);
}

function scratchFor(taskId) { return path.join(claudePaths.configDir(), 'autodev', 'reports', taskId); }

function brief(opts) {
    for (const k of ['repo', 'slug', 'brief-file', 'return']) if (!opts[k]) fault('usage', `--${k} is required for brief`);
    if (!SLUG.test(opts.slug)) fault('bad-slug', `slug must match ${SLUG}`);
    const taskId = opts['task-id'] || `worker-${opts.slug}`;
    if (!SLUG.test(taskId)) fault('bad-task-id', `task id must match ${SLUG}`);
    const base = checkBase(opts.base || 'origin/main');
    const repo = resolveRepo(opts.repo);
    if (git(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).status !== 0) fault('base-unresolved', `${base} does not resolve in ${repo}; fetch first`);
    const body = readBrief(opts['brief-file']);
    const pinned = resolvePins(opts.pin, repo, base);

    const ledgerFile = opts.ledger || defaultLedger();
    return withLock(ledgerFile, () => {
        const ledger = readLedger(ledgerFile);
        const { branch, worktree } = checkUnclaimed(repo, opts.slug, taskId, ledger);
        const returnTo = opts.return;
        // [measured 2026-09-22] a worker told only "a new worktree" and `> f.log`
        // put both in the directory holding the checkouts. Name the scratch home.
        const scratch = scratchFor(taskId);
        const report = opts.report ? path.resolve(opts.report) : path.join(scratch, 'REPORT.md');
        const prompt = composePrompt({ repo, worktree, branch, base, taskId, returnTo, report, slug: opts.slug, body, scratch, pins: pinned.pins });
        const record = {
            taskId, repo, slug: opts.slug, branch, worktree, base, returnTo, report, state: 'composed', ...pinned,
            composedAt: new Date().toISOString(), ...stamp('composed'),
            promptSha256: crypto.createHash('sha256').update(prompt).digest('hex'),
        };
        ledger.records = ledger.records.filter((r) => r.taskId !== taskId).concat(record);
        writeLedger(ledgerFile, ledger);
        return {
            ledger: ledgerFile,
            record,
            createScheduledTask: { taskId, title: opts.title || `Worker: ${opts.slug}`, description: `Unattended worker for ${opts.slug} (one-off run)`, prompt },
            next: ['create_scheduled_task with createScheduledTask (no cronExpression, no fireAt)', `run_scheduled_task ${taskId}`, `record --task-id ${taskId} --session <returned id>`],
        };
    });
}

/**
 * Queue a brief for the headless channel. The target checks that cannot go
 * stale (repo, slug, base spelling, brief, dependencies, ledger claims) run now;
 * the ones that can (base resolves, worktree, branches) run again at launch.
 */
function enqueue(opts) {
    for (const k of ['repo', 'slug', 'brief-file', 'return']) if (!opts[k]) fault('usage', `--${k} is required for enqueue`);
    if (!SLUG.test(opts.slug) || opts.slug.length > HEADLESS_SLUG_MAX) {
        fault('bad-slug', `slug must match ${SLUG} and be at most ${HEADLESS_SLUG_MAX} characters, because it becomes the headless worker code`);
    }
    const taskId = opts['task-id'] || `worker-${opts.slug}`;
    if (!SLUG.test(taskId)) fault('bad-task-id', `task id must match ${SLUG}`);
    const base = checkBase(opts.base || 'origin/main');
    const repo = resolveRepo(opts.repo);
    const body = readBrief(opts['brief-file']);
    // Read now so a bad pin is refused at enqueue, and again at launch against the base the worker starts from.
    const pinned = resolvePins(opts.pin, repo, base);
    const after = opts.after ? opts.after.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (after.includes(taskId)) fault('bad-dependency', `task ${taskId} cannot wait on itself`);
    const launchOpts = {
        model: opts.model || null,
        effort: opts.effort || null,
        permissionMode: opts['permission-mode'] || 'bypassPermissions',
        configDir: opts['config-dir'] || null,
    };
    const ledgerFile = opts.ledger || defaultLedger();
    return withLock(ledgerFile, () => {
        const ledger = readLedger(ledgerFile);
        for (const dep of after) if (!ledger.records.some((r) => r.taskId === dep)) fault('unknown-dependency', `--after names ${dep}, which has no ledger record`);
        checkLedgerFree(ledger, repo, opts.slug, taskId);
        const scratch = scratchFor(taskId);
        fs.mkdirSync(scratch, { recursive: true });
        const briefFile = path.join(scratch, 'BRIEF.md');
        fs.writeFileSync(briefFile, body);
        const record = {
            taskId, repo, slug: opts.slug, branch: `claude/${opts.slug}`, worktree: path.join(repo, '.claude', 'worktrees', opts.slug), base,
            returnTo: opts.return, report: path.join(scratch, 'REPORT.md'), state: 'queued', channel: 'headless',
            title: opts.title || `Worker: ${opts.slug}`, queuedAt: new Date().toISOString(), after, briefFile,
            briefSha256: crypto.createHash('sha256').update(body).digest('hex'), launch: launchOpts, ...pinned,
        };
        ledger.records = ledger.records.filter((r) => r.taskId !== taskId).concat(record);
        writeLedger(ledgerFile, ledger);
        return { ledger: ledgerFile, record };
    });
}

/**
 * Where a dependency stands: `ok` once it finished, succeeded and was accepted;
 * `pending` while that can still happen with no person; `blocked` when only a
 * person can move it (it failed, was retired, or its verdict was not accept).
 */
function dependencyState(dep) {
    if (!dep) return { state: 'blocked', reason: 'no ledger record' };
    if (dep.state === 'retired') return { state: 'blocked', reason: `${dep.taskId} was retired` };
    if (!FINISHED.includes(dep.state)) return { state: 'pending', reason: `${dep.taskId} is ${dep.state}` };
    if (dep.runStatus !== 'succeeded') return { state: 'blocked', reason: `${dep.taskId} ${dep.runStatus || 'ended with no run status'}` };
    if (!dep.verdict) return { state: 'pending', reason: `${dep.taskId} awaits a verdict` };
    if (dep.verdict.decision !== 'accept') return { state: 'blocked', reason: `${dep.taskId} verdict ${dep.verdict.decision}` };
    return { state: 'ok', reason: `${dep.taskId} accepted` };
}

/**
 * Which queued tasks may start now. Pure: the ledger's records and the clock in,
 * the plan out, so a suite can drive every branch without a process.
 * Queued tasks go first-in first-out. A started record of either channel holds a
 * concurrency slot, and every launch in the last hour spends one of the hour's.
 */
function planStarts(records, { now = Date.now(), maxConcurrent = 2, maxPerHour = 2 } = {}) {
    const byId = new Map(records.map((r) => [r.taskId, r]));
    const running = records.filter((r) => r.state === 'started').length;
    const launchedLastHour = records.filter((r) => {
        const at = Date.parse(r.launchedAt || '');
        return Number.isFinite(at) && now - at < HOUR_MS && now >= at;
    }).length;
    let slots = Math.max(0, Math.min(maxConcurrent - running, maxPerHour - launchedLastHour));
    const slotsAtStart = slots;
    const ready = []; const pending = []; const blocked = []; const capped = [];
    const queued = records.filter((r) => r.state === 'queued')
        .sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
    for (const rec of queued) {
        const attempts = (rec.lastLaunchError && rec.lastLaunchError.attempts) || 0;
        if (attempts >= MAX_LAUNCH_ATTEMPTS) { blocked.push({ taskId: rec.taskId, reason: `launch refused ${attempts} times, last: ${rec.lastLaunchError.code}` }); continue; }
        const deps = (rec.after || []).map((id) => ({ id, ...dependencyState(byId.get(id)) }));
        const stuck = deps.filter((d) => d.state === 'blocked');
        if (stuck.length) { blocked.push({ taskId: rec.taskId, reason: stuck.map((d) => `${d.id}: ${d.reason}`).join('; ') }); continue; }
        const waiting = deps.filter((d) => d.state === 'pending');
        if (waiting.length) { pending.push({ taskId: rec.taskId, reason: waiting.map((d) => d.reason).join('; ') }); continue; }
        if (slots > 0) { ready.push(rec.taskId); slots--; } else capped.push(rec.taskId);
    }
    return { ready, pending, blocked, capped, running, launchedLastHour, slots: slotsAtStart, maxConcurrent, maxPerHour };
}

function capOpt(opts, key, fallback) {
    if (opts[key] === undefined) return fallback;
    const n = Number(opts[key]);
    if (!Number.isInteger(n) || n < 0) fault('usage', `--${key} must be a whole number`);
    return n;
}

/** The pointer prompt: the composed prompt goes in a file, since headless-worker passes the prompt in argv. */
function pointerPrompt(promptFile) {
    return `Read ${slashes(promptFile)} in full with the Read tool before anything else, then follow it exactly. `
        + 'It is your whole brief, and its STEP 0 comes first.\n';
}

function defaultHeadlessWorker() { return path.join(__dirname, 'headless-worker.js'); }

/** The argv for `headless-worker.js start`, from a queued record and the launch flags. */
function headlessArgs(rec, files, opts) {
    const l = rec.launch || {};
    const args = [opts['headless-worker'] ? path.resolve(opts['headless-worker']) : defaultHeadlessWorker(), 'start',
        '--code', rec.slug, '--prompt-file', files.pointer, '--log', files.log, '--report', rec.report, '--cwd', rec.repo,
        '--permission-mode', l.permissionMode || 'bypassPermissions'];
    if (l.model) args.push('--model', l.model);
    if (l.effort) args.push('--effort', l.effort);
    if (l.configDir) args.push('--config-dir', l.configDir);
    if (opts['claude-bin']) args.push('--claude-bin', opts['claude-bin']);
    if (opts.dev) args.push('--dev');
    if (opts['dry-run']) args.push('--dry-run');
    return args;
}

function parseHeadless(r) {
    if (r.error) return { ok: false, code: r.error.code === 'ETIMEDOUT' ? 'headless-timeout' : 'headless-spawn', message: r.error.message };
    let doc = null;
    try { doc = JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop()); } catch { doc = null; }
    if (!doc || typeof doc.ok !== 'boolean') return { ok: false, code: 'headless-unparseable', message: `exit ${r.status}: ${String(r.stdout || r.stderr).slice(0, 300)}` };
    if (!doc.ok) return { ok: false, code: String((doc.error && doc.error.code) || 'unknown'), message: String((doc.error && doc.error.message) || '') };
    return { ok: true, value: doc.value };
}

/**
 * A start that timed out can still have spawned its supervisor. If the headless
 * ledger holds a run of this code begun after the spawn, the task started: record
 * it, or the next ticks refuse on code-active and nothing ever closes the run.
 */
function recoverTimedOutStart(code, spawnedAt, file = path.join(claudePaths.configDir(), 'autodev', 'headless-workers.json')) {
    let records;
    try { records = readHeadlessLedger(file).records; } catch { return null; }
    const run = records.filter((h) => h.code === code && Date.parse(h.startedAt || '') >= spawnedAt - 5000).pop();
    return run ? { ok: true, value: { supervisorPid: run.pid || null, ledger: file, record: run, recovered: true } } : null;
}

/**
 * Start one queued task as a headless worker. The brief checks run again,
 * because a worktree, branch or origin branch can have appeared since enqueue.
 * A refusal anywhere leaves the record queued with lastLaunchError and an
 * attempt count, and is rethrown so the caller sees exit 1.
 */
function launch(opts) {
    if (!opts['task-id']) fault('usage', '--task-id is required');
    const ledgerFile = opts.ledger || defaultLedger();
    const dry = opts['dry-run'] === true;
    const first = readLedger(ledgerFile);
    const pre = findRecord(first, opts['task-id']);
    if (pre.state !== 'queued') fault('bad-state', `task ${pre.taskId} is ${pre.state}, not queued`);
    const fetched = git(pre.repo, ['fetch', '--quiet', 'origin'], FETCH_TIMEOUT_MS);
    return withLock(ledgerFile, () => {
        const ledger = readLedger(ledgerFile);
        const rec = findRecord(ledger, opts['task-id']);
        const refuse = (e) => {
            // Only a queued record carries an attempt count: a refusal because the
            // record already moved on must not write onto a record that ran.
            if (!dry && rec.state === 'queued') {
                const code = e.publicCode || 'internal';
                const transient = TRANSIENT_LAUNCH_CODES.includes(code);
                const attempts = ((rec.lastLaunchError && rec.lastLaunchError.attempts) || 0) + (transient ? 0 : 1);
                rec.lastLaunchError = { code, message: e.message, at: new Date().toISOString(), attempts, transient };
                writeLedger(ledgerFile, ledger);
            }
            throw e;
        };
        try {
            if (rec.state !== 'queued') fault('bad-state', `task ${rec.taskId} is ${rec.state}, not queued`);
            resolveRepo(rec.repo);
            if (fetched.status !== 0) fault('fetch-failed', `git fetch origin exited ${fetched.status}: ${fetched.stderr}`);
            if (git(rec.repo, ['rev-parse', '--verify', '--quiet', `${rec.base}^{commit}`]).status !== 0) fault('base-unresolved', `${rec.base} does not resolve in ${rec.repo}`);
            const { branch, worktree } = checkUnclaimed(rec.repo, rec.slug, rec.taskId, ledger, rec.taskId);
            for (const dep of rec.after || []) {
                const d = dependencyState(ledger.records.find((r) => r.taskId === dep));
                if (d.state !== 'ok') fault('dependency-unmet', `${dep}: ${d.reason}`);
            }
            const body = readBrief(rec.briefFile);
            const scratch = path.dirname(rec.briefFile);
            // The base can have moved since enqueue: pin the blobs the worker's worktree will start from.
            const pinned = rec.pins && rec.pins.length ? resolvePins(rec.pins.map((p) => p.path).join(','), rec.repo, rec.base) : {};
            const prompt = composePrompt({ repo: rec.repo, worktree, branch, base: rec.base, taskId: rec.taskId, returnTo: rec.returnTo,
                report: rec.report, slug: rec.slug, body, scratch, channel: 'headless', pins: pinned.pins });
            const files = { prompt: path.join(scratch, 'PROMPT.md'), pointer: path.join(scratch, 'POINTER.md'), log: path.join(scratch, 'worker.log') };
            fs.writeFileSync(files.prompt, prompt);
            fs.writeFileSync(files.pointer, pointerPrompt(files.prompt));
            const args = headlessArgs(rec, files, opts);
            const spawnedAt = Date.now();
            const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: LAUNCH_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            let h = parseHeadless(r);
            if (!h.ok && h.code === 'headless-timeout' && !dry) h = recoverTimedOutStart(rec.slug, spawnedAt) || h;
            if (!h.ok) fault(h.code, `headless-worker start refused: ${h.message}`);
            if (dry) return { ledger: ledgerFile, dryRun: true, taskId: rec.taskId, files, headless: h.value };
            const at = new Date().toISOString();
            Object.assign(rec, pinned, {
                state: 'started', startedAt: at, launchedAt: at,
                promptSha256: crypto.createHash('sha256').update(prompt).digest('hex'),
                headless: { code: rec.slug, pid: h.value.supervisorPid || null, log: files.log, ledger: h.value.ledger || null,
                    startedAt: (h.value.record && h.value.record.startedAt) || null, version: (h.value.record && h.value.record.version) || null },
            });
            delete rec.lastLaunchError;
            writeLedger(ledgerFile, ledger);
            return { ledger: ledgerFile, record: rec, files };
        } catch (e) { return refuse(e); }
    });
}

// A copy inside the plugin cache is the install the run session boots on, so
// its manifest names the release. A checkout copy names the checkout's
// version, and `dev` says so.
function stamp(prefix) {
    const placement = scriptPlacement(__filename);
    return { [`${prefix}Version`]: placement.version, [`${prefix}Dev`]: !placement.installed };
}

function mutate(opts, fn) {
    if (!opts['task-id']) fault('usage', '--task-id is required');
    const ledgerFile = opts.ledger || defaultLedger();
    return withLock(ledgerFile, () => {
        const ledger = readLedger(ledgerFile);
        const rec = findRecord(ledger, opts['task-id']);
        const value = fn(rec);
        writeLedger(ledgerFile, ledger);
        return { ledger: ledgerFile, record: rec, ...value };
    });
}

/** Record a verdict. A judge never replaces a standing verdict; the Brain or the operator can. */
function applyVerdict(rec, { decision, reason, by = 'brain', at = new Date().toISOString(), pins = null }) {
    if (!DECISIONS.includes(decision)) fault('usage', `--decision must be one of ${DECISIONS.join(', ')}`);
    if (!VERDICT_BY.includes(by)) fault('usage', `--by must be one of ${VERDICT_BY.join(', ')}`);
    if (!reason || !String(reason).trim()) fault('usage', '--reason is required');
    if (!FINISHED.includes(rec.state)) fault('bad-state', `task ${rec.taskId} is ${rec.state}; a verdict needs a finished run`);
    if (rec.verdict && by === 'judge') return { applied: false, reason: `a ${rec.verdict.by} verdict (${rec.verdict.decision}) stands, and a judge never replaces one` };
    const previous = rec.verdict || null;
    rec.verdict = { decision, reason: String(reason).slice(0, 2000), by, at, ...(pins || {}) };
    return { applied: true, previous };
}

function run(argv) {
    const opts = parseArgs(argv);
    if (opts.help) return { help: true };
    const cmd = opts._[0];
    if (cmd === 'brief') return brief(opts);
    if (cmd === 'enqueue') return enqueue(opts);
    if (cmd === 'launch') return launch(opts);
    if (cmd === 'record') {
        if (!opts.session || !SESSION.test(opts.session)) fault('bad-session', '--session must be a local_<uuid> id returned by run_scheduled_task');
        return mutate(opts, (rec) => {
            if (rec.state !== 'composed') fault('bad-state', `task ${rec.taskId} is ${rec.state}, not composed`);
            // `version` and `dev` under the names headless-worker.js records use.
            const { startedVersion: version, startedDev: dev } = stamp('started');
            Object.assign(rec, { state: 'started', sessionId: opts.session, startedAt: new Date().toISOString(), version, dev });
            return {};
        });
    }
    if (cmd === 'settle') {
        return mutate(opts, (rec) => {
            const decision = decideSettle(rec, opts['run-status'], opts['report-read'] === true);
            if (decision.deleteSafe && rec.channel === 'headless') {
                // No scheduled task stands behind a headless run: settling it is the end.
                Object.assign(rec, { state: 'closed', settledAt: new Date().toISOString(), runStatus: opts['run-status'], ...stamp('settled') });
                decision.reason += ', and a headless run has no scheduled task to delete: closed';
            } else if (decision.deleteSafe) {
                Object.assign(rec, { state: 'settled', settledAt: new Date().toISOString(), runStatus: opts['run-status'], ...stamp('settled') });
            }
            return { decision };
        });
    }
    if (cmd === 'deleted') {
        return mutate(opts, (rec) => {
            if (rec.channel === 'headless') fault('bad-state', `task ${rec.taskId} ran headless: there is no scheduled task to delete`);
            if (rec.state !== 'settled') fault('bad-state', `task ${rec.taskId} is ${rec.state}; settle it before deleting`);
            Object.assign(rec, { state: 'deleted', deletedAt: new Date().toISOString() });
            return {};
        });
    }
    if (cmd === 'retire') {
        return mutate(opts, (rec) => {
            if (rec.state !== 'composed' && rec.state !== 'queued') fault('bad-state', `task ${rec.taskId} is ${rec.state}; retire is only for a record with no run behind it`);
            Object.assign(rec, { state: 'retired', retiredAt: new Date().toISOString(), reason: opts.reason || 'never ran' });
            return {};
        });
    }
    if (cmd === 'verdict') {
        return mutate(opts, (rec) => {
            // Shape errors first, so a malformed call never spends a fetch on the pin check.
            if (!DECISIONS.includes(opts.decision)) fault('usage', `--decision must be one of ${DECISIONS.join(', ')}`);
            if (!VERDICT_BY.includes(opts.by || 'brain')) fault('usage', `--by must be one of ${VERDICT_BY.join(', ')}`);
            if (!opts.reason || !String(opts.reason).trim()) fault('usage', '--reason is required');
            if (!FINISHED.includes(rec.state)) fault('bad-state', `task ${rec.taskId} is ${rec.state}; a verdict needs a finished run`);
            const pins = gatePins(rec, { decision: opts.decision, allow: opts['allow-pin-change'], head: opts.head });
            return { verdict: applyVerdict(rec, { decision: opts.decision, reason: opts.reason, by: opts.by || 'brain', pins }) };
        });
    }
    if (cmd === 'ready') {
        const ledgerFile = opts.ledger || defaultLedger();
        const ledger = readLedger(ledgerFile);
        const plan = planStarts(ledger.records, { maxConcurrent: capOpt(opts, 'max-concurrent', 2), maxPerHour: capOpt(opts, 'max-per-hour', 2) });
        return { ledger: ledgerFile, ...plan };
    }
    if (cmd === 'status') {
        const ledgerFile = opts.ledger || defaultLedger();
        const ledger = readLedger(ledgerFile);
        const records = opts['task-id'] ? [findRecord(ledger, opts['task-id'])] : ledger.records;
        const counts = {};
        for (const r of ledger.records) counts[r.state] = (counts[r.state] || 0) + 1;
        // Only a record that started can say which release ran it.
        const ran = ledger.records.filter((r) => r.sessionId);
        const versioned = ran.filter((r) => typeof r.version === 'string' && r.version).length;
        return { ledger: ledgerFile, recordsRead: ledger.records.length, counts, ran: ran.length, versioned, unversioned: ran.length - versioned, records };
    }
    fault('usage', cmd ? `unknown command ${cmd}` : 'a command is required');
}

if (require.main === module) {
    try {
        const value = run(process.argv.slice(2));
        if (value.help) process.stdout.write(USAGE);
        else process.stdout.write(JSON.stringify({ ok: true, value }, null, 2) + '\n');
        process.exitCode = 0;
    } catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: { code: e.publicCode || 'internal', message: e.message } }) + '\n');
        process.exitCode = 1;
    }
}

module.exports = { resolvePins, checkPins, gatePins, composePrompt, decideSettle, parseArgs, run, planStarts, dependencyState, applyVerdict, pointerPrompt, headlessArgs, parseHeadless, recoverTimedOutStart, withLock, FINISHED, DECISIONS, TRANSIENT_LAUNCH_CODES };
