#!/usr/bin/env node
'use strict';

// peer-queue-check.js: find peer messages that were queued and never processed.
//
// WHY. A send that returns "queued" waits behind the target session's current
// turn. If that session stops first, for example at its context limit, the
// message is never processed and the sender, who was told "queued", never finds
// out. hooks/peer-send-ledger.js records every send. This reads that ledger and,
// for each queued send old enough to have been picked up, asks the target's own
// transcript whether it was.
//
// HOW A TARGET IS FOUND. The ledger holds the desktop session id
// (`local_<uuid>`), which is what send_message accepts. Transcripts are named for
// a DIFFERENT uuid, the CLI session id, and the two are joined only by the
// `cliSessionId` field of the desktop app's session record. Those records sit
// several directories deep in the store, so the store is walked, not listed. The
// transcript is then `<config dir>/projects/*/<cliSessionId>.jsonl`.
//
// THE VERDICTS, per queued send aged between --min-age-min and 7 days:
//   processed  a row showing the prompt reached the model, timestamped no
//              earlier than the send (less a two-minute allowance, since the
//              ledger line is written after the send returns), contains the
//              probe text
//   pending    not found, and the transcript changed within --idle-min
//              (default 60) minutes
//   lost       not found, and the target's desktop session record carries
//              isArchived true. That is the only on-disk field that says a
//              session ended, and an ended session processes nothing, so the
//              message never will be. Resend it.
//   stalled    not found, the target is not archived, and its transcript has
//              been idle longer than --idle-min. The target may be blocked on
//              a permission prompt and still hold the message, so a resend
//              can make it run twice. Do not resend; look at the target.
//   unknown    the target has no desktop record or no transcript
// An idle transcript is not an ended session. `[measured 2026-09-16]` p90 peer
// delivery is about 48 minutes, and a check that called every message lost
// after 20 idle minutes recommended resends that the target then ran twice.
// That is why lost needs the archived record and why the window is 60.
// A prompt reaches the model in one of two rows. Between turns it is a `user`
// row. Inside a running turn it is an `attachment` row of type
// `queued_command`, carrying the text in `attachment.prompt`. `[measured
// 2026-09-17]` replaying 30 real queued sends found 4 delivered only that second
// way, and a check reading user rows alone called all 4 lost.
// The host also writes a `queue-operation` row holding the text the moment a
// message is ENQUEUED. That row proves the message arrived, not that it was
// processed, so it is never counted. Counting it would call every lost message
// processed.
//
// EXIT CODES. Only lost is non-zero among the verdicts.
//   0  no lost message: every send is processed, pending, stalled or unknown
//   1  at least one lost message
//   2  the ledger, the session store or the transcripts directory could not
//      be read, or an option is malformed. Indeterminate, never reported clean.
// Stalled and unknown exit 0 because neither has an action the sender can take
// safely; both are still listed by name in the output.
//
// Paths: AUTODEV_PEER_LEDGER (default ~/.claude/autodev/peer-sends.jsonl),
// AUTODEV_DESKTOP_SESSION_STORE (default: the desktop app's store for this
// platform), CLAUDE_CONFIG_DIR (default ~/.claude) for the transcripts.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_MS = 7 * DAY_MS;
const DEFAULT_IDLE_MIN = 60;
const SKEW_MS = 2 * 60 * 1000;

const USAGE = 'usage: node plugins/autodev-core/scripts/peer-queue-check.js [--min-age-min N] [--idle-min N] [--json]\n'
    + 'Reads the peer-send ledger and reports queued peer messages as processed, pending, stalled, lost or unknown.\n'
    + '  --min-age-min N  only judge queued sends at least N minutes old (default 20)\n'
    + '  --idle-min N     a target transcript untouched for N minutes is idle (default ' + DEFAULT_IDLE_MIN + ')\n'
    + '  --json           print one JSON object\n'
    + 'Lost needs the target archived; an idle target that is not archived is stalled, and a resend could run it twice.\n'
    + 'Exit 0 nothing lost, 1 something lost, 2 could not read the ledger, store or transcripts.';

function ledgerPath() {
    return process.env.AUTODEV_PEER_LEDGER || path.join(os.homedir(), '.claude', 'autodev', 'peer-sends.jsonl');
}

