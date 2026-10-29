#!/usr/bin/env node
// PostToolUse hook — record a TypeScript/JavaScript edit for the Stop-time check.
//
// Until 2026-09-07 this hook ran `npm run typecheck` and then the linter ITSELF,
// after every Write and Edit, behind a 10 s debounce: up to 25 s + 25 s of
// blocking per edit. Its "[TYPECHECK FAILED]" banner went to stdout, and a
// PostToolUse hook's exit-0 stdout is transcript-only (Ctrl-R); only
// UserPromptSubmit and SessionStart stdout become context. So the expensive
// half ran on nearly every edit and the useful half was read by nobody.
//
// Measured against ECC's post-edit-accumulator + stop-format-typecheck pair
// (docs/evidence-ecc-comparison-2026-09-07.md): batching at Stop runs the check
// once per response instead of once per 10 s, and a Stop hook can answer
// `decision: block` with the errors as the reason, which the model does see.
// The no-op cost of this half is the cost of reading stdin and one existsSync;
// the old hook paid the same plus a stat of its debounce stamp.
//
// This half only appends the edited path to .claude/.typecheck-pending, one
// absolute path per line, and exits. hooks/stop-typecheck.js consumes the list.
// Always exits 0; every quiet path is zero bytes on both streams.
//
// The `typecheck` switch (plugin userConfig, reaching hooks as
// CLAUDE_PLUGIN_OPTION_TYPECHECK="false") skips this hook: it advises, it never
// guards. tooling/test-hooks-profile.js holds the list of hooks that may.
//
// ONE UNRELATED DUTY rides here because this is the only core hook already on
// Write: claiming an auto-mode flag the model just wrote. It runs BEFORE the
// typecheck switch, because it is not typecheck's to disable. See
// scripts/auto-flag.js for why the flag is keyed per session and why the claim
// must happen inside the same tool call rather than at the next Stop.

const fs = require('fs');
const path = require('path');

let data;
try {
    data = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
    process.exit(0);
}

try {
    const fp = data && data.tool_input && data.tool_input.file_path;
    const autoFlags = require(path.join(__dirname, '..', 'scripts', 'auto-flag.js'));
    if (autoFlags.isFlagPath(fp)) {
        autoFlags.claim(path.dirname(path.dirname(path.resolve(data.cwd || process.cwd(), fp))), autoFlags.sidOf(data));
    }
} catch { /* the Stop hook claims anything left over */ }

if (process.env.CLAUDE_PLUGIN_OPTION_TYPECHECK === 'false') process.exit(0);

// THE PROJECT IS THE PAYLOAD'S CWD, NOT OURS. A worker launched in a product's
// main checkout edits a worktree of it; the hook process still starts in the
// main checkout. Recording there made the Stop half typecheck a tree with no
// node_modules. projectRoot below resolves from the payload cwd, and
// stop-typecheck.js carries the same resolver, so both halves agree on where the
// list lives.
// <project-root>
// Kept as the same text in post-tool-typecheck.js and stop-typecheck.js;
// tooling/test-stop-typecheck.js compares the two copies.
/** The nearest ancestor of `start`, itself included, with a `.git` entry (a worktree's is a file). Null when none. */
function gitBoundary(start) {
    for (let dir = start; ; dir = path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, '.git'))) return dir;
        if (path.dirname(dir) === dir) return null;
    }
}
/**
 * The nearest package.json from the cwd up to the `.git` boundary, else the boundary. A
 * monorepo package keeps its own check, and no walk crosses into another checkout. With no
 * `.git` at all the cwd itself: an ancestor package.json there says nothing about this project.
 */
function projectRoot(cwd) {
    const start = path.resolve(typeof cwd === 'string' && cwd ? cwd : process.cwd());
    const boundary = gitBoundary(start);
    if (!boundary) return start;
    for (let dir = start; ; dir = path.dirname(dir)) {
        if (dir === boundary || fs.existsSync(path.join(dir, 'package.json'))) return dir;
    }
}
// </project-root>

try {
    const toolInput = (data && data.tool_input) || {};
    const paths = [];
    if (typeof toolInput.file_path === 'string') paths.push(toolInput.file_path);
    // MultiEdit shape: one payload, several files.
    if (Array.isArray(toolInput.edits)) {
        for (const e of toolInput.edits) if (e && typeof e.file_path === 'string') paths.push(e.file_path);
    }
    const edited = paths.filter((p) => /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(p));
    if (edited.length === 0) process.exit(0);

    // Restraint, kept from the old hook: a cwd with no package.json is not a
    // project this check can run in, and it must not grow a .claude/ directory
    // in every folder a JS file was ever edited from.
    const base = typeof data.cwd === 'string' && data.cwd ? data.cwd : process.cwd();
    const root = projectRoot(base);
    if (!fs.existsSync(path.join(root, 'package.json'))) process.exit(0);

    const dir = path.join(root, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, '.typecheck-pending'),
        edited.map((p) => path.resolve(base, p)).join('\n') + '\n');
} catch {
    // An accumulator that cannot write has nothing to say.
}
process.exit(0);
