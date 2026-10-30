#!/usr/bin/env node
'use strict';
/**
 * delivery-outcomes.js - join worker runs to what actually stood a week later.
 *
 * WHY. The harness counted a headless run as done when it settled succeeded or
 * a judge said accept, and a PR as done when it merged. Neither is delivery: a
 * task can take several attempts, a merged PR can be reverted or the issue it
 * closed reopened, a task can be abandoned, and one task can land through two
 * PRs. Nothing joined the run ledgers to that later truth, so first-attempt
 * acceptance and cost per accepted task could not be measured.
 *
 * WHAT IT READS.
 *   unattended-workers.json  one record per task: its latest attempt, run
 *                            status and verdict (a requeue replaces the record).
 *   headless-workers.json    one record per run: code, startedAt, result, exit,
 *                            log (stream-json; cost is the sum of its `result`
 *                            events' total_cost_usd) and report (PR URLs).
 *   brain-judge/judgements.jsonl and runs.jsonl
 *                            judge verdicts and judge cost for earlier attempts,
 *                            keyed `<taskId>@<worker startedAt>`.
 *   PR facts                 an injected reader: production asks `gh` with a
 *                            timeout, a suite passes --pr-facts <json>.
 *   desktop session records  the Claude desktop app's `claude-code-sessions`
 *                            directory, one `local_<id>.json` per session. A
 *                            session another session started carries
 *                            `spawnedFrom`, and every one carries `prs` with
 *                            the app's last-known state. This is the app's own
 *                            state, not a documented interface: an absent or
 *                            unreadable directory reads as no side sessions and
 *                            says so in the population, never as zero work.
 *
 * ATTRIBUTION. A task's attempts are the headless runs with its code. When two
 * tasks share a code, a run belongs to the earliest task whose latest attempt
 * started at or after it, and a run after every task's latest attempt matches
 * no task and is only counted in the population. An attribution stored once is
 * kept.
 *
 * SIDE SESSIONS. [measured 2026-10-28] since 10-15 the fleet's work runs in
 * desktop side sessions, which no worker ledger records. A spawned session
 * with at least one PR is one task `side:<session id>` with one attempt,
 * accepted when any PR merged, rejected when every PR closed unmerged. Its
 * standing check covers the merged PRs only. A recorded MERGED or CLOSED is
 * trusted, because neither was seen stale (418 and 105 PRs); every stale
 * state seen was OPEN, so an OPEN PR is asked of the PR facts reader. A
 * session with no PR is counted in the population, not as a task. A rework
 * started as a new session is not linked to the first, so for side sessions
 * first-attempt acceptance equals acceptance.
 *
 * SESSION COST. Desktop transcripts carry no total_cost_usd, so a side session,
 * or a desktop-channel worker whose record names its session, is priced from
 * its transcript: the session's `<cliSessionId>.jsonl` under the profile's
 * `projects` dir plus every transcript in the `<cliSessionId>/` dir beside it
 * (its subagents), one usage row per response (the last row of a response),
 * at quota-burn.js list prices. It is list price, not what a subscription
 * bills. A missing transcript, or one with no usage row, is null, never 0.
 * A priced session is kept beside the store as `outcomes.session-cost.json`
 * with the size and mtime of every file it read, and is read again only when
 * one changed. Pricing stops after 20 s per sync, like the PR facts, and an
 * unpriced attempt keeps the cost already stored.
 *
 * PR FACTS BUDGET. sync stops asking PR facts after 45 s so it fits the
 * observer's 90 s timeout, oldest task first, and keeps settled answers (a
 * closed PR, a merge older than the window) beside the store, as
 * `outcomes.pr-facts.json` for `outcomes.jsonl`, so a
 * backlog drains across runs instead of being re-asked.
 *
 * OUTCOME PER TASK.
 *   attempts               runs attributed to it.
 *   costUsd                worker cost of EVERY attempt, failed ones included,
 *                          plus judge cost. null when any attempt's cost cannot
 *                          be read: an undercount would flatter the number.
 *   firstAttemptAccepted   true on an accept verdict on attempt 1, false on a
 *                          non-accept verdict or a failed run, else null.
 *   accepted               true once any attempt is accepted; false only when
 *                          the latest attempt failed or got a non-accept verdict
 *                          and nothing was tried for 7 days (abandoned); else
 *                          null. A succeeded run that never got a verdict stays
 *                          null however old it is: unknown is never a failure.
 *   standingDay7           accepted, every PR the accepted attempt's report
 *                          names merged, and none reverted or its issue reopened
 *                          within 7 days of its merge. null while a window is
 *                          open or when a PR fact cannot be read.
 *
 * DURABILITY. `sync` appends attempt and outcome rows to a compact JSONL store,
 * `<config>/autodev/delivery/outcomes.jsonl` by default, only when a row
 * changed. It sits outside `reports/`, so seven-day scratch retention never
 * deletes it, and an attempt whose log was since removed keeps the cost read
 * while it existed. `report` reads only the store.
 *
 * KNOWN LIMITS. A revert pushed as a plain commit, without a PR whose body says
 * "Reverts <owner>/<repo>#<n>", is not seen. A task whose accepted report names
 * no PR has standingDay7 null.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const claudePaths = require('./claude-paths.js');
const { priceUsage, responseKey } = require('./quota-burn.js');
const { withLedgerLock, writeAtomic } = require('./ledger-lock.js');

const DAY_MS = 24 * 3600 * 1000;
const STAND_DAYS = 7;
const ABANDON_DAYS = 7;
const MATCH_SLACK_MS = 60 * 1000;
const GH_TIMEOUT_MS = 20 * 1000;
// [measured 2026-10-28] brain-clock runs the sync observer under a 90 s timeout, and a first sync
// over the side sessions asked 893 PRs in over ten minutes. 45 s plus one 20 s call fits.
const GH_BUDGET_MS = 45 * 1000;
// Transcript pricing shares the observer's 90 s with the PR facts: 45 + 20 + one 20 s gh call fits.
const COST_BUDGET_MS = 20 * 1000;
const PR_RE = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;
const STORE_VERSION = 1;

const USAGE = [
    'usage: node delivery-outcomes.js sync [--ledger <file>] [--headless-ledger <file>] [--judge-dir <dir>]',
    '                                      [--sessions-dir <dir>] [--projects-dir <dir>] [--store <file>] [--pr-facts <json>]',
    '                                      [--now <iso>] [--json]',
    '       node delivery-outcomes.js report [--store <file>] [--json]',
    '',
    'sync    read the worker, headless and judge ledgers and the desktop side sessions, ask PR facts (gh, or --pr-facts), and append',
    '        changed attempt and outcome rows to the store. Prints the counts and their population.',
    'report  print the counts from the store only, with their population. Writes nothing.',
    '',
    'Counts: tasks attempts first_attempt_accepted accepted standing_day7 unknown. unknown is a task with',
    'no decisive evidence (accepted null); it is never counted as a failure or a success.',
    `Default store: ${path.join('~', '.claude', 'autodev', 'delivery', 'outcomes.jsonl')} (outside reports/, so scratch retention keeps it)`,
    'Exit 0 done, 1 bad usage or internal error, 2 an input could not be read (no verdict).',
].join('\n') + '\n';

function fault(code, message) { const e = new Error(message || code); e.publicCode = code; throw e; }

const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };
const round = (n) => Math.round(n * 10000) / 10000;

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

/** Parsed JSON, null when absent, undefined when unparseable. */
function readJson(file) {
    const t = readText(file);
    if (t === null) return null;
    try { return JSON.parse(t); } catch { return undefined; }
}

