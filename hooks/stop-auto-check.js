#!/usr/bin/env node
// Stop hook - Blocks stopping when auto mode is active.
// Checks for .claude/auto-active flag file.

const fs = require('fs');
const path = require('path');

try {
    // ============================================================
    // Memory: Close session on stop
    // ============================================================
    try {
        const HOME = process.env.HOME || process.env.USERPROFILE;
        const memDbPath = path.join(HOME, '.claude', 'scripts', 'memory-db.js');
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
    } catch (memErr) {
        process.stderr.write(`[Memory] session close error: ${memErr.message}\n`);
    }

    // Flags are project-relative (matches what skills/auto/SKILL.md writes via Write tool).
    const autoFlag = path.join(process.cwd(), '.claude', 'auto-active');
    const exitFlag = path.join(process.cwd(), '.claude', 'auto-exit');
    const idleMarker = path.join(process.cwd(), '.claude', 'auto-idle-triggered');

    // Stale flag cleanup (>2 hours old = crashed session)
    try {
        const flagStat = fs.statSync(autoFlag);
        const flagAgeMs = Date.now() - flagStat.mtimeMs;
        if (flagAgeMs > 2 * 60 * 60 * 1000) {
            fs.unlinkSync(autoFlag);
            process.stderr.write('[Auto-Dev] Removed stale auto-active flag (>2h old)\n');
        }
    } catch {
        // Flag doesn't exist — no cleanup needed
    }

    // Explicit exit signal — user asked Claude to deactivate auto.
    // Claude can't rm the flag (sensitive-file prompt), so it creates auto-exit via Write tool.
    if (fs.existsSync(exitFlag)) {
        try { fs.unlinkSync(exitFlag); } catch {}
        try { fs.unlinkSync(autoFlag); } catch {}
        try { fs.unlinkSync(idleMarker); } catch {}
        process.stderr.write('[Auto-Dev] auto-exit signal received. Cleaning up and allowing stop.\n');
        console.log(JSON.stringify({ decision: 'approve' }));
        process.exit(0);
    }

    if (fs.existsSync(autoFlag)) {
        // Auto mode is active - count remaining tasks
        let remaining = 0;
        let nextTask = '';

        if (fs.existsSync('prd.json')) {
            try {
                const prd = JSON.parse(fs.readFileSync('prd.json', 'utf8'));
                if (prd.stories) {
                    const entries = Object.entries(prd.stories);
                    const pending = entries.filter(([, v]) => v.passes !== true);
                    remaining = pending.length;
                    if (pending.length > 0) {
                        nextTask = pending[0][0];
                    }
                }
            } catch (parseErr) {
                process.stderr.write(`[Auto-Dev] prd.json parse error: ${parseErr.message}\n`);
            }
        }

        if (remaining > 0) {
            // Tasks remain - block stop
            process.stderr.write(`[Auto-Dev] Auto mode active. ${remaining} tasks remaining. Continuing...\n`);
            console.log(JSON.stringify({
                decision: 'block',
                reason: `${remaining} tasks remaining. Next: ${nextTask}. Continue working.`
            }));
        } else if (fs.existsSync('prd.json')) {
            // All tasks done but flag active = IDLE detection (one chance)
            // Mark that IDLE detection has been triggered
            let idleExists = false;
            try { fs.statSync(idleMarker); idleExists = true; } catch {}
            if (idleExists) {
                // Already ran IDLE detection — allow stop to prevent infinite loop
                try { fs.unlinkSync(idleMarker); } catch {}
                try { fs.unlinkSync(autoFlag); } catch {}
                process.stderr.write('[Auto-Dev] IDLE detection already ran. Allowing stop.\n');
                console.log(JSON.stringify({ decision: 'approve' }));
            } else {
                fs.writeFileSync(idleMarker, new Date().toISOString());
                process.stderr.write('[Auto-Dev] Sprint complete. Running IDLE detection...\n');
                console.log(JSON.stringify({
                    decision: 'block',
                    reason: '[Auto-Dev] Sprint complete - running smart next action'
                }));
            }
        } else {
            // No prd.json and no tasks — allow stop
            fs.unlinkSync(autoFlag);
            process.stderr.write('[Auto-Dev] No tasks found. Cleaning up auto-active flag.\n');
            console.log(JSON.stringify({ decision: 'approve' }));
        }
    } else {
        // Not in auto mode - allow normal stop evaluation
        console.log(JSON.stringify({ decision: 'approve' }));
    }

    process.exit(0);
} catch (err) {
    // Hook should never crash - allow stop on error
    process.stderr.write(`stop-auto-check error: ${err.message}\n`);
    console.log(JSON.stringify({ decision: 'approve' }));
    process.exit(0);
}
