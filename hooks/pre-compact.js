#!/usr/bin/env node
// PreCompact hook - Save prd.json before context compaction
// Backs up sprint state so it can be recovered if compaction loses context

const fs = require('fs');

try {
    if (fs.existsSync('prd.json')) {
        fs.mkdirSync('.claude', { recursive: true });
        fs.copyFileSync('prd.json', '.claude/pre-compact-state.json');
        console.log('[PreCompact] Saved prd.json to .claude/pre-compact-state.json');
    }
} catch (err) {
    process.stderr.write(`pre-compact error: ${err.message}\n`);
}

process.exit(0);
