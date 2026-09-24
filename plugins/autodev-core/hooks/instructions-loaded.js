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
 * The log is append-only JSONL, one line per load, capped by size rather than by
 * age so a machine left idle for a month does not lose its history.
 *
 * ROTATED, NEVER REWRITTEN. Every session appends to this one file. The cap used
 * to be a trim in place: read every line, keep the last 4,000, write them back.
 * A row another session appended between that read and that write was lost, and
 * past 4,000 lines every load re-read and rewrote the whole file. Now the load
 * that finds the log past ROTATE_BYTES renames it to a segment with a unique
 * name, and the next append starts a fresh file. A rename moves every byte, so
 * nothing written before it is lost, and two sessions rotating at once make two
 * segments rather than one overwriting the other. check-rules-reachable.js reads
 * the segments before the live log.
 */
'use strict';
// The `instructions_ledger` switch (plugin userConfig, CLAUDE_PLUGIN_OPTION_INSTRUCTIONS_LEDGER="false")
// skips this hook: it advises, it never guards. tooling/test-hooks-profile.js holds the list.
if (process.env.CLAUDE_PLUGIN_OPTION_INSTRUCTIONS_LEDGER === 'false') process.exit(0);


// A live log past this is rotated. Segments are kept newest first until they
// reach KEEP_BYTES, so the history on disk stays between about one and two caps.
const ROTATE_BYTES = 600 * 1024;
const KEEP_BYTES = 600 * 1024;
// check-rules-reachable.js reads the same pattern. test-instructions-loaded.js
// drives both, so a rename on one side fails there.
const SEGMENT = /^instructions-loaded\.\d{13}-\d+\.jsonl$/;

function rotate(fs, path, dir, log) {
    const { size } = fs.statSync(log);
    if (size < ROTATE_BYTES) return;
    const seg = path.join(dir, `instructions-loaded.${String(Date.now()).padStart(13, '0')}-${process.pid}.jsonl`);
    fs.renameSync(log, seg);
    let kept = 0;
    const segs = fs.readdirSync(dir).filter((n) => SEGMENT.test(n)).sort().reverse();
    for (const n of segs) {
        const p = path.join(dir, n);
        if (kept >= KEEP_BYTES) { try { fs.unlinkSync(p); } catch { /* another load pruned it */ } continue; }
        try { kept += fs.statSync(p).size; } catch { /* pruned meanwhile */ }
    }
}

function main() {
    const fs = require('fs');
    const path = require('path');
    const { configDir } = require('../scripts/claude-paths.js');

    let raw = '';
    try { raw = fs.readFileSync(0, 'utf8'); } catch { return; }
    if (!raw.trim()) return;

    let input;
    try { input = JSON.parse(raw); } catch { return; }

    const filePath = input && input.file_path;
    if (!filePath || typeof filePath !== 'string') return;

    const home = configDir();
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

    // One stat per load. The log is read only by the check, never here.
    try { rotate(fs, path, dir, log); } catch { /* a log that cannot be rotated is still a usable log */ }
}

try { main(); } catch { /* never fail a turn over telemetry */ }
process.exit(0);
