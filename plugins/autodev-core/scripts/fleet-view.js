#!/usr/bin/env node
'use strict';
/**
 * fleet-view.js - every worker from every ledger on one local page, with the
 * actions a person needs to unblock one.
 *
 * WHY. Workers are started five ways and each way keeps its own ledger: the
 * runs/ launcher (`~/.claude/autodev/runs/<job>/<stamp>/status.json`),
 * headless-worker.js (`headless-workers.json`), unattended-worker.js
 * (`unattended-workers.json`), a background runner (`bg-runner.json`) and the
 * mission store. The desktop app adds two more stores per account (sessions and
 * routines under `%APPDATA%/Claude/claude-code-sessions/<account>/<org>/`) and
 * shows only the signed-in account. So "what is running, and what is waiting on
 * me" had no single answer. This server merges all of them into one table.
 *
 * WHAT IT GUARANTEES. Every source prints its population. A source that cannot
 * be read renders a COULD-NOT-READ row with the reason, never an empty table,
 * because an empty table reads exactly like an idle fleet.
 *
 * ACTIONS, each appended as one JSON line to the events file:
 *   answer    writes answer.json beside an open ask.json. Refused if one exists.
 *   settle    headless-worker settle for an exited worker.
 *   relaunch  the same prompt plus the answer, under a new code, same account,
 *             model, effort, permission mode and cwd.
 *   takeover  starts --takeover-script in a new console window (win32 only).
 *   stop      kills a headless worker by pid, only after the process identity
 *             matches the record. On Linux that is /proc/<pid>/cwd, on macOS
 *             lsof. Windows exposes no process cwd without native code, so there
 *             the check is the supervisor command line, which carries the
 *             record's --cwd and --code verbatim.
 * The page carries a per-start random token and every POST must return it. The
 * server binds 127.0.0.1 only and refuses a Host header that is not loopback,
 * so another origin can neither read the token nor rebind a name onto it.
 *
 * Usage:
 *   node fleet-view.js [serve] [--port 8766] [--hours 48] [--takeover-script <file>] [--no-launch] [--until-stdin-closes]
 *   node fleet-view.js list [--json] [--hours 48]
 *   node fleet-view.js --selftest
 *   node fleet-view.js --help
 * Shared flags: --home <dir> --appdata <dir> --mission-store <dir> --events <file> --claude-bin <path>
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const HW = require('./headless-worker.js');

const USAGE = [
    'Usage: node fleet-view.js [serve] [--port 8766] [--hours 48] [--takeover-script <file>] [--no-launch] [--until-stdin-closes]',
    '       node fleet-view.js list [--json] [--hours 48]',
    '       node fleet-view.js --selftest',
    'serve: one page on http://127.0.0.1:<port>/ merging every worker ledger and both desktop stores.',
    '       POST /action needs the per-start token the page carries. --port 0 picks a free port.',
    '       --until-stdin-closes: exit cleanly when stdin closes, for a parent that owns the pipe.',
    'list:  the same merge on stdout: a population line per source, then one line per row.',
    'A row shows when it is live, asking, or touched in the last --hours. Every source prints its',
    'population and a COULD-NOT-READ row when unreadable.',
    'Flags: --home <dir> (default the user home), --appdata <dir> (default %APPDATA%, else the MSIX',
    '       package copy under %LOCALAPPDATA%/Packages/Claude_*/LocalCache/Roaming),',
    '       --mission-store <dir> (the mission store has no default location),',
    '       --events <file> (default ~/.claude/autodev/fleet-events.jsonl), --claude-bin <path> (relaunch),',
    '       --takeover-script <file> (a .ps1 taking -Code and -Log), --no-launch (record takeover, open nothing).',
].join('\n') + '\n';

const DEFAULT_PORT = 8766;
const DEFAULT_HOURS = 48;
const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 64 * 1024;
const BODY_MAX = 64 * 1024;
const PR_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;

function fault(code, message) { const e = new Error(message || code); e.publicCode = code; throw e; }

function parseArgs(argv) {
    const out = { _: [] };
    const flags = ['help', 'json', 'selftest', 'no-launch', 'until-stdin-closes'];
    const known = [...flags, 'port', 'hours', 'home', 'appdata', 'mission-store', 'events', 'claude-bin', 'takeover-script'];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h' || a === 'help') { out.help = true; continue; }
        if (!a.startsWith('--')) { out._.push(a); continue; }
        const eq = a.indexOf('=');
        const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
        if (!known.includes(key)) fault('usage', `unknown flag --${key}`);
        if (flags.includes(key)) { out[key] = true; continue; }
        const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (value === undefined || value === '') fault('usage', `--${key} needs a value`);
        out[key] = value;
    }
    return out;
}

// The Desktop app ships as an MSIX package on Windows. Its own child processes see %APPDATA%/Claude
// through a virtualized view, while a process started from outside the package (Task Scheduler, a
// plain terminal) sees only the package's real copy under
// %LOCALAPPDATA%/Packages/Claude_<id>/LocalCache/Roaming. Measured 2026-09-23: a scheduled reader got
// ENOENT on %APPDATA%/Claude for 129 passes while a shell inside the app listed the same path.
function desktopAppdata(env, home) {
    const direct = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    if (fs.existsSync(path.join(direct, 'Claude', 'claude-code-sessions'))) return direct;
    const pkgs = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Packages');
    let names = [];
    try { names = fs.readdirSync(pkgs).filter((n) => /^Claude_/.test(n)).sort(); } catch { /* no Packages dir: keep the direct path */ }
    for (const n of names) {
        const roaming = path.join(pkgs, n, 'LocalCache', 'Roaming');
        if (fs.existsSync(path.join(roaming, 'Claude', 'claude-code-sessions'))) return roaming;
    }
    return direct;
}

