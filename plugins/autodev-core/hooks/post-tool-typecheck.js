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
// hooks_profile=minimal (plugin userConfig, reaching hooks as
// CLAUDE_PLUGIN_OPTION_HOOKS_PROFILE) skips this hook: it advises, it never
// guards. tooling/test-hooks-profile.js holds the list of hooks that may.
if (/^minimal$/i.test(process.env.CLAUDE_PLUGIN_OPTION_HOOKS_PROFILE || process.env.CLAUDE_PLUGIN_OPTION_hooks_profile || '')) process.exit(0);

const fs = require('fs');
const path = require('path');

try {
    let data;
    try {
        data = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        process.exit(0);
    }
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
    if (!fs.existsSync('package.json')) process.exit(0);

    const dir = path.join(process.cwd(), '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, '.typecheck-pending'),
        edited.map((p) => path.resolve(p)).join('\n') + '\n');
} catch {
    // An accumulator that cannot write has nothing to say.
}
process.exit(0);