/** Parsed JSONL rows and the count that would not parse; null when absent. */
function readJsonl(file) {
    const t = readText(file);
    if (t === null) return null;
    const rows = []; let bad = 0;
    for (const line of t.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { bad++; }
    }
    return { rows, bad };
}

function defaultPaths(env = process.env) {
    const autodev = path.join(claudePaths.configDir(env), 'autodev');
    return {
        ledger: path.join(autodev, 'unattended-workers.json'),
        headlessLedger: path.join(autodev, 'headless-workers.json'),
        judgeDir: path.join(autodev, 'brain-judge'),
        store: path.join(autodev, 'delivery', 'outcomes.jsonl'),
        sessionsDir: desktopSessionsDir(env),
        projectsDir: path.join(claudePaths.configDir(env), 'projects'),
    };
}

/** Where the Claude desktop app keeps its session records on this platform. */
function desktopSessionsDir(env = process.env, platform = process.platform) {
    const home = env.USERPROFILE || env.HOME || os.homedir();
    const base = platform === 'win32' ? env.APPDATA || path.join(home, 'AppData', 'Roaming')
        : platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
            : env.XDG_CONFIG_HOME || path.join(home, '.config');
    return path.join(base, 'Claude', 'claude-code-sessions');
}

/**
 * Every `local_<id>.json` session record up to three levels under dir.
 * { records, bad, state }; bad includes unreadable directories as well as files.
 * Partial traversal keeps readable siblings but never claims complete coverage.
 */
function readSessions(dir) {
    if (!dir) return { records: [], bad: 0, state: 'not asked' };
    const files = [];
    let bad = 0;
    let rootError = null;
    const walk = (d, depth) => {
        let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); }
        catch (e) { bad++; if (depth === 0) rootError = e; return false; }
        for (const e of ents) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); } else if (/^local_[0-9a-f-]+\.json$/i.test(e.name)) files.push(p);
        }
        return true;
    };
    if (!walk(dir, 0)) return { records: [], bad: rootError.code === 'ENOENT' ? 0 : bad,
        state: rootError.code === 'ENOENT' ? 'absent' : 'unreadable' };
    const incomplete = bad > 0;
    const records = [];
    for (const file of files.sort()) {
        const j = readJson(file);
        if (j && typeof j === 'object' && typeof j.sessionId === 'string') records.push(j); else bad++;
    }
    return { records, bad, state: incomplete ? 'partial' : 'read' };
}

const isoOf = (t) => { const n = typeof t === 'number' ? t : ms(t); return n === null || !Number.isFinite(n) ? null : new Date(n).toISOString(); };

/**
 * One attempt per spawned session with a PR. prFacts answers only for a PR the
 * app still shows OPEN; without it an OPEN PR leaves the attempt undecided. An
 * OPEN PR the stored attempt already holds as merged is not asked again: these
 * asks run on every sync, before any stored outcome is reused, and the app
 * leaves a merged PR OPEN for as long as nobody reopens the session.
 */
function sideAttempts(records, prFacts, stored = new Map(), costOf = () => null) {
    const out = []; let spawned = 0; let noPr = 0;
    const oldest = records.slice().sort((a, b) => (isoOf(a.createdAt) || '').localeCompare(isoOf(b.createdAt) || '')
        || String(a.sessionId).localeCompare(String(b.sessionId)));
    for (const r of oldest) {
        if (!r.spawnedFrom || typeof r.spawnedFrom !== 'object') continue;
        const startedAt = isoOf(r.createdAt);
        if (!startedAt) continue;
        spawned++;
        const prs = (Array.isArray(r.prs) ? r.prs : []).map((p) => (p && parsePrUrl(p.url) ? { url: p.url, state: p.state } : null)).filter(Boolean);
        if (!prs.length) { noPr++; continue; }
        const taskId = `side:${r.sessionId}`;
        const key = attemptKey(taskId, startedAt);
        const was = stored.get(key);
        const mergedBefore = new Set(was && was.decision === 'accept' && Array.isArray(was.prs) ? was.prs : []);
        for (const p of prs) {
            if (p.state !== 'OPEN') continue;
            if (mergedBefore.has(p.url)) { p.state = 'MERGED'; continue; }
            if (!prFacts) continue;
            const facts = prFacts(p.url);
            if (facts && facts.state) p.state = facts.state;
        }
        const merged = prs.filter((p) => p.state === 'MERGED').map((p) => p.url);
        const allClosed = prs.every((p) => p.state === 'CLOSED');
        out.push({ key, taskId, code: 'side', startedAt,
            runStatus: merged.length ? 'succeeded' : allClosed ? 'failed' : 'running',
            decision: merged.length ? 'accept' : null, decisionBy: merged.length ? 'merged' : null,
            costUsd: costOf(r), judgeCostUsd: 0, prs: merged.length ? merged : prs.map((p) => p.url) });
    }
    return { attempts: out, spawned, noPr };
}

