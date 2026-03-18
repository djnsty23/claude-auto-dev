#!/usr/bin/env node
// Stop hook - Blocks stopping when auto mode is active.
// Checks for .claude/auto-active flag file.

const fs = require('fs');
const path = require('path');

try {
    const HOME = process.env.HOME || process.env.USERPROFILE;
    const autoFlag = path.join(HOME, '.claude', 'auto-active');

    // Stale flag cleanup (>2 hours old = crashed session)
    if (fs.existsSync(autoFlag)) {
        const flagStat = fs.statSync(autoFlag);
        const flagAgeMs = Date.now() - flagStat.mtimeMs;
        if (flagAgeMs > 2 * 60 * 60 * 1000) {
            fs.unlinkSync(autoFlag);
            process.stderr.write('[Auto-Dev] Removed stale auto-active flag (>2h old)\n');
        }
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
            const idleMarker = path.join(HOME, '.claude', 'auto-idle-triggered');
            if (fs.existsSync(idleMarker)) {
                // Already ran IDLE detection — allow stop to prevent infinite loop
                fs.unlinkSync(idleMarker);
                fs.unlinkSync(autoFlag);
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
