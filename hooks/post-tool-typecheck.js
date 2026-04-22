#!/usr/bin/env node
// PostToolUse hook - Run typecheck after TypeScript/JavaScript edits + capture observations
// Always exits 0 (PostToolUse hooks inform, don't block)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
        const HOME = process.env.HOME || process.env.USERPROFILE;
        const memDbPath = path.join(HOME, '.claude', 'scripts', 'memory-db.js');
        const classifierPath = path.join(HOME, '.claude', 'scripts', 'observation-classifier.js');

        if (fs.existsSync(memDbPath) && fs.existsSync(classifierPath)) {
            const memDB = require(memDbPath);
            const { classifyObservation } = require(classifierPath);

            if (memDB.isAvailable()) {
                const sessionId = process.env.AUTO_DEV_SESSION_ID || null;
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

    // Only run typecheck for TypeScript/JavaScript files
    if (/\.(ts|tsx|js|jsx)$/.test(filePath)) {
        // Debounce: skip if last typecheck was <10 seconds ago
        const stampFile = '.claude/.typecheck-stamp';
        try {
            const stamp = fs.statSync(stampFile).mtimeMs;
            if (Date.now() - stamp < 10000) process.exit(0);
        } catch { /* no stamp file = never run */ }

        if (fs.existsSync('package.json')) {
            // Check if typecheck script exists
            let hasTypecheck = false;
            try {
                const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
                hasTypecheck = !!(pkg.scripts && pkg.scripts.typecheck);
            } catch (parseErr) {
                process.stderr.write(`[Typecheck] package.json parse error: ${parseErr.message}\n`);
                hasTypecheck = false;
            }

            if (hasTypecheck) {
                // Detect package manager from lockfile
                const pm = fs.existsSync('pnpm-lock.yaml') ? 'pnpm' :
                           fs.existsSync('yarn.lock') ? 'yarn' :
                           fs.existsSync('bun.lockb') ? 'bun' : 'npm';

                // Update debounce stamp
                try { fs.mkdirSync('.claude', { recursive: true }); fs.writeFileSync(stampFile, ''); } catch {}
                try {
                    execSync(`${pm} run typecheck`, {
                        timeout: 30000,
                        stdio: ['ignore', 'pipe', 'pipe']
                    });
                } catch (e) {
                    const output = (e.stdout ? e.stdout.toString() : '') +
                                   (e.stderr ? e.stderr.toString() : '');
                    if (output.trim()) {
                        console.log('\n[TYPECHECK FAILED] Fix these errors before continuing:');
                        console.log(output.trim());
                        console.log('');
                    }
                }
            }
        }
    }

    process.exit(0);
} catch (err) {
    // Hook should never crash
    process.stderr.write(`post-tool-typecheck error: ${err.message}\n`);
    process.exit(0);
}