/** Every `.jsonl` under dir, recursively, sorted. */
function jsonlUnder(dir) {
    const out = [];
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...jsonlUnder(p)); else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
    return out.sort();
}

/** List-price cost of transcript texts: the last usage row of each response, priced once. */
function transcriptCost(texts) {
    const last = new Map(); let n = 0;
    for (const text of texts) {
        for (const line of String(text).split('\n')) {
            if (!line.includes('"usage"')) continue;
            let j; try { j = JSON.parse(line); } catch { continue; }
            const m = j && j.message;
            if (!m || !m.usage) continue;
            last.set(responseKey(j) || `row${n++}`, { u: m.usage, model: m.model || null });
        }
    }
    if (!last.size) return null;
    let cost = 0;
    for (const { u, model } of last.values()) cost += priceUsage(u, model).cost;
    return { cost: round(cost), responses: last.size };
}

/**
 * A reader from a desktop session record to its list-price cost, or null. It finds the
 * transcript under projectsDir, reuses a cached price while every file it read is unchanged,
 * and stops reading after budgetMs. tally counts priced, reused, missing and skipped.
 */
function sessionCoster(projectsDir, cache, { budgetMs = COST_BUDGET_MS, clock = Date.now } = {}) {
    const tally = { priced: 0, reused: 0, missing: 0, skipped: 0 };
    let index = null;
    // Started on the first read, so a sync with nothing to price never reads the clock.
    let start = null;
    const find = (id) => {
        if (!index) {
            index = new Map();
            let slugs = []; try { slugs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { /* none */ }
            for (const s of slugs) {
                let names = []; try { names = fs.readdirSync(path.join(projectsDir, s.name)); } catch { continue; }
                for (const n of names) if (n.endsWith('.jsonl')) index.set(n.slice(0, -6), path.join(projectsDir, s.name, n));
            }
        }
        return index.get(id) || null;
    };
    const costOf = (rec) => {
        const id = rec && typeof rec.cliSessionId === 'string' && /^[0-9a-f-]{8,}$/i.test(rec.cliSessionId) ? rec.cliSessionId : null;
        if (!id || !projectsDir) return null;
        const main = find(id);
        if (!main) { tally.missing++; return null; }
        const files = [main, ...jsonlUnder(main.slice(0, -6))];
        let sig;
        try { sig = files.map((f) => { const st = fs.statSync(f); return `${st.size}:${Math.floor(st.mtimeMs)}`; }).join(','); } catch { tally.missing++; return null; }
        const hit = cache[id];
        if (hit && hit.sig === sig && Number.isFinite(hit.cost)) { tally.reused++; return hit.cost; }
        if (start === null) start = clock();
        else if (clock() - start >= budgetMs) { tally.skipped++; return null; }
        const texts = [];
        for (const f of files) { try { texts.push(fs.readFileSync(f, 'utf8')); } catch { tally.missing++; return null; } }
        const priced = transcriptCost(texts);
        if (!priced) { tally.missing++; return null; }
        cache[id] = { sig, cost: priced.cost, responses: priced.responses };
        tally.priced++;
        return priced.cost;
    };
    return { costOf, tally };
}

/** Sum of total_cost_usd over every stream-json `result` event (a resumed run has one per process); null when none. */
function logCost(text) {
    if (typeof text !== 'string') return null;
    let sum = 0; let seen = false;
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('{') || !line.includes('"type":"result"')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j && j.type === 'result' && typeof j.total_cost_usd === 'number') { sum += j.total_cost_usd; seen = true; }
    }
    return seen ? round(sum) : null;
}

/** Distinct PR URLs in a report, in order of first mention. */
function prRefs(text) {
    const out = [];
    for (const m of String(text || '').matchAll(PR_RE)) {
        const url = `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`;
        if (!out.includes(url)) out.push(url);
    }
    return out;
}

function parsePrUrl(url) {
    const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)$/.exec(String(url || ''));
    return m ? { owner: m[1], name: m[2], number: Number(m[3]), url } : null;
}

/** The run status headless-worker settles to: succeeded only on exit 0 with a done or stopped report. */
function runStatusOf(run) {
    if (run.state !== 'settled') return 'running';
    return run.exit === 0 && (run.result === 'done' || run.result === 'stopped') ? 'succeeded' : 'failed';
}

const startOfKey = (key) => { const i = String(key || '').lastIndexOf('@'); return i < 0 ? null : String(key).slice(i + 1); };

// ---------------------------------------------------------------- sources

