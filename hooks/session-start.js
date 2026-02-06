#!/usr/bin/env node
// SessionStart hook - Version display, env loading, checkpoint restore, sprint context, git status
// Updates are manual via 'update dev' command (no auto-pull for security)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HOME = process.env.HOME || process.env.USERPROFILE;
const CLAUDE_DIR = path.join(HOME, '.claude');

try {
    // ============================================================
    // 1. Display version (read from local install, no network)
    // ============================================================
    let version = '5.3';
    const manifestPath = path.join(CLAUDE_DIR, 'skills', 'manifest.json');
    if (fs.existsSync(manifestPath)) {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (manifest.version) version = manifest.version;
        } catch {}
    }
    console.log(`[Auto-Dev v${version}]`);

    // ============================================================
    // 2. Auto-source .env.local (project-isolated credentials)
    // ============================================================
    if (fs.existsSync('.env.local')) {
        const lines = fs.readFileSync('.env.local', 'utf8').split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;

            const eqIndex = trimmed.indexOf('=');
            if (eqIndex === -1) continue;

            const key = trimmed.substring(0, eqIndex).trim();
            let value = trimmed.substring(eqIndex + 1);
            value = value.replace(/^["']/, '').replace(/["']$/, '');

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
