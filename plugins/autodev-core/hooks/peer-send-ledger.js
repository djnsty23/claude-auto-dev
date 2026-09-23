#!/usr/bin/env node
'use strict';

// peer-send-ledger.js: record every peer message send and how the host said it
// was delivered, so a message that never got processed can be found later.
//
// WHY. A send that returns "queued" waits behind the target session's current
// turn. If that session stops before the turn ends, for example at its context
// limit, the message is never processed. The sender was told "queued", moved on,
// and nothing anywhere noticed. That has happened twice. The sender's transcript
// cannot answer it and the receiver's transcript is in a different id space, so
// this hook writes the one fact that joins them: target, message id, delivery
// state and a probe of the text. plugins/autodev-core/scripts/peer-queue-check.js
// reads the ledger and decides processed, pending or lost.
//
// WHAT IT PARSES. The tool's result text ends with
// `(delivery: <state>; message_id: <id>)`. PostToolUse delivers that result as
// `tool_response`, and the shape varies by tool and host version: a string, an
// array of content blocks, or an object wrapping either. Every string inside it
// is searched, and the last match wins. No match appends nothing.
//
// WHAT IT WRITES. One JSON line per send to
// `${AUTODEV_PEER_LEDGER || ~/.claude/autodev/peer-sends.jsonl}`:
//   { at, target, messageId, delivery, sha256, probe }
// `probe` is the first 80 characters of the message with whitespace collapsed.
//
// PRUNING. The append always happens. Then, when the file passes 1 MB, lines
// older than 7 days and unparseable lines are dropped. When what is left still
// passes 4 MB, the oldest lines go too, until it fits in 1 MB. The file is
// rewritten only when at least one line is dropped, so a busy week of recent
// sends costs a read per send and never a rewrite.
// The rewrite holds `<ledger>.lock`, created with the exclusive flag. A second
// session that finds the lock skips its prune, not its append. A lock older than
// a minute belongs to a pruner that died and is removed. Appends never take the
// lock, so any bytes appended between the read and the rename are copied onto
// the new file just before the rename. That shrinks the window in which a
// concurrent append can be lost to the gap between that copy and the rename.
//
// SILENT AND FAIL-OPEN, ALWAYS. It emits zero bytes on every path and exits 0
// on every error. A bookkeeping hook must never cost the sender a turn.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// A broken install is quiet, never loud: no helper, no opinion.
let configDir;
try { ({ configDir } = require('../scripts/claude-paths.js')); } catch { process.exit(0); }

const TOOL = 'mcp__ccd_session_mgmt__send_message';
const PROBE_CHARS = 80;
const PRUNE_BYTES = 1024 * 1024;
const HARD_BYTES = 4 * 1024 * 1024;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 60 * 1000;
const DELIVERY_RE = /\(delivery:\s*([A-Za-z_-]+);\s*message_id:\s*([^\s;)]+)\s*\)/g;

function ledgerPath() {
    return process.env.AUTODEV_PEER_LEDGER
        || path.join(configDir(), 'autodev', 'peer-sends.jsonl');
}

/**
 * Every string inside a tool_response, whatever its shape, depth-limited.
 * Object.values covers arrays too, so blocks and wrappers take one branch.
 */
function stringsIn(value, depth, out) {
    if (depth > 6 || out.length > 200) return out;
    if (typeof value === 'string') out.push(value);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) stringsIn(v, depth + 1, out);
    return out;
}

/** { delivery, messageId } from the last delivery marker in the response, or null. */
function parseDelivery(toolResponse) {
    let found = null;
    for (const s of stringsIn(toolResponse, 0, [])) {
        for (const m of s.matchAll(DELIVERY_RE)) found = { delivery: m[1], messageId: m[2] };
    }
    return found;
}

function probeOf(message) {
    return String(message).replace(/\s+/g, ' ').trim().slice(0, PROBE_CHARS);
}

/**
 * The open lock descriptor, or null when another prune holds a lock younger
 * than LOCK_STALE_MS. A stale lock is removed and the create is tried once more.
 */
