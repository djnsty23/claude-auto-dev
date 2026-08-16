#!/usr/bin/env node
// SessionEnd hook (autodev-memory) — close the open memory session and record a
// summary of what the session accomplished.
//
// This runs on SessionEnd, NOT Stop. Stop fires at the end of every assistant
// turn: closing the session there ended it after turn one and deleted the
// session-id file, so every later turn's capture found no session and silently
// dropped its observation. A memory session must span the whole Claude session.
//
// Emits no decision payload — autodev-core owns the Stop decision. Exits 0.

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

try {
    const memDbPath = path.join(PLUGIN_ROOT, 'scripts', 'memory-db.js');
    const sessionFile = path.join(process.cwd(), '.claude', 'memory-session-id');

    if (fs.existsSync(memDbPath) && fs.existsSync(sessionFile)) {
        const memDB = require(memDbPath);
        const sessionId = fs.readFileSync(sessionFile, 'utf8').trim();

        if (sessionId && memDB.isAvailable()) {
            // Read prd.json for session summary context
            let summary = {};
            if (fs.existsSync('prd.json')) {
                try {
                    const prd = JSON.parse(fs.readFileSync('prd.json', 'utf8'));
                    const stories = prd.stories || {};
                    const entries = Object.entries(stories);
                    const done = entries.filter(([, v]) => v.passes === true);
                    const pending = entries.filter(([, v]) => v.passes !== true);
                    summary.completed = done.map(([k, v]) => `${k}: ${v.title}`).join('; ');
                    if (pending.length > 0) {
                        summary.nextSteps = `${pending.length} tasks remaining: ${pending.map(([k]) => k).join(', ')}`;
                    }
                } catch { /* non-critical */ }
            }

            memDB.endSession(sessionId, summary);

            // Clean up session file
            try { fs.unlinkSync(sessionFile); } catch {}
        }
    }
} catch (err) {
    // Memory close is non-critical — never interfere with stopping.
    process.stderr.write(`[Memory] session close error: ${err.message}\n`);
}

process.exit(0);
