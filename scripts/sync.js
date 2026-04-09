#!/usr/bin/env node
// sync.js — Collision-safe sync from repo to ~/.claude
//
// Guarantees:
// - Never touches files in dest that aren't in the repo's shipped list AND
//   aren't tracked in the install sidecar.
// - Refuses to clobber a user-owned item with the same name as a shipped one
//   unless --force, which backs it up to .user-backup-<timestamp>/ first.
// - Writes ~/.claude/.auto-dev-installed.json describing exactly what this
//   install put on disk, so uninstall can be precise across versions.
//
// Usage: node scripts/sync.js --repo /path/to/repo [options]
//
// Options:
//   --repo PATH        Source repo path (required)
//   --dest PATH        Destination (default: ~/.claude)
//   --rules            Also sync config/rules/
//   --settings         Also merge settings.json (preserves user customizations)
//   --force            Back up and overwrite colliding user content
//   --dry-run          Print what would happen, don't touch disk
//   --symlink          DEPRECATED: ignored (always copies)
//   --clean-deprecated DEPRECATED: always runs (sidecar + manifest deprecation)

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const hasFlag = (n) => args.includes(n);
const getArg = (n) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : null; };

const repo = getArg('--repo');
if (!repo) {
    console.error('Usage: node sync.js --repo <path> [--dest <path>] [--rules] [--settings] [--force] [--dry-run]');
    process.exit(1);
}

const home = process.env.HOME || process.env.USERPROFILE;
const dest = getArg('--dest') || path.join(home, '.claude');
const syncRules = hasFlag('--rules');
const syncSettings = hasFlag('--settings');
const force = hasFlag('--force');
const dryRun = hasFlag('--dry-run');

if (hasFlag('--symlink')) {
    console.log('[Sync] NOTE: --symlink is deprecated and ignored. Always copying.');
}

// -------- Helpers --------
function ensureDir(p) {
    if (!fs.existsSync(p)) {
        if (!dryRun) fs.mkdirSync(p, { recursive: true });
    }
}

function copyFile(src, dst) {
    ensureDir(path.dirname(dst));
    if (!dryRun) fs.copyFileSync(src, dst);
}

function copyDir(src, dst) {
    ensureDir(dst);
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) copyDir(s, d);
        else if (entry.isFile()) copyFile(s, d);
    }
}

function removePath(p) {
    if (!fs.existsSync(p)) return;
    if (dryRun) return;
    try {
        const stat = fs.lstatSync(p);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
            fs.rmSync(p, { recursive: true, force: true });
        } else {
            fs.rmSync(p, { force: true });
        }
    } catch {}
}

function sameFile(a, b) {
    try {
        if (fs.statSync(a).size !== fs.statSync(b).size) return false;
        return fs.readFileSync(a).equals(fs.readFileSync(b));
    } catch { return false; }
}

function sameDir(a, b) {
    let ea, eb;
    try {
        ea = fs.readdirSync(a, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name));
        eb = fs.readdirSync(b, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name));
    } catch { return false; }
    if (ea.length !== eb.length) return false;
    for (let i = 0; i < ea.length; i++) {
        if (ea[i].name !== eb[i].name) return false;
        if (ea[i].isDirectory() !== eb[i].isDirectory()) return false;
        const pa = path.join(a, ea[i].name);
        const pb = path.join(b, eb[i].name);
        if (ea[i].isDirectory()) {
            if (!sameDir(pa, pb)) return false;
        } else if (!sameFile(pa, pb)) return false;
    }
    return true;
}

function listFiles(dir, ext) {
    try { return fs.readdirSync(dir).filter(f => !ext || f.endsWith(ext)); }
    catch { return []; }
}

function listDirs(dir) {
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); }
    catch { return []; }
}

// -------- Load manifest --------
let manifest;
try {
    manifest = JSON.parse(fs.readFileSync(path.join(repo, 'skills', 'manifest.json'), 'utf8'));
} catch (e) {
    console.error('[Sync] Cannot read manifest.json: ' + e.message);
    process.exit(1);
}
const deprecatedSkillNames = new Set(manifest.deprecated || []);

// -------- Enumerate what the repo ships --------
const repoSkillsSrc = path.join(repo, 'skills');
const repoHooksSrc = path.join(repo, 'hooks');
const repoAgentsSrc = path.join(repo, 'agents');
const repoRulesSrc = path.join(repo, 'config', 'rules');

