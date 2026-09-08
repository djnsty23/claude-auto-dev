#!/usr/bin/env node
'use strict';
/**
 * workflow-run-triage.js - which agents of a Workflow run were lost, to what,
 * and the exact call that gets them back.
 *
 * WHY THIS EXISTS. `[measured 2026-08-25]` 42 of 280 workflow agents on one
 * machine ran and left no journal result: 20,680 agent-seconds, 1,119 tool
 * calls and 12 MB of transcript that never reached a main thread. 20 of the 42
 * carry a `"model":"<synthetic>"` row reading "You've hit your session limit",
 * and 0 of those 20 journaled. The wall lands on whatever is in flight, so a
 * 6-wide phase lost 6 agents to one wall where a serial chain loses 1.
 *
 * The harness already has the recovery: `Workflow({scriptPath, resumeFromRunId})`
 * re-runs only the agent() calls whose key has no `result` row in
 * `journal.jsonl` and returns the rest from cache. `[measured 2026-09-08]` on
 * the one real resume on this disk that is exactly what it did: 4 lost keys
 * re-ran, 0 cached keys re-ran. What the harness does NOT do is tell anyone
 * afterwards. The failure notification names the command at the instant the
 * main thread is walled too, and after the reset the model works from memory:
 * the session that resumed wrote "nothing cached ... clean start" while
 * launching a resume that cached nothing only because nothing had finished.
 *
 * This script reads a run directory and answers, per agent: journaled,
 * lost-quota-wall, lost-interrupted, lost-api-error or lost-other, with what
 * each cost, and prints the resume call. It is the detection half.
 * stop-workflow-wall-note.js is the hook half and calls triageRun() from here,
 * so there is one reading of a run directory and not two that disagree.
 *
 * WHERE RUNS LIVE. `<claude-home>/projects/<slug>/<session>/subagents/workflows/wf_*`
 * holding `journal.jsonl` ({type:"started"|"result", key, agentId, result}) and
 * one `agent-<id>.jsonl` transcript per agent. The script the run executed is
 * at `<claude-home>/projects/<slug>/<session>/workflows/scripts/<name>-<wf_id>.js`.
 * A `started` row with no `result` row for the same key is the lost call.
 *
 * READ-ONLY. Nothing here writes into a run directory, ever.
 *
 * COULD NOT CHECK, NEVER ZERO. A directory this cannot read is reported as
 * such, on its own line, and is never counted as "0 lost". A zero is a claim
 * about the probe, and the evidence document this stands on has that as its
 * first rule.
 *
 * Usage:
 *   node workflow-run-triage.js <wf_id | run-directory>
 *   node workflow-run-triage.js --latest                 newest run on this machine
 *   node workflow-run-triage.js --all-since 2026-08-25   every run whose agents ran on/after that date
 *   node workflow-run-triage.js --all
 *   options: --json   --projects <dir>   (default <claude-home>/projects; $AUTODEV_CLAUDE_PROJECTS overrides)
 *
 * Exit: 0 nothing lost, 1 at least one agent lost, 2 nothing could be checked.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SYNTHETIC_NEEDLE = '"model":"<synthetic>"';
const INTERRUPT_NEEDLE = '[Request interrupted by user';
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const IN_FLIGHT_MS = 5 * 60 * 1000;

/** Where the per-project session directories live. */
function projectsDir(env = process.env) {
    if (env.AUTODEV_CLAUDE_PROJECTS) return env.AUTODEV_CLAUDE_PROJECTS;
    if (env.CLAUDE_CONFIG_DIR) return path.join(env.CLAUDE_CONFIG_DIR, 'projects');
    return path.join(os.homedir(), '.claude', 'projects');
}

function isDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function safeReaddir(p) {
    try { return { entries: fs.readdirSync(p) }; } catch (e) { return { error: e && e.code ? e.code : String(e) }; }
}

/**
 * Every run directory under a projects directory, with the session it belongs
 * to. Unreadable rungs are collected, not skipped: the caller prints them.
 */
