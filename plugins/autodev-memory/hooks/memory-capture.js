#!/usr/bin/env node
// PostToolUse hook (autodev-memory) — classify each tool call into an observation
// and surface a domain-knowledge brief the first time an area is touched.
//
// Split out of autodev-core's post-tool-typecheck.js: memory is an optional
// plugin, so it owns its own hook rather than being a dead branch inside core.
// Always exits 0 — capture must never disturb the tool result.

const fs = require('fs');
const path = require('path');

// Resolve bundled scripts relative to THIS plugin, not ~/.claude.
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

try {
    const input = fs.readFileSync(0, 'utf8');

    let data;
    try {
        data = JSON.parse(input);
    } catch {
        process.exit(0);
    }

    const filePath = (data.tool_input && data.tool_input.file_path) || '';

    // ============================================================
    // Memory: Capture observation from tool usage
    // ============================================================
    try {
        const memDbPath = path.join(PLUGIN_ROOT, 'scripts', 'memory-db.js');
        const classifierPath = path.join(PLUGIN_ROOT, 'scripts', 'observation-classifier.js');

        if (fs.existsSync(memDbPath) && fs.existsSync(classifierPath)) {
            const memDB = require(memDbPath);
            const { classifyObservation } = require(classifierPath);

            if (memDB.isAvailable()) {
                // Hooks run as separate processes — the env var session-start sets dies
                // with its process. The session FILE it also writes is the cross-process
                // carrier; without this fallback no observation was ever captured.
                let sessionId = process.env.AUTO_DEV_SESSION_ID || null;
                if (!sessionId) {
                    try {
                        sessionId = fs.readFileSync(path.join(process.cwd(), '.claude', 'memory-session-id'), 'utf8').trim() || null;
                    } catch { /* no session file — capture skips quietly */ }
                }
                const toolName = data.tool_name || '';
                const toolInput = data.tool_input || {};
                const toolResult = (data.tool_output || '').slice(0, 500);
                const userPrompt = process.env.AUTO_DEV_LAST_PROMPT || '';

                const obs = classifyObservation(toolName, toolInput, toolResult, userPrompt);
                if (obs && sessionId) {
                    memDB.saveObservation({
                        sessionId,
                        projectPath: process.cwd(),
                        ...obs
                    });
                }
            }
        }
    } catch (memErr) {
        // Memory capture is non-critical — never block tool execution
        process.stderr.write(`[Memory] capture error: ${memErr.message}\n`);
    }

    // ============================================================
    // Memory: Auto-surface a domain-knowledge brief the FIRST time an
    // area is edited in a session (roadmap §3.2 auto-injection).
    // Own try/catch, after capture, so it can never disturb typecheck
    // or capture. Throttled to once per (session, area) via a small
    // state file so it computes at most one brief per area per session.
    // ============================================================
    try {
        // Derive the AREA from the edited file's directory relative to cwd,
        // capped to the first 1-2 path segments (e.g. src/auth/login.js →
        // "src/auth", hooks/x.js → "hooks"). Root-level files / empty / "."
        // are skipped to avoid noise.
        // LIMITATION (monorepo over-broadening): the 2-segment cap collapses a
        // monorepo's `packages/foo/src/auth/login.js` to just `packages/foo`, so
        // all of a package's areas share one throttle key and one brief. This is
        // a deliberate simplicity trade-off, not a bug — documented in
        // skills/knowledge-agent/SKILL.md.
        //
        // Both sides are resolved through realpath first. On macOS a project
        // reached via a symlinked path (/var/folders/... → /private/var/...,
        // /tmp → /private/tmp) makes cwd and file_path disagree, and every edit
        // then looks like it lands outside the project — silently disabling
        // knowledge surfacing for that session.
        const realpath = (p) => {
            try { return fs.realpathSync(p); } catch { return p; }
        };

        let area = '';
        if (filePath) {
            const rel = path
                .relative(realpath(process.cwd()), realpath(filePath))
                .replace(/\\/g, '/');
            if (rel && !rel.startsWith('..')) {
                const dir = path.posix.dirname(rel);
                if (dir && dir !== '.') {
                    area = dir.split('/').filter(Boolean).slice(0, 2).join('/');
                }
            }
        }

        if (area && area !== '.') {
            const memDbPath = path.join(PLUGIN_ROOT, 'scripts', 'memory-db.js');

            if (fs.existsSync(memDbPath)) {
                // Resolve session id the same way the capture block does.
                let sessionId = process.env.AUTO_DEV_SESSION_ID || null;
                if (!sessionId) {
                    try {
                        sessionId = fs.readFileSync(path.join(process.cwd(), '.claude', 'memory-session-id'), 'utf8').trim() || null;
                    } catch { /* no session file */ }
                }
                sessionId = sessionId || 'nosession';

                // THROTTLE — cheap state-file check FIRST. State file lives at
                // .claude/knowledge-surfaced, newline-separated "sessionId\tarea".
                const surfacedFile = path.join(process.cwd(), '.claude', 'knowledge-surfaced');
                const marker = `${sessionId}\t${area}`;
                let existing = '';
                let already = false;
                try {
                    existing = fs.readFileSync(surfacedFile, 'utf8');
                    already = existing.split('\n').includes(marker);
                } catch { /* no state file yet */ }

                if (!already) {
                    const memDB = require(memDbPath);
                    if (memDB.isAvailable()) {
                        const brief = memDB.knowledge(process.cwd(), area, 500);
                        if (brief && brief.total > 0) {
                            const g = brief.groups || {};
                            // Most relevant first: decisions, then gotchas, then bugfixes, then changes.
                            const items = [
                                ...(g.decisions || []),
                                ...(g.gotchas || []),
                                ...(g.bugfixes || []),
                                ...(g.changes || [])
                            ].slice(0, 3);
                            const trunc = (s) => {
                                s = String(s || '').replace(/\s+/g, ' ').trim();
                                return s.length > 100 ? s.slice(0, 97) + '...' : s;
                            };
                            const out = [
                                `[Memory] Domain knowledge for ${area} (${brief.total} note${brief.total === 1 ? '' : 's'}):`
                            ];
                            for (const r of items) {
                                let line = `[Memory]   - ${trunc(r.title)}`;
                                if (r.concept) line += `: ${trunc(r.concept)}`;
                                out.push(line.length > 140 ? line.slice(0, 137) + '...' : line);
                            }
                            process.stderr.write(out.join('\n') + '\n');
                        }
                        // Record the area as surfaced ONLY when knowledge() returned a
                        // real result object. A real empty result (total === 0) is still
                        // recorded so an empty area is not recomputed every edit this
                        // session; but a transient DB failure / broken circuit
                        // (brief === null) is NOT recorded, so the next edit can retry.
                        if (brief !== null) {
                            try {
                                fs.mkdirSync(path.join(process.cwd(), '.claude'), { recursive: true });
                                // Rewrite the throttle file to keep ONLY the CURRENT
                                // session's markers (drop other sessions' lines) before
                                // appending the new one. This bounds the file to this
                                // session's areas across restarts and matches the
                                // "session-specific" intent instead of growing unbounded.
                                const kept = existing
                                    .split('\n')
                                    .filter((l) => l && l.startsWith(sessionId + '\t'));
                                kept.push(marker);
                                fs.writeFileSync(surfacedFile, kept.join('\n') + '\n');
                            } catch { /* non-critical */ }
                        }
                    }
                }
            }
        }
    } catch { /* auto-injection is best-effort — never disturb the hook */ }
} catch (err) {
    process.stderr.write(`[Memory] capture hook error: ${err.message}\n`);
}

process.exit(0);
