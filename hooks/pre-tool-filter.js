#!/usr/bin/env node
// PreToolUse hook - Security filtering and token optimization
// Blocks dangerous Bash commands and unnecessary file reads.
// Exit 2 = block, Exit 0 = allow

const fs = require('fs');

try {
    const input = fs.readFileSync(0, 'utf8');

    let data;
    try {
        data = JSON.parse(input);
    } catch {
        // Can't parse input, allow operation
        process.exit(0);
    }

    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};

    // Bash command filtering
    if (toolName === 'Bash') {
        const command = toolInput.command || '';
        if (!command) process.exit(0);

        const dangerousPatterns = [
            /rm\s+(-[a-z]*r[a-z]*\s+(-[a-z]*f|\/)|(-[a-z]*f[a-z]*\s+-[a-z]*r))/i,   // rm -rf, rm -r -f
            /rm\s+--recursive/i,                      // rm --recursive
            /find\s+\/\s+-delete/i,                    // find / -delete
            /dd\s+if=.*\/dev\//i,                      // dd if=/dev/zero
            /mkfs\./i,                                 // mkfs.ext4
            /chmod\s+-R\s+000\s+\//i,                  // chmod -R 000 /
            /git\s+reset\s+--hard/i,                   // git reset --hard
            /git\s+push\s+(--force|.*--force)/i,       // git push --force (any flag order)
            /git\s+clean\s+(-[a-z]*f|--force)/i,       // git clean -f, -fd, --force
            /git\s+checkout\s+(\.|--\s+\.)/i,          // git checkout .
            /git\s+restore\s+\./i,                     // git restore .
            /DROP\s+(TABLE|DATABASE)/i,                 // SQL injection
            /curl.*\|\s*(ba)?sh/i,                     // curl | bash (remote code exec)
            /wget.*\|\s*(ba)?sh/i,                     // wget | bash
        ];

        // Windows-specific dangerous patterns
        if (process.platform === 'win32') {
            dangerousPatterns.push(
                /format\s+c:/i,                        // format c:
                /del\s+\/s\s+\/q\s+c:/i,              // del /s /q c:
                /diskpart/i                            // diskpart (Windows disk utility)
            );
        }

        for (const pattern of dangerousPatterns) {
            if (pattern.test(command)) {
                process.stderr.write(`Blocked potentially dangerous command: ${command}\n`);
                process.exit(2);
            }
        }
    }

    // Read file filtering - skip large/generated files
    if (toolName === 'Read') {
        const filePath = toolInput.file_path || '';
        if (filePath) {
            const skipPatterns = [
                /node_modules/,
                /dist[/\\]/,
                /build[/\\]/,
                /\.git[/\\]/,
                /package-lock\.json/,
                /yarn\.lock/,
                /pnpm-lock\.yaml/,
                /\.next[/\\]/,
                /coverage[/\\]/,
                /\.turbo[/\\]/,
            ];

            for (const pattern of skipPatterns) {
                if (pattern.test(filePath)) {
                    process.stderr.write(`Skipping generated/large file: ${filePath} (use targeted search instead)\n`);
                    process.exit(2);
                }
            }
        }
    }

    // Allow operation
    process.exit(0);
} catch (err) {
    // Hook should never crash - allow on error
    process.stderr.write(`pre-tool-filter error: ${err.message}\n`);
    process.exit(0);
}