function findRuns(projects) {
    const runs = [];
    const couldNotCheck = [];
    const top = safeReaddir(projects);
    if (top.error) return { runs, couldNotCheck: [`${projects}: ${top.error}`], projectsScanned: 0 };
    let projectsScanned = 0;
    for (const slug of top.entries) {
        const pd = path.join(projects, slug);
        if (!isDir(pd)) continue;
        projectsScanned++;
        const sessions = safeReaddir(pd);
        if (sessions.error) { couldNotCheck.push(`${pd}: ${sessions.error}`); continue; }
        for (const session of sessions.entries) {
            const wd = path.join(pd, session, 'subagents', 'workflows');
            if (!isDir(wd)) continue;
            const r = safeReaddir(wd);
            if (r.error) { couldNotCheck.push(`${wd}: ${r.error}`); continue; }
            for (const name of r.entries) {
                if (!name.startsWith('wf_')) continue;
                runs.push({ id: name, dir: path.join(wd, name), sessionDir: path.join(pd, session), sessionId: session, project: slug });
            }
        }
    }
    return { runs, couldNotCheck, projectsScanned };
}

/**
 * The run directories of ONE session, derived from what a Stop hook is given:
 * the transcript is `<projects>/<slug>/<session_id>.jsonl` and the runs are
 * under `<projects>/<slug>/<session_id>/subagents/workflows/`. Newest first,
 * by the journal's mtime (a directory's mtime does not move on append).
 */
function sessionRunDirs(transcriptPath, sessionId) {
    const sessionDir = path.join(path.dirname(transcriptPath), sessionId);
    const wd = path.join(sessionDir, 'subagents', 'workflows');
    const r = safeReaddir(wd);
    if (r.error) return [];
    const out = [];
    for (const name of r.entries) {
        if (!name.startsWith('wf_')) continue;
        const dir = path.join(wd, name);
        let mtime = 0;
        try { mtime = fs.statSync(path.join(dir, 'journal.jsonl')).mtimeMs; } catch { /* no journal yet */ }
        if (!mtime) { try { mtime = fs.statSync(dir).mtimeMs; } catch { continue; } }
        out.push({ id: name, dir, sessionDir, sessionId, mtime });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
}

/** Script file the run executed, or null. Named `<meta.name>-<wf_id>.js` by the harness. */
function findScript(sessionDir, runId) {
    const r = safeReaddir(path.join(sessionDir, 'workflows', 'scripts'));
    if (r.error) return null;
    const hit = r.entries.find((f) => f.endsWith('-' + runId + '.js'));
    return hit ? path.join(sessionDir, 'workflows', 'scripts', hit) : null;
}

function readJournal(dir) {
    const p = path.join(dir, 'journal.jsonl');
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return { error: e && e.code ? e.code : String(e) }; }
    const keyOf = new Map();       // agentId -> key
    const resulted = new Set();    // agentIds with a result row
    const keysStarted = new Set();
    const keysResulted = new Set();
    let badRows = 0;
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { badRows++; continue; }
        if (!row || typeof row !== 'object') { badRows++; continue; }
        if (row.type === 'started') {
            if (row.agentId) keyOf.set(row.agentId, row.key || null);
            if (row.key) keysStarted.add(row.key);
        } else if (row.type === 'result') {
            if (row.agentId) resulted.add(row.agentId);
            if (row.key) keysResulted.add(row.key);
        }
    }
    return { keyOf, resulted, keysStarted, keysResulted, badRows };
}

/**
 * One agent transcript, read once. Timestamps come from the first and last
 * rows carrying one; tool calls are counted from assistant rows only, so a
 * tool_result that quotes a transcript cannot inflate the count.
 */
