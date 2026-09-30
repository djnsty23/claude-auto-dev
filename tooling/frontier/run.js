#!/usr/bin/env node
'use strict';
/**
 * The frontier runner: real past autodev tasks, run under harness variants,
 * each run recorded as (pass, tokens, wall time). Repo machinery, never ships.
 *
 * A task is a past fix. The worker gets the tree at the fix's parent as a
 * one-commit repo (no history, so `git log` cannot show the answer), a brief,
 * a fresh config dir and the plugins of the last release before the fix. The
 * endpoint suites are held out and copied in after the worker stops. The
 * runner, never the worker, runs the checks.
 *
 * Open lanes grade an answer file instead: locate, review, decide, diagnose
 * (one cause, its file and its mechanism) and plan (implied requirements and
 * traps). Their keys are held out too, and plant proves each key discriminates.
 *
 * Three refusals keep a row honest:
 *   contaminated  a token only the fix adds, or a task's leak term (the prose
 *                 that would carry an open answer), is already in the config
 *                 dir, the task repo or the plugin pin: the answer is in the room.
 *   billed-api    the init event says the run billed an API key, not the Max
 *                 plan. The row is discarded and the batch stops.
 *   token-missing the account's OAuth token is not in the environment.
 *
 * Where things live:
 *   data (FRONTIER_DATA, default ~/.claude/autodev/frontier): runs.jsonl,
 *        plant.json, batches/, ledger.json. Nothing a worker reads.
 *   work (FRONTIER_WORK, default ~/autodev-frontier): snapshot/, pins/, and per
 *        run wt/<run> (the task repo), cfg/<run> (its config dir) and
 *        runs/<run> (prompt, log, report, check output). Outside ~/.claude, so
 *        a worker editing its repo never trips a protected-path prompt.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const USAGE = [
    'Usage: node tooling/frontier/run.js <command> [options]',
    '  snapshot                        freeze the harness config (CLAUDE.md, rules, agents, output styles, settings)',
    '  plant [--task T1,T3]            unfixed red, fixed green, neighbours green, contamination fires; no model tokens',
    '  prepare --task T --variant V    build the repo, config dir and pin, run the contamination check, start nothing',
    '  run --task T --variant V --account <name> [--repeat n]   prepare and start one worker, return at once',
    '  finish --run <id> [--wait-sec n]   grade an exited run and append its row; idempotent',
    '  regrade --run <id>              grade the stored answer of an open-lane run again under the current key of its task,',
    '                                  and append the row; refused when the brief the run saw has changed. No model tokens',
    '  batch --tasks T1,T2|all --variants V0,V1 --account <name> [--k 1] [--max 2] [--quiet-wait <min>]   start a detached batch loop',
    '                                  --quiet-wait holds each item until no gate, coverage run or full suite runs on the',
    '                                  machine, at most <min> minutes (10 when given alone), then starts it as a loaded row',
    '  batch-resume --batch <id>       restart the loop of a batch whose loop died',
    '  status [--json]                 batches and the latest rows',
    'Lanes: fix (held-out checks), locate (F1), review (planted defects), decide (choices and orders),',
    '       diagnose (one cause: file and mechanism keywords, decoys fail), plan (implied requirements, traps fail).',
    'A variant with a route map (V3) runs the variant its brief routes to: mechanical when the brief names a test,',
    '  an npm script, an exit code or checks the work must pass, open otherwise. The row keeps route and routedTo.',
    'A variant with an escalation (V4) runs as itself, and in a batch a red or timed-out run queues a stage-2 run of',
    '  the variant it escalates to, on a fresh repo, given the failing output. Rows keep stage and escalatedFrom, and',
    '  frontier.js reads the pair as one attempt with both costs. A single `run` is stage 1 only.',
    'Options: --src <repo> --tasks-dir <dir> --data <dir> --work <dir> --claude-bin <path> --hw <headless-worker.js>',
    '         --budget-stop 0.70 (seven-day utilisation that stops a batch) --api-sources none (allowed apiKeySource values)',
    'The account token is read from CLAUDE_CODE_OAUTH_TOKEN_<ACCOUNT> and handed to the worker as',
    'CLAUDE_CODE_OAUTH_TOKEN in its env only. Start under: doppler run --project accounts --config prd -- node run.js ...',
    'Exit 0 done, 1 refused or failed (the JSON line says why).',
];

const HERE = __dirname;
const DEFAULT_SRC = path.resolve(HERE, '..', '..');
const DEFAULT_HW = path.join(DEFAULT_SRC, 'plugins', 'autodev-core', 'scripts', 'headless-worker.js');
const EXIT_RE = /^CLAUDE_EXIT=(-?\d+)\s*$/m;
const RUN_RE = /^F-[0-9]{8}-[A-Za-z0-9]{1,4}-[A-Za-z0-9]{1,3}-[0-9]{1,2}$/;
// Settings keys a frozen snapshot keeps. Everything else (hooks, plugins, the
// model, the status line, marketplaces) belongs to a variant or to the live machine.
const SETTINGS_KEEP = ['env', 'permissions', 'outputStyle', 'autoCompactWindow', 'skipDangerousModePermissionPrompt', 'thinkingEnabled'];
const SNAPSHOT_DIRS = ['rules', 'agents', 'output-styles'];
// A variable whose name says it carries a credential never reaches a worker or a check.
const SCRUB_RE = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|DOPPLER_)|TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|_PAT$/i;
const PIN_SKIP = new Set(['autodev-memory']);
const LANES = ['fix', 'locate', 'review', 'decide', 'diagnose', 'plan'];

function fault(code, message) { const e = new Error(message || code); e.publicCode = code; throw e; }

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { out._.push(a); continue; }
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) out[key] = true;
        else { out[key] = next; i++; }
    }
    return out;
}

function homeDir() { return process.env.USERPROFILE || process.env.HOME || os.homedir(); }
/**
 * Work trees must have no claude memory above them (see ancestorMemory), and a
 * home directory usually holds .claude/CLAUDE.md. On Windows the drive root
 * takes a new directory without elevation. Elsewhere the home default stands
 * and the guard names the file to move away from.
 */
function defaultWork() {
    return process.platform === 'win32' ? path.join(path.parse(homeDir()).root, 'autodev-frontier') : path.join(homeDir(), 'autodev-frontier');
}

function ctx(opts) {
    const src = path.resolve(opts.src || process.env.FRONTIER_SRC || DEFAULT_SRC);
    return {
        src,
        tasks: path.resolve(opts['tasks-dir'] || process.env.FRONTIER_TASKS || path.join(HERE, 'tasks')),
        data: path.resolve(opts.data || process.env.FRONTIER_DATA || path.join(homeDir(), '.claude', 'autodev', 'frontier')),
        work: path.resolve(opts.work || process.env.FRONTIER_WORK || defaultWork()),
        claudeHome: path.resolve(process.env.FRONTIER_CLAUDE_HOME || path.join(homeDir(), '.claude')),
        claudeBin: opts['claude-bin'] || process.env.FRONTIER_CLAUDE_BIN || null,
        hw: path.resolve(opts.hw || process.env.FRONTIER_HW || DEFAULT_HW),
        budgetStop: opts['budget-stop'] !== undefined ? Number(opts['budget-stop']) : 0.70,
        apiSources: String(opts['api-sources'] || 'none').split(',').map((s) => s.trim()).filter(Boolean),
        pollMs: Number(process.env.FRONTIER_POLL_MS || 20000),
        processList: process.env.FRONTIER_PROCESS_LIST || null,
    };
}

// ---------------------------------------------------------------- small io
function readJson(file, fallback = undefined) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
        if (fallback !== undefined) return fallback;
        fault('unreadable', `${file}: ${e.code || e.message}`);
    }
}
function writeJsonAtomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tmp, file);
}
function sha(text) { return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16); }
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function isEmptyDir(dir) { try { return fs.readdirSync(dir).length === 0; } catch { return true; } }

// ---------------------------------------------------------------- machine load
// Wall time is a frontier axis, and a worker running a suite beside a peer's
// gate is slower for a reason that is not the variant: one fix run measured
// 1,220 s of local tool time against 94 s of API time while two coverage runs
// shared the CPU. So a row records the heavy jobs (a gate, a coverage run, a
// full suite) running outside its own process tree at start, at every batch
// poll and at the end, plus the machine's CPU busy share over the window, and
// frontier.js compares wall time only between runs that saw none.
const HEAVY_RE = /\b(?:test-all|find-untested-functions|full-gate-queue|gate-lock)\.js\b|\brun gate\b/i;

function cpuTimes() {
    let idle = 0;
    let total = 0;
    for (const cpu of os.cpus()) { const t = cpu.times; idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq; }
    return { idle, total };
}
/** Every process as { pid, ppid, cmd }, or null when the list cannot be read. */
function processList(c) {
    let text = null;
    if (c.processList) {
        try { text = fs.readFileSync(c.processList, 'utf8'); } catch { return null; }
    } else if (process.platform === 'win32') {
        const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }'],
        { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1 << 25 });
        text = r.status === 0 ? r.stdout : null;
    } else {
        const r = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 25 });
        text = r.status === 0 ? (r.stdout || '').split('\n').map((l) => l.trim().replace(/^(\d+)\s+(\d+)\s+/, '$1\t$2\t')).join('\n') : null;
    }
    if (!text) return null;
    return text.split(/\r?\n/).map((l) => l.split('\t')).filter((f) => f.length >= 3 && /^\d+$/.test(f[0]))
        .map((f) => ({ pid: Number(f[0]), ppid: Number(f[1]), cmd: f.slice(2).join('\t') }));
}
/**
 * Labels of the heavy jobs that are not the run's own: outside the tree under
 * `rootPid` (the worker's own suite runs by relative path, so its command line
 * cannot say whose it is) and not naming `ownRepo`. null when the list is null.
 */
