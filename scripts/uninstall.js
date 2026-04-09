#!/usr/bin/env node
// uninstall.js — Surgical uninstall for claude-auto-dev
// Prefers the sidecar (.auto-dev-installed.json) written by sync.js.
// Falls back to manifest-driven removal when no sidecar exists.
//
// Usage: node scripts/uninstall.js [--repo <path>] [--dest <path>] [--dry-run]

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const hasFlag = (n) => args.includes(n);
const getArg = (n) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : null; };

const home = process.env.HOME || process.env.USERPROFILE;
const dest = getArg('--dest') || path.join(home, '.claude');
const dryRun = hasFlag('--dry-run');

let repo = getArg('--repo');
if (!repo) {
    const repoPathFile = path.join(dest, 'repo-path.txt');
    if (fs.existsSync(repoPathFile)) repo = fs.readFileSync(repoPathFile, 'utf8').trim();
}
if (!repo) repo = path.resolve(__dirname, '..');

const prefix = dryRun ? '[DRY-RUN] ' : '';
let removed = 0;
let kept = 0;

function log(msg) { console.log(prefix + msg); }

function removePath(p, label) {
    try {
        const stat = fs.lstatSync(p, { throwIfNoEntry: false });
        if (!stat) return false;
        if (!dryRun) {
            if (stat.isDirectory() && !stat.isSymbolicLink()) {
                fs.rmSync(p, { recursive: true, force: true });
            } else {
                fs.rmSync(p, { force: true });
            }
        }
        log('removed ' + label);
        removed++;
        return true;
    } catch (e) {
        console.log('[WARN] failed to remove ' + label + ': ' + e.message);
        return false;
    }
}

function removeEmptyDir(p, label) {
    try {
        if (!dryRun && fs.existsSync(p) && fs.readdirSync(p).length === 0) {
            fs.rmdirSync(p);
            log('removed empty ' + label);
        }
    } catch {}
}

console.log('Claude Auto-Dev — surgical uninstall');
console.log('  dest: ' + dest);
if (dryRun) console.log('  MODE: dry-run');
console.log('');

// -------- Prefer the sidecar --------
const sidecarPath = path.join(dest, '.auto-dev-installed.json');
let sidecar = null;
try { sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')); } catch {}

// Collect the set of "owned hook files" from the repo (for settings.json cleanup
// below — settings references are by filename, not by sidecar relPath).
let ownedHookFileNames = new Set();
try {
    for (const f of fs.readdirSync(path.join(repo, 'hooks'))) {
        if (f.endsWith('.js')) ownedHookFileNames.add(f);
    }
} catch {}

if (sidecar && sidecar.items && Object.keys(sidecar.items).length > 0) {
    console.log('[Uninstall] Using install sidecar (v' + (sidecar.version || '?') + ', ' + Object.keys(sidecar.items).length + ' items)');
    for (const [rel] of Object.entries(sidecar.items)) {
        removePath(path.join(dest, rel), rel);
    }
    // Derive hook file names from sidecar too, in case repo/hooks is unavailable
    for (const rel of Object.keys(sidecar.items)) {
        if (rel.startsWith('hooks/') && rel.endsWith('.js')) {
            ownedHookFileNames.add(path.basename(rel));
        }
    }
} else {
    // -------- Fallback: manifest-driven (legacy installs with no sidecar) --------
    console.log('[Uninstall] No sidecar found — falling back to manifest-driven removal');
    console.log('  repo: ' + repo);

    let ownedSkills = new Set();
    let deprecatedSkills = new Set();
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'skills', 'manifest.json'), 'utf8'));
        ownedSkills = new Set(Object.keys(manifest.skills || {}));
        deprecatedSkills = new Set(manifest.deprecated || []);
    } catch (e) {
        console.error('[ERROR] No sidecar and cannot read manifest.json: ' + e.message);
        console.error('        Pass --repo <path> to the cloned repo.');
        process.exit(1);
    }

    // Skills dir — remove only dirs/files we own
    const skillsDir = path.join(dest, 'skills');
    if (fs.existsSync(skillsDir)) {
        const stat = fs.lstatSync(skillsDir);
        if (stat.isSymbolicLink()) {
            removePath(skillsDir, 'skills/ (symlink)');
        } else {
            for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
                const full = path.join(skillsDir, entry.name);
                if (entry.isDirectory()) {
                    if (ownedSkills.has(entry.name) || deprecatedSkills.has(entry.name)) {
                        removePath(full, 'skills/' + entry.name + '/');
                    } else kept++;
                } else if (entry.isFile()) {
                    if (entry.name === 'manifest.json' || entry.name === 'commands.md') {
                        removePath(full, 'skills/' + entry.name);
                    } else kept++;
                }
            }
            removeEmptyDir(skillsDir, 'skills/');
        }
    }

    // Hooks
    const hooksDir = path.join(dest, 'hooks');
    if (fs.existsSync(hooksDir)) {
        const stat = fs.lstatSync(hooksDir);
        if (stat.isSymbolicLink()) {
            removePath(hooksDir, 'hooks/ (symlink)');
        } else {
            for (const entry of fs.readdirSync(hooksDir, { withFileTypes: true })) {
                if (entry.isFile() && ownedHookFileNames.has(entry.name)) {
                    removePath(path.join(hooksDir, entry.name), 'hooks/' + entry.name);
                } else kept++;
            }
            removeEmptyDir(hooksDir, 'hooks/');
        }
    }

    // Agents
    const agentsSrc = path.join(repo, 'agents');
    const ownedAgents = new Set();
    try {
        for (const f of fs.readdirSync(agentsSrc)) if (f.endsWith('.md')) ownedAgents.add(f);
    } catch {}
    const agentsDir = path.join(dest, 'agents');
    if (fs.existsSync(agentsDir)) {
        for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
            if (entry.isFile() && ownedAgents.has(entry.name)) {
                removePath(path.join(agentsDir, entry.name), 'agents/' + entry.name);
            } else kept++;
        }
        removeEmptyDir(agentsDir, 'agents/');
    }

    // Rules — only unmodified ones
    const rulesSrc = path.join(repo, 'config', 'rules');
    const ownedRules = new Set();
    try {
        for (const f of fs.readdirSync(rulesSrc)) if (f.endsWith('.md')) ownedRules.add(f);
    } catch {}
    const rulesDir = path.join(dest, 'rules');
    if (fs.existsSync(rulesDir)) {
        for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {
            if (!entry.isFile() || !ownedRules.has(entry.name)) { kept++; continue; }
            try {
                const a = fs.readFileSync(path.join(rulesSrc, entry.name));
                const b = fs.readFileSync(path.join(rulesDir, entry.name));
                if (a.equals(b)) {
                    removePath(path.join(rulesDir, entry.name), 'rules/' + entry.name);
                } else {
                    log('kept rules/' + entry.name + ' (user-modified)');
                    kept++;
                }
            } catch { kept++; }
        }
        removeEmptyDir(rulesDir, 'rules/');
    }
}