function readAgent(file) {
    let size;
    try { size = fs.statSync(file).size; } catch (e) { return { error: e && e.code ? e.code : String(e) }; }
    if (size > MAX_TRANSCRIPT_BYTES) return { error: `${size} bytes exceeds the ${MAX_TRANSCRIPT_BYTES}-byte read cap` };
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { error: e && e.code ? e.code : String(e) }; }
    const lines = text.split('\n');
    let t0 = null;
    let t1 = null;
    let tools = 0;
    let synthetic = null;
    let interrupted = false;
    for (const line of lines) {
        if (!line) continue;
        const hasTs = line.indexOf('"timestamp"') !== -1;
        const hasTool = line.indexOf('"tool_use"') !== -1;
        const hasSynth = line.indexOf(SYNTHETIC_NEEDLE) !== -1;
        const hasInt = line.indexOf(INTERRUPT_NEEDLE) !== -1;
        if (!hasTs && !hasTool && !hasSynth && !hasInt) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (!row || typeof row !== 'object') continue;
        if (row.timestamp) {
            const t = Date.parse(row.timestamp);
            if (Number.isFinite(t)) {
                if (t0 === null || t < t0) t0 = t;
                if (t1 === null || t > t1) t1 = t;
            }
        }
        const msg = row.message;
        const content = msg && Array.isArray(msg.content) ? msg.content : null;
        if (row.type === 'assistant' && content) {
            for (const c of content) if (c && c.type === 'tool_use') tools++;
        }
        if (hasSynth && msg && msg.model === '<synthetic>') {
            const textOf = content ? content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join(' ') : '';
            synthetic = { text: textOf.trim(), error: row.error || null, status: row.apiErrorStatus || null };
        }
        if (hasInt) {
            const textOf = content ? content.map((c) => (c && c.text) || '').join(' ') : (typeof (msg && msg.content) === 'string' ? msg.content : '');
            if (textOf.indexOf(INTERRUPT_NEEDLE) !== -1) interrupted = true;
        }
    }
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* already read it */ }
    return { t0, t1, secs: t0 !== null && t1 !== null ? Math.round((t1 - t0) / 1000) : null, tools, bytes: size, synthetic, interrupted, mtime };
}

function classify(journaled, a) {
    if (journaled) return 'journaled';
    if (a.synthetic) return /limit/i.test(a.synthetic.text) || a.synthetic.error === 'rate_limit' ? 'lost-quota-wall' : 'lost-api-error';
    if (a.interrupted) return 'lost-interrupted';
    return 'lost-other';
}

/** Max concurrency from the agents' own start/end times, as the evidence document derives shape. */
function shapeOf(agents) {
    const ev = [];
    for (const a of agents) if (a.t0 !== null && a.t1 !== null) { ev.push([a.t0, 1]); ev.push([a.t1, -1]); }
    ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    let cur = 0;
    let max = 0;
    for (const e of ev) { cur += e[1]; if (cur > max) max = cur; }
    const n = agents.length;
    const shape = n === 1 ? 'single' : max <= 1 ? 'serial' : max >= n ? 'parallel' : 'mixed';
    return { maxConcurrency: max, shape };
}

/**
 * Triage one run directory. Never throws; anything unreadable lands in
 * `couldNotCheck` and `ok` is false only when NOTHING about the run could be read.
 */