function heavyJobs(procs, rootPid, ownRepo) {
    if (!procs) return null;
    const own = new Set(rootPid ? [Number(rootPid)] : []);
    for (let grew = true; grew;) {
        grew = false;
        for (const p of procs) if (own.has(p.ppid) && !own.has(p.pid)) { own.add(p.pid); grew = true; }
    }
    const repo = ownRepo ? ownRepo.replace(/\\/g, '/').toLowerCase() : null;
    return procs.filter((p) => p.pid !== process.pid && !own.has(p.pid) && HEAVY_RE.test(p.cmd)
        && !(repo && p.cmd.replace(/\\/g, '/').toLowerCase().includes(repo))).map((p) => {
        const m = p.cmd.replace(/\\/g, '/').match(/([^/"\s]+)\/tooling\/([\w-]+\.js)/);
        return m ? `${m[2]}@${m[1]}` : p.cmd.match(HEAVY_RE)[0];
    });
}
function sampleLoad(c, meta) {
    return { at: new Date().toISOString(), cpu: cpuTimes(), heavy: heavyJobs(processList(c), meta.supervisorPid, meta.repo) };
}
/** Fold one poll's reading into the run's samples. */
function noteLoad(samples, heavy) {
    const s = samples || { n: 0, unreadable: 0, loaded: 0, max: 0, jobs: [] };
    s.n++;
    if (heavy === null) s.unreadable++;
    else {
        if (heavy.length) s.loaded++;
        s.max = Math.max(s.max, heavy.length);
        s.jobs = [...new Set([...s.jobs, ...heavy])].slice(0, 12);
    }
    return s;
}
/**
 * The row's load: quiet when every reading was taken and none saw a heavy job,
 * loaded when any did, unknown when a reading is missing. cpuBusy includes the
 * run's own work, so it describes the window, not the neighbours. A run that
 * --quiet-wait started after its wait timed out is loaded whatever the samples
 * say: it began beside a heavy job.
 */
function loadRecord(start, end, samples, quietWait = null) {
    if (!start || !end) return { class: 'unknown', why: 'no start or end sample', quietWait };
    const dTotal = end.cpu.total - start.cpu.total;
    const s = [start.heavy, end.heavy].reduce((acc, h) => noteLoad(acc, h), samples ? JSON.parse(JSON.stringify(samples)) : null);
    const cls = quietWait && quietWait.timedOut ? 'loaded' : s.unreadable ? 'unknown' : s.loaded ? 'loaded' : 'quiet';
    return {
        quietWait,
        class: cls, cpuBusy: dTotal > 0 ? Math.round(Math.min(1, Math.max(0, 1 - (end.cpu.idle - start.cpu.idle) / dTotal)) * 1000) / 1000 : null,
        windowSec: Math.round((Date.parse(end.at) - Date.parse(start.at)) / 1000),
        heavyStart: start.heavy ? start.heavy.length : null, heavyEnd: end.heavy ? end.heavy.length : null,
        samples: s.n, loadedSamples: s.loaded, unreadableSamples: s.unreadable, heavyMax: s.max, jobs: s.jobs,
    };
}

function git(args, { cwd, env, input } = {}) {
    const r = spawnSync('git', args, { cwd, env: env || process.env, input, encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
    if (r.error) fault('git-failed', `git ${args[0]}: ${r.error.code || r.error.message}`);
    if (r.status !== 0) fault('git-failed', `git ${args.join(' ').slice(0, 120)} exited ${r.status}: ${(r.stderr || '').trim().slice(0, 300)}`);
    return r.stdout;
}
function revParse(src, rev) { return git(['rev-parse', '--verify', `${rev}^{commit}`], { cwd: src }).trim(); }

/** Every file under dir (skipping .git), as absolute paths. */
function walk(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (e.name === '.git') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.isFile()) out.push(p);
    }
    return out;
}
function copyDir(from, to) {
    for (const f of walk(from)) {
        const dest = path.join(to, path.relative(from, f));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(f, dest);
    }
}
function dirHash(dir) {
    const h = crypto.createHash('sha256');
    for (const f of walk(dir).sort()) h.update(path.relative(dir, f).replace(/\\/g, '/')).update('\0').update(fs.readFileSync(f)).update('\0');
    return h.digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- trees
/**
 * The files of `rev` (optionally only `paths`) written under `dir`, with LF
 * endings whatever the machine's autocrlf says, through a private index so the
 * source checkout's own index is never touched.
 */
function exportTree(src, rev, dir, paths = null) {
    fs.mkdirSync(dir, { recursive: true });
    const idx = path.join(os.tmpdir(), `frontier-idx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const env = Object.assign({}, process.env, { GIT_INDEX_FILE: idx });
    try {
        git(['read-tree', rev], { cwd: src, env });
        const prefix = dir.replace(/\\/g, '/').replace(/\/?$/, '/');
        const base = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'checkout-index', '-f', `--prefix=${prefix}`];
        if (!paths) git([...base, '-a'], { cwd: src, env });
        else {
            const files = git(['ls-files', '-z', '--', ...paths], { cwd: src, env });
            if (files) git([...base, '-z', '--stdin'], { cwd: src, env, input: files });
        }
    } finally {
        try { fs.unlinkSync(idx); } catch { /* never created */ }
    }
}

/** A fresh one-commit repo from a tree already on disk. */
function initRepo(dir) {
    const g = (args) => git(args, { cwd: dir });
    g(['init', '-q']);
    g(['config', 'core.autocrlf', 'false']);
    g(['config', 'user.name', 'frontier']);
    g(['config', 'user.email', 'frontier@example.invalid']);
    g(['add', '-A']);
    g(['commit', '-q', '--no-verify', '-m', 'snapshot']);
}

function buildTaskRepo(c, task, dir, rev) {
    if (!isEmptyDir(dir)) fault('repo-exists', `${dir} already holds files; a run id is used once`);
    exportTree(c.src, rev, dir);
    for (const s of task.support || []) {
        const dest = path.join(dir, s.to);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(c.tasks, s.from), dest);
    }
    initRepo(dir);
}

/** Held-out files from the fix commit, written over whatever the worker left. */
function copyHeldOut(c, task, repo) {
    for (const p of task.heldOut || []) {
        const body = git(['show', `${task.fixSha}:${p}`], { cwd: c.src });
        const dest = path.join(repo, p);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, body);
    }
}

/** The plugins of the last release tag reachable from the task's parent, built once per tag. */
function pinFor(c, parentSha) {
    const tag = git(['describe', '--tags', '--abbrev=0', '--match', 'v*', parentSha], { cwd: c.src }).trim();
    const dir = path.join(c.work, 'pins', tag);
    const marker = path.join(dir, '.complete');
    if (!fs.existsSync(marker)) {
        const tmp = `${dir}.${process.pid}.tmp`;
        fs.rmSync(tmp, { recursive: true, force: true });
        const names = git(['ls-tree', '--name-only', `${tag}:plugins`], { cwd: c.src }).split('\n').filter((n) => n && !PIN_SKIP.has(n));
        if (!names.length) fault('pin-empty', `${tag} has no plugins under plugins/`);
        exportTree(c.src, tag, tmp, names.map((n) => `plugins/${n}`));
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        fs.renameSync(tmp, dir);
        fs.writeFileSync(marker, JSON.stringify({ tag, commit: revParse(c.src, tag), plugins: names }) + '\n');
    }
    const meta = readJson(marker);
    return { tag, dir, pluginDir: path.join(dir, 'plugins'), plugins: meta.plugins, hash: dirHash(path.join(dir, 'plugins')) };
}

// ---------------------------------------------------------------- snapshot
function snapshot(c) {
    const dir = path.join(c.work, 'snapshot');
    const tmp = `${dir}.${process.pid}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const claudeMd = path.join(c.claudeHome, 'CLAUDE.md');
    if (fs.existsSync(claudeMd)) fs.copyFileSync(claudeMd, path.join(tmp, 'CLAUDE.md'));
    for (const d of SNAPSHOT_DIRS) if (fs.existsSync(path.join(c.claudeHome, d))) copyDir(path.join(c.claudeHome, d), path.join(tmp, d));
    const live = readJson(path.join(c.claudeHome, 'settings.json'), {});
    const kept = {};
    for (const k of SETTINGS_KEEP) if (k in live) kept[k] = live[k];
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify(kept, null, 2) + '\n');
    const hashes = { all: dirHash(tmp) };
    for (const f of ['CLAUDE.md', 'settings.json', ...SNAPSHOT_DIRS]) {
        const p = path.join(tmp, f);
        if (!fs.existsSync(p)) hashes[f] = null;
        else hashes[f] = fs.statSync(p).isDirectory() ? dirHash(p) : sha(fs.readFileSync(p));
    }
    const meta = { id: hashes.all, createdAt: new Date().toISOString(), source: path.basename(c.claudeHome), settingsKept: Object.keys(kept), settingsDropped: Object.keys(live).filter((k) => !(k in kept)), hashes };
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    writeJsonAtomic(path.join(c.work, 'snapshot.json'), meta);
    return meta;
}

function buildConfigDir(c, dir) {
    const snap = path.join(c.work, 'snapshot');
    const meta = readJson(path.join(c.work, 'snapshot.json'), null);
    if (!meta || !fs.existsSync(snap)) fault('snapshot-missing', `no frozen harness at ${snap}: run \`node tooling/frontier/run.js snapshot\` once first`);
    if (!isEmptyDir(dir)) fault('config-exists', `${dir} already holds files; a run id is used once`);
    copyDir(snap, dir);
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }) + '\n');
    return meta;
}

// ---------------------------------------------------------------- tasks
/** A task's hash over its file, brief and key. frontier.js reads rows under an older hash as superseded. */
function hashTask(tasksDir, raw, task) {
    const part = (name) => { try { return name ? fs.readFileSync(path.join(tasksDir, name), 'utf8') : ''; } catch { return ''; } };
    return sha([raw, part(task.brief), part(task.expected)].join('\n--\n'));
}
/** The current hash of task `id` in `tasksDir`, or null when its file is gone or unreadable. */
function currentTaskHash(tasksDir, id) {
    try {
        const raw = fs.readFileSync(path.join(tasksDir, `${id}.json`), 'utf8');
        return hashTask(tasksDir, raw, JSON.parse(raw));
    } catch { return null; }
}
function loadTask(c, id) {
    if (!/^[A-Za-z0-9]{1,4}$/.test(String(id))) fault('usage', `task id ${id} is not 1-4 letters or digits`);
    const file = path.join(c.tasks, `${id}.json`);
    if (!fs.existsSync(file)) fault('no-task', `${file} does not exist`);
    const raw = fs.readFileSync(file, 'utf8');
    const task = JSON.parse(raw);
    if (task.id !== id) fault('bad-task', `${file} says id ${task.id}`);
    if (!LANES.includes(task.lane)) fault('bad-task', `${id}: lane ${task.lane} is not one of ${LANES.join(', ')}`);
    if (task.leakTerms !== undefined && !(Array.isArray(task.leakTerms) && task.leakTerms.every((t) => typeof t === 'string' && t.length >= 4))) {
        fault('bad-task', `${id}: leakTerms is a list of strings of 4 or more characters`);
    }
    // The brief and the key are part of the task: editing either makes the plant check stale.
    task.hash = hashTask(c.tasks, raw, task);
    task.parentSha = revParse(c.src, task.parent);
    if (task.lane === 'fix') {
        if (!task.fix) fault('bad-task', `${id}: a fix task names its fix commit`);
        task.fixSha = revParse(c.src, task.fix);
        if (!Array.isArray(task.checks) || !task.checks.length) fault('bad-task', `${id}: a fix task has at least one check`);
    } else {
        if (!task.answerFile || !task.expected) fault('bad-task', `${id}: a ${task.lane} task names answerFile and expected`);
        // A diagnosis may name the commit that fixed what it diagnoses, so the
        // fix's own tokens are searched for in the room like a fix task's.
        if (task.lane === 'diagnose' && task.fix) task.fixSha = revParse(c.src, task.fix);
    }
    return task;
}
function allTaskIds(c) {
    return fs.readdirSync(c.tasks).filter((f) => /^[A-Za-z0-9]{1,4}\.json$/.test(f)).map((f) => f.slice(0, -5))
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}
function loadVariant(id) {
    const all = readJson(path.join(HERE, 'variants.json'));
    const v = all[id];
    if (!v || id.startsWith('_')) fault('no-variant', `variant ${id} is not in variants.json`);
    if (!/^[A-Za-z0-9]{1,3}$/.test(id)) fault('bad-variant', `variant id ${id} is not 1-3 letters or digits`);
    return Object.assign({ id }, v);
}

// ---------------------------------------------------------------- routing
// What a brief says about how its work ends. An endpoint is a test file, an npm
// script or check, an exit code, or checks and suites that must pass. A change
// is an order to change code. A judgement is a decision, a plan, a diagnosis, a
// review or a list. Hands-off forbids changing anything.
const ROUTE_SIGNALS = {
    endpoint: [
        ['test-file', /\btest-[\w.-]+\.(?:[cm]?js|ts)\b|\b[\w-]+\.(?:test|spec)\.[cm]?[jt]sx?\b/i],
        ['npm-script', /\bnpm (?:test|run [\w:.-]+)|\bcheck:[\w-]+/i],
        ['exit-code', /\bexits? (?:with )?(?:code |status )?\d\b|\bexit (?:code|status)\b/i],
        ['checks', /\bchecks? (?:use|read|call)\b|\b(?:tests?|suites?|checks?|gate) (?:must |should |to )?(?:pass|go green|turn green|stay green|are green|is green)\b|\bmake (?:the |it |them )?(?:tests?|suites?|checks?|gate) (?:pass|green)\b/i],
    ],
    change: [
        ['imperative', /(?:^|[.!?:]\s+|\n\s*(?:[-*]\s+)?)(?:fix|make|implement|repair)\b/i],
        ['wanted', /\bcorrect behaviou?r:|\bwanted:|\bnew export\b/i],
    ],
    judgement: [
        ['decide', /\b(?:decide|choose|pick (?:one|between)|which option|recommend)\b/i],
        ['plan', /\b(?:plan|propose|design) (?:how|the|a|an)\b/i],
        ['diagnose', /\b(?:find|name|identify|explain) (?:the )?(?:root )?cause\b|\bdiagnos/i],
        ['review', /\breview\b/i],
        ['list', /\b(?:list|find) every\b/i],
    ],
    handsOff: [
        ['no-change', /\b(?:do not|don't|never) (?:fix|build|change|edit|implement|modify)\b/i],
    ],
};
/**
 * The route a brief asks for: `mechanical` when it names an endpoint the work
 * ends in and either orders a change or asks for no judgement, `open`
 * otherwise. A test or gate named inside a decision, a diagnosis or a plan is
 * the situation or an option, not the endpoint, and a brief that forbids
 * changes ends in no suite whatever it names.
 */
function routeFor(brief) {
    const text = String(brief || '');
    const hit = (group) => ROUTE_SIGNALS[group].filter(([, re]) => re.test(text)).map(([id]) => id);
    const signals = { endpoint: hit('endpoint'), change: hit('change'), judgement: hit('judgement'), handsOff: hit('handsOff') };
    const mechanical = !signals.handsOff.length && signals.endpoint.length > 0 && (signals.change.length > 0 || !signals.judgement.length);
    return { route: mechanical ? 'mechanical' : 'open', signals };
}
/** The variant that runs: one with a route map hands the run to the variant its route names, one hop only. */
function resolveVariant(variant, route) {
    if (!variant.route) return variant;
    const to = variant.route[route];
    if (!to) fault('bad-variant', `variant ${variant.id} has no target for the ${route} route`);
    const target = loadVariant(to);
    if (target.route) fault('bad-variant', `variant ${variant.id} routes to ${to}, which routes again`);
    return target;
}

// ---------------------------------------------------------------- contamination
const CODEY = (w) => /[A-Z].*[A-Z_0-9]|[a-z][A-Z]|_|\d|-/.test(w.slice(1)) || /^[A-Z_0-9]{6,}$/.test(w);
/**
 * Tokens the fix adds that the parent tree does not contain anywhere, and that
 * look like code (camelCase, SNAKE, digits, hyphenated codes), minus what the
 * brief discloses on purpose. Plain English words are left out: a rule file
 * saying "localises" is not the answer.
 */
function fixTokens(c, task) {
    const diff = git(['diff', '--no-color', '-U0', task.parentSha, task.fixSha], { cwd: c.src });
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
    const words = [...new Set(added.match(/[A-Za-z_][A-Za-z0-9_-]{5,}/g) || [])].filter(CODEY);
    if (!words.length) return [];
    const patterns = path.join(os.tmpdir(), `frontier-pat-${process.pid}-${Date.now()}`);
    fs.writeFileSync(patterns, words.join('\n') + '\n');
    let found = '';
    try {
        const r = spawnSync('git', ['grep', '-h', '-o', '-I', '-F', '-f', patterns, task.parentSha], { cwd: c.src, encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
        if (r.status !== 0 && r.status !== 1) fault('git-failed', `git grep over ${task.parentSha} exited ${r.status}`);
        found = r.stdout || '';
    } finally { fs.unlinkSync(patterns); }
    // git grep -o prints each match as the longest pattern it hit; a shorter word
    // inside a longer one is still in the parent, so test containment line by line.
    const present = new Set(found.split('\n').filter(Boolean));
    const disclosed = new Set(task.disclosed || []);
    return words.filter((w) => !disclosed.has(w) && ![...present].some((p) => p.includes(w))).sort();
}

/** Every (token, file) hit under the given roots, first `limit` of them. */
function scanForTokens(tokens, roots, limit = 10) {
    const hits = [];
    if (!tokens.length) return hits;
    for (const root of roots) {
        for (const f of walk(root)) {
            let st;
            try { st = fs.statSync(f); } catch { continue; }
            if (st.size > 4 * 1024 * 1024) continue;
            const text = fs.readFileSync(f, 'latin1');
            for (const t of tokens) {
                if (text.includes(t)) { hits.push({ token: t, file: f }); if (hits.length >= limit) return hits; }
            }
        }
    }
    return hits;
}

/**
 * Memory files above the task repo that claude loads as project memory.
 * `[measured 2026-09-30]` claude walks up from its cwd to the root and reads
 * each directory's CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md and
 * .claude/rules/*.md, so a work root under the home directory loaded the live
 * ~/.claude/CLAUDE.md and every live rule as project memory beside the frozen
 * config. --config-dir moves only the user layer. The repo's own CLAUDE.md is
 * part of the task and is not listed. `stop` ends the walk after that
 * directory: the suite sets it (FRONTIER_MEMORY_STOP) to its own temp root,
 * because its fake claude loads nothing and the machine above it is not the
 * subject. A real run leaves it unset.
 */
function ancestorMemory(repo, stop = process.env.FRONTIER_MEMORY_STOP || null) {
    const found = [];
    const end = stop ? path.resolve(stop) : null;
    let dir = path.dirname(path.resolve(repo));
    for (;;) {
        for (const name of ['CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md')]) {
            const f = path.join(dir, name);
            try { if (fs.statSync(f).isFile()) found.push(f); } catch { /* absent */ }
        }
        for (const f of walk(path.join(dir, '.claude', 'rules'))) if (f.endsWith('.md')) found.push(f);
        const up = path.dirname(dir);
        const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
        if (up === dir || (end && same(dir, end))) return found;
        dir = up;
    }
}

// ---------------------------------------------------------------- env
/** The worker's env: no credential but the one account token, under the name claude reads. */
function workerEnv(base, account) {
    if (!/^[a-z0-9]{2,20}$/.test(String(account || ''))) fault('usage', '--account is a lowercase name, for example personal or work');
    const name = `CLAUDE_CODE_OAUTH_TOKEN_${account.toUpperCase()}`;
    const token = base[name];
    if (!token) fault('token-missing', `${name} is not in the environment. Start the runner under doppler run --project accounts --config prd -- node tooling/frontier/run.js ...`);
    const env = checksEnv(base);
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
    return env;
}
/** A check's env, and the base of a worker's: every credential-shaped name removed, the gate lock off. */
function checksEnv(base) {
    const env = {};
    for (const [k, v] of Object.entries(base)) if (!SCRUB_RE.test(k)) env[k] = v;
    env.AUTODEV_GATE_LOCK = '0';
    return env;
}

// ---------------------------------------------------------------- the prompt
function composePrompt(task, brief, repo, failing = null) {
    const answer = task.lane === 'fix'
        ? ['- The full gate (`npm run gate`) is not available here. Run the suites that cover what you change, for example `node tooling/test-<name>.js`.',
            '- Commit your change when you are done (stage explicit paths, then `git commit -F <file>`).',
            '- Your change is graded after you stop, by checks you cannot see.']
        : [`- Write your answer to \`${task.answerFile}\` at the repository root, in the format the task gives. Change no other file.`,
            '- The answer file is graded after you stop.'];
    return [
        `# Frontier task ${task.id}`,
        '',
        `You are working in ${repo.replace(/\\/g, '/')}, a git repository holding a one-commit snapshot of the autodev plugin marketplace. It has no remote and no history. Read its CLAUDE.md before you start.`,
        '',
        brief.replace(/\s+$/, ''),
        '',
        ...(failing === null ? [] : [
            '## A previous attempt failed',
            'Another worker ran this task before you and its result was graded red. This is what the grading printed:',
            '',
            '~~~~text',
            failing.replace(/\s+$/, ''),
            '~~~~',
            '',
            'You start from a fresh copy of the repository: nothing that worker changed is in it.',
            '',
        ]),
        '## How this run works',
        '- Work only inside this repository. Everything the task needs is in it.',
        ...answer,
        '',
    ].join('\n');
}

// ---------------------------------------------------------------- run ids and paths
function stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
function runPaths(c, run) {
    const dir = path.join(c.work, 'runs', run);
    return { dir, repo: path.join(c.work, 'wt', run), cfg: path.join(c.work, 'cfg', run), meta: path.join(dir, 'run.json'),
        prompt: path.join(dir, 'prompt.md'), log: path.join(dir, 'worker.log'), report: path.join(dir, 'report.md'), checks: path.join(dir, 'checks.log') };
}
function newRunId(c, task, variant, repeat) {
    for (let i = 0; i < 100; i++) {
        const id = `F-${stamp(new Date(Date.now() + i * 1000))}-${task.id}-${variant.id}-${repeat}`;
        if (!fs.existsSync(runPaths(c, id).dir)) return id;
    }
    fault('run-id', 'no free run id in 100 tries');
}

// ---------------------------------------------------------------- plant state
function plantOk(c, task) {
    const plant = readJson(path.join(c.data, 'plant.json'), { tasks: {} });
    const rec = plant.tasks[task.id];
    if (!rec) fault('not-planted', `${task.id} has no plant record: run \`run.js plant --task ${task.id}\` first`);
    if (rec.taskHash !== task.hash) fault('plant-stale', `${task.id}.json changed since its plant check: re-run plant`);
    if (!rec.ok) fault('plant-failed', `${task.id} failed its plant check: ${rec.reason}`);
    return rec;
}

// ---------------------------------------------------------------- prepare and start
function prepare(c, taskId, variantId, repeat = 1, { account = null, escalation = null } = {}) {
    const task = loadTask(c, taskId);
    const variant = loadVariant(variantId);
    const brief = fs.readFileSync(path.join(c.tasks, task.brief), 'utf8');
    // Every run records its brief's route, so frontier.js can derive the routed
    // variant from rows measured without it. A routed variant runs its target,
    // and the stage-2 run of an escalating variant runs the one it escalates to.
    const routing = routeFor(brief);
    let target = resolveVariant(variant, routing.route);
    if (escalation) {
        if (!variant.escalate) fault('bad-variant', `variant ${variant.id} does not escalate`);
        target = loadVariant(variant.escalate);
        if (target.route || target.escalate) fault('bad-variant', `variant ${variant.id} escalates to ${target.id}, which routes or escalates again`);
    }
    if (target.lanes && !target.lanes.includes(task.lane)) {
        fault('lane-mismatch', `variant ${target.id}${target === variant ? '' : ` (where ${variant.id} routes ${routing.route})`} runs only ${target.lanes.join(',')} and ${task.id} is ${task.lane}`);
    }
    const plant = plantOk(c, task);
    const run = newRunId(c, task, variant, repeat);
    const p = runPaths(c, run);
    fs.mkdirSync(p.dir, { recursive: true });
    buildTaskRepo(c, task, p.repo, task.parentSha);
    const snap = buildConfigDir(c, p.cfg);
    const pin = pinFor(c, task.parentSha);
    // A fix's own tokens, and for an open task the prose that would carry its
    // answer (its leakTerms): either one in the room refuses the run.
    const tokens = [...(task.fixSha ? fixTokens(c, task) : []), ...(task.leakTerms || [])];
    const hits = scanForTokens(tokens, [p.cfg, p.repo, pin.pluginDir]);
    // Memory above the repo reaches the worker whatever it holds, so any file
    // refuses the run.
    const ancestors = ancestorMemory(p.repo);
    for (const f of ancestors) hits.push({ token: 'ancestor memory', file: f });
    fs.writeFileSync(p.prompt, composePrompt(task, brief, p.repo, escalation ? escalation.output : null));
    const meta = {
        run, task: task.id, taskHash: task.hash, lane: task.lane, variant: variant.id, model: target.model, effort: target.effort || null,
        route: routing.route, routeSignals: routing.signals, routedTo: target === variant ? null : target.id,
        stage: variant.escalate ? (escalation ? 2 : 1) : null, escalatedFrom: escalation ? escalation.from : null,
        escalation: escalation ? { source: escalation.source, chars: escalation.output.length } : null,
        account, repeat, createdAt: new Date().toISOString(), timeoutMin: Number(task.timeoutMin || 30),
        repo: p.repo, cfg: p.cfg, log: p.log, report: p.report, prompt: p.prompt,
        pin: { tag: pin.tag, hash: pin.hash, plugins: pin.plugins, dir: pin.pluginDir },
        snapshot: snap.id, harnessCommit: revParse(c.src, 'HEAD'), plantAt: plant.at,
        contamination: { tokens: tokens.length, hits, ancestors, memoryStop: process.env.FRONTIER_MEMORY_STOP || null },
        state: hits.length ? 'contaminated' : 'prepared',
    };
    writeJsonAtomic(p.meta, meta);
    return meta;
}

function start(c, meta, env) {
    const p = runPaths(c, meta.run);
    const argv = [c.hw, 'start', '--code', meta.run, '--prompt-file', p.prompt, '--log', p.log, '--report', p.report,
        '--config-dir', p.cfg, '--model', meta.model, '--plugin-dir', meta.pin.dir, '--permission-mode', 'bypassPermissions',
        '--cwd', p.repo, '--ledger', path.join(c.data, 'ledger.json'), '--dev'];
    if (meta.effort) argv.push('--effort', meta.effort);
    if (c.claudeBin) argv.push('--claude-bin', c.claudeBin);
    const r = spawnSync(process.execPath, argv, { env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    let out = null;
    try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { out = null; }
    if (!out || !out.ok) fault('start-failed', `headless-worker start: ${out ? out.error.code + ' ' + out.error.message : (r.stderr || r.stdout || '').slice(0, 300)}`);
    Object.assign(meta, { state: 'running', startedAt: out.value.record.startedAt, supervisorPid: out.value.supervisorPid, workerVersion: out.value.record.version });
    meta.loadStart = sampleLoad(c, meta);
    writeJsonAtomic(p.meta, meta);
    return meta;
}

function runOne(c, taskId, variantId, account, repeat, env, extra = {}) {
    const wenv = workerEnv(env, account);
    const { escalation = null, ...rest } = extra;
    const meta = Object.assign(prepare(c, taskId, variantId, repeat, { account, escalation }), rest);
    if (meta.state === 'contaminated') {
        appendRow(c, rowFor(c, meta, { verdict: 'contaminated', pass: null }));
        const up = meta.contamination.hits.some((h) => h.token === 'ancestor memory')
            ? '. Memory above the task repo loads as project memory: set --work or FRONTIER_WORK to a directory with none above it' : '';
        fault('contaminated', `${meta.run}: ${meta.contamination.hits.map((h) => `${h.token} in ${h.file}`).join('; ')}${up}`);
    }
    return start(c, meta, wenv);
}

// ---------------------------------------------------------------- the stream
function parseStream(text) {
    const out = { init: null, result: null, rate: null, toolInputs: [] };
    for (const line of text.split('\n')) {
        if (!line.startsWith('{')) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'system' && ev.subtype === 'init' && !out.init) out.init = ev;
        else if (ev.type === 'result') out.result = ev;
        else if (ev.type === 'rate_limit_event') out.rate = ev;
        else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
            for (const item of ev.message.content) if (item.type === 'tool_use') out.toolInputs.push(JSON.stringify(item.input || {}));
        }
    }
    return out;
}

/** Token totals across every model the run used (subagents included), from the result event. */
function tokensOf(result) {
    if (!result) return null;
    const mu = result.modelUsage;
    if (mu && typeof mu === 'object' && Object.keys(mu).length) {
        const t = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, thinking: 0, costUsd: 0, perModel: {} };
        for (const [m, u] of Object.entries(mu)) {
            t.input += u.inputTokens || 0; t.output += u.outputTokens || 0; t.cacheWrite += u.cacheCreationInputTokens || 0;
            t.cacheRead += u.cacheReadInputTokens || 0; t.thinking += u.thinkingTokens || 0; t.costUsd += u.costUSD || 0;
            t.perModel[m] = { input: u.inputTokens || 0, output: u.outputTokens || 0, cacheWrite: u.cacheCreationInputTokens || 0, cacheRead: u.cacheReadInputTokens || 0, costUsd: u.costUSD || 0 };
        }
        t.total = t.input + t.output + t.cacheWrite + t.cacheRead;
        t.costUsd = Math.round(t.costUsd * 10000) / 10000;
        return t;
    }
    const u = result.usage || {};
    const t = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0,
        thinking: (u.output_tokens_details || {}).thinking_tokens || 0, costUsd: result.total_cost_usd || 0, perModel: {} };
    t.total = t.input + t.output + t.cacheWrite + t.cacheRead;
    return t;
}

/**
 * The part of one tool input that can reach outside the run. A write into the
 * run's own tree is its answer, so only its path counts: `[measured
 * 2026-09-30]` two T11 plans were flagged for naming ~/.claude as a place the
 * harness would write, inside their own answer file. A command keeps
 * everything but its heredoc bodies, which are text being written.
 */
function readsOf(s, run) {
    let j;
    try { j = JSON.parse(s); } catch { return s; }
    if (!j || typeof j !== 'object') return s;
    const own = new RegExp(`[\\\\/]wt[\\\\/]+${run}(?:[\\\\/]|$)`, 'i');
    if (typeof j.file_path === 'string' && own.test(j.file_path) && ['content', 'new_string', 'edits'].some((k) => k in j)) return j.file_path;
    if (typeof j.command === 'string') return j.command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g, '<<heredoc');
    return s;
}

/** Paths in the worker's tool calls that reach outside its own run: the source checkout, the live config, other runs. */
function leakHits(toolInputs, run) {
    const res = [
        /claude-auto-dev/i,
        /(?:Users[\\/]+[^\\/"]+|home[\\/]+[^\\/"]+|~|\$HOME|%USERPROFILE%)[\\/]+\.claude(?:-b|-w)?(?:[\\/"]|$)/i,
        /claude-memory/i,
    ];
    const other = /autodev-frontier[\\/]+(?:wt|cfg|runs)[\\/]+([A-Za-z0-9-]+)/gi;
    const hits = [];
    for (const raw of toolInputs) {
        const s = readsOf(raw, run);
        let hit = res.find((re) => re.test(s));
        if (!hit) {
            for (const m of s.matchAll(other)) if (m[1] !== run) { hit = true; break; }
        }
        if (hit) hits.push(raw.slice(0, 160));
    }
    return hits;
}

// ---------------------------------------------------------------- grading
function runChecks(argvs, repo, env, logFile, label) {
    const out = [];
    for (const argv of argvs || []) {
        const real = argv.map((a) => a.replace('{frontier}', HERE));
        const cmd = real[0] === 'node' ? process.execPath : real[0];
        const t0 = Date.now();
        const r = spawnSync(cmd, real.slice(1), { cwd: repo, env, encoding: 'utf8', timeout: 600000, maxBuffer: 1 << 26, windowsHide: true });
        const ms = Date.now() - t0;
        const exit = r.status === null ? null : r.status;
        fs.appendFileSync(logFile, `\n=== ${label}: ${argv.join(' ')} -> exit ${exit}${r.error ? ' ' + (r.error.code || r.error.message) : ''} in ${ms} ms\n${(r.stdout || '').slice(-4000)}\n${(r.stderr || '').slice(-2000)}\n`);
        out.push({ argv, exit, ms, timedOut: !!(r.error && r.error.code === 'ETIMEDOUT') });
    }
    return out;
}
const green = (checks) => checks.length > 0 && checks.every((k) => k.exit === 0);

function normPath(p) { return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim(); }
/** File-level F1 of a located list against the expected one. */
function gradeLocate(answer, expected, threshold) {
    const want = new Set((expected.items || []).map((i) => normPath(i.path)));
    const got = new Set(((answer && answer.items) || []).map((i) => normPath(i && i.path)).filter(Boolean));
    const tp = [...got].filter((p) => want.has(p)).length;
    const precision = got.size ? tp / got.size : 0;
    const recall = want.size ? tp / want.size : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    const r3 = (x) => Math.round(x * 1000) / 1000;
    return { tp, answered: got.size, expected: want.size, precision: r3(precision), recall: r3(recall), f1: r3(f1),
        missed: [...want].filter((p) => !got.has(p)), extra: [...got].filter((p) => !want.has(p)), pass: f1 >= threshold };
}
/** Planted defects named (right section, blocker or major, claim matches), and blockers that match no planted defect. */
function gradeReview(answer, expected) {
    const findings = ((answer && answer.findings) || []).filter((f) => f && typeof f.claim === 'string');
    const planted = (expected.planted || []).map((d) => ({ id: d.id, section: String(d.section).toUpperCase(), res: d.match.map((m) => new RegExp(m, 'i')) }));
    const matchesAny = (f) => planted.some((d) => d.res.some((re) => re.test(f.claim)));
    const found = planted.map((d) => ({ id: d.id, found: findings.some((f) => String(f.section).toUpperCase() === d.section
        && ['blocker', 'major'].includes(String(f.severity).toLowerCase()) && d.res.some((re) => re.test(f.claim))) }));
    const invented = findings.filter((f) => String(f.severity).toLowerCase() === 'blocker' && !matchesAny(f)).length;
    const named = found.filter((d) => d.found).length;
    return { named, planted: planted.length, invented, findings: findings.length, found, pass: planted.length > 0 && named === planted.length && invented === 0 };
}

/**
 * A decision point: each question is a `choice` among options the brief lists (right when the
 * choice is in `accept`) or an `order` of items (right when it holds every item once and every
 * `before` pair in that order). The task passes when every question is right.
 */
function gradeDecide(answer, expected) {
    const given = new Map((((answer && answer.answers) || []).filter((a) => a && a.id)).map((a) => [String(a.id), a]));
    const results = (expected.questions || []).map((q) => {
        const a = given.get(String(q.id));
        if (!a) return { id: q.id, ok: false, why: 'unanswered' };
        if (q.kind === 'order') {
            const order = Array.isArray(a.order) ? a.order.map(String) : [];
            const items = (q.items || []).map(String);
            if (order.length !== items.length || new Set(order).size !== order.length || !items.every((i) => order.includes(i))) return { id: q.id, ok: false, why: 'not every item exactly once' };
            const broken = (q.before || []).filter(([x, y]) => order.indexOf(String(x)) > order.indexOf(String(y)));
            return { id: q.id, ok: broken.length === 0, why: broken.length ? `broke ${broken.map(([x, y]) => `${x} before ${y}`).join(', ')}` : 'order holds' };
        }
        const ok = (q.accept || []).map(String).includes(String(a.choice));
        return { id: q.id, ok, why: `chose ${a.choice}` };
    });
    const right = results.filter((r) => r.ok).length;
    return { right, questions: results.length, results, pass: results.length > 0 && right === results.length };
}
/** The key's own answer, from each question's `example` or, for one question, its `wrong`. */
function decideAnswer(expected, wrongId = null) {
    return { answers: (expected.questions || []).map((q) => Object.assign({ id: q.id }, q.id === wrongId ? q.wrong : q.example)) };
}

// A mechanism commits to one cause, and what was considered and dropped goes
// in `ruledOut`, which is not graded. A hedge offers a SECOND cause, so the
// test is per sentence: one that opens on a hedge word, one that names another
// cause, or an either-or whose "or" branch is a clause with its own verb.
// "maybe a GC pause" inside a sentence qualifies the one cause, and "either
// the second .tmp or the log" names two files, not two causes.
const HEDGE_LEAD_RE = /^(?:alternatively|or|perhaps|possibly|maybe|it (?:may|might|could) (?:also |instead )?be|there (?:may|might|could) also)\b/i;
const HEDGE_RE = /\banother (?:possible |likely |plausible )?(?:cause|explanation|possibility|candidate|culprit|suspect|reason)\b|\b(?:could|might|may) (?:also|instead) be\b|\bor else\b|\bor (?:perhaps|possibly|maybe)\b|\balternatively\b/i;
const EITHER_RE = /\beither\b[\s\S]*?\bor\s+(?:(?:\S+\s+){0,3}?(?:is|are|was|were|has|had|does|did|may|might|could|can|will|would|races?|racing|reuses?|renames?|writes?|reads?|stats?|fails?|causes?|returns?|caches?|lands?|hits?|exceeds?|runs?|takes?|gets?|truncates?|times out)|(?:the|a|an|its|this|that|their)\s+\w+\s+\w+s)\b/i;
/** Sentences of a mechanism. A dot inside a name (".tmp", "test-inbox.js") ends none. */
function sentencesOf(text) {
    return String(text).split(/[.;!?](?=\s|$)/).map((s) => s.trim()).filter(Boolean);
}
function hedgedSentence(s) { return HEDGE_LEAD_RE.test(s) || HEDGE_RE.test(s) || EITHER_RE.test(s); }
/**
 * One named cause. It passes when its file is one the key accepts, one
 * sentence of its mechanism hits each keyword group, it offers no second cause and fits in
 * `maxMechanism` characters (600 by default), so an answer that lists every
 * candidate fails as hedged or too long.
 */
function gradeDiagnose(answer, expected) {
    const cause = (answer && answer.cause) || {};
    const file = normPath(cause.file);
    const mechanism = typeof cause.mechanism === 'string' ? cause.mechanism : '';
    const key = expected.cause || {};
    // Per sentence, so the words of one group cannot be collected from two
    // claims: "released its handle" in one and "the same inode" in another.
    const sentences = sentencesOf(mechanism);
    const groups = (key.groups || []).map((g) => ({ id: g.id, hit: (g.match || []).some((m) => sentences.some((s) => new RegExp(m, 'i').test(s))) }));
    const fileOk = !!file && (key.files || []).map(normPath).includes(file);
    const hedged = sentences.some(hedgedSentence);
    const tooLong = mechanism.length > Number(expected.maxMechanism || 600);
    return { file, fileOk, groups, hedged, tooLong, chars: mechanism.length,
        pass: fileOk && groups.length > 0 && groups.every((g) => g.hit) && !hedged && !tooLong };
}

/**
 * A plan against the requirements its vague brief implies. A requirement is met
 * when one of its `text` patterns matches a step (its `do` and `commands`) or
 * one of its `path` patterns matches a path a step creates. Risks are graded for
 * length only: naming a danger is not a step that avoids it. The plan passes at
 * `threshold` requirements met with no trap tripped. A trap trips on a path a
 * step creates or edits that matches its `creates` pattern, or on one step
 * whose text matches every `step.all` pattern and no `step.none` pattern.
 */
function gradePlan(answer, expected) {
    const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    const steps = ((answer && Array.isArray(answer.steps) && answer.steps) || []).filter((s) => s && typeof s === 'object');
    const doOf = (s) => (typeof s.do === 'string' ? s.do : '');
    const stepProse = steps.map((s) => [doOf(s), ...strs(s.commands)].join('\n')).join('\n');
    const prose = [stepProse, ...strs(answer && answer.risks)].join('\n');
    const creates = steps.flatMap((s) => strs(s.creates)).map(normPath);
    const touches = [...creates, ...steps.flatMap((s) => strs(s.edits)).map(normPath)];
    const any = (pats, text) => (pats || []).some((m) => new RegExp(m, 'i').test(text));
    const requirements = (expected.requirements || []).map((r) => ({ id: r.id, met: any(r.text, stepProse) || creates.some((p) => any(r.path, p)) }));
    const stepTrips = (t, s) => {
        const text = [doOf(s), ...strs(s.commands), ...strs(s.creates), ...strs(s.edits)].join('\n');
        const all = t.step.all || [];
        return all.length > 0 && all.every((m) => new RegExp(m, 'i').test(text)) && !any(t.step.none, text);
    };
    const traps = (expected.traps || []).filter((t) => (t.creates && touches.some((p) => new RegExp(t.creates, 'i').test(p)))
        || (t.step && steps.some((s) => stepTrips(t, s)))).map((t) => t.id);
    const met = requirements.filter((r) => r.met).length;
    const threshold = Number(expected.threshold);
    const tooLong = prose.length > Number(expected.maxChars || 8000);
    return { met, threshold, requirements, traps, steps: steps.length, chars: prose.length, tooLong,
        pass: requirements.length > 0 && met >= threshold && traps.length === 0 && !tooLong };
}

function gradeAnswer(c, task, repo) {
    const expected = readJson(path.join(c.tasks, task.expected));
    let answer = null;
    try { answer = JSON.parse(fs.readFileSync(path.join(repo, task.answerFile), 'utf8')); } catch (e) {
        return { pass: false, reason: `no readable ${task.answerFile}: ${e.code || e.message}` };
    }
    if (task.lane === 'decide') return gradeDecide(answer, expected);
    if (task.lane === 'diagnose') return gradeDiagnose(answer, expected);
    if (task.lane === 'plan') return gradePlan(answer, expected);
    return task.lane === 'locate' ? gradeLocate(answer, expected, Number(task.threshold || 0.8)) : gradeReview(answer, expected);
}

// ---------------------------------------------------------------- rows
function rowsFile(c) { return path.join(c.data, 'runs.jsonl'); }
function readRows(c) {
    let text = '';
    try { text = fs.readFileSync(rowsFile(c), 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function appendRow(c, row) {
    fs.mkdirSync(c.data, { recursive: true });
    fs.appendFileSync(rowsFile(c), JSON.stringify(row) + '\n');
    return row;
}
function rowFor(c, meta, extra) {
    return Object.assign({
        v: 1, run: meta.run, task: meta.task, lane: meta.lane, variant: meta.variant, route: meta.route || null, routedTo: meta.routedTo || null,
        stage: meta.stage || null, escalatedFrom: meta.escalatedFrom || null, escalation: meta.escalation || null,
        account: meta.account, repeat: meta.repeat, taskHash: meta.taskHash, startedAt: meta.startedAt || null,
        fingerprint: { requestedModel: meta.model, effort: meta.effort, pin: meta.pin.tag, pinHash: meta.pin.hash, plugins: meta.pin.plugins,
            snapshot: meta.snapshot, harnessCommit: meta.harnessCommit, workerVersion: meta.workerVersion || null },
        contaminationTokens: meta.contamination.tokens, finishedAt: new Date().toISOString(),
        ancestorMemory: meta.contamination && Array.isArray(meta.contamination.ancestors) ? meta.contamination.ancestors.length : null,
    }, extra);
}

function killTree(pid) {
    if (!pid) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, encoding: 'utf8' });
    else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } }
}

/**
 * Grade one run and append its row. Returns the row, or null while the worker
 * is still inside its time budget. A run past its budget is killed by
 * supervisor pid and graded as a timeout. Idempotent under a per-run lock.
 */
function finish(c, run, { allowKill = true } = {}) {
    if (!RUN_RE.test(run)) fault('usage', `${run} is not a run id`);
    const p = runPaths(c, run);
    const meta = readJson(p.meta);
    // The latest row: a regrade appends a row for a run already graded.
    const existing = readRows(c).filter((r) => r.run === run).pop();
    if (existing) return existing;
    const log = fs.existsSync(p.log) ? fs.readFileSync(p.log, 'utf8') : '';
    const exitM = log.match(EXIT_RE);
    const startedMs = Date.parse(meta.startedAt || meta.createdAt);
    const overdue = Date.now() - startedMs > meta.timeoutMin * 60000;
    if (!exitM && !overdue) return null;
    const lock = path.join(p.dir, 'finish.lock');
    let fd;
    try { fd = fs.openSync(lock, 'wx'); } catch { return null; }
    try {
        let timedOut = false;
        if (!exitM) {
            if (!allowKill) return null;
            killTree(meta.supervisorPid);
            timedOut = true;
        }
        const exitMs = exitM ? fs.statSync(p.log).mtimeMs : Date.now();
        // Before grading: the held-out checks are this runner's own load.
        const load = loadRecord(meta.loadStart, sampleLoad(c, meta), meta.loadSamples, meta.quietWait || null);
        const s = parseStream(log);
        const tokens = tokensOf(s.result);
        const init = s.init || {};
        const rl = s.rate && s.rate.rate_limit_info && s.rate.rate_limit_info.unifiedWindows;
        const budget = rl ? { fiveHour: (rl.five_hour || {}).utilization ?? null, sevenDay: (rl.seven_day || {}).utilization ?? null, at: new Date().toISOString() } : null;
        const leaks = leakHits(s.toolInputs, run);
        const base = {
            exit: exitM ? Number(exitM[1]) : null, wallMs: Math.round(exitMs - startedMs),
            durationMs: s.result ? s.result.duration_ms ?? null : null, durationApiMs: s.result ? s.result.duration_api_ms ?? null : null,
            turns: s.result ? s.result.num_turns ?? null : null, resultSubtype: s.result ? s.result.subtype || null : null,
            tokens, costUsd: tokens ? tokens.costUsd : null, costBasis: 'list price, notional on a Max plan',
            apiKeySource: init.apiKeySource ?? null, budget, leak: { suspect: leaks.length > 0, hits: leaks.slice(0, 5) }, load,
        };
        const fp = { model: init.model || null, claudeVersion: init.claude_code_version || null, permissionMode: init.permissionMode || null,
            loadedPlugins: (init.plugins || []).map((x) => `${x.name}@${x.version || '?'}`), tools: Array.isArray(init.tools) ? init.tools.length : null,
            mcpServers: (init.mcp_servers || []).map((m) => m.name), outputStyle: init.output_style || null };
        let row;
        if (s.init && !c.apiSources.includes(String(init.apiKeySource))) {
            row = rowFor(c, meta, Object.assign(base, { verdict: 'billed-api', pass: null }));
        } else if (timedOut) {
            row = rowFor(c, meta, Object.assign(base, { verdict: 'timeout', pass: false }));
        } else if (!s.init) {
            row = rowFor(c, meta, Object.assign(base, { verdict: 'no-stream', pass: null }));
        } else {
            const task = loadTask(c, meta.task);
            const env = checksEnv(process.env);
            let grade;
            if (task.lane === 'fix') {
                copyHeldOut(c, task, meta.repo);
                const checks = runChecks(task.checks, meta.repo, env, p.checks, 'check');
                const p2p = runChecks(task.passToPass || [], meta.repo, env, p.checks, 'pass-to-pass');
                grade = { checks, passToPass: p2p, pass: green(checks) && p2p.every((k) => k.exit === 0) };
            } else {
                grade = gradeAnswer(c, task, meta.repo);
            }
            row = rowFor(c, meta, Object.assign(base, { verdict: grade.pass ? 'pass' : 'fail', pass: grade.pass, grade }));
        }
        Object.assign(row.fingerprint, fp);
        appendRow(c, row);
        meta.state = 'finished';
        writeJsonAtomic(p.meta, meta);
        return row;
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Grade an open-lane run's stored answer again, under its task's current key,
 * and append the new row beside the old one. A key is corrected on answers it
 * has already seen, so the new row keeps the old verdict and grade in
 * `regradedFrom`, and frontier.js counts only the latest row of a run. It is
 * refused for a fix run (its checks ran on a tree that is gone), for a key the
 * plant check has not passed, for an answer file that is gone, and for a
 * brief that differs from the one the run saw: a new brief asks a new
 * question, which only a new run answers. Idempotent: a row already on the
 * current key is returned as it is.
 */
function regrade(c, run) {
    if (!RUN_RE.test(run)) fault('usage', `${run} is not a run id`);
    const p = runPaths(c, run);
    const meta = readJson(p.meta);
    if (!meta) fault('no-run', `${run} has no run.json`);
    const last = readRows(c).filter((r) => r.run === run).pop();
    if (!last) fault('not-finished', `${run} has no row: run finish first`);
    if (last.verdict !== 'pass' && last.verdict !== 'fail') fault('not-graded', `${run} is ${last.verdict}, and only a graded answer can be graded again`);
    const task = loadTask(c, meta.task);
    if (task.lane === 'fix') fault('bad-lane', `${run} is a fix run: its held-out checks ran on a tree that is gone`);
    if (last.taskHash === task.hash) return last;
    plantOk(c, task);
    const brief = fs.readFileSync(path.join(c.tasks, task.brief), 'utf8');
    const seen = fs.readFileSync(p.prompt, 'utf8');
    const same = meta.escalation ? seen.includes(brief.replace(/\s+$/, '')) : seen === composePrompt(task, brief, meta.repo, null);
    if (!same) fault('brief-changed', `${task.id}'s brief is not the one ${run} saw: a new brief needs a new run`);
    if (!fs.existsSync(path.join(meta.repo, task.answerFile))) fault('no-answer', `${run}'s ${task.answerFile} is gone`);
    const grade = gradeAnswer(c, task, meta.repo);
    return appendRow(c, Object.assign({}, last, {
        taskHash: task.hash, verdict: grade.pass ? 'pass' : 'fail', pass: grade.pass, grade, regradedAt: new Date().toISOString(),
        regradedFrom: { taskHash: last.taskHash, verdict: last.verdict, grade: last.grade, regradedAt: last.regradedAt || null },
    }));
}

/**
 * What a red stage-1 run hands the run that escalates it: what the grading
 * printed, never the key. A fix run's failing checks as they printed, last
 * 4000 characters. An answer run gets its verdict only, because its grade
 * lists the expected answer. The check output names the held-out tests the
 * first worker could not see, so stage 2 knows more than a plain V0 run does:
 * the same asymmetry the rule creates in real dispatch.
 */
const FAILING_MAX = 4000;
function failingOutput(c, row) {
    if (row.verdict === 'timeout') return { source: 'timeout', output: 'The previous worker ran past its time budget and was stopped. Nothing it did was graded.' };
    if (row.lane === 'fix') {
        let log = '';
        try { log = fs.readFileSync(runPaths(c, row.run).checks, 'utf8'); } catch { log = ''; }
        const red = log.split(/\n(?==== )/).filter((sec) => { const m = sec.match(/^=== .*? -> exit (\S+)/); return m && m[1] !== '0'; });
        const text = red.map((s) => s.trim()).join('\n\n');
        if (text) return { source: 'checks', output: text.length > FAILING_MAX ? text.slice(-FAILING_MAX) : text };
        return { source: 'checks', output: 'The checks failed and printed nothing.' };
    }
    const task = readJson(path.join(c.tasks, `${row.task}.json`), {});
    const reason = row.grade && row.grade.reason ? `: ${row.grade.reason}` : '.';
    return { source: 'verdict', output: `The previous worker's answer in ${task.answerFile || 'its answer file'} was graded wrong${reason}` };
}

// ---------------------------------------------------------------- plant
/**
 * A decide key must discriminate: its examples pass, an empty answer fails, each question's
 * `wrong` answer alone fails, and every option and item it grades is named in the brief, so a
 * worker could have picked it.
 */
function plantDecide(c, task) {
    const expected = readJson(path.join(c.tasks, task.expected));
    const brief = fs.readFileSync(path.join(c.tasks, task.brief), 'utf8');
    const qs = expected.questions || [];
    const self = gradeDecide(decideAnswer(expected), expected);
    const empty = gradeDecide({ answers: [] }, expected);
    const wrongFails = qs.map((q) => ({ id: q.id, fails: !!q.wrong && !gradeDecide(decideAnswer(expected, q.id), expected).pass }));
    const named = [];
    for (const q of qs) {
        const words = q.kind === 'order' ? (q.items || []) : [...(q.accept || []), ...(q.wrong ? [q.wrong.choice] : [])];
        for (const w of words) if (!brief.includes(String(w))) named.push(`${q.id}:${w}`);
    }
    const ok = qs.length > 0 && self.pass && !empty.pass && wrongFails.every((w) => w.fails) && named.length === 0;
    return { ok, keySize: qs.length, selfPass: self.pass, emptyPass: empty.pass,
        reason: ok ? 'key grades itself pass, an empty answer and each wrong answer fail, and the brief names every option'
            : `key: ${qs.length} questions, self ${self.pass}, empty ${empty.pass}, wrong not failing [${wrongFails.filter((w) => !w.fails).map((w) => w.id).join(',')}], not in the brief [${named.join(',')}]` };
}
/** The contamination assertion, planted with the fix's own files: they must make it fire. */
function contaminationPlant(c, task, scratch) {
    const tokens = fixTokens(c, task);
    const planted = path.join(scratch, 'contamination-plant');
    const changed = git(['diff', '--name-only', task.parentSha, task.fixSha], { cwd: c.src }).split('\n').filter(Boolean);
    for (const f of changed) {
        const dest = path.join(planted, f);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, git(['show', `${task.fixSha}:${f}`], { cwd: c.src }));
    }
    return { tokens, fired: scanForTokens(tokens, [planted], 1).length > 0 };
}
function inTree(c, sha, file) {
    return spawnSync('git', ['cat-file', '-e', `${sha}:${file}`], { cwd: c.src, windowsHide: true }).status === 0;
}
/** Leak terms the brief or the parent tree already holds: the first tells the worker, the second fires on every run. */
function leakTermsPresent(c, task, brief) {
    return (task.leakTerms || []).filter((t) => {
        if (brief.includes(t)) return true;
        const r = spawnSync('git', ['grep', '-q', '-F', '-e', t, task.parentSha], { cwd: c.src, windowsHide: true });
        if (r.status !== 0 && r.status !== 1) fault('git-failed', `git grep for a leak term over ${task.parentSha} exited ${r.status}`);
        return r.status === 0;
    });
}
/**
 * A diagnose key must discriminate: at least two example answers pass, at least
 * two decoys and an empty answer fail, the brief matches no keyword group (it
 * would hand the worker the mechanism), every file the key names is in the
 * parent tree, no leak term is already in the brief or the tree, and a fix the
 * task names fires the contamination check.
 */
function plantDiagnose(c, task, scratch) {
    const expected = readJson(path.join(c.tasks, task.expected));
    const brief = fs.readFileSync(path.join(c.tasks, task.brief), 'utf8');
    const examples = expected.examples || [];
    const decoys = expected.decoys || [];
    const groups = (expected.cause && expected.cause.groups) || [];
    const reasons = [];
    if (examples.length < 2) reasons.push(`${examples.length} examples, needs 2 or more`);
    if (decoys.length < 2) reasons.push(`${decoys.length} decoys, needs 2 or more`);
    const exFail = examples.map((a, i) => (gradeDiagnose(a, expected).pass ? null : i)).filter((i) => i !== null);
    if (exFail.length) reasons.push(`examples that fail [${exFail.join(',')}]`);
    const decoyPass = decoys.filter((d) => gradeDiagnose(d.answer, expected).pass).map((d) => d.id);
    if (decoyPass.length) reasons.push(`decoys that pass [${decoyPass.join(',')}]`);
    if (gradeDiagnose({}, expected).pass) reasons.push('an empty answer passes');
    const inBrief = groups.filter((g) => (g.match || []).some((m) => new RegExp(m, 'i').test(brief))).map((g) => g.id);
    if (inBrief.length) reasons.push(`the brief already matches groups [${inBrief.join(',')}]`);
    const named = [...((expected.cause && expected.cause.files) || []), ...decoys.map((d) => d.answer && d.answer.cause && d.answer.cause.file)];
    const absent = [...new Set(named.filter(Boolean).map(normPath))].filter((f) => !inTree(c, task.parentSha, f));
    if (absent.length) reasons.push(`files not in the parent tree [${absent.join(',')}]`);
    const leaks = leakTermsPresent(c, task, brief);
    if (leaks.length) reasons.push(`leak terms already in the brief or the parent tree [${leaks.join(',')}]`);
    const cont = task.fixSha ? contaminationPlant(c, task, scratch) : null;
    if (cont && cont.tokens.length && !cont.fired) reasons.push('the contamination check did not fire on the fix files');
    if (!(cont && cont.tokens.length) && !(task.leakTerms || []).length) reasons.push('nothing to search the room for: name the fix or leakTerms');
    return { ok: reasons.length === 0, keySize: groups.length, examples: examples.length, decoys: decoys.length,
        contaminationTokens: cont ? cont.tokens.length : 0, contaminationFired: cont ? cont.fired : null, leakTerms: (task.leakTerms || []).length,
        reason: reasons.join('; ') || `examples pass, decoys and an empty answer fail, the brief matches no group${cont && cont.tokens.length ? ', contamination fires' : ''}` };
}
/**
 * A plan key must discriminate: every right example passes, the careless one
 * and an empty plan fail, each trap has an example that meets the threshold
 * and fails on that trap, and the brief meets no text requirement by itself.
 */
function plantPlan(c, task) {
    const expected = readJson(path.join(c.tasks, task.expected));
    const brief = fs.readFileSync(path.join(c.tasks, task.brief), 'utf8');
    const ex = expected.examples || {};
    const reqs = expected.requirements || [];
    const traps = expected.traps || [];
    const reasons = [];
    const threshold = Number(expected.threshold);
    if (!(threshold >= 1 && threshold <= reqs.length)) reasons.push(`threshold ${expected.threshold} is not between 1 and ${reqs.length}`);
    const right = ex.right || [];
    if (!right.length) reasons.push('no right example');
    const rightFail = right.map((a, i) => (gradePlan(a, expected).pass ? null : i)).filter((i) => i !== null);
    if (rightFail.length) reasons.push(`right examples that fail [${rightFail.join(',')}]`);
    if (!ex.careless) reasons.push('no careless example');
    else if (gradePlan(ex.careless, expected).pass) reasons.push('the careless example passes');
    if (gradePlan({}, expected).pass) reasons.push('an empty plan passes');
    if (!traps.length) reasons.push('no trap');
    const trapMiss = traps.filter((t) => {
        const g = ex.traps && ex.traps[t.id] ? gradePlan(ex.traps[t.id], expected) : null;
        return !g || g.pass || !g.traps.includes(t.id) || !(g.met >= g.threshold);
    }).map((t) => t.id);
    if (trapMiss.length) reasons.push(`traps whose example does not fail on the trap alone [${trapMiss.join(',')}]`);
    const inBrief = reqs.filter((r) => (r.text || []).some((m) => new RegExp(m, 'i').test(brief))).map((r) => r.id);
    if (inBrief.length) reasons.push(`the brief already meets [${inBrief.join(',')}]`);
    const leaks = leakTermsPresent(c, task, brief);
    if (leaks.length) reasons.push(`leak terms already in the brief or the parent tree [${leaks.join(',')}]`);
    return { ok: reasons.length === 0, keySize: reqs.length, threshold, traps: traps.length, rightExamples: right.length, leakTerms: (task.leakTerms || []).length,
        reason: reasons.join('; ') || 'right examples pass, the careless and empty plans fail, each trap fails its example, the brief meets nothing' };
}
function plantTask(c, task) {
    const at = new Date().toISOString();
    const rec = { taskHash: task.hash, at, lane: task.lane };
    if (task.drop) return Object.assign(rec, { ok: false, reason: `dropped: ${task.drop}` });
    const scratch = path.join(c.work, 'plant', task.id);
    fs.rmSync(scratch, { recursive: true, force: true });
    const env = checksEnv(process.env);
    const log = path.join(scratch, 'plant.log');
    if (task.lane === 'decide') return Object.assign(rec, plantDecide(c, task));
    if (task.lane === 'diagnose') return Object.assign(rec, plantDiagnose(c, task, scratch));
    if (task.lane === 'plan') return Object.assign(rec, plantPlan(c, task));
    if (task.lane !== 'fix') {
        const expected = readJson(path.join(c.tasks, task.expected));
        const self = task.lane === 'locate' ? gradeLocate(expected, expected, Number(task.threshold || 0.8)) : gradeReview({ findings: plantedFindings(expected) }, expected);
        const empty = task.lane === 'locate' ? gradeLocate({ items: [] }, expected, Number(task.threshold || 0.8)) : gradeReview({ findings: [] }, expected);
        const size = task.lane === 'locate' ? (expected.items || []).length : (expected.planted || []).length;
        const ok = self.pass && !empty.pass && size >= 2;
        return Object.assign(rec, { ok, keySize: size, selfPass: self.pass, emptyPass: empty.pass,
            reason: ok ? 'key grades itself pass and an empty answer fail' : `key: self ${self.pass}, empty ${empty.pass}, ${size} items (needs 2 or more)` });
    }
    fs.mkdirSync(scratch, { recursive: true });
    const parentRepo = path.join(scratch, 'parent');
    const fixRepo = path.join(scratch, 'fix');
    exportTree(c.src, task.parentSha, parentRepo);
    exportTree(c.src, task.fixSha, fixRepo);
    copyHeldOut(c, task, parentRepo);
    const red = runChecks(task.checks, parentRepo, env, log, 'unfixed');
    const grn = runChecks(task.checks, fixRepo, env, log, 'fixed');
    const p2pParent = runChecks(task.passToPass || [], parentRepo, env, log, 'p2p unfixed');
    const p2pFix = runChecks(task.passToPass || [], fixRepo, env, log, 'p2p fixed');
    const { tokens, fired } = contaminationPlant(c, task, scratch);
    const unfixedRed = red.some((k) => k.exit !== 0);
    const fixedGreen = green(grn);
    const p2pOk = p2pParent.every((k) => k.exit === 0) && p2pFix.every((k) => k.exit === 0);
    const reasons = [];
    if (!unfixedRed) reasons.push('the checks pass on the unfixed tree, so the task measures nothing');
    if (!fixedGreen) reasons.push('the checks fail on the fixed tree');
    if (!p2pOk) reasons.push('a pass-to-pass suite is red on one side');
    // A waiver is written in the task file with its reason; it never covers a
    // task whose fix does add tokens, where the check must fire.
    if (!tokens.length && !task.contaminationWaiver) reasons.push('the fix adds no distinctive token, so contamination cannot be checked, and the task carries no waiver');
    else if (tokens.length && !fired) reasons.push('the contamination check did not fire on the fix files');
    fs.rmSync(parentRepo, { recursive: true, force: true });
    fs.rmSync(fixRepo, { recursive: true, force: true });
    const okText = `red unfixed, green fixed, neighbours green, ${tokens.length ? 'contamination fires' : 'contamination waived'}`;
    return Object.assign(rec, { ok: reasons.length === 0, reason: reasons.join('; ') || okText,
        unfixed: red.map((k) => k.exit), fixed: grn.map((k) => k.exit), p2pUnfixed: p2pParent.map((k) => k.exit), p2pFixed: p2pFix.map((k) => k.exit),
        contaminationTokens: tokens.length, contaminationFired: fired, contaminationWaiver: tokens.length ? null : task.contaminationWaiver || null });
}
/** The findings a perfect reviewer would write: one blocker per planted defect, quoting a phrase each regex accepts. */
function plantedFindings(expected) {
    return (expected.planted || []).map((d) => ({ section: d.section, severity: 'blocker', claim: d.example || '' }));
}

function plant(c, ids) {
    const file = path.join(c.data, 'plant.json');
    const state = readJson(file, { tasks: {} });
    const results = {};
    for (const id of ids) {
        let rec;
        try { rec = plantTask(c, loadTask(c, id)); } catch (e) { rec = { ok: false, reason: `${e.publicCode || 'error'}: ${e.message}`, at: new Date().toISOString() }; }
        state.tasks[id] = rec;
        results[id] = rec;
        state.srcHead = revParse(c.src, 'HEAD');
        state.updatedAt = new Date().toISOString();
        writeJsonAtomic(file, state);
    }
    return results;
}

// ---------------------------------------------------------------- batch
function batchFile(c, id) { return path.join(c.data, 'batches', `${id}.json`); }
function pidAlive(pid) {
    if (!pid) return false;
    if (process.platform === 'win32') {
        const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
        return new RegExp(`"${pid}"`).test(r.stdout || '');
    }
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
/** The latest seven-day utilisation this account reported: finished rows, then the logs of runs still going. */
function latestSevenDay(c, account, running) {
    let best = null;
    for (const r of readRows(c)) {
        if (r.account === account && r.budget && typeof r.budget.sevenDay === 'number' && (!best || r.finishedAt > best.at)) best = { value: r.budget.sevenDay, at: r.finishedAt };
    }
    for (const run of running) {
        const log = runPaths(c, run).log;
        let text = '';
        try { text = fs.readFileSync(log, 'utf8'); } catch { continue; }
        const s = parseStream(text.slice(-262144));
        const w = s.rate && s.rate.rate_limit_info && s.rate.rate_limit_info.unifiedWindows;
        if (w && w.seven_day && typeof w.seven_day.utilization === 'number') {
            const at = fs.statSync(log).mtime.toISOString();
            if (!best || at > best.at) best = { value: w.seven_day.utilization, at };
        }
    }
    return best;
}

function createBatch(c, { tasks, variants, account, k, max, quietWaitMin = 0 }) {
    const id = `B-${stamp()}`;
    const items = [];
    for (let rep = 1; rep <= k; rep++) for (const t of tasks) for (const v of variants) items.push({ task: t, variant: v, rep, state: 'queued', run: null, verdict: null });
    const batch = { id, createdAt: new Date().toISOString(), account, max, budgetStop: c.budgetStop, quietWaitMin, items, state: 'running', loopPid: null };
    writeJsonAtomic(batchFile(c, id), batch);
    return batch;
}
/**
 * With --quiet-wait, an item starts only when no gate, coverage run or full
 * suite runs anywhere on the machine, a sibling run's included. Held for at
 * most quietWaitMin, then it starts anyway and its row is loaded. The wait
 * spans polls, so running items keep being graded meanwhile. Returns null with
 * the option off, { hold } while waiting, and { record } once it may start.
 */
function quietGate(c, batch) {
    if (!(batch.quietWaitMin > 0)) return null;
    const found = heavyJobs(processList(c), null, null);
    // One gate is several heavy processes with one label, so labels are deduplicated before the cap.
    const heavy = found && [...new Set(found)];
    const busy = heavy === null || heavy.length > 0;
    const since = batch.waitingSince ? Date.parse(batch.waitingSince) : Date.now();
    const waitedSec = Math.round((Date.now() - since) / 1000);
    if (busy && waitedSec < batch.quietWaitMin * 60) {
        batch.waitingSince = new Date(since).toISOString();
        batch.waitingOn = heavy === null ? ['process list unreadable'] : heavy.slice(0, 12);
        return { hold: true };
    }
    const record = { waitedSec: batch.waitingSince ? waitedSec : 0, timedOut: busy, jobs: busy ? (heavy || ['process list unreadable']).slice(0, 12) : [] };
    delete batch.waitingSince;
    delete batch.waitingOn;
    return { record };
}

/**
 * Restart a batch whose loop died. A wait that was open when the loop died is
 * closed here, because quietGate measures from waitingSince: `[measured
 * 2026-09-30]` a resume 14 hours after the loop died read waitedSec 51738, past
 * every limit, so its item started at once on a loaded machine and the
 * --quiet-wait it was resumed for held nothing. The resumed item waits afresh.
 */
function resumeBatch(c, id, opts, spawnFn = spawnLoop) {
    const b = readJson(batchFile(c, id));
    if (b.state === 'running' && pidAlive(b.loopPid)) fault('loop-alive', `${b.id} has a live loop, pid ${b.loopPid}`);
    const stale = b.waitingSince || null;
    delete b.waitingSince;
    delete b.waitingOn;
    writeJsonAtomic(batchFile(c, id), b);
    return { batch: b.id, loopPid: spawnFn(c, b.id, opts), clearedWaitSince: stale };
}

function spawnLoop(c, id, opts) {
    const pass = [];
    for (const k of ['src', 'tasks-dir', 'data', 'work', 'claude-bin', 'hw', 'budget-stop', 'api-sources']) if (opts[k] !== undefined) pass.push(`--${k}`, String(opts[k]));
    const child = spawn(process.execPath, [__filename, 'batch-loop', '--batch', id, ...pass], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    child.unref();
    return child.pid;
}

function batchLoop(c, id) {
    const file = batchFile(c, id);
    let batch = readJson(file);
    batch.loopPid = process.pid;
    batch.state = 'running';
    writeJsonAtomic(file, batch);
    const save = () => { batch.updatedAt = new Date().toISOString(); writeJsonAtomic(file, batch); };
    try {
        for (;;) {
            let stop = null;
            const live = batch.items.filter((x) => x.state === 'running');
            const procs = live.length ? processList(c) : null;
            for (const it of live) {
                const mp = runPaths(c, it.run).meta;
                const meta = readJson(mp, null);
                if (meta && meta.state === 'running') {
                    meta.loadSamples = noteLoad(meta.loadSamples, heavyJobs(procs, meta.supervisorPid, meta.repo));
                    writeJsonAtomic(mp, meta);
                }
            }
            for (const it of live) {
                const row = finish(c, it.run);
                if (row) {
                    it.state = 'done'; it.verdict = row.verdict;
                    if (row.verdict === 'billed-api') stop = 'stopped-billed-api';
                    // A red stage 1 of an escalating variant is half an attempt: queue its stage 2.
                    if (row.stage === 1 && (row.verdict === 'fail' || row.verdict === 'timeout')) {
                        batch.items.push({ task: it.task, variant: it.variant, rep: it.rep, stage: 2, from: row.run, state: 'queued', run: null, verdict: null });
                    }
                }
            }
            if (stop) {
                for (const it of batch.items.filter((x) => x.state === 'running')) killTree(readJson(runPaths(c, it.run).meta).supervisorPid);
                batch.state = stop; save(); return batch;
            }
            const running = batch.items.filter((x) => x.state === 'running').map((x) => x.run);
            const queued = batch.items.filter((x) => x.state === 'queued');
            if (!queued.length && !running.length) { batch.state = 'done'; save(); return batch; }
            const reading = latestSevenDay(c, batch.account, running);
            batch.lastBudget = reading;
            if (reading && reading.value >= batch.budgetStop) {
                if (!running.length) { batch.state = 'stopped-budget'; save(); return batch; }
            } else {
                // Without a reading yet, one run at a time until the first rate_limit_event lands.
                const room = (reading ? batch.max : 1) - running.length;
                const next = queued.slice(0, Math.max(0, room));
                const wait = next.length ? quietGate(c, batch) : null;
                for (const it of wait && wait.hold ? [] : next) {
                    try {
                        const extra = wait ? { quietWait: wait.record } : {};
                        if (it.stage === 2) {
                            const red = readRows(c).find((r) => r.run === it.from);
                            if (!red) fault('no-stage-1', `stage 1 run ${it.from} has no row`);
                            extra.escalation = Object.assign({ from: it.from }, failingOutput(c, red));
                        }
                        const meta = runOne(c, it.task, it.variant, batch.account, it.rep, process.env, extra);
                        it.run = meta.run; it.state = 'running';
                    } catch (e) {
                        it.state = 'skipped'; it.verdict = e.publicCode || 'error'; it.error = e.message.slice(0, 300);
                    }
                    save();
                }
            }
            save();
            sleepMs(c.pollMs);
        }
    } catch (e) {
        batch.state = 'loop-error'; batch.error = `${e.publicCode || 'internal'}: ${e.message}`.slice(0, 400); save();
        throw e;
    }
}

function status(c) {
    const dir = path.join(c.data, 'batches');
    let batches = [];
    try { batches = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f), null)).filter(Boolean); } catch { batches = []; }
    const rows = readRows(c);
    return {
        batches: batches.map((b) => ({ id: b.id, state: b.state, loopAlive: b.state === 'running' ? pidAlive(b.loopPid) : null, account: b.account,
            done: b.items.filter((i) => i.state === 'done').length, running: b.items.filter((i) => i.state === 'running').length,
            queued: b.items.filter((i) => i.state === 'queued').length, skipped: b.items.filter((i) => i.state === 'skipped').length,
            pass: b.items.filter((i) => i.verdict === 'pass').length, lastBudget: b.lastBudget || null,
            waiting: b.waitingSince ? { since: b.waitingSince, on: b.waitingOn || [] } : null })),
        rows: rows.length,
        latest: rows.slice(-10).map((r) => ({ run: r.run, verdict: r.verdict, wallMs: r.wallMs, tokens: r.tokens ? r.tokens.total : null, costUsd: r.costUsd })),
    };
}

// ---------------------------------------------------------------- cli
function main(argv) {
    const opts = parseArgs(argv);
    const cmd = opts._[0];
    if (!cmd || opts.help || cmd === 'help') { process.stdout.write(USAGE.join('\n') + '\n'); return 0; }
    const c = ctx(opts);
    const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
    let value;
    switch (cmd) {
        case 'snapshot': value = snapshot(c); break;
        case 'plant': value = plant(c, opts.task ? list(opts.task) : allTaskIds(c)); break;
        case 'prepare': {
            if (!opts.task || !opts.variant) fault('usage', 'prepare needs --task and --variant');
            value = prepare(c, opts.task, opts.variant, Number(opts.repeat || 1));
            break;
        }
        case 'run': {
            if (!opts.task || !opts.variant || !opts.account) fault('usage', 'run needs --task, --variant and --account');
            value = runOne(c, opts.task, opts.variant, opts.account, Number(opts.repeat || 1), process.env);
            break;
        }
        case 'finish': {
            if (!opts.run) fault('usage', 'finish needs --run');
            const deadline = Date.now() + Number(opts['wait-sec'] || 0) * 1000;
            for (;;) {
                value = finish(c, opts.run);
                if (value || Date.now() >= deadline) break;
                sleepMs(Math.min(c.pollMs, 2000));
            }
            if (!value) value = { run: opts.run, state: 'running' };
            break;
        }
        case 'regrade': {
            if (!opts.run) fault('usage', 'regrade needs --run');
            value = regrade(c, opts.run);
            break;
        }
        case 'batch': {
            if (!opts.tasks || !opts.variants || !opts.account) fault('usage', 'batch needs --tasks, --variants and --account');
            workerEnv(process.env, opts.account);
            const tasks = opts.tasks === 'all' ? allTaskIds(c) : list(opts.tasks);
            const variants = list(opts.variants);
            for (const t of tasks) plantOk(c, loadTask(c, t));
            for (const v of variants) loadVariant(v);
            const qw = opts['quiet-wait'] === true ? 10 : Number(opts['quiet-wait'] || 0);
            if (!(qw >= 0)) fault('usage', '--quiet-wait takes minutes, 10 when given alone');
            const b = createBatch(c, { tasks, variants, account: opts.account, k: Number(opts.k || 1), max: Math.min(2, Number(opts.max || 2)), quietWaitMin: qw });
            const pid = spawnLoop(c, b.id, opts);
            value = { batch: b.id, items: b.items.length, loopPid: pid, file: batchFile(c, b.id) };
            break;
        }
        case 'batch-resume': {
            if (!opts.batch) fault('usage', 'batch-resume needs --batch');
            value = resumeBatch(c, opts.batch, opts);
            break;
        }
        case 'batch-loop': value = batchLoop(c, opts.batch); break;
        case 'status': value = status(c); break;
        default: fault('usage', `unknown command ${cmd}; run with --help`);
    }
    process.stdout.write(JSON.stringify({ ok: true, value }) + '\n');
    return 0;
}

if (require.main === module) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: { code: e.publicCode || 'internal', message: e.message } }) + '\n');
        process.exitCode = 1;
    }
}

module.exports = { parseArgs, regrade, fixTokens, scanForTokens, ancestorMemory, currentTaskHash, workerEnv, checksEnv, composePrompt, parseStream, tokensOf, leakHits,
    gradeLocate, gradeReview, gradeDecide, decideAnswer, gradeDiagnose, gradePlan, plantedFindings, readRows, routeFor,
    RUN_RE, SCRUB_RE, SETTINGS_KEEP, CODEY, HEDGE_RE, sentencesOf, hedgedSentence, processList, heavyJobs, noteLoad, loadRecord, quietGate, resumeBatch, failingOutput, HEAVY_RE };
