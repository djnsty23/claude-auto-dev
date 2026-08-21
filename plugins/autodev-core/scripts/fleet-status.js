#!/usr/bin/env node
/**
 * fleet-status.js - one view of every session on this machine.
 *
 * Answers two questions the per-session checks cannot, because each of them
 * only ever sees its own transcript:
 *
 *   PENDING PANEL   a session is blocked on an AskUserQuestion and nobody has
 *                   answered it. Detected as a tool_use whose id never appears
 *                   in a later tool_result - the exact inverse of the filter in
 *                   check-queue-drained.js, which collects ANSWERED panels only.
 *
 *   HEARTBEAT       how long since the transcript last grew. This is the cheap
 *                   status signal: it needs no model turn in the target session,
 *                   only a stat() here. A ping that WAKES a session costs that
 *                   session's whole context (~405k tokens); a ping that reads
 *                   its mtime costs nothing.
 *
 * READ-ONLY. It never writes to a transcript and never messages a session.
 * Delivery is a separate decision made by whoever reads this output.
 *
 * Usage:
 *   node fleet-status.js                 # table, most-urgent first
 *   node fleet-status.js --json          # machine-readable, for the interface
 *   node fleet-status.js --days 2        # how far back to scan (default 2)
 *   node fleet-status.js --pending       # only sessions blocked on a panel
 *
 * Always exits 0. This is a report, never a gate.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME;
const ROOT = path.join(HOME, '.claude', 'projects');

// The desktop app keeps its own session records, in a DIFFERENT id space from
// the transcripts. A transcript is named for its cliSessionId; the id that
// list_sessions returns and send_message accepts is `local_<uuid>`, and the two
// are joined only by the `cliSessionId` field inside these files.
//
// This matters more than it looks: without the join, a pending panel found in a
// transcript cannot be turned into a message target or a jump-to-session link.
// Checking that a transcript's internal sessionId equals its own filename looks
// like a mapping check and is vacuous - it compares a file to itself.
const SESSION_STORE = path.join(
    process.env.APPDATA || path.join(HOME, '.config'), 'Claude', 'claude-code-sessions'
);

/** cliSessionId -> desktop session record. Empty map on any failure. */
function loadSessionIndex() {
    const index = new Map();
    const walk = (dir, depth) => {
        if (depth > 3) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p, depth + 1); continue; }
            if (!e.isFile() || !e.name.startsWith('local_') || !e.name.endsWith('.json')) continue;
            let rec; try { rec = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
            if (!rec.cliSessionId) continue;
            const pr = Array.isArray(rec.prs) && rec.prs.length ? rec.prs[rec.prs.length - 1] : null;
            index.set(rec.cliSessionId, {
                addressableId: rec.sessionId,      // what send_message accepts
                title: rec.title || null,
                worktreeName: rec.worktreeName || null,
                originCwd: rec.originCwd || null,
                model: rec.model || null,
                effort: rec.effort || null,
                isArchived: !!rec.isArchived,
                lastActivityAt: rec.lastActivityAt || null,
                prNumber: pr && (pr.number || pr.prNumber) || null,
                prState: pr && (pr.state || pr.prState) || null,
            });
        }
    };
    walk(SESSION_STORE, 0);
    return index;
}

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DAYS = Number(val('--days', 2));
const CUTOFF = Date.now() - DAYS * 864e5;

/**
 * Parse one transcript into a status record.
 *
 * Reads the file once and keeps only the last of everything - these files run to
 * thousands of lines and the whole point of this script is to stay cheap enough
 * to run on a timer.
 */
function readTranscript(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }

    const calls = [];           // AskUserQuestion tool_use records, oldest first
    const answered = new Set(); // tool_use_ids that received a result
    let cwd = null, sessionId = null, lastRole = null, lastTs = null, gitBranch = null;

    for (const line of raw.split('\n')) {
        if (!line) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }

        if (rec.cwd) cwd = rec.cwd;
        if (rec.sessionId) sessionId = rec.sessionId;
        if (rec.gitBranch) gitBranch = rec.gitBranch;
        if (rec.timestamp) lastTs = rec.timestamp;
        if (rec.message && rec.message.role) lastRole = rec.message.role;

        const content = rec.message && rec.message.content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
            if (part.type === 'tool_use' && part.name === 'AskUserQuestion') {
                calls.push({ id: part.id, ts: rec.timestamp, questions: (part.input || {}).questions || [] });
            } else if (part.type === 'tool_result' && part.tool_use_id) {
                answered.add(part.tool_use_id);
            }
        }
    }

    const last = calls[calls.length - 1] || null;
    const pending = last && !answered.has(last.id) ? last : null;

    return {
        sessionId, cwd, gitBranch, lastRole, lastTs,
        transcript: file,
        panelCount: calls.length,
        pending: pending && {
            askedAt: pending.ts,
            questions: pending.questions.map((q) => ({
                question: q.question,
                header: q.header,
                multiSelect: !!q.multiSelect,
                options: (q.options || []).map((o) => ({ label: o.label, description: o.description })),
            })),
        },
    };
}

