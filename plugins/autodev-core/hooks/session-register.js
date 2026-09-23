#!/usr/bin/env node
'use strict';
/**
 * session-register.js - which account a session belongs to, and whether its
 * process is still alive. SessionStart and SessionEnd hook.
 *
 * WHY THIS EXISTS. The peer registry behind ListAgents and list_sessions is
 * kept per CLAUDE_CONFIG_DIR, so a terminal session started under a second
 * config dir is invisible to sessions under the first and cannot be messaged
 * from them. This hook writes one small record per session into a directory
 * BOTH config dirs resolve to, naming the config dir it runs under and the
 * pid of its session process, so fleet-registry.js can list every account's
 * sessions in one table and say which are still running.
 *
 * WHAT IT IS NOT, so nobody builds a fourth:
 *   - It does not record when a session last finished a turn. That is the
 *     heartbeat fleet-heartbeat.js writes on Stop (called from
 *     stop-auto-check.js) at <fleetDir>/<uuid>.json, and fleet-status.js reads.
 *   - It does not derive sessions from transcripts or the desktop session
 *     store. That is fleet-status.js and session-pile.js.
 *   There is deliberately no Stop leg here: it would duplicate the heartbeat
 *   and add a sixth Stop subprocess to every turn of every installed session.
 *   Liveness comes from the pid, not from counting turns.
 *
 * WHERE. <fleetDir>/sessions/<session_id>.json, with
 *   fleetDir = AUTODEV_FLEET_DIR || <config dir>/fleet
 * the same convention as fleet-heartbeat.js and watch-panels.js, where the
 * config dir is claude-paths.configDir(). The default is PER PROFILE: a
 * second profile under its own CLAUDE_CONFIG_DIR must never write into the
 * first one's config dir, so it keeps its own registry. The registry becomes
 * cross-account only when BOTH profiles set AUTODEV_FLEET_DIR to one shared
 * directory. Setting it on one account and not the other splits the registry
 * silently, and each half then reports the other's sessions as absent. The sessions/ subdirectory sits safely beside the heartbeats:
 * fleet-heartbeat.js isHeartbeatFile() requires a name ending in .json, so a
 * directory is neither read as a heartbeat nor pruned as a stale one.
 *
 * THE PID. `pid` is process.ppid, and that is the session process.
 * [measured 2026-09-17, win32] fourteen exec-form hook children spawned by the
 * host all had the claude executable as their direct parent, with no shell
 * between; a headless run's grandparent was the launching shell, which does
 * not change what ppid names. If a future host inserts a wrapper, ppid names
 * the wrapper and a live session reads as dead the moment the wrapper exits;
 * the reader script prints which pid it checked so that is diagnosable.
 *
 * LIMITS. SessionEnd does not fire when a session is killed or the machine
 * reboots, so such records keep no endedAt and only the pid separates them
 * from live ones. After a reboot a pid can be reused by an unrelated process.
 * fleet-registry.js treats a record refreshed before the current boot as
 * dead for that reason, and the prune below removes anything untouched for
 * RETAIN_DAYS.
 *
 * CONTRACT. Zero bytes on stdout and stderr, always, and exit 0, including on
 * malformed stdin, an unwritable directory and any thrown error. A session id
 * that is not a UUID writes nothing: other suites drive hooks with fixture
 * payloads, and fleet-heartbeat.js carries the same rule for the same store.
 * Spawns nothing. One write plus, on SessionStart, one prune of sessions/.
 */
const fs = require('fs');
const path = require('path');

let claudePaths;
try { claudePaths = require('../scripts/claude-paths.js'); } catch { process.exit(0); }

const FLEET_DIR = process.env.AUTODEV_FLEET_DIR || path.join(claudePaths.configDir(), 'fleet');
const DIR = path.join(FLEET_DIR, 'sessions');
const RETAIN_DAYS = 7;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readPayload() {
    try {
        if (process.stdin.isTTY) return null;
        const raw = fs.readFileSync(0, 'utf8');
        if (!raw.trim()) return null;
        const p = JSON.parse(raw);
        return p && typeof p === 'object' ? p : null;
    } catch {
        return null;
    }
}

function readRecord(file) {
    try {
        const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
        return rec && typeof rec === 'object' ? rec : null;
    } catch {
        return null;
    }
}

// Write-then-rename, so a reader never parses a half-written record.
function writeRecord(file, rec) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec) + '\n', 'utf8');
    fs.renameSync(tmp, file);
}

// Drop records nobody has touched for RETAIN_DAYS: by endedAt, else by
// refreshedAt, else (a record that parses as neither) by the file's mtime.
// Only files ending in .json inside sessions/ are ever considered.
function prune(now) {
    const cutoff = now - RETAIN_DAYS * 864e5;
    let entries;
    try { entries = fs.readdirSync(DIR); } catch { return; }
    for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(DIR, name);
        try {
            const rec = readRecord(file);
            const stamp = rec && (rec.endedAt || rec.refreshedAt);
            const at = stamp ? Date.parse(stamp) : fs.statSync(file).mtimeMs;
            if (Number.isFinite(at) && at < cutoff) fs.unlinkSync(file);
        } catch { /* vanished or locked, nothing to do */ }
    }
}

function main() {
    try {
        if (process.argv.includes('--help')) return;
        const payload = readPayload();
        if (!payload) return;
        const id = payload.session_id;
        if (typeof id !== 'string' || !UUID_RE.test(id)) return;
        const event = payload.hook_event_name;
        if (event !== 'SessionStart' && event !== 'SessionEnd') return;

        fs.mkdirSync(DIR, { recursive: true });
        const file = path.join(DIR, id + '.json');
        const existing = readRecord(file);
        const now = new Date().toISOString();
        const configDir = process.env.CLAUDE_CONFIG_DIR
            ? path.basename(process.env.CLAUDE_CONFIG_DIR) : 'default';

        const rec = {
            sessionId: id,
            configDir,
            cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
            pid: process.ppid,
            headless: process.env.AUTODEV_HEADLESS === '1',
            workerCode: process.env.AUTODEV_WORKER_CODE || null,
            transcriptPath: typeof payload.transcript_path === 'string' ? payload.transcript_path : null,
            startedAt: (existing && existing.startedAt) || null,
            refreshedAt: now,
            endedAt: null,
            endReason: null,
        };
        if (event === 'SessionStart') {
            // A start after an end is the same session resumed: it is live again.
            if (!rec.startedAt) rec.startedAt = now;
            writeRecord(file, rec);
            prune(Date.now());
        } else {
            rec.endedAt = now;
            rec.endReason = typeof payload.reason === 'string' ? payload.reason : null;
            writeRecord(file, rec);
        }
    } catch { /* a registry must never be the reason a session cannot start or end */ }
}

main();