/** Every input, resolved and read. The worker ledger is required; the others may be absent. */
function readSources({ ledger, headlessLedger, judgeDir, sessionsDir }) {
    const w = readJson(ledger);
    if (w === null) fault('unreadable', `${ledger} does not exist`);
    if (!w || !Array.isArray(w.records)) fault('unreadable', `${ledger}: no records array`);
    const h = readJson(headlessLedger);
    if (h === undefined || (h && !Array.isArray(h.records))) fault('unreadable', `${headlessLedger}: not a ledger`);
    const base = path.dirname(path.resolve(headlessLedger));
    const at = (p) => (p ? path.resolve(base, p) : null);
    const runs = (h ? h.records : []).map((r) => ({ ...r, log: at(r.log), report: at(r.report) }));
    const judgements = readJsonl(path.join(judgeDir, 'judgements.jsonl'));
    const judgeRuns = readJsonl(path.join(judgeDir, 'runs.jsonl'));
    const sessions = readSessions(sessionsDir);
    return {
        tasks: w.records, runs, sessions,
        judgements: judgements ? judgements.rows : [], judgeRuns: judgeRuns ? judgeRuns.rows : [],
        files: { ledger, headlessLedger: h ? headlessLedger : null, judgements: judgements ? 'read' : 'absent', judgeRuns: judgeRuns ? 'read' : 'absent', sessions: sessions.state },
    };
}

const codeOf = (rec) => (rec.headless && rec.headless.code) || rec.slug || rec.taskId;
const attemptKey = (code, startedAt) => `${code}@${startedAt}`;

/**
 * Attempts per task, from the live ledgers merged over the stored ones.
 * Returns { byTask: Map taskId -> attempts sorted by start, unmatched, notStarted, side }.
 */
function buildAttempts(src, stored = new Map(), { prFacts = null, costOf = () => null } = {}) {
    const started = src.tasks.filter((r) => r.taskId && r.startedAt);
    const notStarted = src.tasks.length - started.length;
    const latestOf = new Map();
    for (const rec of started) {
        const code = codeOf(rec);
        let latest = rec.headless && rec.headless.startedAt;
        if (!latest) {
            const launched = ms(rec.launchedAt || rec.startedAt);
            const run = src.runs.filter((r) => r.code === code && ms(r.startedAt) !== null && launched !== null && ms(r.startedAt) >= launched - MATCH_SLACK_MS).pop();
            latest = run ? run.startedAt : null;
        }
        latestOf.set(rec.taskId, latest);
    }
    const storedOwner = new Map([...stored.values()].map((a) => [a.key, a.taskId]));
    const live = new Map();
    let unmatched = 0;
    for (const run of src.runs) {
        const key = attemptKey(run.code, run.startedAt);
        let owner = storedOwner.get(key);
        if (!owner) {
            const t = ms(run.startedAt);
            const candidates = started.filter((rec) => codeOf(rec) === run.code && latestOf.get(rec.taskId))
                .sort((a, b) => ms(latestOf.get(a.taskId)) - ms(latestOf.get(b.taskId)));
            const hit = t === null ? null : candidates.find((rec) => t <= ms(latestOf.get(rec.taskId)) + MATCH_SLACK_MS);
            owner = hit ? hit.taskId : null;
        }
        if (!owner) { unmatched++; continue; }
        live.set(key, {
            key, taskId: owner, code: run.code, startedAt: run.startedAt, runStatus: runStatusOf(run),
            decision: null, decisionBy: null, costUsd: logCost(readText(run.log)), judgeCostUsd: 0, prs: prRefs(readText(run.report)),
        });
    }
    // A started task with no headless run (a desktop-channel worker) is one attempt, priced from
    // its session's transcript when the record names a session the desktop app still holds.
    const sessionById = new Map(((src.sessions && src.sessions.records) || []).map((r) => [r.sessionId, r]));
    for (const rec of started) {
        const key = attemptKey(codeOf(rec), rec.startedAt);
        // Its own stored attempt (the same key) is priced again; the stored fill below keeps the
        // stored cost when this read returns null. A stored attempt under another key is a run.
        if ([...live.values()].some((a) => a.taskId === rec.taskId) || [...stored.values()].some((a) => a.taskId === rec.taskId && a.key !== key)) continue;
        live.set(key, { key, taskId: rec.taskId, code: codeOf(rec), startedAt: rec.startedAt, runStatus: rec.runStatus || 'running',
            decision: null, decisionBy: null, costUsd: rec.sessionId && sessionById.has(rec.sessionId) ? costOf(sessionById.get(rec.sessionId)) : null,
            judgeCostUsd: 0, prs: prRefs(readText(rec.report)) });
        latestOf.set(rec.taskId, rec.startedAt);
    }
    const byTask = new Map();
    for (const a of live.values()) { if (!byTask.has(a.taskId)) byTask.set(a.taskId, []); byTask.get(a.taskId).push(a); }
    // A session a ledger record names is that worker's task, so it is not a side task as well.
    const registered = new Set(src.tasks.map((r) => r && r.sessionId).filter((id) => typeof id === 'string'));
    const side = sideAttempts(((src.sessions && src.sessions.records) || []).filter((r) => !registered.has(r.sessionId)), prFacts, stored, costOf);
    for (const a of side.attempts) { live.set(a.key, a); byTask.set(a.taskId, [a]); }
    // The attempt a `<taskId>@<worker startedAt>` key names: the first one started at or after that launch.
    const attemptFor = (taskId, key) => {
        const t = ms(startOfKey(key));
        const list = (byTask.get(taskId) || []).slice().sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
        return t === null ? null : list.find((a) => ms(a.startedAt) >= t - MATCH_SLACK_MS) || null;
    };
    for (const j of src.judgements.slice().sort((a, b) => (ms(a.at) || 0) - (ms(b.at) || 0))) {
        if (j.applied !== true || !j.decision) continue;
        const a = attemptFor(j.taskId, j.key);
        if (a) { a.decision = j.decision; a.decisionBy = 'judge'; }
    }
    for (const r of src.judgeRuns) {
        const a = typeof r.costUsd === 'number' ? attemptFor(r.taskId, r.key) : null;
        if (a) a.judgeCostUsd = round(a.judgeCostUsd + r.costUsd);
    }
    // The ledger record speaks for its latest attempt, and its verdict wins over a judge row.
    for (const rec of started) {
        const a = live.get(attemptKey(codeOf(rec), latestOf.get(rec.taskId)));
        if (!a || a.taskId !== rec.taskId) continue;
        if (rec.runStatus) a.runStatus = rec.runStatus;
        if (rec.verdict && rec.verdict.decision) { a.decision = rec.verdict.decision; a.decisionBy = rec.verdict.by || null; }
    }
    // Stored attempts fill what the live ledgers lost (a pruned run, a removed log, a replaced verdict).
    for (const s of stored.values()) {
        // A store written before registered sessions were excluded holds them as side tasks too.
        if (typeof s.taskId === 'string' && s.taskId.startsWith('side:') && registered.has(s.taskId.slice(5))) continue;
        const a = live.get(s.key);
        if (!a) {
            if (!byTask.has(s.taskId)) byTask.set(s.taskId, []);
            byTask.get(s.taskId).push(attemptFields(s));
            continue;
        }
        for (const k of ['costUsd', 'decision', 'decisionBy']) if (a[k] === null && s[k] !== null && s[k] !== undefined) a[k] = s[k];
        if (!a.prs.length && Array.isArray(s.prs)) a.prs = s.prs;
        if (!a.judgeCostUsd && typeof s.judgeCostUsd === 'number') a.judgeCostUsd = s.judgeCostUsd;
    }
    for (const list of byTask.values()) list.sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
    return { byTask, unmatched, notStarted, side: { spawned: side.spawned, noPr: side.noPr, tasks: side.attempts.length } };
}

