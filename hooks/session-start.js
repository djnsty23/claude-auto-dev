#!/usr/bin/env node
// SessionStart hook - Auto-update, env loading, checkpoint restore, sprint context, git status

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HOME = process.env.HOME || process.env.USERPROFILE;
const CLAUDE_DIR = path.join(HOME, '.claude');

// --- Helper: recursive directory copy ---
function copyDirRecursive(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        entry.isDirectory() ? copyDirRecursive(s, d) : fs.copyFileSync(s, d);
    }
}

try {
    // ============================================================
    // 1. Auto-update claude-auto-dev (with timeout for offline)
    // ============================================================
    const repoPathFile = path.join(CLAUDE_DIR, 'repo-path.txt');

    if (fs.existsSync(repoPathFile)) {
        const repoPath = fs.readFileSync(repoPathFile, 'utf8').trim();
        const gitDir = path.join(repoPath, '.git');

        if (fs.existsSync(gitDir)) {
            // Verify remote origin matches expected repo
            let result = 'skipped';
            try {
                const remoteUrl = execSync('git remote get-url origin', {
                    cwd: repoPath,
                    timeout: 5000,
                    stdio: ['ignore', 'pipe', 'pipe']
                }).toString().trim();

                if (remoteUrl && !remoteUrl.includes('claude-auto-dev')) {
                    process.stderr.write('[Auto-Dev] WARNING: Unexpected remote origin, skipping pull\n');
                    result = 'skipped';
                } else {
                    try {
                        result = execSync('git pull', {
                            cwd: repoPath,
                            timeout: 5000,
                            stdio: ['ignore', 'pipe', 'pipe']
                        }).toString().trim();
                    } catch {
                        result = 'timeout';
                    }
                }
            } catch {
                result = 'timeout';
            }

            // Read version
            let version = '5.0';
            const versionFile = path.join(repoPath, 'VERSION');
            if (fs.existsSync(versionFile)) {
                version = fs.readFileSync(versionFile, 'utf8').split('\n')[0].trim();
            }

            // Check if using copy mode (skills is a directory, not symlink)
            const skillsPath = path.join(CLAUDE_DIR, 'skills');
            let isSymlink = false;
            try {
                isSymlink = fs.lstatSync(skillsPath).isSymbolicLink();
            } catch {
                // Not found or error
            }

            if (result !== 'Already up to date.' &&
                !result.startsWith('Already up to date') &&
                result !== 'timeout' &&
                result !== 'skipped') {
                console.log(`[Auto-Dev] Updated to v${version}`);

                // If copy mode, re-copy skills and hooks
                if (!isSymlink) {
                    // Copy skills
                    const srcSkills = path.join(repoPath, 'skills');
                    if (fs.existsSync(srcSkills)) {
                        copyDirRecursive(srcSkills, path.join(CLAUDE_DIR, 'skills'));
                    }

                    // Copy hooks
                    const srcHooks = path.join(repoPath, 'hooks');
                    if (fs.existsSync(srcHooks)) {
                        for (const file of fs.readdirSync(srcHooks)) {
                            const s = path.join(srcHooks, file);
                            const d = path.join(CLAUDE_DIR, 'hooks', file);
                            if (fs.statSync(s).isFile()) {
                                fs.mkdirSync(path.dirname(d), { recursive: true });
                                fs.copyFileSync(s, d);
                            }
                        }
                    }

                    // Copy correct settings file
                    const settingsSource = process.platform === 'win32'
                        ? 'settings.json'
                        : 'settings-unix.json';
                    const srcSettings = path.join(repoPath, 'config', settingsSource);
                    if (fs.existsSync(srcSettings)) {
                        fs.copyFileSync(srcSettings, path.join(CLAUDE_DIR, 'settings.json'));
                    }

                    // Remove stale skill directories not in manifest
                    const manifestPath = path.join(repoPath, 'skills', 'manifest.json');
                    if (fs.existsSync(manifestPath)) {
                        try {
                            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                            const validSkills = new Set(Object.keys(manifest.skills || {}));
                            const destSkills = path.join(CLAUDE_DIR, 'skills');
                            for (const entry of fs.readdirSync(destSkills, { withFileTypes: true })) {
                                if (entry.isDirectory() && !validSkills.has(entry.name)) {
                                    fs.rmSync(path.join(destSkills, entry.name), { recursive: true, force: true });
                                    console.log(`[Auto-Dev] Removed stale skill: ${entry.name}`);
                                }
                            }
                        } catch {
                            // Silent fail on stale cleanup
                        }
                    }

                    console.log('[Auto-Dev] Skills/hooks/settings synced');
                }
            } else {
                console.log(`[Auto-Dev v${version}]`);
            }
        }
    } else {
        console.log('[Auto-Dev v5.0]');
    }

    // ============================================================
    // 2. Auto-source .env.local (project-isolated credentials)
    // ============================================================
    if (fs.existsSync('.env.local')) {
        const lines = fs.readFileSync('.env.local', 'utf8').split('\n');
        for (const line of lines) {
            // Skip comments and empty lines
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;

            // Split on first = only (preserves = in values like base64, JWT, URLs)
            const eqIndex = trimmed.indexOf('=');
            if (eqIndex === -1) continue;

            const key = trimmed.substring(0, eqIndex).trim();
            let value = trimmed.substring(eqIndex + 1);

            // Strip surrounding quotes from value
            value = value.replace(/^["']/, '').replace(/["']$/, '');

            // Only export valid variable names
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
                process.env[key] = value;
            }
        }
        console.log('[Env] .env.local loaded');
    }

    // ============================================================
    // 3. Check for checkpoint (context restore after /compact)
    // ============================================================
    if (fs.existsSync('.claude/checkpoint.md')) {
        console.log('');
        console.log('[Checkpoint Found] Restoring context...');
        const content = fs.readFileSync('.claude/checkpoint.md', 'utf8');
        const firstLines = content.split('\n').slice(0, 30).join('\n');
        console.log(firstLines);
        console.log('');
        console.log('---');
    }

    // ============================================================
    // 4. Sprint context from prd.json
    // ============================================================
    if (fs.existsSync('prd.json')) {
        try {
            const prd = JSON.parse(fs.readFileSync('prd.json', 'utf8'));
            const sprint = prd.sprint || '';
            const total = prd.completedStories || 0;
            const all = prd.totalStories || 0;
            const pending = all - total;
            if (sprint) {
                console.log(`[Sprint] ${sprint} | ${total} done, ${pending} pending`);
            }
        } catch {
            // Silent fail on prd.json parse
        }
    }

    // ============================================================
    // 5. Git status (brief)
    // ============================================================
    try {
        const gitStatus = execSync('git status --short', {
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe']
        }).toString().trim();

        if (gitStatus) {
            const changes = gitStatus.split('\n').length;
            console.log(`[Git] ${changes} uncommitted changes`);
        }
    } catch {
        // Not a git repo or git not available
    }

} catch (err) {
    // Hook should never crash
    process.stderr.write(`session-start error: ${err.message}\n`);
}