function projectsDir() {
    return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

/** The desktop session store directory, or null when it cannot be found. */
function storeDir() {
    const override = process.env.AUTODEV_DESKTOP_SESSION_STORE;
    if (override) {
        try { return fs.statSync(override).isDirectory() ? override : null; } catch { return null; }
    }
    try { return require(path.join(__dirname, 'claude-paths.js')).sessionStore(); } catch { return null; }
}

/** Parsed ledger rows plus a malformed count, or null when the file cannot be read. */
function readLedger(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
    const rows = [];
    let malformed = 0;
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
            const row = JSON.parse(line);
            if (row && typeof row === 'object' && Number.isFinite(Date.parse(row.at))) rows.push(row);
            else malformed++;
        } catch { malformed++; }
    }
    return { rows, malformed };
}

/**
 * desktop session id -> { cli, archived }, walking the nested store. `archived`
 * is true only when the record says isArchived === true: a record without the
 * field is a live session, not an ended one.
 */
function loadStore(dir) {
    const index = new Map();
    const walk = (d, depth) => {
        if (depth > 4) return;
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { walk(p, depth + 1); continue; }
            if (!e.isFile() || !e.name.startsWith('local_') || !e.name.endsWith('.json')) continue;
            let rec;
            try { rec = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
            if (!rec || typeof rec.cliSessionId !== 'string') continue;
            index.set(typeof rec.sessionId === 'string' ? rec.sessionId : e.name.slice(0, -5), { cli: rec.cliSessionId, archived: rec.isArchived === true });
        }
    };
    walk(dir, 0);
    return index;
}

/** The transcript for a CLI session id under projects/, or null. */
function findTranscript(projects, cliId) {
    if (!/^[A-Za-z0-9_-]+$/.test(cliId)) return null;
    for (const d of fs.readdirSync(projects)) {
        const p = path.join(projects, d, cliId + '.jsonl');
        if (fs.existsSync(p)) return p;
    }
    return null;
}

/** Plain text of a user row's message content, whitespace collapsed. */
function textOf(content) {
    const parts = [];
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
        for (const b of content) {
            if (typeof b === 'string') parts.push(b);
            else if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
        }
    }
    return parts.join(' ').replace(/\s+/g, ' ');
}

/**
 * [{ t, text }] for every row that shows a prompt reaching the model: a user
 * row, or a queued_command attachment injected into a running turn.
 * queue-operation rows are skipped by type.
 */
function deliveredRows(file) {
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const t = Date.parse(row && row.timestamp);
        if (!Number.isFinite(t)) continue;
        if (row.type === 'user' && row.message) out.push({ t, text: textOf(row.message.content) });
        else if (row.type === 'attachment' && row.attachment && row.attachment.type === 'queued_command') {
            out.push({ t, text: textOf(row.attachment.prompt) });
        }
    }
    return out;
}