function settings(opts) {
    const home = path.resolve(opts.home || process.env.USERPROFILE || process.env.HOME || os.homedir());
    const hours = opts.hours === undefined ? DEFAULT_HOURS : Number(opts.hours);
    if (!Number.isFinite(hours) || hours <= 0) fault('usage', '--hours must be a positive number');
    const autodev = path.join(home, '.claude', 'autodev');
    return {
        home, hours, autodev,
        appdata: path.resolve(opts.appdata || desktopAppdata(process.env, home)),
        missionStore: opts['mission-store'] ? path.resolve(opts['mission-store']) : null,
        events: path.resolve(opts.events || path.join(autodev, 'fleet-events.jsonl')),
        claudeBin: opts['claude-bin'] || null,
        takeoverScript: opts['takeover-script'] ? path.resolve(opts['takeover-script']) : null,
        noLaunch: !!opts['no-launch'],
    };
}

// ---------------------------------------------------------------- small readers
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function readJson(file) { const t = readText(file); if (t === null) return null; try { return JSON.parse(t); } catch { return undefined; } }
function mtime(file) { try { return fs.statSync(file).mtimeMs; } catch { return null; } }

function readSlice(file, fromEnd, bytes) {
    try {
        const st = fs.statSync(file);
        const len = Math.min(st.size, bytes);
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(file, 'r');
        try { fs.readSync(fd, buf, 0, len, fromEnd ? st.size - len : 0); } finally { fs.closeSync(fd); }
        return buf.toString('utf8');
    } catch { return null; }
}

function lastPr(...texts) {
    let last = null;
    for (const t of texts) for (const m of String(t || '').matchAll(PR_RE)) last = m[0];
    return last;
}

function clip(s, n) { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '\u2026' : t; }
function project(cwd) { return cwd ? path.basename(String(cwd).replace(/[\\/]+$/, '')) : ''; }
function ts(v) { const n = typeof v === 'number' ? v : Date.parse(v || ''); return Number.isFinite(n) ? n : null; }

/** The last checklist line of a progress file and its STATUS line. */
function progressOf(text) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const statusLine = [...lines].reverse().find((l) => /^STATUS:/i.test(l));
    const items = lines.filter((l) => /^- \[[ x!~]\]/i.test(l));
    const done = [...items].reverse().find((l) => /^- \[[x!~]\]/i.test(l));
    return { status: statusLine ? statusLine.replace(/^STATUS:\s*/i, '').toLowerCase() : null, last: done || items[items.length - 1] || null };
}

/** The first init line of a stream-json log: the cwd, model and session a worker really ran with. */
function initOf(logFile) {
    const head = readSlice(logFile, false, HEAD_BYTES);
    if (!head) return null;
    for (const line of head.split('\n')) {
        if (!line.includes('"subtype":"init"')) continue;
        try { const j = JSON.parse(line); return { cwd: j.cwd || null, model: j.model || null, session: j.session_id || null }; } catch { /* a torn first line */ }
    }
    return null;
}