/**
 * TODO(andy) - decide what "needs attention" MEANS.
 *
 * This is the judgement the whole interface is built around, and it is genuinely
 * yours: it decides what shows up red at the top of the board and what stays
 * quiet. Everything above this line is mechanical parsing. This is policy.
 *
 * The inputs available on `s`:
 *   s.pending      the unanswered panel object, or null
 *   s.idleMinutes  minutes since the transcript last grew
 *   s.lastRole     'assistant' (it spoke last - likely waiting on you)
 *                  or 'user' (you spoke last - likely still working)
 *   s.isRunning    process alive, from list_sessions (null when not supplied)
 *   s.panelCount   how many panels this session has raised
 *
 * The tension worth resolving: a pending panel is unambiguous - someone is
 * blocked. Idle time is not. A session idle 40 minutes with lastRole
 * 'assistant' finished and is waiting; the same 40 minutes with lastRole 'user'
 * may be a long build, or may be a session that died mid-task. Ranking those
 * identically buries the real one.
 *
 * Note also that a hard staleness cutoff marks every finished-and-fine session
 * red overnight, which is how a status board gets muted - the failure mode
 * rules/agent-quality.md 22b exists to prevent.
 *
 * WHAT IS ENCODED BELOW is a starting policy, not a finding. Overrule it freely -
 * it is five lines and everything else in this file is independent of it.
 *
 * 'blocked'  an unanswered panel. The only state proven by the transcript rather
 *            than inferred from timing.
 * 'working'  the transcript grew in the last few minutes. Says nothing about
 *            whether progress is good, only that something is being written.
 * 'stalled'  YOU spoke last and nothing has happened since. This is the state
 *            worth surfacing and the one a pure staleness sort hides: it is
 *            either a long build or a session that died mid-task, and those are
 *            indistinguishable from here. Better to show it and be wrong twice a
 *            day than to bury a dead session under quiet ones.
 * 'done'     merged PR and quiet for an hour. Deliberately narrow: without the
 *            PR evidence this would just be a staleness cutoff painting every
 *            finished session red overnight, which is how a board gets muted.
 * 'waiting'  everything else - it spoke last and stopped. The common resting
 *            state, and intentionally the quietest.
 */
function classify(s) {
    if (s.pending) return 'blocked';
    if (s.idleMinutes <= 3) return 'working';

    // A heartbeat REFINES the timing heuristic; it never replaces it. When the
    // Stop hook fired at or after the last write, the turn finished — so the
    // session is resting, not stalled, however long it has been quiet.
    if (s.endedCleanly === true && s.prState !== 'MERGED') return 'waiting';

    // endedCleanly === false is the strong signal: the transcript grew after the
    // last recorded turn end, so a turn started and never finished.
    if (s.endedCleanly === false && s.idleMinutes >= 10) return 'stalled';

    // null (no heartbeat yet) falls back to the timing-only heuristic.
    if (s.lastRole === 'user' && s.idleMinutes >= 15) return 'stalled';
    if (s.prState === 'MERGED' && s.idleMinutes >= 60) return 'done';
    return 'waiting';
}

// ---------------------------------------------------------------------------

/**
 * Scan the whole fleet. Extracted from main() so the board server can call it
 * in-process rather than shelling out and re-parsing its own JSON.
 *
 * @param {number} days how far back to look
 */
