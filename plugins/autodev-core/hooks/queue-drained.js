#!/usr/bin/env node
/**
 * PostToolUse hook - after a `git commit`, report the options-protocol queue.
 *
 * The matcher in hooks.json is the TOOL name (Bash), so this fires on every Bash
 * call and has to gate on the command itself. Anything that is not a real commit
 * exits silently - a hook that narrates on every shell call gets muted, and a
 * muted hook catches nothing.
 *
 * Always exits 0. PostToolUse informs, it does not block, and a false positive
 * must never come between Andy and a commit that already succeeded.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// A real commit, not `git log`, not `git commit --dry-run`, not an echoed string.
// Non-greedy token skip so `git -C <path> commit` matches too - measured: an
// options-only pattern missed exactly that shape, which is the common one here.
const COMMIT_RE = /(^|[;&|]|\s)git\s+(?:\S+\s+)*?commit\b/;
const DRY_RUN_RE = /--dry-run\b/;

try {
    let raw = '';
    try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }

    let data;
    try { data = JSON.parse(raw); } catch { process.exit(0); }

    const command = (data.tool_input && data.tool_input.command) || '';
    if (!COMMIT_RE.test(command) || DRY_RUN_RE.test(command)) process.exit(0);

    const transcript = data.transcript_path || data.transcriptPath;
    if (!transcript || !fs.existsSync(transcript)) {
        // Say so rather than passing silently - an unreadable transcript is
        // "could not check", never "nothing to report".
        console.log('[queue] NOT RUN after commit - no readable transcript.');
        process.exit(0);
    }

    const { report } = require(path.join(__dirname, '..', 'scripts', 'check-queue-drained.js'));
    report(transcript);
} catch (err) {
    console.log(`[queue] NOT RUN after commit - ${err && err.message ? err.message : 'unknown error'}`);
}

process.exit(0);
