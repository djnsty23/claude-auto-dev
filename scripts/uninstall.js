#!/usr/bin/env node
// uninstall.js — Surgical uninstall for claude-auto-dev
// Removes ONLY files owned by this repo. Leaves user-installed skills, hooks,
// agents, rules, and settings entries untouched.
//
// Usage: node scripts/uninstall.js [--repo <path>] [--dest <path>] [--dry-run] [--yes]

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
};

const home = process.env.HOME || process.env.USERPROFILE;
const dest = getArg('--dest') || path.join(home, '.claude');
const dryRun = hasFlag('--dry-run');

// Resolve repo path: --repo arg, or ~/.claude/repo-path.txt, or script's parent
let repo = getArg('--repo');
if (!repo) {
  const repoPathFile = path.join(dest, 'repo-path.txt');
  if (fs.existsSync(repoPathFile)) {
    repo = fs.readFileSync(repoPathFile, 'utf8').trim();
  }
}
if (!repo) {
  repo = path.resolve(__dirname, '..');
}

const prefix = dryRun ? '[DRY-RUN] ' : '';
let removed = 0;
let kept = 0;

function log(msg) { console.log(prefix + msg); }

function removePath(p, label) {
  if (!fs.existsSync(p) && !fs.lstatSync(p, { throwIfNoEntry: false })) return false;
  try {
    const stat = fs.lstatSync(p);
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

// --- Load manifest to know which skills we own ---
let ownedSkills = new Set();
let deprecatedSkills = new Set();
try {
  const manifestPath = path.join(repo, 'skills', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  ownedSkills = new Set(Object.keys(manifest.skills || {}));
  deprecatedSkills = new Set(manifest.deprecated || []);
} catch (e) {
  console.error('[ERROR] Could not read manifest.json from ' + repo + '/skills/');
  console.error('        ' + e.message);
  console.error('        Pass --repo <path> to the cloned repo, or run from inside it.');
  process.exit(1);
}

console.log('Claude Auto-Dev — surgical uninstall');
console.log('  repo: ' + repo);
console.log('  dest: ' + dest);
if (dryRun) console.log('  MODE: dry-run (no files will be changed)');
console.log('');

// --- Skills ---
const skillsDir = path.join(dest, 'skills');
if (fs.existsSync(skillsDir)) {
  const skillsStat = fs.lstatSync(skillsDir);
  if (skillsStat.isSymbolicLink()) {
    // Symlink points at the repo's skills dir — removing the link is safe,
    // it drops the pointer but leaves the repo intact.
    removePath(skillsDir, 'skills/ (symlink)');
  } else {
    // Copy mode: remove ONLY the directories we own + our own files
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      const full = path.join(skillsDir, entry.name);
      if (entry.isDirectory()) {
        if (ownedSkills.has(entry.name) || deprecatedSkills.has(entry.name)) {
          removePath(full, 'skills/' + entry.name + '/');
        } else {
          kept++;
        }
      } else if (entry.isFile()) {
        // Only our known files
        if (entry.name === 'manifest.json' || entry.name === 'commands.md') {
          removePath(full, 'skills/' + entry.name);
        } else {
          kept++;
        }
      }
    }
    // Remove skills dir if empty
    try {
      if (!dryRun && fs.readdirSync(skillsDir).length === 0) {
        fs.rmdirSync(skillsDir);
        log('removed empty skills/');
      }
    } catch {}
  }
}

// --- Hooks ---
// Enumerate hook file names from the repo so we always match what we shipped.
const hooksSrc = path.join(repo, 'hooks');
const ownedHooks = new Set();
try {
  for (const f of fs.readdirSync(hooksSrc)) {
    if (f.endsWith('.js')) ownedHooks.add(f);
  }
} catch {}

const hooksDir = path.join(dest, 'hooks');
if (fs.existsSync(hooksDir)) {
  const hooksStat = fs.lstatSync(hooksDir);
  if (hooksStat.isSymbolicLink()) {
    removePath(hooksDir, 'hooks/ (symlink)');
  } else {
    for (const entry of fs.readdirSync(hooksDir, { withFileTypes: true })) {
      if (entry.isFile() && ownedHooks.has(entry.name)) {
        removePath(path.join(hooksDir, entry.name), 'hooks/' + entry.name);
      } else {
        kept++;
      }
    }
    try {
      if (!dryRun && fs.readdirSync(hooksDir).length === 0) {
        fs.rmdirSync(hooksDir);
        log('removed empty hooks/');
      }
    } catch {}
  }
}

// --- Agents ---
const agentsSrc = path.join(repo, 'agents');
const ownedAgents = new Set();
try {
  for (const f of fs.readdirSync(agentsSrc)) {
    if (f.endsWith('.md')) ownedAgents.add(f);
  }
} catch {}

const agentsDir = path.join(dest, 'agents');
if (fs.existsSync(agentsDir)) {
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (entry.isFile() && ownedAgents.has(entry.name)) {
      removePath(path.join(agentsDir, entry.name), 'agents/' + entry.name);
    } else {
      kept++;
    }
  }
  try {
    if (!dryRun && fs.readdirSync(agentsDir).length === 0) {
      fs.rmdirSync(agentsDir);
      log('removed empty agents/');
    }
  } catch {}
}

// --- Rules (only if they match our shipped set and are unmodified) ---
const rulesSrc = path.join(repo, 'config', 'rules');
const ownedRules = new Set();
try {
  for (const f of fs.readdirSync(rulesSrc)) {
    if (f.endsWith('.md')) ownedRules.add(f);
  }
} catch {}

const rulesDir = path.join(dest, 'rules');
if (fs.existsSync(rulesDir)) {
  for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !ownedRules.has(entry.name)) { kept++; continue; }
    // Only remove if unmodified vs. repo (byte-identical)
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
  try {
    if (!dryRun && fs.readdirSync(rulesDir).length === 0) {
      fs.rmdirSync(rulesDir);
      log('removed empty rules/');
    }
  } catch {}
}

// --- repo-path.txt ---
removePath(path.join(dest, 'repo-path.txt'), 'repo-path.txt');

// --- Clean settings.json hook entries (don't delete the file) ---
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
            // Drop any entry that invokes one of our hook files
            for (const hookFile of ownedHooks) {
              if (cmd.includes(hookFile)) return false;
            }
            return true;
          });
          if (filteredHooks.length !== (group.hooks || []).length) changed = true;
          if (filteredHooks.length > 0) {
            filteredGroups.push({ ...group, hooks: filteredHooks });
          } else {
            changed = true;
          }
        }
        if (filteredGroups.length === 0) {
          delete settings.hooks[event];
        } else {
          settings.hooks[event] = filteredGroups;
        }
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }

    if (changed) {
      if (!dryRun) {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      }
      log('cleaned auto-dev hooks from settings.json');
      removed++;
    } else {
      log('settings.json: no auto-dev hooks found');
    }
  } catch (e) {
    console.log('[WARN] could not process settings.json: ' + e.message);
  }
}

// --- Summary ---
console.log('');
console.log('Summary: ' + removed + ' removed, ' + kept + ' user files preserved');
console.log('');
console.log('Next steps (manual, not automated for safety):');
console.log('  1. Remove the update-dev function from your shell profile');
console.log('     (bash/zsh: ~/.bashrc, ~/.zshrc, or ~/.profile)');
console.log('  2. If you cloned the repo, delete it manually when ready.');
