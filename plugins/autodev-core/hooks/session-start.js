#!/usr/bin/env node
// SessionStart hook — surface the version, the active sprint, and the working
// tree state at the top of a session.
//
// Output is structured deliberately:
//   systemMessage     → the one-line banner the user sees
//   additionalContext → the sprint state Claude should actually reason about
// Plain stdout is not a reliable channel for the second one.
//
// Updates are handled by Claude Code: /plugin marketplace update autodev

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

// Hooks are always piped JSON in production; the TTY guard keeps a manual
// `node session-start.js` from blocking forever on an interactive stdin.
function readPayload() {
    try {
        if (process.stdin.isTTY) return {};
        return JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        return {};
    }
}

const payload = readPayload();
const cwd = payload.cwd || process.cwd();

const context = [];
let banner = '';

try {
    // ---- Version (single source of truth: our own plugin.json) ----
    let version = '?';
    try {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')
        );
        if (manifest.version) version = manifest.version;
    } catch { /* banner degrades to v? — never worth failing over */ }
    banner = `Auto-Dev v${version}`;

    // ---- Sprint state from prd.json ----
    const prdPath = path.join(cwd, 'prd.json');
    if (fs.existsSync(prdPath)) {
        try {
            const prd = JSON.parse(fs.readFileSync(prdPath, 'utf8'));
            const stories = prd.stories || {};
            const entries = Object.entries(stories);
            const done = entries.filter(([, s]) => s.passes === true);
            const deferred = entries.filter(([, s]) => s.passes === 'deferred');
            const pending = entries.filter(([, s]) => s.passes !== true && s.passes !== 'deferred');

            const summary = `Sprint ${prd.sprint || '(unnamed)'}: ${done.length} done, ` +
                `${pending.length} pending, ${deferred.length} deferred.`;
            banner += ` | ${summary}`;

            context.push(`This project uses autodev's prd.json task system. ${summary}`);
            if (pending.length > 0) {
                const next = pending.slice(0, 3).map(([id, s]) => `${id} (${s.title || 'untitled'})`);
                context.push(`Next pending stories: ${next.join(', ')}${pending.length > 3 ? `, +${pending.length - 3} more` : ''}.`);
            }
        } catch (parseErr) {
            context.push(`prd.json exists but failed to parse: ${parseErr.message}. Fix it before running sprint commands.`);
        }
    }

    // ---- Working tree ----
    try {
        const gitStatus = execSync('git status --short', {
            cwd,
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe'],
        }).toString().trim();

        if (gitStatus) {
            const changes = gitStatus.split('\n').length;
            context.push(`Working tree has ${changes} uncommitted change${changes === 1 ? '' : 's'} at session start.`);
        }
    } catch { /* not a git repo, or git unavailable */ }

    // NOTE: two things used to happen here and no longer do.
    //
    // 1. `.env.local` was parsed into process.env. A hook runs in its own
    //    process, so those variables died with it — SessionStart hooks cannot
    //    set environment variables for the session (they must come from your
    //    shell profile or settings.json). It read a secrets file and printed
    //    "[Env] .env.local loaded" for no effect whatsoever.
    //
    // 2. The version number inside ~/.claude/projects/<slug>/memory/MEMORY.md
    //    was rewritten in place, using a guessed encoding of the project path.
    //    A dev tool has no business silently editing the user's memory files.
} catch (err) {
    process.stderr.write(`session-start error: ${err.message}\n`);
}

const out = {
    systemMessage: `[${banner}]`,
};
if (context.length > 0) {
    out.hookSpecificOutput = {
        hookEventName: 'SessionStart',
        additionalContext: context.join('\n'),
    };
}

process.stdout.write(JSON.stringify(out));

// Always exit 0 — SessionStart hooks inform, never block
process.exit(0);