function scanFleet(days) {
    const cutoff = Date.now() - days * 864e5;
    if (!fs.existsSync(ROOT)) return { population: { dirs: 0, transcripts: 0, withPanels: 0, blocked: 0, addressable: 0 }, sessions: [] };

    let scannedDirs = 0, scannedFiles = 0;
    const sessions = [];
    const index = loadSessionIndex();

    // Heartbeats say a turn ENDED; an mtime only says the file grew. Absent
    // until the plugin restart that installs the hook, so every consumer must
    // treat "no heartbeat" as UNKNOWN rather than as "did not end cleanly" -
    // an unrecognised state must never fall through to the confident reading.
    let beats = new Map();
    try {
        const { readAll } = require(path.join(__dirname, 'fleet-heartbeat.js'));
        beats = new Map(readAll().map((h) => [h.cliSessionId, h]));
    } catch { /* heartbeat module absent - everything stays unknown */ }

    for (const dir of fs.readdirSync(ROOT)) {
        const d = path.join(ROOT, dir);
        let st; try { st = fs.statSync(d); } catch { continue; }
        if (!st.isDirectory()) continue;
        scannedDirs++;

        for (const f of fs.readdirSync(d)) {
            if (!f.endsWith('.jsonl')) continue;
            const p = path.join(d, f);
            let fst; try { fst = fs.statSync(p); } catch { continue; }
            if (fst.mtimeMs < cutoff) continue;
            scannedFiles++;

            const rec = readTranscript(p);
            if (!rec) continue;
            rec.idleMinutes = Math.round((Date.now() - fst.mtimeMs) / 60000);
            rec.isRunning = null;
            Object.assign(rec, index.get(rec.sessionId) || { addressableId: null, title: null });

            const hb = beats.get(rec.sessionId);
            rec.stoppedAt = hb ? hb.stoppedAt : null;
            // true  = the Stop hook fired at or after the last write, so the turn
            //         finished rather than being cut off
            // false = the transcript grew AFTER the last recorded turn end
            // null  = no heartbeat at all; say nothing
            rec.endedCleanly = hb ? (Date.parse(hb.stoppedAt) >= fst.mtimeMs - 2000) : null;

            rec.state = classify(rec);
            sessions.push(rec);
        }
    }

    // Blocked first, then longest-waiting.
    sessions.sort((a, b) => (b.pending ? 1 : 0) - (a.pending ? 1 : 0) || a.idleMinutes - b.idleMinutes);

    return {
        scannedAt: new Date().toISOString(),
        population: {
            dirs: scannedDirs,
            transcripts: scannedFiles,
            withPanels: sessions.filter((s) => s.panelCount).length,
            blocked: sessions.filter((s) => s.pending).length,
            // If this is 0 the board is read-only: nothing can be messaged.
            addressable: sessions.filter((s) => s.addressableId).length,
        },
        sessions,
    };
}

function main() {
    if (!fs.existsSync(ROOT)) {
        console.error('no transcript root at ' + ROOT);
        process.exit(0);
    }

    let scannedDirs = 0, scannedFiles = 0;
    const sessions = [];
    const index = loadSessionIndex();

    for (const dir of fs.readdirSync(ROOT)) {
        const d = path.join(ROOT, dir);
        let st; try { st = fs.statSync(d); } catch { continue; }
        if (!st.isDirectory()) continue;
        scannedDirs++;

        for (const f of fs.readdirSync(d)) {
            if (!f.endsWith('.jsonl')) continue;
            const p = path.join(d, f);
            let fst; try { fst = fs.statSync(p); } catch { continue; }
            if (fst.mtimeMs < CUTOFF) continue;
            scannedFiles++;

            const rec = readTranscript(p);
            if (!rec) continue;
            rec.idleMinutes = Math.round((Date.now() - fst.mtimeMs) / 60000);
            rec.isRunning = null;   // runtime-only; filled in by the caller from list_sessions
            Object.assign(rec, index.get(rec.sessionId) || { addressableId: null, title: null });
            rec.state = classify(rec);
            sessions.push(rec);
        }
    }

    // Blocked first, then by how long they have been waiting.
    sessions.sort((a, b) => (b.pending ? 1 : 0) - (a.pending ? 1 : 0) || a.idleMinutes - b.idleMinutes);

    const shown = has('--pending') ? sessions.filter((s) => s.pending) : sessions;

    if (has('--json')) {
        console.log(JSON.stringify({
            scannedAt: new Date().toISOString(),
            population: {
                dirs: scannedDirs,
                transcripts: scannedFiles,
                withPanels: sessions.filter((s) => s.panelCount).length,
                blocked: sessions.filter((s) => s.pending).length,
                // If this is 0 the board is read-only: nothing can be messaged.
                addressable: sessions.filter((s) => s.addressableId).length,
            },
            sessions: shown,
        }, null, 2));
        return;
    }

    // A report that prints only a verdict is indistinguishable from one that
    // found nothing (rules/agent-quality.md 22c), so always print the population.
    console.log('scanned ' + scannedFiles + ' transcripts in ' + scannedDirs + ' project dirs, last ' + DAYS + 'd');
    console.log(sessions.filter((s) => s.pending).length + ' blocked on an unanswered panel');
    console.log('');

    for (const s of shown) {
        const name = s.title || (s.cwd ? s.cwd.split(/[\\/]/).slice(-1)[0] : '?');
        const flag = s.pending ? '* BLOCKED' : '  ' + s.state;
        const branch = s.gitBranch ? '  [' + s.gitBranch + ']' : '';
        const addr = s.addressableId ? '' : '  (not addressable)';
        console.log(flag + '  ' + s.idleMinutes + 'm idle  ' + name + branch + addr);
        if (s.pending) {
            for (const q of s.pending.questions) {
                console.log('      ? ' + q.question);
                for (const o of q.options) console.log('        - ' + o.label);
            }
        }
    }
}

if (require.main === module) main();
module.exports = { readTranscript, classify, scanFleet, loadSessionIndex };