function attemptFields(a) {
    return { key: a.key, taskId: a.taskId, code: a.code, startedAt: a.startedAt, runStatus: a.runStatus, decision: a.decision ?? null,
        decisionBy: a.decisionBy ?? null, costUsd: a.costUsd ?? null, judgeCostUsd: a.judgeCostUsd || 0, prs: Array.isArray(a.prs) ? a.prs : [] };
}

// ---------------------------------------------------------------- outcome

/** 'accept', 'reject' (a non-accept verdict or a failed run), or null (running, or no verdict yet). */
function decisive(a) {
    if (a.decision === 'accept') return 'accept';
    if (a.decision === 'follow-up' || a.decision === 'escalate') return 'reject';
    if (a.runStatus === 'failed') return 'reject';
    return null;
}

/** Whether the PRs of an accepted attempt stood for 7 days after each merge: { value, reason }. */
function standing(prs, acceptedAt, now, prFacts) {
    if (!prs.length) return { value: null, reason: 'the accepted attempt names no PR' };
    const facts = [];
    for (const url of prs) {
        const f = prFacts(url);
        if (!f) return { value: null, reason: `PR facts unreadable for ${url}` };
        facts.push({ url, ...f });
    }
    for (const f of facts) {
        const merged = ms(f.mergedAt);
        if (f.state !== 'MERGED' || merged === null) continue;
        for (const [what, at] of [['reverted', f.revertedAt], ['issue reopened', f.reopenedAt]]) {
            const t = ms(at);
            if (t !== null && t >= merged && t <= merged + STAND_DAYS * DAY_MS) {
                return { value: false, reason: `${f.url} ${what} ${round((t - merged) / DAY_MS)} day(s) after merge` };
            }
        }
    }
    const open = facts.filter((f) => f.state !== 'MERGED' || ms(f.mergedAt) === null);
    if (open.length) {
        return now - (ms(acceptedAt) || now) >= STAND_DAYS * DAY_MS
            ? { value: false, reason: `${open[0].url} is ${open[0].state || 'not merged'} ${STAND_DAYS}+ days after acceptance` }
            : { value: null, reason: `${open[0].url} not merged yet` };
    }
    const pending = facts.filter((f) => now < ms(f.mergedAt) + STAND_DAYS * DAY_MS);
    if (pending.length) return { value: null, reason: `${pending[0].url} merged under ${STAND_DAYS} days ago` };
    return { value: true, reason: `${facts.length} PR(s) merged and clean for ${STAND_DAYS} days` };
}

/**
 * The earliest non-accept worker attempt whose PRs merged: { attempt, prs },
 * { unreadable: url }, or {}. A side session already reads its own merges.
 */
function mergedPrs(attempts, prFacts) {
    for (const a of attempts) {
        if (a.code === 'side') continue;
        const prs = [];
        for (const url of a.prs || []) {
            const f = prFacts(url);
            if (!f) return { unreadable: url };
            if (f.state === 'MERGED' && ms(f.mergedAt) !== null) prs.push(url);
        }
        if (prs.length) return { attempt: a, prs };
    }
    return {};
}

/** One task's outcome from its attempts. */
function computeOutcome(taskId, attempts, { now, prFacts }) {
    const costs = attempts.map((a) => (typeof a.costUsd === 'number' ? a.costUsd + (a.judgeCostUsd || 0) : null));
    const costUsd = costs.includes(null) ? null : round(costs.reduce((s, c) => s + c, 0));
    const first = attempts.length ? decisive(attempts[0]) : null;
    const out = {
        taskId, attempts: attempts.length, costUsd,
        firstAttemptAccepted: first === 'accept' ? true : first === 'reject' ? false : null,
        accepted: null, standingDay7: null, status: 'unknown', reason: '', prs: [],
        lastAttemptAt: attempts.length ? attempts[attempts.length - 1].startedAt : null,
    };
    const acc = attempts.find((a) => a.decision === 'accept');
    if (acc) {
        out.accepted = true;
        out.prs = acc.prs;
        const s = standing(acc.prs, acc.startedAt, now, prFacts);
        out.standingDay7 = s.value;
        out.status = s.value === true ? 'standing' : s.value === false ? 'not-standing' : 'accepted-day7-unknown';
        out.reason = s.reason;
        return out;
    }
    // `[measured 2026-10-30]` 4 judge accepts were written as follow-up for a
    // missing receipt and then merged, and outcomes read only the accept's PRs,
    // so delivered work counted as abandoned. A merged PR from any attempt
    // delivered the task, as it does for a side session.
    const landed = mergedPrs(attempts, prFacts);
    if (landed.unreadable) {
        out.reason = `PR facts unreadable for ${landed.unreadable}`;
        return out;
    }
    if (landed.attempt) {
        const s = standing(landed.prs, landed.attempt.startedAt, now, prFacts);
        Object.assign(out, { accepted: true, prs: landed.prs, standingDay7: s.value,
            status: s.value === true ? 'standing' : s.value === false ? 'not-standing' : 'accepted-day7-unknown',
            reason: `merged after a ${landed.attempt.decision || landed.attempt.runStatus || 'missing'} verdict: ${s.reason}` });
        return out;
    }
    const last = attempts[attempts.length - 1];
    const quietFor = last ? now - (ms(last.startedAt) || now) : 0;
    if (last && decisive(last) === 'reject' && quietFor >= ABANDON_DAYS * DAY_MS) {
        Object.assign(out, { accepted: false, standingDay7: false, status: 'abandoned',
            reason: `latest attempt ${last.decision || last.runStatus}, nothing tried for ${Math.floor(quietFor / DAY_MS)} day(s)` });
        return out;
    }
    out.reason = !last ? 'no attempt' : decisive(last) === 'reject' ? `latest attempt ${last.decision || last.runStatus} under ${ABANDON_DAYS} days ago`
        : `latest attempt ${last.runStatus} with no verdict`;
    return out;
}

