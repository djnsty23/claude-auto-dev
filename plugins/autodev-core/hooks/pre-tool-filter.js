#!/usr/bin/env node
// PreToolUse hook - Security filtering and token optimization
// Blocks dangerous Bash commands and unnecessary file reads.
// Exit 2 = block, Exit 0 = allow

const fs = require('fs');
const path = require('path');

// Module-level constants — compiled once, reused on every tool call

// Dev cache directories — safe to rm -r. Matched before DANGEROUS_BASH_PATTERNS.
const SAFE_RM_TARGETS = [
    '.next', '.turbo', '.nuxt', '.svelte-kit', '.vite', '.parcel-cache',
    'dist', 'build', 'out', 'coverage', '.cache',
    'node_modules/.cache', 'node_modules\\.cache',
    '.tsbuildinfo', 'tsconfig.tsbuildinfo',
];

// Match `rm -rf .next`, `rm -r ./dist`, `rm -rf node_modules/.cache`, etc.
// Accepts optional ./ prefix, trailing slash, and chained safe targets.
const SAFE_RM_REGEX = new RegExp(
    '^\\s*rm\\s+-[rRf]+\\s+((\\.\\/)?(?:' +
    SAFE_RM_TARGETS.map(t => t.replace(/[.\\]/g, '\\$&')).join('|') +
    ')[\\\\/]?\\s*)+$', 'i'
);

