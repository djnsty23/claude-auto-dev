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
                decision: 'REJECT',
                reason: `${remaining} tasks remaining. Next: ${nextTask}. Continue working.`
            }));
        } else {
            // No tasks but flag still active = IDLE detection phase
            process.stderr.write('[Auto-Dev] Sprint complete. Running IDLE detection...\n');
            console.log(JSON.stringify({
                decision: 'REJECT',
                reason: '[Auto-Dev] Sprint complete - running smart next action'
            }));
        }
    } else {
        // Not in auto mode - allow normal stop evaluation
        console.log(JSON.stringify({ ok: true }));
    }

    process.exit(0);
} catch (err) {
    // Hook should never crash - allow stop on error
    process.stderr.write(`stop-auto-check error: ${err.message}\n`);
    console.log(JSON.stringify({ ok: true }));
    process.exit(0);
}
