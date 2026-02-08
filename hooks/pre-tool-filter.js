#!/usr/bin/env node
// PreToolUse hook - Security filtering and token optimization
// Blocks dangerous Bash commands and unnecessary file reads.
// Exit 2 = block, Exit 0 = allow

const fs = require('fs');

// Module-level constants — compiled once, reused on every tool call
const DANGEROUS_BASH_PATTERNS = [
    /rm\s+(-[a-z]*r[a-z]*\s+(-[a-z]*f|\/)|(-[a-z]*f[a-z]*\s+-[a-z]*r))/i,   // rm -rf, rm -r -f
    /rm\s+--recursive/i,                      // rm --recursive
    /rm\s+--force\s+--recursive/i,            // rm --force --recursive
    /rm\s+--force\s+-r/i,                     // rm --force -r
    /rm\s+-r\s+[^-]/i,                        // rm -r (without -f, still dangerous)
    /find\s+\/\s+-delete/i,                    // find / -delete
    /dd\s+if=.*\/dev\//i,                      // dd if=/dev/zero
    /mkfs\./i,                                 // mkfs.ext4
    /chmod\s+-R\s+000\s+\//i,                  // chmod -R 000 /
    /git\s+reset\s+--hard/i,                   // git reset --hard
    /git\s+push\s+(--force|-f\b|.*--force|.*\s-f\b)/i, // git push --force/-f (any flag order)
    /git\s+clean\s+(-[a-z]*f|--force)/i,       // git clean -f, -fd, --force
    /git\s+checkout\s+(\.|--\s+\.)/i,          // git checkout .
    /git\s+restore\s+\./i,                     // git restore .
    /git\s+stash\s+(drop|clear)/i,             // git stash drop/clear
    /git\s+branch\s+-D/,                        // git branch -D (force delete, case-sensitive)
    /DROP\s+(TABLE|DATABASE)/i,                 // SQL injection
    /curl.*\|\s*(ba)?sh/i,                     // curl | bash (remote code exec)
    /wget.*\|\s*(ba)?sh/i,                     // wget | bash
];

const DANGEROUS_WIN32_PATTERNS = [
    /format\s+c:/i,                            // format c:
    /del\s+\/s\s+\/q\s+c:/i,                  // del /s /q c:
    /diskpart/i,                               // diskpart (Windows disk utility)
];

const PROTECTED_FILE_PATTERNS = [
    /[/\\]\.claude[/\\]hooks[/\\]/,            // Hook scripts (security-critical)
    /[/\\]\.claude[/\\]settings\.json$/,        // Permission deny rules
];

const SKIP_READ_PATTERNS = [
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

        for (const pattern of DANGEROUS_BASH_PATTERNS) {
            if (pattern.test(command)) {
                process.stderr.write(`Blocked potentially dangerous command: ${command}\n`);
                process.exit(2);
            }
        }

        // Windows-specific dangerous patterns
        if (process.platform === 'win32') {
            for (const pattern of DANGEROUS_WIN32_PATTERNS) {
                if (pattern.test(command)) {
                    process.stderr.write(`Blocked potentially dangerous command: ${command}\n`);
                    process.exit(2);
                }
            }
        }
    }

    // Write/Edit protection - prevent Claude from modifying security-critical files
    if (toolName === 'Write' || toolName === 'Edit') {
        const filePath = toolInput.file_path || '';
        for (const pattern of PROTECTED_FILE_PATTERNS) {
            if (pattern.test(filePath)) {
                process.stderr.write(`Blocked: Cannot modify security-critical file: ${filePath}\nUse 'update dev' to sync from repo instead.\n`);
                process.exit(2);
            }
        }
    }

    // Read file filtering - skip large/generated files
    if (toolName === 'Read') {
        const filePath = toolInput.file_path || '';
        if (filePath) {
            for (const pattern of SKIP_READ_PATTERNS) {
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