const DANGEROUS_BASH_PATTERNS = [
    /rm\s+(-[a-z]*r[a-z]*\s+(-[a-z]*f|\/)|(-[a-z]*f[a-z]*\s+-[a-z]*r))/i,   // rm -rf, rm -r -f
    /rm\s+-[rRf]+\s+~\/?(\s|$)/,              // rm -rf ~ / ~/   (home dir wipe)
    /rm\s+--recursive/i,                      // rm --recursive
    /rm\s+--force\s+--recursive/i,            // rm --force --recursive
    /rm\s+--recursive\s+--force/i,            // rm --recursive --force
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
    /git\s+restore\s+(--staged\s+)?\./i,        // git restore . and git restore --staged .
    /git\s+stash\s+(drop|clear)/i,             // git stash drop/clear
    /git\s+branch\s+-D/,                        // git branch -D (force delete, case-sensitive)
    /DROP\s+(TABLE|DATABASE)/i,                 // SQL injection
    // Fetch-and-execute. Anchored to command start or a chain operator: this
    // hook only ever sees command TEXT, so an unanchored rule cannot tell
    // running `curl … | bash` from grepping for the string "curl | bash".
    // The unanchored version blocked a maintainer searching for it by name.
    /(?:^|[;&|]\s*)(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i,
    /(?:^|[;&|]\s*)(bash|sh)\s+-c\b/i,             // bash -c / sh -c at command start or after chain (not inside quoted args)
    /(?:^|[;&|]\s*)eval\s/i,                   // eval at command start or after chain operator
    // `node -e` is a real escape hatch, but only when the CODE comes from
    // somewhere untrusted. Blocking it after any pipe made `cat x.json | node -e
    // 'parse'` — an everyday read-only idiom — impossible, which is how this
    // hook blocked its own maintainers. Block it at command start, and after a
    // pipe only when the upstream is a network fetch.
    /(?:^|[;&]\s*)node\s+(-e|--eval|-p|--print)\b/i,
    /\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?node\s+(-e|--eval|-p|--print)\b/i,
    /(?:^|[;&|]\s*)npx\s+(?!tsc\b|tsx\b|supabase\b|vercel\b|next\b|vite\b|vitest\b|jest\b|playwright\b|eslint\b|prettier\b|npm-check-updates\b|axe-core-cli\b|@next\/bundle-analyzer\b|lighthouse\b|netlify\b|remotion\b|shadcn\b|shadcn-ui\b|create-next-app\b|prisma\b)/i, // npx at command start or after chain operator (not inside quoted strings)
    /rm\s.*prd-archive/i,                      // NEVER delete prd archives (move instead)
    /rm\s.*prd-backup/i,                       // NEVER delete prd backups (move instead)
    /del\s.*prd-archive/i,                     // Windows: NEVER delete prd archives
    /del\s.*prd-backup/i,                      // Windows: NEVER delete prd backups
    /Remove-Item\s.*prd-archive/i,             // PowerShell: NEVER delete prd archives
    /Remove-Item\s.*prd-backup/i,              // PowerShell: NEVER delete prd backups
    /(cp|mv)\s+.*\.claude[/\\](hooks|settings)/i, // Block cp/mv targeting security-critical files
];

const DANGEROUS_WIN32_PATTERNS = [
    /format\s+c:/i,                            // format c:
    /del\s+\/s\s+\/q\s+c:/i,                  // del /s /q c:
    /diskpart/i,                               // diskpart (Windows disk utility)
];

const PROTECTED_FILE_PATTERNS = [
    /[/\\]\.claude[/\\]hooks[/\\]/,            // Project/global hook scripts
    /[/\\]\.claude[/\\]settings\.json$/,        // Permission deny rules
    // Installed plugin trees — hooks and their registration moved here in 8.0,
    // so without this the patterns above stopped protecting any hook that
    // actually runs. Scoped to the INSTALL location on purpose: editing a
    // plugin's source in its own repo is ordinary development, not tampering.
    /[/\\]\.claude[/\\]plugins[/\\]/,
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
        // Can't parse input — block to be safe (fail-closed)
        process.stderr.write('pre-tool-filter: failed to parse hook input, blocking operation\n');
        process.exit(2);
    }

    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};

    // Bash command filtering
    if (toolName === 'Bash') {
        const command = toolInput.command || '';
        if (!command) process.exit(0);

        // Allow `rm -r/-rf` on known dev cache dirs (.next, dist, coverage, etc.)
        // Checked before dangerous patterns so it overrides the generic `rm -r` deny.
        if (SAFE_RM_REGEX.test(command)) {
            process.exit(0);
        }

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
                process.stderr.write(`Blocked: Cannot modify security-critical file: ${filePath}\nInstalled plugin files are managed by Claude Code — edit them in the source repo and run /plugin marketplace update.\n`);
                process.exit(2);
            }
        }
    }

    // Private-name leak protection, at WRITE time rather than at validate time.
    //
    // tooling/check-no-private-names.js already gates this, but only when it is
    // invoked. On 2026-08-16 a handoff doc naming three private repos was
    // written, validated (the file was untracked, so the gate could not see it),
    // added and PUSHED to a public remote. The gate was correct and still ran
    // after the leak. This block moves the same list to the moment of the write.
    //
    // SCOPED, NOT GLOBAL — the part that took the most care. This hook fires in
    // every project; the denylist belongs to one. Writing a private repo's own
    // name inside that repo is normal work, and a global version of this check would
    // block legitimate writes in three active production repos. So: walk up from
    // the target file looking for that repo's OWN check script, and do nothing
    // if there isn't one.
    //
    // The list is READ FROM that script rather than copied here, so the hook and
    // the gate cannot drift apart. Adding a name to NAMES arms both at once.
    //
    // FAIL OPEN, unlike the rest of this hook. Everything above fails closed,
    // because a filter that cannot read its input must not pass a dangerous
    // command. This block is the reverse case: it is defence-in-depth in front
    // of a gate that still runs, and it ships inside an INSTALLED plugin, so a
    // defect here blocks every write in every project until the user reinstalls.
    // That is not hypothetical — during development a missing `require('path')`
    // hit the outer fail-closed handler and blocked every write in this repo,
    // reporting a plausible +2.3ms cost for a code path that only ever crashed.
    // Backstop present, blast radius large: skip the check, say so, let it pass.
    if (toolName === 'Write' || toolName === 'Edit') {
        const filePath = toolInput.file_path || '';
        const content = toolInput.content || toolInput.new_string || '';
        try {
            if (filePath && content) {
                let dir = path.dirname(path.resolve(filePath));
                let checker = null;
                for (let i = 0; i < 40; i++) {
                    const candidate = path.join(dir, 'tooling', 'check-no-private-names.js');
                    if (fs.existsSync(candidate)) { checker = candidate; break; }
                    const up = path.dirname(dir);
                    if (up === dir) break;
                    dir = up;
                }
                // The denylist file IS the list; editing it must not trip on itself.
                if (checker && path.resolve(filePath) !== checker) {
                    const listSrc = fs.readFileSync(checker, 'utf8');
                    const block = listSrc.match(/const NAMES = \[([\s\S]*?)\]/);
                    const names = block ? [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
                    if (names.length) {
                        const hit = new RegExp('\\b(' + names.join('|') + ')\\b', 'i').exec(content);
                        if (hit) {
                            process.stderr.write(
                                `Blocked: this write puts the private project name "${hit[1]}" into `
                                + `${path.relative(dir, path.resolve(filePath))}, which is a PUBLIC repo.\n`
                                + `Anonymise it (Project A/B/C, keeping the numbers and the product shape), or add\n`
                                + `a reviewed exemption to ALLOW in tooling/check-no-private-names.js.\n`);
                            process.exit(2);
                        }
                    }
                }
            }
        } catch (err) {
            process.stderr.write(
                `pre-tool-filter: private-name check skipped (${err.message}); `
                + `tooling/check-no-private-names.js still gates this at validate time\n`);
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
    // Hook should never crash - fail closed on error
    process.stderr.write(`pre-tool-filter error (blocking): ${err.message}\n`);
    process.exit(2);
}
