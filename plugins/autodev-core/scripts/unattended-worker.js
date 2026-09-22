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
 *   status  prints every ledger record and how many were read.
 *
 * WHAT IT IS NOT. It starts nothing, deletes nothing and verifies no result.
 * A `started` record means a session id was returned, not that step 0 passed.
 *
 * Usage:
 *   node unattended-worker.js brief --repo <dir> --slug <topic> --brief-file <md> --return <address>
 *        [--base origin/main] [--task-id <id>] [--title <text>] [--ledger <file>]
 *   node unattended-worker.js record --task-id <id> --session <local_uuid> [--ledger <file>]
 *   node unattended-worker.js settle --task-id <id> --run-status running|succeeded|failed [--report-read] [--ledger <file>]
 *   node unattended-worker.js deleted --task-id <id> [--ledger <file>]
 *   node unattended-worker.js retire --task-id <id> [--reason <text>] [--ledger <file>]
 *   node unattended-worker.js status [--task-id <id>] [--ledger <file>]
 * Output: {"ok":true,"value":{...}} exit 0; {"ok":false,"error":{"code","message"}} exit 1.
 */
const fs = require('node:fs');
const path = require('node:path');
const claudePaths = require('./claude-paths.js');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const USAGE = [
    'Usage: node unattended-worker.js brief --repo <dir> --slug <topic> --brief-file <md> --return <address> [--base origin/main] [--task-id <id>] [--title <text>] [--ledger <file>]',
    '       node unattended-worker.js record --task-id <id> --session <local_uuid> [--ledger <file>]',
    '       node unattended-worker.js settle --task-id <id> --run-status running|succeeded|failed [--report-read] [--ledger <file>]',
    '       node unattended-worker.js deleted --task-id <id> [--ledger <file>]',
    '       node unattended-worker.js retire --task-id <id> [--reason <text>] [--ledger <file>]',
    '       node unattended-worker.js status [--task-id <id>] [--ledger <file>]',
    'brief: refuse a slug already claimed (worktree path, local branch, origin branch, active ledger record),',
    '       then print create_scheduled_task arguments whose prompt opens with git worktree add.',
    'settle: delete_scheduled_task archives the run session, so it is safe only once the run has ended',
    '       AND its result was read (--report-read).',
    'retire: close a composed record whose task never ran, freeing its slug and task id.',
    'Starts nothing and deletes nothing: the coordinator makes the scheduled-tasks calls.',
    `Default ledger: ${path.join('~', '.claude', 'autodev', 'unattended-workers.json')}`,
].join('\n') + '\n';

const ACTIVE = ['composed', 'started', 'settled'];
const RUN_STATUSES = ['running', 'succeeded', 'failed'];
const SLUG = /^[a-z0-9][a-z0-9-]{1,48}$/;
const SESSION = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fault(code, message) { const e = new Error(message || code); e.publicCode = code; throw e; }