function triageRun(run, opts = {}) {
    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const dir = typeof run === 'string' ? run : run.dir;
    const id = (typeof run === 'object' && run.id) || path.basename(dir);
    const sessionDir = (typeof run === 'object' && run.sessionDir) || path.resolve(dir, '..', '..', '..');
    const out = {
        id, dir, sessionDir, ok: true, couldNotCheck: [], agents: [],
        counts: { started: 0, onDisk: 0, journaled: 0, lostQuotaWall: 0, lostInterrupted: 0, lostApiError: 0, lostOther: 0, lost: 0 },
        lostSecs: 0, lostTools: 0, lostBytes: 0, keptSecs: 0,
        keys: { started: 0, resulted: 0, rerun: 0 },
        shape: null, inFlight: false, newestMtime: 0, resume: null, wallText: null,
    };
    const listing = safeReaddir(dir);
    if (listing.error) {
        out.ok = false;
        out.couldNotCheck.push(`run directory unreadable: ${listing.error}`);
        return out;
    }
    const journal = readJournal(dir);
    if (journal.error) out.couldNotCheck.push(`journal.jsonl unreadable: ${journal.error} (every agent below is classified from its transcript alone)`);
    else if (journal.badRows) out.couldNotCheck.push(`journal.jsonl: ${journal.badRows} row(s) not parseable`);
    const keyOf = journal.keyOf || new Map();
    const resulted = journal.resulted || new Set();
    out.counts.started = keyOf.size;
    out.keys.started = journal.keysStarted ? journal.keysStarted.size : 0;
    out.keys.resulted = journal.keysResulted ? journal.keysResulted.size : 0;
    out.keys.rerun = journal.keysStarted ? [...journal.keysStarted].filter((k) => !journal.keysResulted.has(k)).length : 0;

    for (const name of listing.entries.sort()) {
        const m = /^agent-([0-9a-f]+)\.jsonl$/.exec(name);
        if (!m) continue;
        out.counts.onDisk++;
        const agentId = m[1];
        const a = readAgent(path.join(dir, name));
        if (a.error) { out.couldNotCheck.push(`agent ${agentId}: ${a.error}`); continue; }
        const journaled = resulted.has(agentId);
        const outcome = classify(journaled, a);
        const row = { id: agentId, key: keyOf.get(agentId) || null, outcome, secs: a.secs, tools: a.tools, bytes: a.bytes, t0: a.t0, t1: a.t1, marker: a.synthetic ? a.synthetic.text : (a.interrupted ? INTERRUPT_NEEDLE + ']' : null) };
        out.agents.push(row);
        if (a.mtime > out.newestMtime) out.newestMtime = a.mtime;
        if (outcome === 'journaled') { out.counts.journaled++; out.keptSecs += a.secs || 0; continue; }
        out.counts.lost++;
        out.lostSecs += a.secs || 0;
        out.lostTools += a.tools;
        out.lostBytes += a.bytes;
        if (outcome === 'lost-quota-wall') { out.counts.lostQuotaWall++; if (!out.wallText) out.wallText = a.synthetic.text; }
        else if (outcome === 'lost-interrupted') out.counts.lostInterrupted++;
        else if (outcome === 'lost-api-error') out.counts.lostApiError++;
        else out.counts.lostOther++;
    }
    // A started row whose transcript never appeared on disk is lost too, and
    // costs nothing measurable: say so rather than let it vanish from the count.
    for (const agentId of keyOf.keys()) {
        if (resulted.has(agentId)) continue;
        if (out.agents.some((r) => r.id === agentId)) continue;
        out.agents.push({ id: agentId, key: keyOf.get(agentId) || null, outcome: 'lost-other', secs: null, tools: 0, bytes: 0, t0: null, t1: null, marker: 'no transcript on disk' });
        out.counts.lost++;
        out.counts.lostOther++;
    }
    if (!out.agents.length && journal.error) out.ok = false;
    out.shape = shapeOf(out.agents);
    out.inFlight = out.newestMtime > 0 && now - out.newestMtime < IN_FLIGHT_MS;
    if (out.counts.lost > 0) {
        const scriptPath = findScript(sessionDir, id);
        if (!scriptPath) out.couldNotCheck.push('script file not found under <session>/workflows/scripts/ (the resume call below needs it)');
        out.resume = {
            scriptPath,
            command: `Workflow({scriptPath: ${JSON.stringify(scriptPath || '<session>/workflows/scripts/<name>-' + id + '.js')}, resumeFromRunId: ${JSON.stringify(id)}})`,
        };
    }
    return out;
}

// ---------------------------------------------------------------------------
// CLI

function fmtInt(n) { return Number(n || 0).toLocaleString('en-US'); }
function fmtMB(b) { return (b / 1e6).toFixed(b >= 1e6 ? 1 : 2) + ' MB'; }

