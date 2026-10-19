#!/usr/bin/env node
/**
 * instruction-envelope - SessionStart: say so when the always-on instruction set is
 * over budget, has lost a required rule, or carries conflicting style directives.
 *
 * Nothing to say means ZERO bytes on stdout and stderr, and every path exits 0. The
 * measurement and the blocking preflight live in scripts/instruction-envelope.js. This
 * hook only reports: a session cannot fix its own rules before it starts, so a block
 * here would cost the user a session and fix nothing. The block belongs to the update
 * path (`instruction-envelope.js apply`), which refuses the change before it lands.
 *
 * THE LEDGER. Each start whose payload carries a session id also appends one row to
 * <config dir>/logs/instruction-envelope.jsonl: the session id, the start's source
 * (startup, resume, clear or compact), and whether the measured envelope was inside its
 * budget with no required rule missing and no style conflict. The scorecard's
 * instruction-window reads it to grade fresh sessions on every host profile. A live log
 * past ROTATE_BYTES becomes the single `.1` segment, so the history on disk stays
 * between one and two caps. A row that cannot be written is dropped silently.
 */
'use strict';
// The `instruction_envelope` switch (plugin userConfig) skips this hook: it advises, it never guards.
if (process.env.CLAUDE_PLUGIN_OPTION_INSTRUCTION_ENVELOPE === 'false') process.exit(0);

const fs = require('fs');
const path = require('path');

const ROTATE_BYTES = 1024 * 1024;

function readPayload() {
    try {
        const v = JSON.parse(fs.readFileSync(0, 'utf8'));
        return v && typeof v === 'object' ? v : {};
    } catch { return {}; }
}

function record(envelope, configDir, payload) {
    if (typeof payload.session_id !== 'string' || !payload.session_id) return;
    const r = envelope.measureEnvelope({ configDir });
    const row = {
        at: new Date().toISOString(),
        sessionId: payload.session_id,
        source: typeof payload.source === 'string' ? payload.source : null,
        inside: !r.over && !r.required.missing.length && !r.conflicts.length,
        rulesTotal: r.rulesTotal,
        budget: r.budget,
        envelopeTotal: r.envelopeTotal,
        missing: r.required.missing.length,
        conflicts: r.conflicts.length,
    };
    const dir = path.join(configDir, 'logs');
    const log = path.join(dir, 'instruction-envelope.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(log, JSON.stringify(row) + '\n', 'utf8');
    try { if (fs.statSync(log).size >= ROTATE_BYTES) fs.renameSync(log, `${log}.1`); } catch { /* another start rotated it */ }
}

try {
    const root = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
    const envelope = require(path.join(root, 'scripts', 'instruction-envelope.js'));
    const payload = readPayload();
    const line = envelope.hookLine(process.env);
    if (line) process.stdout.write(JSON.stringify({ systemMessage: line }) + '\n');
    try { record(envelope, require(path.join(root, 'scripts', 'claude-paths.js')).configDir(process.env), payload); } catch { /* the ledger is telemetry, never a reason to speak */ }
} catch { /* advisory: an unreadable profile is not a reason to speak or to block */ }
process.exitCode = 0;
