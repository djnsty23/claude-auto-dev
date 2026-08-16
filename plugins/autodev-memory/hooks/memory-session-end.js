#!/usr/bin/env node
// SessionEnd hook (autodev-memory) — close this session's memory session and
// record a summary of what it accomplished.
//
// This runs on SessionEnd, NOT Stop. Stop fires at the end of every assistant
// turn: closing the session there ended it after turn one and deleted the
// carrier file, so every later turn's observations were silently dropped. A
// memory session must span the whole Claude session.
//
// Emits no decision payload — autodev-core owns the Stop decision. Exits 0.

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

function readPayload() {
    try {
        if (process.stdin.isTTY) return {};
        return JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        return {};
    }
}

const payload = readPayload();
const cwd = payload.cwd || process.cwd();
const harnessSessionId = payload.session_id || null;

try {
    const memDbPath = path.join(PLUGIN_ROOT, 'scripts', 'memory-db.js');
    if (fs.existsSync(memDbPath)) {
        const carrier = require(path.join(PLUGIN_ROOT, 'scripts', 'session-carrier.js'));
        const sessionId = carrier.read(cwd, harnessSessionId);
        const memDB = require(memDbPath);

        if (sessionId && memDB.isAvailable()) {
            // Read prd.json for session summary context
            let summary = {};
            const prdPath = path.join(cwd, 'prd.json');
            if (fs.existsSync(prdPath)) {
                try {
                    const prd = JSON.parse(fs.readFileSync(prdPath, 'utf8'));
                    const entries = Object.entries(prd.stories || {});
                    const done = entries.filter(([, v]) => v.passes === true);
                    const pending = entries.filter(([, v]) => v.passes !== true && v.passes !== 'deferred');
                    summary.completed = done.map(([k, v]) => `${k}: ${v.title}`).join('; ');
                    if (pending.length > 0) {
                        summary.nextSteps = `${pending.length} tasks remaining: ${pending.map(([k]) => k).join(', ')}`;
                    }
                } catch { /* non-critical */ }
            }

            memDB.endSession(sessionId, summary);
        }

        // Clear only THIS session's carrier — other sessions on the same
        // project keep theirs.
        carrier.clear(cwd, harnessSessionId);
        carrier.clearPrompt(cwd, harnessSessionId);
    }
} catch (err) {
    // Memory close is non-critical — never interfere with session teardown.
    process.stderr.write(`[Memory] session close error: ${err.message}\n`);
}

process.exit(0);