// -------- Clean up empty parent dirs left behind after sidecar-driven removal --------
for (const sub of ['skills', 'hooks', 'agents', 'rules']) {
    removeEmptyDir(path.join(dest, sub), sub + '/');
}

// -------- Remove the sidecar itself --------
if (fs.existsSync(sidecarPath)) {
    removePath(sidecarPath, '.auto-dev-installed.json');
}

// -------- Remove repo-path.txt --------
removePath(path.join(dest, 'repo-path.txt'), 'repo-path.txt');

// -------- Clean auto-dev hook entries from settings.json --------
const settingsPath = path.join(dest, 'settings.json');
if (fs.existsSync(settingsPath)) {
    try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        let changed = false;

        if (settings.hooks) {
            for (const [event, groups] of Object.entries(settings.hooks)) {
                if (!Array.isArray(groups)) continue;
                const filteredGroups = [];
                for (const group of groups) {
                    const filteredHooks = (group.hooks || []).filter(h => {
                        const cmd = h.command || '';
                        for (const hookFile of ownedHookFileNames) {
                            if (cmd.includes(hookFile)) return false;
                        }
                        return true;
                    });
                    if (filteredHooks.length !== (group.hooks || []).length) changed = true;
                    if (filteredHooks.length > 0) filteredGroups.push({ ...group, hooks: filteredHooks });
                    else changed = true;
                }
                if (filteredGroups.length === 0) delete settings.hooks[event];
                else settings.hooks[event] = filteredGroups;
            }
            if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
        }

        if (changed) {
            if (!dryRun) fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
            log('cleaned auto-dev hooks from settings.json');
            removed++;
        } else {
            log('settings.json: no auto-dev hooks found');
        }
    } catch (e) {
        console.log('[WARN] could not process settings.json: ' + e.message);
    }
}

console.log('');
console.log('Summary: ' + removed + ' removed, ' + kept + ' user files preserved');
console.log('');
console.log('Manual follow-up (not automated for safety):');
console.log('  - Remove the update-dev function from your shell profile');
console.log('    (bash/zsh: ~/.bashrc, ~/.zshrc, or ~/.profile)');
console.log('  - If you cloned the repo, delete it manually when ready.');
console.log('  - If you used --force during install, a .user-backup-<ts>/ directory may exist in ' + dest);