function computeAll(byTask, opts) {
    return [...byTask.keys()].sort().map((id) => computeOutcome(id, byTask.get(id), opts));
}

function counts(outcomes) {
    return {
        tasks: outcomes.length,
        attempts: outcomes.reduce((s, o) => s + o.attempts, 0),
        first_attempt_accepted: outcomes.filter((o) => o.firstAttemptAccepted === true).length,
        accepted: outcomes.filter((o) => o.accepted === true).length,
        standing_day7: outcomes.filter((o) => o.standingDay7 === true).length,
        unknown: outcomes.filter((o) => o.accepted === null).length,
    };
}

function summaryLine(c) {
    return `tasks=${c.tasks} attempts=${c.attempts} first_attempt_accepted=${c.first_attempt_accepted} accepted=${c.accepted} standing_day7=${c.standing_day7} unknown=${c.unknown}`;
}

/** The lines a reader needs beside the counts: what was decided, and the cost per accepted task with its population. */
function detailLines(outcomes) {
    const c = counts(outcomes);
    const decided = outcomes.filter((o) => o.accepted !== null);
    const pending = outcomes.filter((o) => o.accepted === true && o.standingDay7 === null).length;
    const costed = decided.filter((o) => o.costUsd !== null);
    const total = round(costed.reduce((s, o) => s + o.costUsd, 0));
    const acc = costed.filter((o) => o.accepted).length;
    return [
        `decided: ${decided.length} of ${c.tasks} task(s); first-attempt acceptance ${c.first_attempt_accepted} of ${decided.length}; `
            + `standing_day7 ${c.standing_day7} of ${c.accepted} accepted (${pending} not yet known)`,
        `cost: $${total.toFixed(2)} over ${costed.length} decided task(s) with every attempt's cost read, `
            + `${acc ? `$${(total / acc).toFixed(2)} per accepted task (${acc} accepted)` : 'no accepted task to divide by'}; `
            + `${decided.length - costed.length} decided task(s) with an unread cost left out`,
    ];
}

// ---------------------------------------------------------------- PR facts

/** A reader over a JSON map of PR URL -> { state, mergedAt, revertedAt, reopenedAt }. */
function fileFacts(file) {
    const j = readJson(file);
    if (!j || typeof j !== 'object') fault('unreadable', `${file}: no PR facts`);
    return (url) => (j[url] && typeof j[url] === 'object' ? j[url] : null);
}

const GH_QUERY = 'query($owner:String!,$name:String!,$number:Int!,$q:String!){'
    + 'repository(owner:$owner,name:$name){pullRequest(number:$number){state mergedAt '
    + 'closingIssuesReferences(first:10){nodes{timelineItems(itemTypes:[REOPENED_EVENT],first:10){nodes{... on ReopenedEvent{createdAt}}}}}}}'
    + 'search(query:$q,type:ISSUE,first:10){nodes{... on PullRequest{mergedAt}}}}';