function parseArgs(argv) {
    const out = { _: [] };
    const flags = ['help', 'report-read'];
    const known = ['_', ...flags, 'repo', 'slug', 'brief-file', 'return', 'base', 'task-id', 'title', 'ledger', 'session', 'run-status', 'reason'];
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

function git(repo, args) {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
function composePrompt({ repo, worktree, branch, base, taskId, returnTo, body, scratch }) {
    const r = slashes(repo), w = slashes(worktree);
    return [
        'STEP 0. Do this before anything else. This session opened in a checkout other sessions share.',
        '```bash',
        `git -C "${r}" fetch origin`,
        `git -C "${r}" worktree add "${w}" -b "${branch}" ${base}`,
        `cd "${w}"`,
        `test "$(git rev-parse --show-toplevel)" = "${w}" || { echo "STEP 0 FAILED: not inside ${w}"; exit 1; }`,
        '```',
        `Work ONLY inside ${w}, on branch ${branch}. Do not edit, commit, check out or stash in the checkout this session opened in.`,
        `Every later shell command starts with \`cd "${w}" && \`: the shell's working directory is reset to the checkout this session opened in between commands, so a bare command after STEP 0 runs in the shared checkout. Before any commit, push or merge, print \`git rev-parse --show-toplevel\` in the same command and check it says ${w}.`,
        `If STEP 0 fails, do no other work: report the failing command and its output to ${returnTo} with SendMessage, then stop.`,
        `Any further worktree goes at ${r}/.claude/worktrees/<name>, never beside the repo.${scratch ? ` Logs, diffs, exit files and other scratch output go under ${slashes(scratch)}, never in the directory that holds the checkouts.` : ''}`,
        '',
        body.trim(),
        '',
        `WHEN DONE OR BLOCKED, send one report to ${returnTo} with SendMessage: the commits, each verification command with what it printed, and what remains.`,
        `Do not delete scheduled task ${taskId}. Deleting it archives this session; the coordinator deletes it after reading your report.`,
        '',
    ].join('\n');
}

/** Whether delete_scheduled_task is safe for a record, given the run's status. */
function decideSettle(record, runStatus, reportRead) {
    if (!RUN_STATUSES.includes(runStatus)) fault('usage', `--run-status must be one of ${RUN_STATUSES.join(', ')}`);
    if (record.state === 'composed') return { deleteSafe: false, reason: 'no run recorded: run_scheduled_task, then record its session id' };
    if (record.state === 'deleted') return { deleteSafe: false, reason: 'already deleted' };
    if (record.state === 'retired') return { deleteSafe: false, reason: 'retired before it ran: there is no run to settle' };
    if (runStatus === 'running') return { deleteSafe: false, reason: 'the run is still going, and deleting the task archives its session' };
    if (!reportRead) return { deleteSafe: false, reason: `the run ${runStatus} but its result was not read: read list_events for ${record.sessionId}, then pass --report-read` };
    return { deleteSafe: true, reason: `the run ${runStatus} and its result was read` };
}

function brief(opts) {
    for (const k of ['repo', 'slug', 'brief-file', 'return']) if (!opts[k]) fault('usage', `--${k} is required for brief`);
    if (!SLUG.test(opts.slug)) fault('bad-slug', `slug must match ${SLUG}`);
    const taskId = opts['task-id'] || `worker-${opts.slug}`;
    if (!SLUG.test(taskId)) fault('bad-task-id', `task id must match ${SLUG}`);
    const base = opts.base || 'origin/main';
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base)) fault('bad-base', `base ${base} is not a plain ref name`);

    let repo;
    try { repo = fs.realpathSync.native(opts.repo); } catch { fault('not-a-repo', `${opts.repo} does not exist`); }
    const top = git(repo, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0 || !sameDir(top.stdout, repo)) fault('not-a-repo', `${repo} is not the top of a git work tree`);
    if (git(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).status !== 0) fault('base-unresolved', `${base} does not resolve in ${repo}; fetch first`);

    const body = fs.existsSync(opts['brief-file']) ? fs.readFileSync(opts['brief-file'], 'utf8') : fault('brief-missing', `${opts['brief-file']} does not exist`);
    if (!body.trim()) fault('brief-empty', `${opts['brief-file']} is empty`);

    const branch = `claude/${opts.slug}`;
    const worktree = path.join(repo, '.claude', 'worktrees', opts.slug);
    if (fs.existsSync(worktree)) fault('worktree-exists', `${worktree} already exists`);
    if (git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0) fault('branch-exists', `local branch ${branch} already exists`);
    // Exit 2 is the only answer that means absent. Anything else, including an
    // unreachable origin, is treated as a claim, because a guessed "free" is the
    // expensive mistake: two sessions pushing one branch.
    const remote = git(repo, ['ls-remote', '--exit-code', '--heads', 'origin', branch]);
    if (remote.status === 0) fault('remote-branch-exists', `origin already has ${branch}`);
    if (remote.status !== 2) fault('origin-unreadable', `ls-remote origin exited ${remote.status}: ${remote.stderr}`);

    const ledgerFile = opts.ledger || defaultLedger();
    const ledger = readLedger(ledgerFile);
    const active = ledger.records.filter((r) => ACTIVE.includes(r.state));
    if (active.some((r) => r.taskId === taskId)) fault('task-id-in-use', `task ${taskId} has an active ledger record`);
    if (active.some((r) => sameDir(r.repo, repo) && r.slug === opts.slug)) fault('ledger-collision', `slug ${opts.slug} is active for ${repo}`);

    const returnTo = opts.return;
    // [measured 2026-09-22] a worker told only "a new worktree" and `> f.log`
    // put both in the directory holding the checkouts. Name the scratch home.
    const scratch = path.join(os.homedir(), '.claude', 'autodev', 'reports', taskId);
    const prompt = composePrompt({ repo, worktree, branch, base, taskId, returnTo, body, scratch });
    const record = {
        taskId, repo, slug: opts.slug, branch, worktree, base, returnTo, state: 'composed',
        composedAt: new Date().toISOString(),
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
}

function mutate(opts, fn) {
    if (!opts['task-id']) fault('usage', '--task-id is required');
    const ledgerFile = opts.ledger || defaultLedger();
    const ledger = readLedger(ledgerFile);
    const rec = findRecord(ledger, opts['task-id']);
    const value = fn(rec);
    writeLedger(ledgerFile, ledger);
    return { ledger: ledgerFile, record: rec, ...value };
}

function run(argv) {
    const opts = parseArgs(argv);
    if (opts.help) return { help: true };
    const cmd = opts._[0];
    if (cmd === 'brief') return brief(opts);
    if (cmd === 'record') {
        if (!opts.session || !SESSION.test(opts.session)) fault('bad-session', '--session must be a local_<uuid> id returned by run_scheduled_task');
        return mutate(opts, (rec) => {
            if (rec.state !== 'composed') fault('bad-state', `task ${rec.taskId} is ${rec.state}, not composed`);
            Object.assign(rec, { state: 'started', sessionId: opts.session, startedAt: new Date().toISOString() });
            return {};
        });
    }
    if (cmd === 'settle') {
        return mutate(opts, (rec) => {
            const decision = decideSettle(rec, opts['run-status'], opts['report-read'] === true);
            if (decision.deleteSafe) Object.assign(rec, { state: 'settled', settledAt: new Date().toISOString(), runStatus: opts['run-status'] });
            return { decision };
        });
    }
    if (cmd === 'deleted') {
        return mutate(opts, (rec) => {
            if (rec.state !== 'settled') fault('bad-state', `task ${rec.taskId} is ${rec.state}; settle it before deleting`);
            Object.assign(rec, { state: 'deleted', deletedAt: new Date().toISOString() });
            return {};
        });
    }
    if (cmd === 'retire') {
        return mutate(opts, (rec) => {
            if (rec.state !== 'composed') fault('bad-state', `task ${rec.taskId} is ${rec.state}; retire is only for a record with no run behind it`);
            Object.assign(rec, { state: 'retired', retiredAt: new Date().toISOString(), reason: opts.reason || 'never ran' });
            return {};
        });
    }
    if (cmd === 'status') {
        const ledgerFile = opts.ledger || defaultLedger();
        const ledger = readLedger(ledgerFile);
        const records = opts['task-id'] ? [findRecord(ledger, opts['task-id'])] : ledger.records;
        const counts = {};
        for (const r of ledger.records) counts[r.state] = (counts[r.state] || 0) + 1;
        return { ledger: ledgerFile, recordsRead: ledger.records.length, counts, records };
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

module.exports = { composePrompt, decideSettle, parseArgs, run };
