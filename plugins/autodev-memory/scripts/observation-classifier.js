#!/usr/bin/env node
// observation-classifier.js — decides which tool calls become observations.
// Used by hooks/memory-capture.js on every PostToolUse event.
//
// Rewritten 2026-09-08 from the measurement in
// docs/evidence-memory-recall-2026-09-08.md. The previous classifier recorded
// most Bash commands as `Ran: <command>`, test-shaped commands as `Tests
// passed`, file reads and greps as discoveries, and took BOTH the type and the
// concept from the user's last prompt. Read row by row, 90 % of the store was
// command echoes, the type was a keyword guess (88 of 143 "bugfix" rows were
// plain file creations), and the concept column held the prompt, including
// other sessions' messages. Nothing ever read any of it back.
//
// What is recorded now, and why only this:
//   - a Write or Edit of a file INSIDE the project. That is the one event whose
//     record is not already better kept by git, because it exists before the
//     commit does.
//   - type is what the tool did, not what the prompt said: every row is a
//     `change`. The other types stay valid in the database for rows written
//     deliberately through the API; capture no longer guesses them.
//   - concept is the edit itself (old → new, or the new file's path), never the
//     prompt. A prompt is the user's words about the whole task, not about this
//     edit, and it carried cross-session messages and production command lines
//     into a column that session-start injection would have replayed.
// Everything else returns null: Bash, Read, Grep, Glob, and any write that lands
// outside the project, in a scratchpad, in a probe directory, or in the memory
// directory (the memory file IS the memory; a row saying it was written is not).

const fs = require('fs');
const path = require('path');

const VALID_TYPES = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'];

// Path fragments that mark a write nobody needs a row for. Matched on a
// slash-normalised, lowercased path. `/scratchpad/` is the session scratch
// directory; `/.claude/probe/` is where suites plant probe files; the memory
// directory lives under `~/.claude/projects/<slug>/memory/`.
const EXCLUDED_FRAGMENTS = ['/scratchpad/', '/.claude/probe/', '/.claude/projects/'];

// Resolve symlinks on as much of the path as exists. A Write's target usually
// does not exist yet, and `realpathSync` on a missing path throws; falling back
// to the raw path then compares `/var/folders/...` against a cwd that resolved
// to `/private/var/folders/...`, and every new file looks outside the project.
// So the nearest existing ancestor is resolved and the missing tail re-attached.
function realpathOr(p) {
    let head = p;
    const tail = [];
    for (let i = 0; i < 64 && head; i++) {
        try {
            const real = fs.realpathSync(head);
            return tail.length ? path.join(real, ...tail) : real;
        } catch {
            const parent = path.dirname(head);
            if (parent === head) return p;
            tail.unshift(path.basename(head));
            head = parent;
        }
    }
    return p;
}

// True when the file belongs to the project the hook is running in. A relative
// path is taken as project-relative. With no cwd the location cannot be judged,
// so only the fragment exclusions apply.
function isProjectFile(filePath, cwd) {
    if (!filePath) return false;
    const norm = String(filePath).replace(/\\/g, '/').toLowerCase();
    if (EXCLUDED_FRAGMENTS.some((f) => norm.includes(f))) return false;
    if (!cwd || !path.isAbsolute(filePath)) return true;
    const rel = path.relative(realpathOr(cwd), realpathOr(filePath));
    if (!rel) return true;
    return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Classify a tool usage into an observation, or null to skip.
 *
 * @param {string} toolName - Write, Edit, Bash, Read, Grep, Glob, ...
 * @param {object} toolInput - the tool's input parameters
 * @param {string} toolResult - unused; kept so older callers still resolve
 * @param {object|string} context - `{ cwd }` of the session. A string here is
 *   the pre-2026-09-08 prompt argument and is ignored: the prompt no longer
 *   shapes an observation.
 * @returns {object|null}
 */
function classifyObservation(toolName, toolInput, toolResult, context) {
    if (!toolName) return null;
    if (toolName !== 'Write' && toolName !== 'Edit') return null;

    const cwd = context && typeof context === 'object' ? context.cwd : undefined;
    const filePath = (toolInput && (toolInput.file_path || toolInput.path)) || '';
    if (!isProjectFile(filePath, cwd)) return null;

    const fileName = path.basename(filePath);
    const shown = cwd && path.isAbsolute(filePath)
        ? path.relative(realpathOr(cwd), realpathOr(filePath)).replace(/\\/g, '/')
        : filePath;

    if (toolName === 'Write') {
        return {
            type: 'change',
            title: `Created ${fileName}`,
            concept: `New file: ${shown}`,
            sourceFiles: [filePath],
        };
    }

    const oldStr = String((toolInput && toolInput.old_string) || '').slice(0, 80);
    const newStr = String((toolInput && toolInput.new_string) || '').slice(0, 80);
    return {
        type: 'change',
        title: `Modified ${fileName}`,
        concept: oldStr || newStr ? `${oldStr} → ${newStr}` : `Edited ${shown}`,
        sourceFiles: [filePath],
    };
}

module.exports = { classifyObservation, isProjectFile, VALID_TYPES };
