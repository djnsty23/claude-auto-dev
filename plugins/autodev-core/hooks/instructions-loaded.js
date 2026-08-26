#!/usr/bin/env node
/**
 * instructions-loaded - record which instruction files actually reached context.
 *
 * WHY. This repo shipped 8.103.0 "the rules that could never load" and 8.104.0
 * "nine always-on rules with nothing to load them". A rule that never loads is
 * the worst kind of defect in a rules system: it is invisible from the inside,
 * because everything about it looks correct. The file exists, its frontmatter
 * parses, its content is good, and it silently contributes nothing. No error, no
 * diff, no failing test. The only observable is its absence from context, and
 * nothing was watching for that.
 *
 * The InstructionsLoaded hook is the missing observable. It fires per file as
 * CLAUDE.md and .claude/rules/*.md reach context, carrying the path and WHY it
 * loaded. This hook writes that down. `check-rules-reachable.js` reads the log
 * back and compares it against what exists on disk.
 *
 * WHAT THIS HOOK DELIBERATELY DOES NOT DO.
 *
 *   It never blocks. The hook's own contract says its exit code is ignored, so
 *   pretending otherwise would be theatre.
 *
 *   It emits ZERO BYTES on stdout and stderr, always. It fires once per
 *   instruction file per session, which on a repo with several rules is many
 *   invocations before the user has typed anything. A hook with something to say
 *   on every one of those is a hook that gets disabled. The finding belongs in
 *   the check that reads the log, not here.
 *
 *   It never fails the turn. Every path is wrapped and exits 0. A logger that
 *   can break a session is worse than no logger, and this one runs at the
 *   earliest possible moment, before the user can react to anything going wrong.
 *
 * The log is append-only JSONL, one line per load, capped by line count rather
 * than by age so a machine left idle for a month does not lose its history.
 */
'use strict';

const MAX_LINES = 4000;

function main() {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    let raw = '';
    try { raw = fs.readFileSync(0, 'utf8'); } catch { return; }
    if (!raw.trim()) return;

    let input;
    try { input = JSON.parse(raw); } catch { return; }

    const filePath = input && input.file_path;
    if (!filePath || typeof filePath !== 'string') return;

    const home = process.env.CLAUDE_CONFIG_DIR
        || path.join(os.homedir(), '.claude');
    const dir = path.join(home, 'logs');
    const log = path.join(dir, 'instructions-loaded.jsonl');

    // Record the file's own shape alongside the load, so the check can tell an
    // unconditional rule from a path-scoped one WITHOUT re-reading the file
    // later. By then the file may have changed, and a claim about "what loaded"
    // has to describe the thing that loaded, not its successor.
    const content = typeof input.file_content === 'string' ? input.file_content : '';
    const head = content.slice(0, 2000);
    const scoped = /^---[\s\S]*?^\s*paths:/m.test(head);

    const row = {
        at: new Date().toISOString(),
        file: filePath,
        reason: input.load_reason || null,
        scoped,
        bytes: content.length,
        cwd: input.cwd || process.cwd(),
    };

    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(log, JSON.stringify(row) + '\n', 'utf8');
    } catch { return; }

    // Trim opportunistically and cheaply. Reading the whole file on every load
    // would make a large log quadratic, so only look when it is plausibly big.
    try {
        const { size } = fs.statSync(log);
        if (size < 600 * 1024) return;
        const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
        if (lines.length <= MAX_LINES) return;
        fs.writeFileSync(log, lines.slice(-MAX_LINES).join('\n') + '\n', 'utf8');
    } catch { /* a log that cannot be trimmed is still a usable log */ }
}

try { main(); } catch { /* never fail a turn over telemetry */ }
process.exit(0);