/** PR facts from gh, or null on any failure or timeout. `run` is injectable for a suite. */
function ghPrFacts(url, { run = spawnSync, timeoutMs = GH_TIMEOUT_MS } = {}) {
    const ref = parsePrUrl(url);
    if (!ref) return null;
    const q = `repo:${ref.owner}/${ref.name} is:pr is:merged "Reverts ${ref.owner}/${ref.name}#${ref.number}" in:body`;
    const r = run('gh', ['api', 'graphql', '-f', `query=${GH_QUERY}`, '-f', `owner=${ref.owner}`, '-f', `name=${ref.name}`,
        '-F', `number=${ref.number}`, '-f', `q=${q}`], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    if (!r || r.error || r.status !== 0) return null;
    let doc; try { doc = JSON.parse(r.stdout); } catch { return null; }
    const pr = doc && doc.data && doc.data.repository && doc.data.repository.pullRequest;
    if (!pr) return null;
    const merged = ms(pr.mergedAt);
    const after = (ts) => ts.filter((t) => t !== null && (merged === null || t >= merged)).sort((a, b) => a - b);
    const reverts = after(((doc.data.search && doc.data.search.nodes) || []).map((n) => ms(n && n.mergedAt)));
    const reopens = after(((pr.closingIssuesReferences && pr.closingIssuesReferences.nodes) || [])
        .flatMap((i) => ((i.timelineItems && i.timelineItems.nodes) || []).map((e) => ms(e && e.createdAt))));
    const iso = (t) => (t === undefined ? null : new Date(t).toISOString());
    return { state: pr.state, mergedAt: pr.mergedAt || null, revertedAt: iso(reverts[0]), reopenedAt: iso(reopens[0]) };
}

/**
 * A reader that stops asking once budgetMs has passed and answers null, which leaves the
 * outcome unread and not final, so the next sync asks again. tally counts both.
 */
function budgeted(reader, budgetMs, clock = Date.now) {
    const start = clock(); const tally = { asked: 0, skipped: 0 };
    const read = (url) => {
        if (clock() - start >= budgetMs) { tally.skipped++; return null; }
        tally.asked++; return reader(url);
    };
    return { read, tally };
}

function memo(reader) {
    const cache = new Map();
    return (url) => { if (!cache.has(url)) cache.set(url, reader(url)); return cache.get(url); };
}

// ---------------------------------------------------------------- store

/** Latest attempt row per key and outcome row per task; null when the store is absent. */
function readStore(file) {
    const j = readJsonl(file);
    if (!j) return null;
    const attempts = new Map(); const outcomes = new Map(); let lastAt = null;
    for (const r of j.rows) {
        if (r.type === 'attempt' && r.key) attempts.set(r.key, r);
        if (r.type === 'outcome' && r.taskId) { outcomes.set(r.taskId, r); lastAt = r.at || lastAt; }
    }
    return { attempts, outcomes, rows: j.rows.length, bad: j.bad, lastAt };
}

const strip = (row) => { const { at, v, type, ...rest } = row; return JSON.stringify(rest); };

/** A stored outcome that later evidence cannot change for the same attempts, so its PRs need no new query. */
const isFinal = (o) => o.accepted === false || (o.accepted === true && o.standingDay7 !== null);

function sync(opts) {
    const p = { ...defaultPaths(opts.env), ...opts.paths };
    const now = opts.now ?? Date.now();
    const src = readSources(p);
    const store = readStore(p.store);
    const before = store || { attempts: new Map(), outcomes: new Map() };
    const budget = budgeted(opts.prFacts || ((url) => ghPrFacts(url)), opts.budgetMs ?? GH_BUDGET_MS, opts.clock);
    // [measured 2026-10-28] without this a budgeted sync stalled: 22 PRs the app shows OPEN
    // were CLOSED and re-asked every run, and a task holding more PRs than one budget reads
    // never became final. A closed PR, or a merge older than the window, cannot change the
    // day-7 answer, so it is kept beside the store and never asked twice. A closed PR that is
    // later reopened and merged is missed; none has been seen.
    const cacheFile = p.store.replace(/\.jsonl$/, '') + '.pr-facts.json';
    const cache = readJson(cacheFile) || {};
    const settled = (f) => !!f && (f.state === 'CLOSED'
        || (f.state === 'MERGED' && ms(f.mergedAt) !== null && now - ms(f.mergedAt) > STAND_DAYS * DAY_MS));
    let hits = 0; let kept = 0;
    const prFacts = memo((url) => {
        if (cache[url] && typeof cache[url] === 'object') { hits++; return cache[url]; }
        const f = budget.read(url);
        if (settled(f)) { cache[url] = f; kept++; }
        return f;
    });
    const costFile = p.store.replace(/\.jsonl$/, '') + '.session-cost.json';
    const costCache = readJson(costFile) || {};
    const coster = sessionCoster(p.projectsDir, costCache, { budgetMs: opts.costBudgetMs ?? COST_BUDGET_MS, clock: opts.clock });
    // Building attempts must not consume the query budget before ordering them.
    const { byTask, unmatched, notStarted, side } = buildAttempts(src, before.attempts, { costOf: coster.costOf });
    const sideRecords = new Map(src.sessions.records.map((r) => [`side:${r.sessionId}`, r]));
    // Oldest first, so a budget cut leaves the newest unread and the backlog drains across runs.
    const first = (id) => byTask.get(id)[0].startedAt || '';
    const oldest = [...byTask.keys()].sort((a, b) => (first(a) < first(b) ? -1 : first(a) > first(b) ? 1 : a < b ? -1 : 1));
    const computed = new Map(oldest.map((id) => {
        const skippedBefore = budget.tally.skipped;
        const record = sideRecords.get(id);
        if (record) {
            const refreshed = sideAttempts([record], prFacts, before.attempts).attempts[0];
            if (refreshed) {
                const a = byTask.get(id)[0];
                for (const k of ['runStatus', 'decision', 'decisionBy', 'prs']) a[k] = refreshed[k];
            }
        }
        const prev = before.outcomes.get(id);
        const fresh = computeOutcome(id, byTask.get(id), { now, prFacts: () => null });
        // Reuse a final stored outcome when the attempts are unchanged; otherwise ask the PR facts.
        if (prev && isFinal(prev) && prev.attempts === fresh.attempts && prev.accepted === fresh.accepted && prev.costUsd === fresh.costUsd) {
            const { at, v, type, ...o } = prev;
            return [id, o];
        }
        const o = computeOutcome(id, byTask.get(id), { now, prFacts });
        // A read the budget skipped says nothing new: keep the last stored outcome rather than
        // append a row that only swaps its reason for "unreadable" until the next run.
        if (budget.tally.skipped > skippedBefore && prev && prev.attempts === fresh.attempts) {
            const { at, v, type, ...kept } = prev;
            return [id, kept];
        }
        return [id, o];
    }));
    const outcomes = [...byTask.keys()].sort().map((id) => computed.get(id));
    const at = new Date(now).toISOString();
    const rows = [];
    for (const list of byTask.values()) for (const a of list) {
        const row = { v: STORE_VERSION, type: 'attempt', at, ...attemptFields(a) };
        const prev = before.attempts.get(a.key);
        if (!prev || strip(prev) !== strip(row)) rows.push(row);
    }
    for (const o of outcomes) {
        const row = { v: STORE_VERSION, type: 'outcome', at, ...o };
        const prev = before.outcomes.get(o.taskId);
        if (!prev || strip(prev) !== strip(row)) rows.push(row);
    }
    if (rows.length && !opts.dryRun) {
        fs.mkdirSync(path.dirname(p.store), { recursive: true });
        fs.appendFileSync(p.store, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
    if (kept && !opts.dryRun) {
        // Collect remote facts outside the lock; re-read and merge inside it so
        // another sync's newly settled facts cannot be overwritten by our snapshot.
        withLedgerLock(cacheFile, () => {
            const latest = readJson(cacheFile) || {};
            writeAtomic(cacheFile, JSON.stringify({ ...latest, ...cache }));
        });
    }
    if (coster.tally.priced && !opts.dryRun) {
        fs.mkdirSync(path.dirname(costFile), { recursive: true });
        fs.writeFileSync(costFile + '.tmp', JSON.stringify(costCache));
        fs.renameSync(costFile + '.tmp', costFile);
    }
    const c = counts(outcomes);
    const population = `population: ${c.tasks} task(s) with an attempt from ${p.ledger} (${src.tasks.length} record(s), ${notStarted} not started); `
        + `${src.runs.length} headless run(s), ${src.runs.length - unmatched} matched a task, ${unmatched} matched none; `
        + `${src.judgements.length} judgement(s), ${src.judgeRuns.length} judge run(s); `
        + `side sessions ${src.files.sessions}${['read', 'partial', 'unreadable'].includes(src.sessions.state)
            ? `: ${src.sessions.records.length} record(s), ${src.sessions.bad} unreadable, ${side.spawned} spawned, ${side.tasks} with a PR, ${side.noPr} with none` : ''}; `
        + `PR facts: ${hits} settled from ${path.basename(cacheFile)}, ${budget.tally.asked} asked${budget.tally.skipped ? `, ${budget.tally.skipped} left unread after the ${(opts.budgetMs ?? GH_BUDGET_MS) / 1000} s budget` : ''}; `
        + `session cost: ${coster.tally.priced} priced, ${coster.tally.reused} reused from ${path.basename(costFile)}, ${coster.tally.missing} with no transcript${coster.tally.skipped ? `, ${coster.tally.skipped} left unpriced after the ${(opts.costBudgetMs ?? COST_BUDGET_MS) / 1000} s budget` : ''}; `
        + `store ${p.store}: ${rows.length} row(s) appended`;
    return { counts: c, summary: summaryLine(c), population, details: detailLines(outcomes), outcomes, appended: rows.length, store: p.store };
}

function report(opts) {
    const file = (opts.paths && opts.paths.store) || defaultPaths(opts.env).store;
    const store = readStore(file);
    if (!store) fault('unreadable', `COULD NOT READ ${file}: it does not exist (run sync first)`);
    const outcomes = [...store.outcomes.values()].map(({ at, v, type, ...o }) => o).sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
    const c = counts(outcomes);
    const population = `population: ${c.tasks} task outcome(s), ${c.attempts} attempt(s) in ${file} `
        + `(${store.rows} row(s), ${store.bad} unparseable, last computed ${store.lastAt || 'never'})`;
    return { counts: c, summary: summaryLine(c), population, details: detailLines(outcomes), outcomes, store: file };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
    const out = { _: [] };
    const valued = new Set(['ledger', 'headless-ledger', 'judge-dir', 'sessions-dir', 'projects-dir', 'store', 'pr-facts', 'now']);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') { out.help = true; continue; }
        if (a === '--json') { out.json = true; continue; }
        if (a.startsWith('--')) {
            const key = a.slice(2);
            if (!valued.has(key)) fault('usage', `unknown flag ${a}`);
            const value = argv[++i];
            if (value === undefined || value === '') fault('usage', `${a} needs a value`);
            out[key] = value;
            continue;
        }
        out._.push(a);
    }
    return out;
}

function main(argv) {
    const o = parseArgs(argv);
    if (o.help || !o._.length) { process.stdout.write(USAGE); return 0; }
    const cmd = o._[0];
    const paths = {};
    if (o.ledger) paths.ledger = path.resolve(o.ledger);
    if (o['headless-ledger']) paths.headlessLedger = path.resolve(o['headless-ledger']);
    if (o['judge-dir']) paths.judgeDir = path.resolve(o['judge-dir']);
    if (o['sessions-dir']) paths.sessionsDir = path.resolve(o['sessions-dir']);
    if (o['projects-dir']) paths.projectsDir = path.resolve(o['projects-dir']);
    if (o.store) paths.store = path.resolve(o.store);
    let res;
    if (cmd === 'sync') {
        let now;
        if (o.now !== undefined) { now = ms(o.now); if (now === null) fault('usage', '--now must be an ISO time'); }
        res = sync({ paths, now, prFacts: o['pr-facts'] ? fileFacts(path.resolve(o['pr-facts'])) : null });
    } else if (cmd === 'report') {
        res = report({ paths });
    } else fault('usage', `unknown command ${cmd}`);
    process.stdout.write(o.json ? JSON.stringify({ ok: true, ...res }) + '\n' : [res.population, res.summary, ...res.details].join('\n') + '\n');
    return 0;
}

if (require.main === module) {
    try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
        const code = e.publicCode || 'internal';
        process.stdout.write(JSON.stringify({ ok: false, error: { code, message: e.message } }) + '\n');
        process.exitCode = code === 'unreadable' ? 2 : 1;
    }
}

module.exports = {
    logCost, prRefs, parsePrUrl, runStatusOf, readSources, buildAttempts, decisive, standing, computeOutcome, computeAll,
    counts, summaryLine, detailLines, fileFacts, ghPrFacts, readStore, sync, report, parseArgs, main, defaultPaths,
    desktopSessionsDir, readSessions, sideAttempts, budgeted, transcriptCost, sessionCoster,
    STAND_DAYS, ABANDON_DAYS,
};
