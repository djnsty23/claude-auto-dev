#!/usr/bin/env node
// SessionStart hook (autodev-memory) — open a memory session and inject context
// carried over from previous sessions in this project.
//
// The memory session id is handed to the other hooks through a file keyed by the
// harness session id; see scripts/session-carrier.js for why it cannot be an
// environment variable. Always exits 0.

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

const context = [];

try {
    const memDbPath = path.join(PLUGIN_ROOT, 'scripts', 'memory-db.js');
    if (fs.existsSync(memDbPath)) {
        const memDB = require(memDbPath);

        if (memDB.isAvailable()) {
            const carrier = require(path.join(PLUGIN_ROOT, 'scripts', 'session-carrier.js'));

            const sessionId = memDB.startSession(cwd);
            if (sessionId) {
                try {
                    carrier.write(cwd, harnessSessionId, sessionId);
                } catch { /* non-critical — capture will no-op for this session */ }
            }

            // Carry forward what the last few sessions ended with.
            const recent = memDB.getRecentContext(cwd, 3);
            if (recent.length > 0) {
                const stats = memDB.getStats(cwd);
                context.push(
                    `Project memory: ${stats ? stats.totalObservations : '?'} observations across ` +
                    `${recent.length}+ previous sessions. Use /mem-search to query it.`
                );
                const last = recent[0];
                if (last.next_steps) context.push(`Last session's next steps: ${last.next_steps.slice(0, 300)}`);
                if (last.learned) context.push(`Last session learned: ${last.learned.slice(0, 300)}`);
            }
        }
    }
} catch (err) {
    // Memory is non-critical — never block session start.
    process.stderr.write(`[Memory] session start error: ${err.message}\n`);
}

if (context.length > 0) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: context.join('\n'),
        },
    }));
}

process.exit(0);
