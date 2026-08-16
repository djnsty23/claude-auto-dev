#!/usr/bin/env node
// SessionStart hook (autodev-memory) — open a memory session and inject context
// carried over from previous sessions in this project.
//
// The session id is written to .claude/memory-session-id because hooks run as
// separate processes: an env var set here dies with this process, so the file
// is the cross-process carrier that memory-capture.js and memory-session-end.js
// read. Always exits 0.

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

try {
    const memDbPath = path.join(PLUGIN_ROOT, 'scripts', 'memory-db.js');
    if (fs.existsSync(memDbPath)) {
        const memDB = require(memDbPath);
        if (memDB.isAvailable()) {
            // Start a new memory session
            const sessionId = memDB.startSession(process.cwd());
            if (sessionId) {
                // Export session ID for other hooks to use
                process.env.AUTO_DEV_SESSION_ID = sessionId;
                // Write to a temp file so other hooks can read it
                const sessionFile = path.join(process.cwd(), '.claude', 'memory-session-id');
                try {
                    fs.mkdirSync(path.join(process.cwd(), '.claude'), { recursive: true });
                    fs.writeFileSync(sessionFile, sessionId);
                } catch { /* non-critical */ }
            }

            // Inject context from past sessions
            const context = memDB.getRecentContext(process.cwd(), 3);
            if (context.length > 0) {
                const stats = memDB.getStats(process.cwd());
                console.log(`[Memory] ${stats ? stats.totalObservations : '?'} observations across ${context.length}+ sessions`);
                const last = context[0];
                if (last.next_steps) {
                    console.log(`[Memory] Last next steps: ${last.next_steps.slice(0, 120)}`);
                }
                if (last.learned) {
                    console.log(`[Memory] Last learned: ${last.learned.slice(0, 120)}`);
                }
            }
        }
    }
} catch (err) {
    // Memory is non-critical — never block session start.
    process.stderr.write(`[Memory] session start error: ${err.message}\n`);
}

process.exit(0);