function acquireLock(lock, nowMs) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try { return fs.openSync(lock, 'wx'); } catch (e) {
            if (!e || e.code !== 'EEXIST') return null;
        }
        let ageMs;
        try { ageMs = nowMs - fs.statSync(lock).mtimeMs; } catch { continue; }
        if (ageMs <= LOCK_STALE_MS) return null;
        try { fs.unlinkSync(lock); } catch { return null; }
    }
    return null;
}

/** The bytes of `file` from `start` to `end`. */
function readRange(file, start, end) {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(end - start);
        const n = fs.readSync(fd, buf, 0, buf.length, start);
        return buf.subarray(0, n);
    } finally { fs.closeSync(fd); }
}

/**
 * Once the ledger passes PRUNE_BYTES, drop lines older than KEEP_MS and lines
 * that do not parse. When the rest still passes HARD_BYTES, drop the oldest
 * until it fits in PRUNE_BYTES. Rewrite only when something was dropped.
 */
function pruneIfLarge(file, nowMs) {
    if (fs.statSync(file).size <= PRUNE_BYTES) return;
    const lock = file + '.lock';
    const lockFd = acquireLock(lock, nowMs);
    if (lockFd === null) return;
    const tmp = file + '.' + process.pid + '.tmp';
    try {
        const buf = fs.readFileSync(file);
        // Whole lines only. A line still being appended is carried over below.
        const end = buf.lastIndexOf(0x0a) + 1;
        let kept = [];
        let keptBytes = 0;
        let dropped = 0;
        for (const line of buf.toString('utf8', 0, end).split('\n')) {
            if (!line) continue;
            let row;
            try { row = JSON.parse(line); } catch { dropped++; continue; }
            const t = Date.parse(row && row.at);
            if (Number.isFinite(t) && nowMs - t <= KEEP_MS) {
                kept.push(line);
                keptBytes += Buffer.byteLength(line, 'utf8') + 1;
            } else dropped++;
        }
        if (keptBytes > HARD_BYTES) {
            let first = 0;
            while (first < kept.length && keptBytes > PRUNE_BYTES) {
                keptBytes -= Buffer.byteLength(kept[first], 'utf8') + 1;
                first++;
            }
            dropped += first;
            kept = kept.slice(first);
        }
        if (!dropped) return;
        fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
        const size = fs.statSync(file).size;
        if (size > end) fs.appendFileSync(tmp, readRange(file, end, size));
        fs.renameSync(tmp, file);
    } finally {
        try { fs.closeSync(lockFd); } catch { /* already closed */ }
        try { fs.unlinkSync(lock); } catch { /* already gone */ }
        try { fs.unlinkSync(tmp); } catch { /* renamed, or never written */ }
    }
}

function main(rawPayload) {
    let payload;
    try { payload = JSON.parse(rawPayload); } catch { return; }
    const name = payload && (payload.tool_name || payload.toolName);
    if (name !== TOOL) return;
    const input = (payload.tool_input || payload.toolInput) || {};
    if (typeof input.session_id !== 'string' || typeof input.message !== 'string' || !input.message) return;
    const response = payload.tool_response !== undefined ? payload.tool_response : payload.tool_output;
    const parsed = parseDelivery(response);
    if (!parsed) return;

    const now = new Date();
    const row = {
        at: now.toISOString(),
        target: input.session_id,
        messageId: parsed.messageId,
        delivery: parsed.delivery,
        sha256: crypto.createHash('sha256').update(input.message, 'utf8').digest('hex'),
        probe: probeOf(input.message),
    };
    const file = ledgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
    pruneIfLarge(file, now.getTime());
}

if (require.main === module) {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => {
        try { main(buf); } catch { /* fails open, always, with zero bytes */ }
        process.exitCode = 0;
    });
    process.stdin.on('error', () => { process.exitCode = 0; });
}

module.exports = { parseDelivery, probeOf, TOOL, PROBE_CHARS, KEEP_MS, PRUNE_BYTES, HARD_BYTES, LOCK_STALE_MS };
