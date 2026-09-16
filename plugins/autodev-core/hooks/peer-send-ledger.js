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
// When the file passes 1 MB, lines older than 7 days are pruned.
//
// SILENT AND FAIL-OPEN, ALWAYS. It emits zero bytes on every path and exits 0
// on every error. A bookkeeping hook must never cost the sender a turn.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL = 'mcp__ccd_session_mgmt__send_message';
const PROBE_CHARS = 80;
const PRUNE_BYTES = 1024 * 1024;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const DELIVERY_RE = /\(delivery:\s*([A-Za-z_-]+);\s*message_id:\s*([^\s;)]+)\s*\)/g;

function ledgerPath() {
    return process.env.AUTODEV_PEER_LEDGER
        || path.join(os.homedir(), '.claude', 'autodev', 'peer-sends.jsonl');
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

/** Drop lines older than KEEP_MS once the ledger passes PRUNE_BYTES. */
function pruneIfLarge(file, nowMs) {
    const size = fs.statSync(file).size;
    if (size <= PRUNE_BYTES) return;
    const kept = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const t = Date.parse(row && row.at);
        if (Number.isFinite(t) && nowMs - t <= KEEP_MS) kept.push(line);
    }
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
    fs.renameSync(tmp, file);
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

module.exports = { parseDelivery, probeOf, TOOL, PROBE_CHARS, KEEP_MS, PRUNE_BYTES };