const shippedSkillDirs = listDirs(repoSkillsSrc).filter(n => !deprecatedSkillNames.has(n));
const shippedSkillFiles = ['manifest.json', 'commands.md'].filter(f => fs.existsSync(path.join(repoSkillsSrc, f)));
const shippedHookFiles = listFiles(repoHooksSrc, '.js');
const shippedAgentFiles = listFiles(repoAgentsSrc, '.md');
const shippedRuleFiles = listFiles(repoRulesSrc, '.md');

// -------- Load sidecar (record of last install) --------
const sidecarPath = path.join(dest, '.auto-dev-installed.json');
let sidecar = null;
try { sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')); } catch {}

const previouslyInstalled = new Set(sidecar ? Object.keys(sidecar.items || {}) : []);

// Legacy detection: no sidecar but a prior install exists. Trust shipped list
// as "previously owned" so we don't flag every shipped item as a collision.
if (!sidecar && fs.existsSync(path.join(dest, 'skills', 'manifest.json'))) {
    try {
        const legacy = JSON.parse(fs.readFileSync(path.join(dest, 'skills', 'manifest.json'), 'utf8'));
        if (legacy && legacy.skills && typeof legacy.skills === 'object') {
            console.log('[Sync] Legacy install detected (no sidecar). Treating shipped items as pre-owned.');
            for (const n of shippedSkillDirs) previouslyInstalled.add('skills/' + n);
            for (const f of shippedSkillFiles) previouslyInstalled.add('skills/' + f);
            for (const f of shippedHookFiles) previouslyInstalled.add('hooks/' + f);
            for (const f of shippedAgentFiles) previouslyInstalled.add('agents/' + f);
            if (syncRules) for (const f of shippedRuleFiles) previouslyInstalled.add('rules/' + f);
            for (const n of deprecatedSkillNames) previouslyInstalled.add('skills/' + n);
        }
    } catch {}
}

// -------- Collision detection --------
const collisions = [];
function checkCollision(relPath, srcPath, type) {
    const dstPath = path.join(dest, relPath);
    if (!fs.existsSync(dstPath)) return;
    if (previouslyInstalled.has(relPath)) return; // ours from last install
    const same = type === 'dir' ? sameDir(srcPath, dstPath) : sameFile(srcPath, dstPath);
    if (!same) collisions.push({ relPath, type, dstPath });
}

for (const n of shippedSkillDirs) checkCollision('skills/' + n, path.join(repoSkillsSrc, n), 'dir');
for (const f of shippedSkillFiles) checkCollision('skills/' + f, path.join(repoSkillsSrc, f), 'file');
for (const f of shippedHookFiles) checkCollision('hooks/' + f, path.join(repoHooksSrc, f), 'file');
for (const f of shippedAgentFiles) checkCollision('agents/' + f, path.join(repoAgentsSrc, f), 'file');
if (syncRules) for (const f of shippedRuleFiles) checkCollision('rules/' + f, path.join(repoRulesSrc, f), 'file');

if (collisions.length > 0) {
    if (!force) {
        console.error('');
        console.error('[Sync] REFUSING TO OVERWRITE — name collisions detected:');
        console.error('');
        for (const c of collisions) console.error('  ' + c.relPath + '  (' + c.dstPath + ')');
        console.error('');
        console.error('These files exist in ' + dest + ' but are NOT byte-identical to');
        console.error('this repo\'s shipped versions, and are not tracked in the install');
        console.error('sidecar. They look like your own content.');
        console.error('');
        console.error('Options:');
        console.error('  1. Rename or remove the colliding items, then re-run.');
        console.error('  2. Re-run with --force to back them up to .user-backup-<ts>/');
        console.error('     and install ours on top.');
        process.exit(1);
    } else {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupRoot = path.join(dest, '.user-backup-' + stamp);
        console.log('[Sync] --force: backing up ' + collisions.length + ' colliding item(s) to ' + path.basename(backupRoot));
        ensureDir(backupRoot);
        for (const c of collisions) {
            const backupDst = path.join(backupRoot, c.relPath);
            if (!dryRun) {
                ensureDir(path.dirname(backupDst));
                if (c.type === 'dir') copyDir(c.dstPath, backupDst);
                else fs.copyFileSync(c.dstPath, backupDst);
            }
            console.log('  backed up ' + c.relPath);
        }
    }
}

// -------- Remove previously-installed items (sidecar-driven) --------
// Also sweep deprecated skills listed in the manifest.
const toRemove = new Set(previouslyInstalled);
for (const n of deprecatedSkillNames) toRemove.add('skills/' + n);

ensureDir(dest);
for (const rel of toRemove) removePath(path.join(dest, rel));

// -------- Copy everything we ship --------
const newItems = {};

for (const n of shippedSkillDirs) {
    copyDir(path.join(repoSkillsSrc, n), path.join(dest, 'skills', n));
    newItems['skills/' + n] = 'dir';
}
for (const f of shippedSkillFiles) {
    copyFile(path.join(repoSkillsSrc, f), path.join(dest, 'skills', f));
    newItems['skills/' + f] = 'file';
}
console.log('[Sync] Skills: ' + shippedSkillDirs.length + ' dirs, ' + shippedSkillFiles.length + ' files');

for (const f of shippedHookFiles) {
    copyFile(path.join(repoHooksSrc, f), path.join(dest, 'hooks', f));
    newItems['hooks/' + f] = 'file';
}
console.log('[Sync] Hooks: ' + shippedHookFiles.length + ' files');

for (const f of shippedAgentFiles) {
    copyFile(path.join(repoAgentsSrc, f), path.join(dest, 'agents', f));
    newItems['agents/' + f] = 'file';
}
console.log('[Sync] Agents: ' + shippedAgentFiles.length + ' files');

if (syncRules) {
    for (const f of shippedRuleFiles) {
        copyFile(path.join(repoRulesSrc, f), path.join(dest, 'rules', f));
        newItems['rules/' + f] = 'file';
    }
    console.log('[Sync] Rules: ' + shippedRuleFiles.length + ' files');
}

// -------- Settings merge (unchanged semantics) --------
if (syncSettings) {
    const isWindows = process.platform === 'win32' || (process.env.OSTYPE || '').match(/msys|cygwin/);
    const settingsSrc = path.join(repo, 'config', isWindows ? 'settings.json' : 'settings-unix.json');
    const settingsDst = path.join(dest, 'settings.json');

    try {
        const incoming = JSON.parse(fs.readFileSync(settingsSrc, 'utf8'));
        let existing = {};
        try { existing = JSON.parse(fs.readFileSync(settingsDst, 'utf8')); } catch {}

        if (Object.keys(existing).length > 0 && !dryRun) {
            fs.writeFileSync(settingsDst.replace('.json', '.backup.json'), JSON.stringify(existing, null, 2));
        }

        const merged = JSON.parse(JSON.stringify(incoming));
        const incomingAllow = new Set(incoming.permissions?.allow || []);
        const incomingDeny = new Set(incoming.permissions?.deny || []);
        for (const r of (existing.permissions?.allow || [])) if (!incomingAllow.has(r)) merged.permissions.allow.push(r);
        for (const r of (existing.permissions?.deny || [])) if (!incomingDeny.has(r)) merged.permissions.deny.push(r);
        if (existing.model && existing.model !== 'opus') merged.model = existing.model;

        const incomingHookEvents = new Set(Object.keys(incoming.hooks || {}));
        for (const [event, hooks] of Object.entries(existing.hooks || {})) {
            if (!incomingHookEvents.has(event)) merged.hooks[event] = hooks;
        }

        if (!dryRun) fs.writeFileSync(settingsDst, JSON.stringify(merged, null, 2) + '\n');
        console.log('[Sync] Settings: merged (user rules preserved)');
    } catch (e) {
        console.log('[Sync] Settings: skipped — ' + e.message);
    }
}

// -------- Write sidecar --------
const newSidecar = {
    version: manifest.version || 'unknown',
    installedAt: new Date().toISOString(),
    repo: path.resolve(repo),
    items: newItems,
};
if (!dryRun) fs.writeFileSync(sidecarPath, JSON.stringify(newSidecar, null, 2) + '\n');
console.log('[Sync] Sidecar: ' + Object.keys(newItems).length + ' items tracked at .auto-dev-installed.json');

// -------- Validation --------
let warnings = 0;
for (const [rel, label] of [
    ['skills/manifest.json', 'manifest.json'],
    ['hooks/session-start.js', 'session-start.js'],
    ['skills/commands.md', 'commands.md'],
]) {
    if (!fs.existsSync(path.join(dest, rel))) { console.log('[WARN] ' + label + ' missing'); warnings++; }
}
console.log('[Sync] v' + (manifest.version || '?') + ' — ' + (warnings === 0 ? 'OK' : warnings + ' warning(s)'));
if (dryRun) console.log('[Sync] DRY RUN: nothing was actually written.');