/** The last thing a worker said or did, from its stream-json log. Tool COMMANDS are never shown. */
function lastActivity(logFile) {
    const tail = readSlice(logFile, true, TAIL_BYTES);
    if (!tail) return null;
    let last = null;
    for (const line of tail.split('\n')) {
        if (!line.startsWith('{')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const content = j.message && Array.isArray(j.message.content) ? j.message.content : [];
        for (const b of content) {
            if (b.type === 'text' && j.type === 'assistant' && b.text) last = clip(b.text, 140);
            else if (b.type === 'tool_use') {
                const inp = b.input || {};
                last = clip(`${b.name} ${inp.description || inp.file_path || inp.pattern || ''}`, 140);
            }
        }
        if (j.type === 'result' && j.result) last = clip(j.result, 140);
    }
    return last;
}

function question(askFile, answerFile) {
    if (!askFile) return null;
    const ask = readText(askFile);
    if (ask === null || readText(answerFile) !== null) return null;
    let q; try { q = JSON.parse(ask); } catch { return { text: '(ask.json does not parse)', options: [] }; }
    const options = Array.isArray(q.options) ? q.options.map((o) => clip(o && o.label, 80)).filter(Boolean) : [];
    return { text: clip(q.question || '(no question field)', 400), options };
}

// ---------------------------------------------------------------- accounts
/** Account uuid -> label, from every config dir under home that carries an oauthAccount. */
function accountLabels(home) {
    const labels = new Map();
    const add = (uuid, label) => { if (!uuid) return; labels.set(uuid, labels.has(uuid) ? `${labels.get(uuid)}|${label}` : label); };
    const top = readJson(path.join(home, '.claude.json'));
    if (top && top.oauthAccount) add(top.oauthAccount.accountUuid, 'default');
    let names = [];
    try { names = fs.readdirSync(home).filter((n) => /^\.claude-[A-Za-z0-9_-]+$/.test(n)); } catch { /* home unreadable */ }
    for (const n of names.sort()) {
        const j = readJson(path.join(home, n, '.claude.json'));
        if (j && j.oauthAccount) add(j.oauthAccount.accountUuid, n);
    }
    return labels;
}

// ---------------------------------------------------------------- sources
function unreadable(source, why) {
    return { source, readable: false, population: `${source}: COULD NOT READ (${why})`, rows: [] };
}

function runsSource(s) {
    const source = 'runs';
    const root = path.join(s.autodev, 'runs');
    let jobs;
    try { jobs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (e) { return unreadable(source, `${root}: ${e.code || e.message}`); }
    const rows = [];
    let broken = 0;
    for (const job of jobs) {
        let stamps = [];
        try { stamps = fs.readdirSync(path.join(root, job)); } catch { continue; }
        for (const stamp of stamps) {
            const dir = path.join(root, job, stamp);
            const st = readJson(path.join(dir, 'status.json'));
            if (st === null) continue;
            if (st === undefined) { broken++; continue; }
            const progressText = readText(path.join(dir, 'progress.md'));
            const p = progressOf(progressText);
            const askFile = path.join(dir, 'ask.json');
            const answerFile = path.join(dir, 'answer.json');
            // status.json records no pid, so "running" is the launcher's last word, not a fact about
            // a process. One written before this boot cannot be running, and a launcher that died
            // leaves "running" behind for ever, so only a same-boot claim counts as live.
            const running = st.state !== 'finished';
            const sameBoot = (ts(st.started) || 0) >= HW.bootAt();
            const processState = !running ? 'exited' : (st.state === 'running' && sameBoot ? 'running' : `unknown (says ${st.state || 'nothing'})`);
            rows.push({
                key: `runs:${job}/${stamp}`, source, kind: 'runs', code: job,
                title: clip((readText(path.join(dir, 'brief.md')) || '').split('\n').find((l) => l.trim()) || job, 90),
                project: project(st.cwd), cwd: st.cwd || null, account: 'default',
                process: processState, exit: st.exitCode === undefined ? null : st.exitCode,
                result: p.status || (running ? 'none' : 'no STATUS line'), progress: p.last,
                lastAt: Math.max(mtime(path.join(dir, 'progress.md')) || 0, ts(st.finished) || 0, ts(st.started) || 0) || null,
                pr: lastPr(progressText), question: question(askFile, answerFile),
                live: processState === 'running', askFile, answerFile,
            });
        }
    }
    return { source, readable: true, population: `${source}: ${rows.length} run(s) read under ${root}${broken ? `, ${broken} status.json unparseable` : ''}`, rows };
}

function headlessSource(s) {
    const source = 'headless-worker';
    const file = path.join(s.autodev, 'headless-workers.json');
    if (!fs.existsSync(file)) return unreadable(source, `${file} does not exist`);
    let ledger;
    try { ledger = HW.readLedger(file); } catch (e) { return unreadable(source, e.message); }
    const boot = HW.bootAt();
    const rows = ledger.records.map((rec) => {
        const st = HW.recordStatus(rec, boot);
        const init = initOf(rec.log);
        const reportText = readText(rec.report);
        const cwd = rec.cwd || (init && init.cwd) || null;
        return {
            key: `headless-worker:${rec.code}:${rec.startedAt}`, source, kind: 'headless-worker', code: rec.code,
            title: clip((readText(rec.promptFile) || '').split('\n').find((l) => l.trim()) || rec.code, 90),
            project: project(cwd), cwd, account: rec.configDir || 'default', model: rec.model || (init && init.model) || null,
            process: st.process, exit: st.exit, result: st.settled ? `${st.result} (settled)` : st.result, progress: lastActivity(rec.log),
            lastAt: Math.max(mtime(rec.log) || 0, mtime(rec.report) || 0, ts(rec.startedAt) || 0) || null,
            pr: lastPr(reportText), question: st.ask === 'open' || st.ask === 'unreadable' ? question(st.askFile, st.answerFile) : null,
            live: st.process === 'running', answered: st.ask === 'answered', pid: rec.pid, session: init && init.session, settled: st.settled,
            askFile: st.askFile, answerFile: st.answerFile, record: rec, ledger: file,
        };
    });
    return { source, readable: true, population: `${source}: ${file}: ${ledger.records.length} record(s)`, rows };
}

function unattendedSource(s) {
    const source = 'unattended-worker';
    const file = path.join(s.autodev, 'unattended-workers.json');
    const j = readJson(file);
    if (j === null) return unreadable(source, `${file} does not exist`);
    if (!j || !Array.isArray(j.records)) return unreadable(source, `${file}: no records array`);
    const rows = j.records.map((r) => {
        const report = r.report || path.join(s.autodev, 'reports', r.taskId || '', 'REPORT.md');
        const text = readText(report);
        let result = text === null ? 'none' : 'unparseable';
        for (const m of String(text || '').matchAll(/^RESULT\s+(\S+)\s+(done|stopped|failed):\s*(.+)$/gm)) result = `${m[2]}: ${clip(m[3], 100)}`;
        const at = [r.deletedAt, r.settledAt, r.retiredAt, r.startedAt, r.composedAt].map(ts).filter(Boolean);
        return {
            key: `unattended-worker:${r.taskId}`, source, kind: 'unattended', code: r.slug || r.taskId, title: r.taskId,
            project: project(r.repo), cwd: r.worktree || r.repo || null, account: 'desktop',
            process: r.state || 'unknown', exit: null, result, progress: text === null ? null : clip(text.split('\n').filter((l) => l.trim()).slice(-2, -1)[0], 140),
            lastAt: Math.max(mtime(report) || 0, ...at, 0) || null, pr: lastPr(text), question: null,
            live: r.state === 'started',
        };
    });
    return { source, readable: true, population: `${source}: ${file}: ${j.records.length} record(s)`, rows };
}

function bgRunnerSource(s) {
    const source = 'bg-runner';
    const file = path.join(s.autodev, 'bg-runner.json');
    const j = readJson(file);
    if (j === null) return unreadable(source, `${file} does not exist`);
    if (!j || !Array.isArray(j.workers)) return unreadable(source, `${file}: no workers array`);
    const rows = j.workers.map((w) => ({
        key: `bg-runner:${w.id || w.code}:${w.startedAt}`, source, kind: 'bg-runner', code: w.code || w.id, title: w.sessionId || w.id,
        project: project(w.cwd), cwd: w.cwd || null, account: 'default',
        process: w.state || 'unknown', exit: null, result: w.closedFrom ? `closed from ${w.closedFrom}` : 'none', progress: null,
        lastAt: Math.max(ts(w.closedAt) || 0, ts(w.stopRequestedAt) || 0, ts(w.startedAt) || 0) || null, pr: null, question: null,
        live: w.state !== 'closed',
    }));
    return { source, readable: true, population: `${source}: ${file}: ${j.workers.length} worker(s)`, rows };
}

function missionSource(s) {
    const source = 'missions';
    if (!s.missionStore) return unreadable(source, 'no --mission-store given, and the store has no default location');
    if (typeof process.getuid !== 'function') return unreadable(source, `the mission store needs POSIX ownership checks and node:sqlite, and this host is ${process.platform}`);
    const file = path.join(s.missionStore, 'missions.sqlite');
    if (!fs.existsSync(file)) return unreadable(source, `${file} does not exist`);
    let db;
    try {
        const { DatabaseSync } = require('node:sqlite');
        db = new DatabaseSync(file, { readOnly: true });
        const all = db.prepare('SELECT id,state,attempt_count,updated_at,contract_json FROM missions ORDER BY updated_at DESC').all();
        const rows = all.map((m) => {
            let c = {}; try { c = JSON.parse(m.contract_json); } catch { /* the store validated it on admit */ }
            const cwd = c.repo && (c.repo.worktree || c.repo.commonDir);
            return {
                key: `missions:${m.id}`, source, kind: 'mission', code: m.id, title: clip(c.title || c.goal || m.id, 90),
                project: project(cwd), cwd: cwd || null, account: 'default', process: m.state, exit: null,
                result: `attempts ${m.attempt_count}`, progress: null, lastAt: ts(m.updated_at), pr: null, question: null,
                live: !['settled', 'exhausted', 'cancelled'].includes(m.state),
            };
        });
        return { source, readable: true, population: `${source}: ${file}: ${all.length} mission(s)`, rows };
    } catch (e) {
        return unreadable(source, `${file}: ${e.code || e.message}`);
    } finally { try { if (db) db.close(); } catch { /* closed */ } }
}

function desktopSource(s) {
    const source = 'desktop';
    const root = path.join(s.appdata, 'Claude', 'claude-code-sessions');
    let accounts;
    try { accounts = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (e) {
        return [unreadable('desktop-sessions', `${root}: ${e.code || e.message}`), unreadable('desktop-routines', `${root}: ${e.code || e.message}`)];
    }
    const labels = accountLabels(s.home);
    const sessions = [];
    const routines = [];
    let sessionFiles = 0; let sessionBroken = 0; let routineFiles = 0; let routineBroken = 0; let routinesRead = 0;
    for (const acct of accounts) {
        const label = labels.get(acct) || acct.slice(0, 8);
        let orgs = [];
        try { orgs = fs.readdirSync(path.join(root, acct), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
        for (const org of orgs) {
            const dir = path.join(root, acct, org);
            let names = [];
            try { names = fs.readdirSync(dir); } catch { continue; }
            for (const n of names) {
                if (!/^local_.*\.json$/.test(n)) continue;
                sessionFiles++;
                const j = readJson(path.join(dir, n));
                if (!j) { sessionBroken++; continue; }
                sessions.push({
                    key: `desktop:${j.sessionId || n}`, source: 'desktop-sessions', kind: j.scheduledTaskId ? 'desktop (routine run)' : 'desktop',
                    code: clip(j.title || j.sessionId || n, 60), title: j.sessionId || n, project: project(j.cwd), cwd: j.cwd || null,
                    account: label, model: j.model || null, process: j.isArchived ? 'archived' : 'open', exit: null, result: 'none', progress: null,
                    lastAt: ts(j.lastActivityAt) || ts(j.createdAt), pr: null, question: null, live: false, archived: !!j.isArchived,
                    session: j.cliSessionId || null,
                });
            }
            const tasksFile = path.join(dir, 'scheduled-tasks.json');
            const t = readJson(tasksFile);
            if (t === null) continue;
            routineFiles++;
            if (!t || !Array.isArray(t.scheduledTasks)) { routineBroken++; continue; }
            routinesRead += t.scheduledTasks.length;
            for (const r of t.scheduledTasks) {
                if (!r.enabled) continue;
                routines.push({
                    key: `routine:${acct}:${org}:${r.id}`, source: 'desktop-routines', kind: 'routine', code: r.id, title: clip(r.displayName || r.id, 90),
                    project: project(r.cwd), cwd: r.cwd || null, account: label, process: r.cronExpression ? `cron ${r.cronExpression}` : (r.fireAt ? `fires ${new Date(r.fireAt).toISOString().slice(0, 16)}Z` : 'manual'),
                    exit: null, result: 'none', progress: null, lastAt: ts(r.lastRunAt) || ts(r.createdAt), pr: null, question: null,
                    live: !!(r.fireAt && r.fireAt > Date.now()),
                });
            }
        }
    }
    return [
        { source: 'desktop-sessions', readable: true, population: `desktop-sessions: ${sessionFiles} session file(s) across ${accounts.length} account folder(s) under ${root}${sessionBroken ? `, ${sessionBroken} unparseable` : ''}`, rows: sessions },
        { source: 'desktop-routines', readable: true, population: `desktop-routines: ${routinesRead} routine(s) in ${routineFiles} scheduled-tasks.json file(s), ${routines.length} enabled${routineBroken ? `, ${routineBroken} unparseable` : ''}`, rows: routines },
    ];
}

/** Every source, merged, with the window applied. Never throws: a source that throws becomes a COULD-NOT-READ row. */
function collect(s, now = Date.now()) {
    const sources = [];
    const guard = (name, fn) => { try { const v = fn(s); sources.push(...(Array.isArray(v) ? v : [v])); } catch (e) { sources.push(unreadable(name, e.message)); } };
    guard('runs', runsSource);
    guard('headless-worker', headlessSource);
    guard('unattended-worker', unattendedSource);
    guard('bg-runner', bgRunnerSource);
    guard('missions', missionSource);
    guard('desktop', desktopSource);
    const windowMs = s.hours * 3600 * 1000;
    const rows = [];
    for (const src of sources) {
        if (!src.readable) {
            rows.push({ key: `unreadable:${src.source}`, source: src.source, kind: src.source, code: 'COULD-NOT-READ', title: '', project: '', account: '',
                process: 'COULD-NOT-READ', exit: null, result: '', progress: src.population, lastAt: null, pr: null, question: null, actions: [] });
            continue;
        }
        let shown = 0;
        for (const r of src.rows) {
            const recent = r.lastAt !== null && now - r.lastAt <= windowMs;
            // An archived desktop session is finished by the user's own hand, so it never shows.
            if (r.archived || !(r.live || r.question || recent)) continue;
            r.actions = actionsFor(r, s);
            rows.push(r);
            shown++;
        }
        src.shown = shown;
        src.population += `, ${shown} shown`;
    }
    rows.sort((a, b) => rank(a) - rank(b) || (b.lastAt || 0) - (a.lastAt || 0));
    return { sources, rows, window: `live, asking, or touched in the last ${s.hours} h`, at: new Date(now).toISOString() };
}

function rank(r) { return r.process === 'COULD-NOT-READ' ? 0 : r.question ? 1 : r.live ? 2 : 3; }

function actionsFor(r, s) {
    const a = [];
    if (r.question && r.answerFile) a.push('answer');
    if (r.source === 'headless-worker') {
        if (r.process === 'exited' && !r.settled && /^(done|stopped|failed)$/.test(r.result)) a.push('settle');
        // A worker that finished its brief has nothing to continue, so relaunch is offered only
        // for one that stopped, failed, never reported, or was asked and has now been answered.
        if (r.process !== 'running' && (!/^done\b/.test(r.result) || r.answered)) a.push('relaunch');
        if (s.takeoverScript && r.session && process.platform === 'win32') a.push('takeover');
        if (r.process === 'running' && r.pid && r.cwd) a.push('stop');
    }
    return a;
}

// ---------------------------------------------------------------- actions
function appendEvent(s, ev) {
    try {
        fs.mkdirSync(path.dirname(s.events), { recursive: true });
        fs.appendFileSync(s.events, JSON.stringify({ at: new Date().toISOString(), ...ev }) + '\n', 'utf8');
    } catch { /* the page still reports the outcome; the event file is a log, not the action */ }
}

function nextCode(code, ledgerRecords) {
    const base = code.replace(/-R\d+$/, '');
    const taken = new Set(ledgerRecords.map((r) => r.code));
    for (let n = 2; n < 100; n++) {
        const suffix = `-R${n}`;
        const c = base.slice(0, 24 - suffix.length) + suffix;
        if (!taken.has(c) && HW.CODE_RE.test(c)) return c;
    }
    fault('no-code', `no free relaunch code for ${code}`);
}

/** Whether a live pid is the worker a record describes. Returns { ok, how, detail }. */
function processMatches(pid, rec, platform = process.platform, runner = spawnSync) {
    const want = path.resolve(rec.cwd);
    const same = (a, b) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (platform === 'linux') {
        try { const cwd = fs.readlinkSync(`/proc/${pid}/cwd`); return { ok: same(path.resolve(cwd), want), how: 'proc-cwd', detail: cwd }; } catch (e) { return { ok: false, how: 'proc-cwd', detail: e.code || e.message }; }
    }
    if (platform === 'darwin') {
        const r = runner('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
        const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('n'));
        return line ? { ok: same(path.resolve(line.slice(1)), want), how: 'lsof-cwd', detail: line.slice(1) } : { ok: false, how: 'lsof-cwd', detail: 'lsof printed no cwd' };
    }
    if (platform === 'win32') {
        const r = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', windowsHide: true });
        const cmd = String(r.stdout || '').trim();
        if (!cmd) return { ok: false, how: 'win32-cmdline', detail: 'no such process, or its command line is unreadable' };
        const hasCwd = cmd.toLowerCase().includes(`--cwd ${want.toLowerCase()}`) || cmd.toLowerCase().includes(`--cwd "${want.toLowerCase()}"`);
        const hasCode = new RegExp(`--code\\s+"?${rec.code.replace(/[-]/g, '\\-')}"?(\\s|$)`).test(cmd);
        return { ok: hasCwd && hasCode && /\bsupervise\b/.test(cmd), how: 'win32-cmdline', detail: clip(cmd, 300) };
    }
    return { ok: false, how: 'unsupported', detail: `no process identity check for ${platform}` };
}

function killTree(pid) {
    if (process.platform === 'win32') {
        const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
        return r.status === 0 ? 'taskkill /T' : fault('stop-failed', clip(r.stderr || r.stdout, 200));
    }
    try { process.kill(-pid, 'SIGTERM'); return 'SIGTERM to the process group'; } catch { process.kill(pid, 'SIGTERM'); return 'SIGTERM'; }
}

function hwCli(args) {
    const r = spawnSync(process.execPath, [require.resolve('./headless-worker.js'), ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    let json = null;
    try { json = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { /* reported below */ }
    if (!json) fault('headless-worker', `headless-worker.js printed no JSON (exit ${r.status}): ${clip(r.stderr || r.stdout, 200)}`);
    if (!json.ok) fault(json.error.code, json.error.message);
    return json.value;
}

function doAction(s, action, key, fields) {
    const { rows } = collect(s);
    const row = rows.find((r) => r.key === key);
    if (!row) fault('unknown-row', `no row ${key} in the current view`);
    if (!row.actions.includes(action)) fault('not-allowed', `${action} is not available for ${row.code} (${row.process}, ${row.result})`);
    if (action === 'answer') {
        const label = clip(fields.label, 200);
        if (!label) fault('usage', 'an answer needs a label: pick an option or type one');
        // A row whose answer.json exists has no open question, so the action gate above already
        // refuses a second answer. The exclusive create covers the race between that read and this write.
        fs.writeFileSync(row.answerFile, JSON.stringify({ label, note: String(fields.note || '').slice(0, 4000), at: new Date().toISOString(), via: 'fleet-view' }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
        return { row, detail: `wrote ${row.answerFile}` };
    }
    if (action === 'settle') {
        const v = hwCli(['settle', '--code', row.code, '--ledger', row.ledger]);
        return { row, detail: `settled ${row.code}: ${v.state}` };
    }
    if (action === 'relaunch') {
        const rec = row.record;
        const ledger = HW.readLedger(row.ledger);
        const code = nextCode(rec.code, ledger.records);
        const answer = readJson(row.answerFile);
        const prompt = readText(rec.promptFile);
        if (prompt === null) fault('prompt-missing', `${rec.promptFile} is gone, so there is nothing to relaunch`);
        const promptFile = path.join(path.dirname(rec.promptFile), `${code}.md`);
        const note = [`RELAUNCH of ${rec.code}. Its report is ${rec.report}: read it first and continue from where it stopped.`];
        if (answer && answer.label) note.push(`The answer to its question: ${answer.label}.${answer.note ? ` ${answer.note}` : ''}`);
        fs.writeFileSync(promptFile, prompt.replace(/\s+$/, '') + '\n\n' + note.join('\n') + '\n', 'utf8');
        const logExt = path.extname(rec.log) || '.log';
        const args = ['start', '--code', code, '--prompt-file', promptFile, '--log', path.join(path.dirname(rec.log), code + logExt),
            '--report', path.join(path.dirname(rec.report), `${code}.report.md`), '--ledger', row.ledger,
            '--permission-mode', rec.permissionMode || 'default'];
        if (row.cwd) args.push('--cwd', row.cwd);
        if (rec.configDir) args.push('--config-dir', path.isAbsolute(rec.configDir) ? rec.configDir : path.join(s.home, rec.configDir));
        if (rec.model) args.push('--model', rec.model);
        if (rec.effort) args.push('--effort', rec.effort);
        if (s.claudeBin) args.push('--claude-bin', s.claudeBin);
        const v = hwCli(args);
        return { row, detail: `started ${code} (supervisor pid ${v.supervisorPid})`, newCode: code };
    }
    if (action === 'takeover') {
        if (/["\r\n]/.test(row.record.log + s.takeoverScript)) fault('bad-path', 'a path with a quote cannot be passed to a console safely');
        const command = `start "takeover ${row.code}" powershell.exe -NoExit -ExecutionPolicy Bypass -File "${s.takeoverScript}" -Code ${row.code} -Log "${row.record.log}"`;
        if (s.noLaunch) return { row, detail: `not launched (--no-launch): ${command}` };
        const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: false });
        child.on('error', () => { /* reported by the absence of a window; the event line records the command */ });
        child.unref();
        return { row, detail: `opened a console: ${command}` };
    }
    if (action === 'stop') {
        const match = processMatches(row.pid, { cwd: row.cwd, code: row.code });
        if (!match.ok) fault('identity-mismatch', `pid ${row.pid} is not ${row.code} by ${match.how}: ${match.detail}`);
        const how = killTree(row.pid);
        return { row, detail: `stopped pid ${row.pid} (${how}), identity by ${match.how}` };
    }
    fault('usage', `unknown action ${action}`);
}

// ---------------------------------------------------------------- rendering
function esc(v) { return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function age(ms, now = Date.now()) {
    if (!ms) return '';
    const m = Math.max(0, Math.round((now - ms) / 60000));
    return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

function listLines(view) {
    const out = view.sources.map((src) => src.population);
    out.push(`window: ${view.window}. ${view.rows.length} row(s).`);
    for (const r of view.rows) {
        out.push([r.code, r.project || '-', r.account || '-', r.kind, r.process + (r.exit !== null && r.exit !== undefined ? ` ${r.exit}` : ''),
            r.result || '-', age(r.lastAt) || '-', r.pr || '', r.question ? `ASKS: ${r.question.text}` : '', r.progress ? `| ${r.progress}` : ''].filter(Boolean).join('  '));
    }
    return out.join('\n') + '\n';
}

function actionForm(r, action, token) {
    const hidden = `<input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="key" value="${esc(r.key)}"><input type="hidden" name="action" value="${action}">`;
    if (action === 'answer') {
        const opts = (r.question.options || []).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
        return `<form method="post" action="/action" class="answer">${hidden}
<label>Option <select name="label">${opts}<option value="">(type below)</option></select></label>
<label>Or your own <input name="custom" autocomplete="off"></label>
<label>Note <input name="note" autocomplete="off"></label><button>Answer</button></form>`;
    }
    const confirm = action === 'stop' ? ' onsubmit="return confirm(\'Stop this worker?\')"' : '';
    return `<form method="post" action="/action"${confirm}>${hidden}<button>${action[0].toUpperCase() + action.slice(1)}</button></form>`;
}

function renderPage(view, token, flash) {
    const rows = view.rows.length ? view.rows.map((r) => `<tr class="${r.process === 'COULD-NOT-READ' ? 'bad' : r.question ? 'ask' : r.live ? 'live' : ''}">
<td><b>${esc(r.code)}</b><div class="sub">${esc(r.title)}</div></td><td>${esc(r.project)}</td><td>${esc(r.account)}</td><td>${esc(r.kind)}</td>
<td>${esc(r.process)}${r.exit !== null && r.exit !== undefined ? ` <span class="sub">exit ${esc(r.exit)}</span>` : ''}</td><td>${esc(r.result)}</td>
<td class="prog">${esc(r.progress)}</td><td>${esc(age(r.lastAt))}</td>
<td>${r.pr ? `<a href="${esc(r.pr)}" target="_blank" rel="noopener">#${esc(r.pr.split('/').pop())}</a>` : ''}</td>
<td>${r.question ? esc(r.question.text) : ''}</td><td class="acts">${(r.actions || []).map((a) => actionForm(r, a, token)).join('')}</td></tr>`).join('\n')
        : `<tr><td colspan="11">No rows in the window (${esc(view.window)}). Every source was read: see the population lines above.</td></tr>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fleet View</title><style>
:root{--bg:#fbfbfa;--fg:#1c1c1a;--muted:#6b6a65;--line:#e4e2dc;--ask:#fff4d6;--bad:#fde2e0;--live:#e6f3ea;--accent:#2f5d8a}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--muted:#a09e97;--line:#2e2d2a;--ask:#3a3218;--bad:#44201d;--live:#1d3325;--accent:#8db7e0}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
main{padding:16px;max-width:1600px;margin:0 auto}h1{font-size:18px;margin:0 0 4px}
.sub{color:var(--muted);font-size:12px}.pop{font-size:12px;color:var(--muted);margin:8px 0 12px;padding-left:16px}
.flash{padding:8px 12px;border:1px solid var(--line);border-radius:6px;margin:8px 0}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}table{border-collapse:collapse;width:100%;min-width:1100px}
th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid var(--line)}th{font-size:12px;color:var(--muted);font-weight:600}
tr.ask td{background:var(--ask)}tr.bad td{background:var(--bad)}tr.live td{background:var(--live)}
td.prog{max-width:320px}td.acts form{display:inline-block;margin:0 4px 4px 0}form.answer{display:flex;flex-direction:column;gap:4px;min-width:220px}
button{font:inherit;padding:4px 10px;min-height:32px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
input,select{font:inherit;padding:3px 6px;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg);max-width:100%}
a{color:var(--accent)}</style></head><body><main>
<h1>Fleet View</h1><div class="sub">${esc(view.at)} · ${esc(view.window)} · <a href="/">Refresh</a></div>
${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
<ul class="pop">${view.sources.map((src) => `<li>${esc(src.population)}</li>`).join('')}</ul>
<div class="wrap"><table><thead><tr><th>Code</th><th>Project</th><th>Account</th><th>Kind</th><th>Process</th><th>Result</th><th>Last progress</th><th>Age</th><th>PR</th><th>Question</th><th>Actions</th></tr></thead>
<tbody>${rows}</tbody></table></div></main></body></html>`;
}

// ---------------------------------------------------------------- server
function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0; const chunks = [];
        req.on('data', (c) => { size += c.length; if (size > BODY_MAX) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function tokenMatches(given, token) {
    const a = Buffer.from(String(given || ''));
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function serve(s, port, { untilStdinCloses = false } = {}) {
    const token = crypto.randomBytes(24).toString('hex');
    const server = http.createServer(async (req, res) => {
        const send = (status, type, body, extra = {}) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', ...extra }); res.end(body); };
        try {
            const addr = server.address();
            const host = String(req.headers.host || '');
            if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${addr.port}$`).test(host)) return send(421, 'text/plain', 'refused: the Host header is not this loopback server\n');
            const url = new URL(req.url, `http://${host}`);
            if (req.method === 'GET' && url.pathname === '/') return send(200, 'text/html; charset=utf-8', renderPage(collect(s), token, url.searchParams.get('msg')));
            if (req.method === 'GET' && url.pathname === '/rows.json') return send(200, 'application/json', JSON.stringify(collect(s), (k, v) => (k === 'record' ? undefined : v)));
            if (req.method === 'POST' && url.pathname === '/action') {
                const form = new URLSearchParams(await readBody(req));
                const fields = Object.fromEntries(form.entries());
                if (!tokenMatches(fields.token, token)) {
                    appendEvent(s, { action: fields.action || null, key: fields.key || null, ok: false, detail: 'refused: missing or wrong token' });
                    return send(403, 'text/plain', 'refused: missing or wrong token\n');
                }
                if (fields.action === 'answer' && fields.custom) fields.label = fields.custom;
                let msg;
                try {
                    const out = doAction(s, fields.action, fields.key, fields);
                    appendEvent(s, { action: fields.action, key: fields.key, source: out.row.source, code: out.row.code, ok: true, detail: out.detail });
                    msg = `${fields.action} ${out.row.code}: ${out.detail}`;
                } catch (e) {
                    appendEvent(s, { action: fields.action, key: fields.key, ok: false, code: e.publicCode || 'internal', detail: e.message });
                    msg = `${fields.action} refused (${e.publicCode || 'internal'}): ${e.message}`;
                }
                return send(303, 'text/plain', msg + '\n', { Location: `/?msg=${encodeURIComponent(msg)}` });
            }
            return send(404, 'text/plain', 'not found\n');
        } catch (e) {
            return send(e.status || 500, 'text/plain', `error: ${e.message}\n`);
        }
    });
    server.listen(port, '127.0.0.1', () => {
        process.stdout.write(`fleet-view listening on http://127.0.0.1:${server.address().port}/ (POST needs the page token, events go to ${s.events})\n`);
    });
    // A parent that owns the pipe ends the server by closing it, and the exit is
    // a normal one. A kill on Windows is TerminateProcess, so V8 writes no coverage
    // dump: the suite's kill left every request path reading as never called
    // (check:coverage 44 against a ceiling of 36, 2026-09-24). Opt-in, because a
    // server started with stdin ignored would see end-of-file at once and exit.
    if (untilStdinCloses) {
        const stop = () => { server.close(); server.closeAllConnections(); };
        process.stdin.on('end', stop);
        process.stdin.on('error', stop);
        process.stdin.resume();
    }
    return server;
}

// ---------------------------------------------------------------- selftest
function selftest() {
    const cases = [];
    const t = (name, ok) => cases.push({ name, ok: !!ok });
    const p = progressOf('- [x] a - done\n- [ ] b\n- [!] c needs a key\n\nSTATUS: blocked\n');
    t('progress keeps the last finished or blocked line', p.last === '- [!] c needs a key' && p.status === 'blocked');
    t('progress with no STATUS line reads null', progressOf('- [ ] a').status === null);
    t('the last PR link wins', lastPr('https://github.com/o/r/pull/1 then https://github.com/o/r/pull/22') === 'https://github.com/o/r/pull/22');
    t('esc neutralises markup', esc('<a href="x">\'&') === '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
    t('a relaunch code bumps and fits the code rule', nextCode('B-EB1', [{ code: 'B-EB1-R2' }]) === 'B-EB1-R3' && nextCode('B-EB1-R3', []) === 'B-EB1-R2');
    t('a long code is cut to fit', HW.CODE_RE.test(nextCode('A'.repeat(24), [])));
    t('the token check refuses a near miss', tokenMatches('abc', 'abc') && !tokenMatches('abd', 'abc') && !tokenMatches(undefined, 'abc'));
    const fakeCmd = (out) => () => ({ stdout: out, status: 0 });
    const want = { cwd: 'C:\\w t', code: 'B-X1' };
    t('win32 identity needs supervise, --code and --cwd', processMatches(1, want, 'win32', fakeCmd('node hw.js supervise --code B-X1 --log x --cwd "C:\\w t" --claude-bin c')).ok);
    t('win32 identity refuses another code', !processMatches(1, want, 'win32', fakeCmd('node hw.js supervise --code B-X10 --cwd "C:\\w t"')).ok);
    t('win32 identity refuses a missing process', !processMatches(1, want, 'win32', fakeCmd('')).ok);
    t('an unknown platform is never a match', !processMatches(1, want, 'aix', fakeCmd('x')).ok);
    const dcwd = path.resolve('fv-selftest-cwd');
    const dwant = { cwd: dcwd, code: 'B-X1' };
    t('darwin identity reads the lsof cwd', processMatches(1, dwant, 'darwin', fakeCmd(`p1\nfcwd\nn${dcwd}\n`)).ok);
    t('darwin identity refuses another cwd', !processMatches(1, dwant, 'darwin', fakeCmd(`p1\nn${dcwd}-other\n`)).ok);
    t('age reads minutes, hours and days', age(Date.now() - 5 * 60000) === '5m' && age(Date.now() - 3 * 3600000) === '3h' && age(Date.now() - 3 * 86400000) === '3d');
    const failed = cases.filter((c) => !c.ok).map((c) => c.name);
    if (failed.length) fault('selftest-failed', failed.join(' | '));
    return { selftest: 'pass', cases: cases.length };
}

function main(argv) {
    const opts = parseArgs(argv);
    if (opts.help) { process.stdout.write(USAGE); return; }
    if (opts.selftest) { process.stdout.write(JSON.stringify({ ok: true, value: selftest() }) + '\n'); return; }
    const cmd = opts._[0] || 'serve';
    const s = settings(opts);
    if (cmd === 'list') {
        const view = collect(s);
        process.stdout.write(opts.json ? JSON.stringify(view, (k, v) => (k === 'record' ? undefined : v)) + '\n' : listLines(view));
        return;
    }
    if (cmd === 'serve') {
        const port = opts.port === undefined ? DEFAULT_PORT : Number(opts.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) fault('usage', '--port must be 0-65535');
        serve(s, port, { untilStdinCloses: !!opts['until-stdin-closes'] });
        return;
    }
    fault('usage', `unknown command ${cmd}`);
}

if (require.main === module) {
    try { main(process.argv.slice(2)); } catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: { code: e.publicCode || 'internal', message: e.message } }) + '\n');
        process.exitCode = 1;
    }
}

module.exports = { parseArgs, settings, collect, doAction, processMatches, progressOf, lastPr, nextCode, renderPage, listLines, selftest, esc };
