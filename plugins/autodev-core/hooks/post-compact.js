#!/usr/bin/env node
// PostCompact hook — fires after Claude Code compacts the conversation context.
// Pairs with pre-compact.js (which saves prd.json snapshot beforehand).
//
// Compaction discards mid-conversation state inside the model. This hook
// outputs a brief system message guiding Claude to re-orient by reading
// the snapshot + active sprint context before continuing work.
//
// Registered on the PostCompact event. Pre-8.0 it was registered as PostToolUse
// with matcher "compact", which never fired.

const fs = require('fs');
const path = require('path');

try {
    const lines = ['[PostCompact] Context was compacted. To resume work:'];

    const snapshotPath = path.join('.claude', 'pre-compact-state.json');
    if (fs.existsSync(snapshotPath)) {
        lines.push(`  - Read ${snapshotPath} for the prd.json snapshot saved pre-compact`);
        lines.push('  - Find the in-progress story (passes: null) and continue from there');
    } else if (fs.existsSync('prd.json')) {
        lines.push('  - Re-read prd.json for the active sprint and any in-progress story');
    } else {
        lines.push('  - No prd.json in this directory; re-read CLAUDE.md and ask the user where work was paused');
    }

    if (fs.existsSync('.claude/agent-memory')) {
        lines.push('  - Project memory at .claude/agent-memory/ may contain prior decisions worth re-reading');
    }

    console.log(lines.join('\n'));
} catch (err) {
    process.stderr.write(`post-compact error: ${err.message}\n`);
}

process.exit(0);
