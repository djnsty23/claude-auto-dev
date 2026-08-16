#!/usr/bin/env node
// UserPromptSubmit hook — tell Claude when something new landed in the inbox.
//
// Fires on every prompt, so the budget is a readdir plus one stat per file.
// It never opens an image. Arrivals are announced with their age so Claude can
// judge whether a screenshot that landed 20 seconds ago relates to what you just
// typed, and Read it only then. Auto-injecting every arrival would cost about a
// thousand tokens per screenshot for the ones you did not mean.
//
// Silent when the inbox has nothing new, which is almost every turn.

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const DEADLINE_MS = 250;
const started = Date.now();

function done(context) {
    if (context) {
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
        }));
    }
    process.exit(0);
}

try {
    // Read stdin so the hook does not block, but nothing here needs the payload.
    try { if (!process.stdin.isTTY) fs.readFileSync(0, 'utf8'); } catch { /* fine */ }

    if (process.env.AUTODEV_INBOX_DISABLED === '1') done(null);

    const script = path.join(PLUGIN_ROOT, 'scripts', 'inbox-watch.js');
    if (!fs.existsSync(script)) done(null);

    // In-process, not a subprocess: spawning a second Node to read one directory
    // measured 56ms per prompt against 31ms for importing it, and that cost is
    // paid on every turn whether or not anything arrived.
    let out = '';
    try {
        const inbox = require(script);
        out = inbox.check();
        // Claim immediately: announce each arrival ONCE. Re-announcing until the
        // user acts would add ~250 tokens to every subsequent turn for as long as
        // the file sits there. The announcement stays in the conversation, so
        // Claude can still act on it later; `/inbox` re-lists on demand.
        if (out) { try { inbox.claim(); } catch { /* unwritable inbox */ } }
    } catch {
        done(null);   // inbox missing, slow disk, iCloud stalled — never block a prompt
    }

    if (!out || !out.trim()) done(null);

    done(
        out.trim() +
        '\n\nThese arrived out of band (phone screenshot, drop folder). Read one only if it ' +
        'plausibly relates to what the user just asked — judge by the arrival age above. ' +
        'Do not read them all speculatively; each image costs roughly a thousand tokens.'
    );
} catch (err) {
    process.stderr.write(`inbox-notify error: ${err.message}\n`);
    process.exit(0);
}