function renderRun(t) {
    const lines = [];
    const c = t.counts;
    const head = t.ok
        ? `${t.id}  ${c.onDisk} agent transcript(s) · ${c.started} started · shape ${t.shape.shape} (max ${t.shape.maxConcurrency} wide) · ${c.journaled} journaled · ${c.lost} lost`
        : `${t.id}  COULD NOT CHECK`;
    lines.push(head);
    for (const w of t.couldNotCheck) lines.push(`  COULD NOT CHECK: ${w}`);
    for (const a of t.agents) {
        const secs = a.secs === null ? '   ? s' : String(a.secs).padStart(5) + ' s';
        lines.push(`  ${a.id.slice(0, 8)}  ${a.outcome.padEnd(16)} ${secs}  ${String(a.tools).padStart(4)} tools  ${fmtMB(a.bytes).padStart(8)}${a.marker ? '  "' + a.marker.slice(0, 70) + '"' : ''}`);
    }
    if (c.lost > 0) {
        lines.push(`  lost: ${fmtInt(t.lostSecs)} agent-s, ${fmtInt(t.lostTools)} tool calls, ${fmtMB(t.lostBytes)} of transcript that never reached the main thread`);
        if (t.inFlight) lines.push('  IN FLIGHT: an agent transcript changed in the last 5 minutes; the run may still finish');
        lines.push(`  resume re-runs the ${t.keys.rerun} of ${t.keys.started} agent call(s) with no result (${t.keys.resulted} cached, ${fmtInt(t.keptSecs)} agent-s kept); stages that never started run fresh:`);
        lines.push(`    ${t.resume.command}`);
    }
    return lines.join('\n');
}

