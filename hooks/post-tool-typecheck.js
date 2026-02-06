#!/usr/bin/env node
// PostToolUse hook - Run typecheck after TypeScript/JavaScript edits
// Always exits 0 (PostToolUse hooks inform, don't block)

const fs = require('fs');
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

    // Only run typecheck for TypeScript/JavaScript files
    if (/\.(ts|tsx|js|jsx)$/.test(filePath)) {
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
                try {
                    execSync('npm run typecheck', {
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