/** The numeric value after `flag`, or its default; null when it is not a non-negative number. */
function minutesOption(argv, flag, fallback) {
    const i = argv.indexOf(flag);
    if (i < 0) return fallback;
    const n = Number(argv[i + 1]);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

function check(argv, nowMs) {
    const json = argv.includes('--json');
    const minAgeMin = minutesOption(argv, '--min-age-min', 20);
    if (minAgeMin === null) return { code: 2, json, report: { ok: false, error: '--min-age-min needs a non-negative number' } };
    const idleMin = minutesOption(argv, '--idle-min', DEFAULT_IDLE_MIN);
    if (idleMin === null) return { code: 2, json, report: { ok: false, error: '--idle-min needs a non-negative number' } };
    const file = ledgerPath();
    const ledger = readLedger(file);
    if (!ledger) {
        return { code: 2, json, report: { ok: false, ledger: file, error: 'could not read the ledger. This is NOT a clean result: either no send was ever recorded or the hook is not installed' } };
    }
    const candidates = ledger.rows.filter((r) => {
        const age = nowMs - Date.parse(r.at);
        return r.delivery === 'queued' && age >= minAgeMin * 60000 && age < MAX_AGE_MS;
    });
    const report = {
        ok: true, ledger: file, entries: ledger.rows.length, malformed: ledger.malformed, minAgeMin, idleMin,
        scanned: candidates.length, processed: 0, pending: 0, stalled: [], lost: [], unknown: [],
    };
    if (!candidates.length) return { code: 0, json, report };

    const store = storeDir();
    if (!store) return { code: 2, json, report: Object.assign(report, { ok: false, error: 'could not find the desktop session store, so no target could be resolved' }) };
    const projects = projectsDir();
    try { fs.readdirSync(projects); } catch {
        return { code: 2, json, report: Object.assign(report, { ok: false, error: 'could not read the transcripts directory ' + projects }) };
    }
    const index = loadStore(store);
    const cache = new Map();
    for (const c of candidates) {
        const brief = { target: c.target, messageId: c.messageId, at: c.at, probe: c.probe };
        const rec = index.get(c.target);
        const transcript = rec ? findTranscript(projects, rec.cli) : null;
        if (!transcript) {
            report.unknown.push(Object.assign(brief, { reason: rec ? 'no transcript for this session' : 'target not in the desktop session store' }));
            continue;
        }
        if (!cache.has(transcript)) cache.set(transcript, deliveredRows(transcript));
        const since = Date.parse(c.at) - SKEW_MS;
        const probe = String(c.probe || '').replace(/\s+/g, ' ').trim();
        if (probe && cache.get(transcript).some((r) => r.t >= since && r.text.includes(probe))) { report.processed++; continue; }
        // Not processed. Only an archived record proves the session ended; an
        // idle transcript can be a target blocked on a prompt, still holding it.
        if (rec.archived) { report.lost.push(Object.assign(brief, { reason: 'target session is archived' })); continue; }
        const idleMs = nowMs - fs.statSync(transcript).mtimeMs;
        if (idleMs <= idleMin * 60000) { report.pending++; continue; }
        report.stalled.push(Object.assign(brief, { idleMinutes: Math.round(idleMs / 60000) }));
    }
    report.ok = report.lost.length === 0;
    return { code: report.ok ? 0 : 1, json, report };
}

function render(result) {
    const r = result.report;
    if (result.json) return JSON.stringify(r, null, 2);
    const lines = [];
    const population = r.ledger === undefined ? '' : 'ledger ' + r.ledger + ': ' + (r.entries === undefined ? 'unread' : r.entries + ' entries (' + r.malformed + ' malformed)')
        + (r.scanned === undefined ? '' : ', ' + r.scanned + ' queued send(s) aged ' + r.minAgeMin + ' min to 7 days scanned');
    if (population) lines.push('peer-queue-check: ' + population);
    if (r.error) {
        lines.push('peer-queue-check: INDETERMINATE: ' + r.error);
        return lines.join('\n');
    }
    lines.push('  processed ' + r.processed + ', pending ' + r.pending + ', stalled ' + r.stalled.length + ', lost ' + r.lost.length + ', unknown ' + r.unknown.length
        + ' (idle window ' + r.idleMin + ' min; unknown was not verified either way)');
    for (const l of r.lost) lines.push('LOST     ' + l.target + ' message ' + l.messageId + ' queued ' + l.at + ' "' + l.probe + '" (' + l.reason + ')');
    for (const s of r.stalled) lines.push('STALLED  ' + s.target + ' message ' + s.messageId + ' queued ' + s.at + ' "' + s.probe + '" (target idle ' + s.idleMinutes + ' min, not archived)');
    for (const u of r.unknown) lines.push('UNKNOWN  ' + u.target + ' message ' + u.messageId + ' queued ' + u.at + ' (' + u.reason + ')');
    if (r.lost.length) lines.push('A lost message was never processed by its target, and the target has ended. Resend it, or deliver the fact another way.');
    if (r.stalled.length) lines.push('A stalled message may still be held by a target blocked on a prompt. Do not resend it, or it can run twice; check the target first.');
    return lines.join('\n');
}

if (require.main === module) {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(USAGE);
    } else {
        let result;
        try { result = check(argv, Date.now()); } catch (e) {
            result = { code: 2, json: argv.includes('--json'), report: { ok: false, error: 'could not complete the check: ' + ((e && e.message) || e) } };
        }
        (result.json || result.code !== 2 ? process.stdout : process.stderr).write(render(result) + '\n');
        process.exitCode = result.code;
    }
}

module.exports = { check, loadStore, textOf, deliveredRows };