function main(argv) {
    const args = argv.slice(2);
    const has = (f) => args.includes(f);
    const val = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : null; };
    if (has('--help') || has('-h') || args.length === 0) {
        const lines = fs.readFileSync(__filename, 'utf8').split('\n');
        const head = [];
        for (const line of lines.slice(2)) {
            if (/^\s*(\*|\/\*\*|\*\/)/.test(line)) head.push(line.replace(/^\s*\/?\*+\/?\s?/, ''));
            else break;
        }
        console.log(head.join('\n').trim());
        return args.length === 0 ? 2 : 0;
    }
    const asJson = has('--json');
    const projects = val('--projects') || projectsDir();
    const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--projects' && args[i - 1] !== '--all-since');

    let targets = [];
    const couldNotCheck = [];
    let population = null;
    const needScan = has('--latest') || has('--all') || has('--all-since') || positional.some((p) => /^wf_/.test(p) && !isDir(p));
    if (needScan) {
        const scan = findRuns(projects);
        population = { projects: scan.projectsScanned, runs: scan.runs.length, projectsDir: projects };
        couldNotCheck.push(...scan.couldNotCheck);
        if (has('--all') || has('--all-since')) targets = scan.runs.slice();
        if (has('--latest')) {
            const withTime = scan.runs.map((r) => { let m = 0; try { m = fs.statSync(path.join(r.dir, 'journal.jsonl')).mtimeMs; } catch { try { m = fs.statSync(r.dir).mtimeMs; } catch { /* unreadable; sorts last */ } } return { ...r, mtime: m }; });
            withTime.sort((a, b) => b.mtime - a.mtime);
            if (withTime.length) targets.push(withTime[0]);
        }
        for (const p of positional) {
            if (isDir(p)) continue;
            const hit = scan.runs.filter((r) => r.id === p || r.id.startsWith(p));
            if (!hit.length) couldNotCheck.push(`${p}: no run directory with that id under ${projects}`);
            targets.push(...hit);
        }
    }
    for (const p of positional) if (isDir(p)) targets.push({ id: path.basename(p), dir: path.resolve(p), sessionDir: path.resolve(p, '..', '..', '..') });

    let since = null;
    if (has('--all-since')) {
        since = Date.parse(val('--all-since') || '');
        if (!Number.isFinite(since)) { console.error('--all-since needs a date, e.g. --all-since 2026-08-25'); return 2; }
    }
    const results = [];
    let outsideWindow = 0;
    for (const run of targets) {
        const t = triageRun(run);
        if (since !== null && t.ok) {
            const last = t.agents.reduce((m, a) => Math.max(m, a.t1 || 0), 0);
            if (last < since) { outsideWindow++; continue; }
        }
        results.push(t);
    }
    // De-duplicate a run named twice (by id and by path).
    const seen = new Set();
    const uniq = results.filter((t) => (seen.has(t.dir) ? false : (seen.add(t.dir), true)));

    const totals = { runs: uniq.length, runsOk: 0, runsLost: 0, runsRecoverable: 0, agents: 0, journaled: 0, lostQuotaWall: 0, lostInterrupted: 0, lostApiError: 0, lostOther: 0, lost: 0, lostSecs: 0, lostTools: 0, lostBytes: 0, keptSecsInLostRuns: 0 };
    for (const t of uniq) {
        if (!t.ok) continue;
        totals.runsOk++;
        totals.agents += t.agents.length;
        totals.journaled += t.counts.journaled;
        totals.lostQuotaWall += t.counts.lostQuotaWall;
        totals.lostInterrupted += t.counts.lostInterrupted;
        totals.lostApiError += t.counts.lostApiError;
        totals.lostOther += t.counts.lostOther;
        totals.lost += t.counts.lost;
        totals.lostSecs += t.lostSecs;
        totals.lostTools += t.lostTools;
        totals.lostBytes += t.lostBytes;
        if (t.counts.lost > 0) {
            totals.runsLost++;
            totals.keptSecsInLostRuns += t.keptSecs;
            if (t.resume && t.resume.scriptPath) totals.runsRecoverable++;
        }
    }
    const unreadable = uniq.filter((t) => !t.ok).length;

    if (asJson) {
        console.log(JSON.stringify({ population, couldNotCheck, runs: uniq, totals }, null, 2));
    } else {
        for (const t of uniq) console.log(renderRun(t) + '\n');
        for (const w of couldNotCheck) console.log('COULD NOT CHECK: ' + w);
        if (population) console.log(`POPULATION: ${population.runs} run directories under ${population.projects} project directories in ${population.projectsDir}`);
        if (since !== null) console.log(`WINDOW: ${uniq.length} run(s) with an agent active on or after ${new Date(since).toISOString().slice(0, 10)}; ${outsideWindow} earlier run(s) excluded`);
        console.log(`TRIAGED: ${totals.runsOk} run(s) read${unreadable ? `, ${unreadable} COULD NOT CHECK` : ''} · ${totals.agents} agents · ${totals.journaled} journaled · ${totals.lost} lost `
            + `(${totals.lostQuotaWall} quota-wall, ${totals.lostInterrupted} interrupted, ${totals.lostApiError} api-error, ${totals.lostOther} other)`);
        if (totals.lost) {
            console.log(`LOST: ${fmtInt(totals.lostSecs)} agent-s, ${fmtInt(totals.lostTools)} tool calls, ${fmtMB(totals.lostBytes)} across ${totals.runsLost} run(s)`);
            console.log(`RESUME: ${totals.runsRecoverable} of ${totals.runsLost} lost run(s) still have their script file; resuming them keeps ${fmtInt(totals.keptSecsInLostRuns)} journaled agent-s and re-runs ${fmtInt(totals.lostSecs)} agent-s of lost work`);
        }
    }
    // An empty WINDOW over a scanned population is an answer (0 runs since the
    // date); an empty scan, or a set where nothing could be read, is not.
    if (!uniq.length && since !== null && population && population.runs > 0) return 0;
    if (!uniq.length || unreadable === uniq.length) return 2;
    return totals.lost > 0 ? 1 : 0;
}

module.exports = { projectsDir, findRuns, sessionRunDirs, findScript, triageRun, renderRun, SYNTHETIC_NEEDLE, INTERRUPT_NEEDLE, IN_FLIGHT_MS };

if (require.main === module) {
    let code = 2;
    try { code = main(process.argv); } catch (e) { console.error('COULD NOT CHECK: ' + (e && e.message ? e.message : e)); code = 2; }
    process.exit(code);
}
