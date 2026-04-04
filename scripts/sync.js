#!/usr/bin/env node
// sync.js — Single source of truth for syncing repo files to ~/.claude
// Usage: node scripts/sync.js --repo /path/to/repo [options]
//
// Options:
//   --repo PATH        Source repo path (required)
//   --dest PATH        Destination (default: ~/.claude)
//   --symlink          Try symlinks first, fall back to copy
//   --rules            Also sync config/rules/
//   --settings         Also merge settings.json (preserves user customizations)
//   --clean-deprecated Remove deprecated skill dirs listed in manifest.json

const fs = require('fs');
const path = require('path');

// Parse args
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}
const hasFlag = (name) => args.includes(name);

const repo = getArg('--repo');
if (!repo) {
  console.error('Usage: node sync.js --repo <path> [--dest <path>] [--symlink] [--rules] [--settings] [--clean-deprecated]');
  process.exit(1);
}

const home = process.env.HOME || process.env.USERPROFILE;
const dest = getArg('--dest') || path.join(home, '.claude');
const useSymlink = hasFlag('--symlink');
const syncRules = hasFlag('--rules');
const syncSettings = hasFlag('--settings');
const cleanDeprecated = hasFlag('--clean-deprecated');

// Normalize paths for Windows compatibility
function norm(p) { return path.resolve(p); }

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyDir(src, dst, recursive) {
  ensureDir(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory() && recursive) {
      copyDir(srcPath, dstPath, true);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function trySymlink(src, dst) {
  try {
    fs.symlinkSync(norm(src), norm(dst), 'junction');
    return true;
  } catch {
    return false;
  }
}

function removeTarget(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

// --- Sync skills ---
const skillsSrc = path.join(repo, 'skills');
const skillsDst = path.join(dest, 'skills');
let usedCopy = false;

removeTarget(skillsDst);
if (useSymlink && trySymlink(skillsSrc, skillsDst)) {
  console.log('[Sync] Skills: symlinked');
} else {
  copyDir(skillsSrc, skillsDst, true);
  usedCopy = true;
  console.log('[Sync] Skills: copied');
}

// --- Sync hooks ---
const hooksSrc = path.join(repo, 'hooks');
const hooksDst = path.join(dest, 'hooks');

removeTarget(hooksDst);
if (useSymlink && !usedCopy && trySymlink(hooksSrc, hooksDst)) {
  console.log('[Sync] Hooks: symlinked');
} else {
  copyDir(hooksSrc, hooksDst, false);
  console.log('[Sync] Hooks: copied');
}

// --- Sync agents (always copy — preserves user-created agents) ---
const agentsSrc = path.join(repo, 'agents');
const agentsDst = path.join(dest, 'agents');
ensureDir(agentsDst);
if (fs.existsSync(agentsSrc)) {
  for (const f of fs.readdirSync(agentsSrc)) {
    if (f.endsWith('.md')) {
      fs.copyFileSync(path.join(agentsSrc, f), path.join(agentsDst, f));
    }
  }
  console.log('[Sync] Agents: copied');
}

// --- Sync rules (optional) ---
if (syncRules) {
  const rulesSrc = path.join(repo, 'config', 'rules');
  const rulesDst = path.join(dest, 'rules');
  if (fs.existsSync(rulesSrc)) {
    ensureDir(rulesDst);
    for (const f of fs.readdirSync(rulesSrc)) {
      fs.copyFileSync(path.join(rulesSrc, f), path.join(rulesDst, f));
    }
    console.log('[Sync] Rules: copied');
  }
}

// --- Merge settings (optional) ---
if (syncSettings) {
  const isWindows = process.platform === 'win32' || (process.env.OSTYPE || '').match(/msys|cygwin/);
  const settingsSrc = path.join(repo, 'config', isWindows ? 'settings.json' : 'settings-unix.json');
  const settingsDst = path.join(dest, 'settings.json');

  try {
    const incoming = JSON.parse(fs.readFileSync(settingsSrc, 'utf8'));
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(settingsDst, 'utf8')); } catch {}

    // Backup existing settings
    if (Object.keys(existing).length > 0) {
      fs.writeFileSync(settingsDst.replace('.json', '.backup.json'), JSON.stringify(existing, null, 2));
    }

    // Merge: incoming is base, preserve user-added entries
    const merged = JSON.parse(JSON.stringify(incoming));

    // Permissions: keep user-added allow/deny rules
    const incomingAllow = new Set(incoming.permissions?.allow || []);
    const incomingDeny = new Set(incoming.permissions?.deny || []);
    for (const r of (existing.permissions?.allow || [])) {
      if (!incomingAllow.has(r)) merged.permissions.allow.push(r);
    }
    for (const r of (existing.permissions?.deny || [])) {
      if (!incomingDeny.has(r)) merged.permissions.deny.push(r);
    }

    // Preserve user model preference
    if (existing.model && existing.model !== 'opus') merged.model = existing.model;

    // Hooks: incoming wins (security-critical), preserve user-added hook events
    const incomingHookEvents = new Set(Object.keys(incoming.hooks || {}));
    for (const [event, hooks] of Object.entries(existing.hooks || {})) {
      if (!incomingHookEvents.has(event)) merged.hooks[event] = hooks;
    }

    fs.writeFileSync(settingsDst, JSON.stringify(merged, null, 2) + '\n');
    console.log('[Sync] Settings: merged (user rules preserved)');
  } catch (e) {
    try {
      JSON.parse(fs.readFileSync(settingsSrc, 'utf8'));
      fs.copyFileSync(settingsSrc, settingsDst);
      console.log('[Sync] Settings: copied (merge failed: ' + e.message + ')');
    } catch (e2) {
      console.log('[Sync] Settings: skipped (invalid source: ' + e2.message + ')');
    }
  }
}

// --- Clean deprecated skills (optional) ---
if (cleanDeprecated) {
  try {
    const manifestPath = path.join(dest, 'skills', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const deprecated = new Set(manifest.deprecated || []);
    const skillsDir = path.join(dest, 'skills');
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && deprecated.has(entry.name)) {
        fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true });
        console.log('[Sync] Removed deprecated: ' + entry.name);
      }
    }
  } catch (e) {
    console.log('[Sync] Deprecated cleanup skipped: ' + e.message);
  }
}

// --- Validation ---
let warnings = 0;
const checks = [
  ['skills/manifest.json', 'manifest.json'],
  ['hooks/session-start.js', 'session-start.js'],
  ['settings.json', 'settings.json'],
  ['skills/commands.md', 'commands.md'],
];
for (const [rel, label] of checks) {
  if (!fs.existsSync(path.join(dest, rel))) {
    console.log('[WARN] ' + label + ' missing');
    warnings++;
  }
}

const version = fs.readFileSync(path.join(repo, 'VERSION'), 'utf8').trim();
console.log('[Sync] v' + version + ' — ' + (warnings === 0 ? 'OK' : warnings + ' warning(s)'));
