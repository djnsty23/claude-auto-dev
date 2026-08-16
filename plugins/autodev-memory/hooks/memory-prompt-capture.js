#!/usr/bin/env node
// UserPromptSubmit hook (autodev-memory) — stash the user's latest prompt so the
// observation classifier can use it.
//
// Why this exists: classifyObservation() takes the prompt and derives both the
// observation TYPE (decision / bugfix / gotcha / feature) and its concept text
// from it. It was wired to an `AUTO_DEV_LAST_PROMPT` environment variable that
// nothing ever set, so every observation ever captured fell back to a generic
// type and a generic concept string — and `mem decisions` / `mem bugs` returned
// almost nothing as a result.
//
// The prompt never leaves the machine: it goes to .claude/memory-sessions/,
// which the file-organization rule already keeps out of git, and SessionEnd
// deletes it. Anything wrapped in <private></private> is redacted first, matching
// what memory-db does before writing an observation.
//
// Must be cheap — it runs on every single user turn. Always exits 0.

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

try {
    let data;
    try {
        data = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        process.exit(0);
    }

    const prompt = data.prompt || '';
    if (!prompt) process.exit(0);

    const cwd = data.cwd || process.cwd();
    const harnessSessionId = data.session_id || null;

    const carrier = require(path.join(PLUGIN_ROOT, 'scripts', 'session-carrier.js'));

    // Only stash for a session memory is actually recording. No carrier means
    // node:sqlite was unavailable or SessionStart never ran — writing prompts to
    // disk that nothing will ever read is pure cost.
    if (!carrier.read(cwd, harnessSessionId)) process.exit(0);

    const redacted = prompt.replace(/<private>[\s\S]*?<\/private>/g, '[REDACTED]');
    carrier.writePrompt(cwd, harnessSessionId, redacted);
} catch (err) {
    process.stderr.write(`[Memory] prompt capture error: ${err.message}\n`);
}

// Emit nothing — this hook only records. Any stdout would land in Claude's context.
process.exit(0);
