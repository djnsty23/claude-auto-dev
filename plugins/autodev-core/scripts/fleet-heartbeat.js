#!/usr/bin/env node
/**
 * fleet-heartbeat.js - record that a session just finished a turn.
 *
 * WHY THIS EXISTS, given transcripts already have an mtime: an mtime tells you a
 * file grew, not that a turn ENDED. Those look identical from outside, and the
 * difference is the whole question a status board answers. A Stop hook fires at
 * exactly the moment a session stops working and starts waiting, so that is the
 * moment worth recording.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: read the transcript. check-queue-drained
 * already reads that file on every Stop and these run to ~4.7MB; a second full
 * read inside a hook with a 5s timeout is the expensive mistake. Pending-panel
 * detection lives in fleet-status.js, which runs on demand and can afford it.
 *
 * COST: one JSON write plus a readdir every 25th call. No model turn is involved
 * anywhere - that is the point. A heartbeat that woke each session to self-report
 * would re-ingest its whole context (~405k tokens) to say one line.
 *
 * Never throws. A heartbeat must never be the reason a turn cannot end.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME;
const DIR = path.join(HOME, '.claude', 'fleet');
const RETAIN_DAYS = 7;
const PRUNE_EVERY = 25;

/**
 * Drop records for sessions that stopped talking a week ago. Cheap and rare:
 * a readdir plus a stat per entry, on roughly one call in twenty-five.
 */
function prune() {
    const cutoff = Date.now() - RETAIN_DAYS * 864e5;
    let entries;
    try { entries = fs.readdirSync(DIR); } catch { return; }
    for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const p = path.join(DIR, name);
        try {
            if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
        } catch { /* vanished or locked - nothing to do */ }
    }
}

/**
 * @param {object} payload  the Stop hook's stdin payload, already parsed
 * @param {string} cwd      the project cwd the hook resolved
 * @returns {string|null}   the file written, or null on any failure
 */
function write(payload, cwd) {
    try {
        const transcript = (payload && (payload.transcript_path || payload.transcriptPath)) || null;

        // The transcript is named for the cliSessionId, which is the join key to
        // the desktop session record - and therefore to an addressable id. Prefer
        // it over payload.session_id, which is not guaranteed to be present.
        const id = transcript
            ? path.basename(transcript, '.jsonl')
            : (payload && payload.session_id) || null;
        if (!id) return null;

        fs.mkdirSync(DIR, { recursive: true });

        const rec = {
            cliSessionId: id,
            cwd: cwd || null,
            transcript,
            stoppedAt: new Date().toISOString(),
            // Distinguishes a turn ending normally from one ending inside a
            // stop-hook continuation, which is not the same kind of "waiting".
            stopHookActive: !!(payload && payload.stop_hook_active),
        };

        const file = path.join(DIR, id + '.json');
        // Write-then-rename: a board reading this directory must never catch a
        // half-written record and parse it as a corrupt session.
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(rec) + '\n');
        fs.renameSync(tmp, file);

        if (Math.floor(Date.now() / 1000) % PRUNE_EVERY === 0) prune();
        return file;
    } catch {
        return null;   // never strand a turn
    }
}

/** Every heartbeat on this machine, freshest first. Used by fleet-status. */
function readAll() {
    const out = [];
    let entries;
    try { entries = fs.readdirSync(DIR); } catch { return out; }
    for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        try { out.push(JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'))); } catch { /* skip */ }
    }
    return out.sort((a, b) => String(b.stoppedAt).localeCompare(String(a.stoppedAt)));
}

module.exports = { write, readAll, prune, DIR };

if (require.main === module) {
    const all = readAll();
    console.log(`${all.length} heartbeat(s) in ${DIR}`);
    for (const h of all.slice(0, 20)) {
        const mins = Math.round((Date.now() - Date.parse(h.stoppedAt)) / 60000);
        console.log(`  ${String(mins).padStart(5)}m ago  ${h.cliSessionId.slice(0, 8)}  ${h.cwd || '?'}`);
    }
}
