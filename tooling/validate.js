#!/usr/bin/env node
/**
 * validate.js — consistency checker for the autodev plugin marketplace.
 *
 * Checks the invariants the plugin layout depends on and nothing else. The
 * pre-8.0 validator policed a hand-maintained skills/manifest.json that no
 * runtime ever read; those checks are gone with the manifest.
 *
 * Usage: node tooling/validate.js
 * Exit codes: 0 = pass, 1 = at least one FAIL
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');

let passCount = 0;
let failCount = 0;
let warnCount = 0;

function log(status, message) {
  console.log(`[${status}] ${message}`);
  if (status === 'PASS') passCount++;
  else if (status === 'FAIL') failCount++;
  else if (status === 'WARN') warnCount++;
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    log('FAIL', `${path.relative(ROOT, p)}: ${e.message}`);
    return null;
  }
}

function parseFrontmatter(content) {
  const match = content.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = {};
  let currentKey = null;
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      const raw = kv[2].trim();
      fm[currentKey] = raw === '' ? [] : raw.replace(/^["']|["']$/g, '');
    } else if (currentKey && /^\s*-\s+/.test(line)) {
      if (!Array.isArray(fm[currentKey])) fm[currentKey] = [];
      fm[currentKey].push(line.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
    }
  }
  return fm;
}

function pluginDirs() {
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function skillDirs(plugin) {
  const d = path.join(PLUGINS_DIR, plugin, 'skills');
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

// ---------------------------------------------------------------- checks

function checkVersionSync() {
  const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  const sources = [['package.json', readJSON(path.join(ROOT, 'package.json'))?.version]];

  const marketplace = readJSON(path.join(ROOT, '.claude-plugin', 'marketplace.json'));
  sources.push(['marketplace.json', marketplace?.metadata?.version]);

  for (const p of pluginDirs()) {
    const manifest = readJSON(path.join(PLUGINS_DIR, p, '.claude-plugin', 'plugin.json'));
    sources.push([`${p}/plugin.json`, manifest?.version]);
  }

  let ok = true;
  for (const [label, found] of sources) {
    if (found !== version) {
      log('FAIL', `Version drift: VERSION is ${version} but ${label} is ${found}`);
      ok = false;
    }
  }
  if (ok) log('PASS', `Version sync: ${version} across ${sources.length + 1} files`);
}

function checkMarketplace() {
  const mp = readJSON(path.join(ROOT, '.claude-plugin', 'marketplace.json'));
  if (!mp) return;

  if (!mp.name) log('FAIL', 'marketplace.json: missing required field "name"');
  if (!Array.isArray(mp.plugins) || mp.plugins.length === 0) {
    log('FAIL', 'marketplace.json: "plugins" must be a non-empty array');
    return;
  }

  const onDisk = new Set(pluginDirs());
  const listed = new Set();
  let ok = true;

  for (const entry of mp.plugins) {
    if (!entry.name || !entry.source) {
      log('FAIL', `marketplace.json: plugin entry needs both name and source: ${JSON.stringify(entry)}`);
      ok = false;
      continue;
    }
    listed.add(entry.name);

    const src = path.resolve(ROOT, entry.source);
    if (!fs.existsSync(src)) {
      log('FAIL', `marketplace.json: ${entry.name} source does not exist: ${entry.source}`);
      ok = false;
      continue;
    }
    const manifest = readJSON(path.join(src, '.claude-plugin', 'plugin.json'));
    if (manifest && manifest.name !== entry.name) {
      log('FAIL', `marketplace.json: ${entry.name} source manifest is named "${manifest.name}"`);
      ok = false;
    }
  }

  for (const d of onDisk) {
    if (!listed.has(d)) {
      log('FAIL', `plugins/${d} exists on disk but is not listed in marketplace.json`);
      ok = false;
    }
  }

  if (ok) log('PASS', `Marketplace: ${mp.plugins.length} plugins listed and resolvable`);
}

function checkPluginManifests() {
  for (const p of pluginDirs()) {
    const dir = path.join(PLUGINS_DIR, p);
    const manifestPath = path.join(dir, '.claude-plugin', 'plugin.json');

    if (!fs.existsSync(manifestPath)) {
      log('FAIL', `plugins/${p}: missing .claude-plugin/plugin.json`);
      continue;
    }
    const manifest = readJSON(manifestPath);
    if (!manifest) continue;

    if (manifest.name !== p) {
      log('FAIL', `plugins/${p}: manifest name "${manifest.name}" does not match directory`);
      continue;
    }

    // Component dirs must sit at the plugin root, never inside .claude-plugin/.
    for (const stray of ['skills', 'agents', 'hooks', 'commands', 'scripts']) {
      if (fs.existsSync(path.join(dir, '.claude-plugin', stray))) {
        log('FAIL', `plugins/${p}: ${stray}/ must live at the plugin root, not inside .claude-plugin/`);
      }
    }

    log('PASS', `plugins/${p}: manifest valid`);
  }
}

function checkSkillFrontmatter() {
  let total = 0;
  let ok = true;

  for (const p of pluginDirs()) {
    for (const name of skillDirs(p)) {
      const file = path.join(PLUGINS_DIR, p, 'skills', name, 'SKILL.md');
      const rel = `plugins/${p}/skills/${name}/SKILL.md`;

      if (!fs.existsSync(file)) {
        log('FAIL', `${rel}: skill directory has no SKILL.md`);
        ok = false;
        continue;
      }
      total++;

      const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      if (!fm) {
        log('FAIL', `${rel}: no YAML frontmatter`);
        ok = false;
        continue;
      }
      if (!fm.description) {
        log('FAIL', `${rel}: missing required "description"`);
        ok = false;
      }
      if (fm.name && fm.name !== name) {
        log('FAIL', `${rel}: name "${fm.name}" does not match directory "${name}"`);
        ok = false;
      }
      if (fm.triggers) {
        log('FAIL', `${rel}: "triggers" is not a Claude Code frontmatter field — use when_to_use`);
        ok = false;
      }
      // Both invocation paths off makes a skill unreachable by anyone.
      if (String(fm['user-invocable']) === 'false' && String(fm['disable-model-invocation']) === 'true') {
        log('FAIL', `${rel}: user-invocable:false AND disable-model-invocation:true — nothing can ever load this skill`);
        ok = false;
      }
    }
  }

  if (ok) log('PASS', `Skill frontmatter: ${total} skills validated`);
}

function checkHookWiring() {
  const VALID_EVENTS = new Set([
    'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure',
    'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PostCompact',
    'SubagentStart', 'SubagentStop', 'Notification', 'PermissionRequest',
  ]);

  for (const p of pluginDirs()) {
    const hooksFile = path.join(PLUGINS_DIR, p, 'hooks', 'hooks.json');
    if (!fs.existsSync(hooksFile)) continue;

    const cfg = readJSON(hooksFile);
    if (!cfg) continue;

    let count = 0;
    let ok = true;

    for (const [event, groups] of Object.entries(cfg.hooks || {})) {
      if (!VALID_EVENTS.has(event)) {
        log('FAIL', `plugins/${p}/hooks/hooks.json: unknown hook event "${event}"`);
        ok = false;
      }
      for (const group of groups) {
        for (const hook of group.hooks || []) {
          count++;
          const cmd = hook.command || '';
          if (!cmd.includes('${CLAUDE_PLUGIN_ROOT}')) {
            log('FAIL', `plugins/${p}: ${event} hook does not use \${CLAUDE_PLUGIN_ROOT}: ${cmd}`);
            ok = false;
            continue;
          }
          const m = cmd.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"']+)/);
          if (m && !fs.existsSync(path.join(PLUGINS_DIR, p, m[1]))) {
            log('FAIL', `plugins/${p}: ${event} hook points at a missing file: ${m[1]}`);
            ok = false;
          }
        }
      }
    }

    if (ok) log('PASS', `plugins/${p}: ${count} hooks wired to existing files`);
  }
}

function checkScriptReferences() {
  let ok = true;
  let checked = 0;

  for (const p of pluginDirs()) {
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.md')) {
          const content = fs.readFileSync(full, 'utf8');
          const rel = path.relative(ROOT, full);

          // A skill must not reach into the old global install location.
          if (/~\/\.claude\/(scripts|hooks|skills|agents)\//.test(content)) {
            log('FAIL', `${rel}: references the pre-8.0 global install path (~/.claude/...)`);
            ok = false;
          }

          for (const m of content.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+)/g)) {
            checked++;
            if (!fs.existsSync(path.join(PLUGINS_DIR, p, m[1]))) {
              log('FAIL', `${rel}: \${CLAUDE_PLUGIN_ROOT}/${m[1]} does not exist in this plugin`);
              ok = false;
            }
          }
        }
      }
    };
    walk(path.join(PLUGINS_DIR, p));
  }

  if (ok) log('PASS', `Script references: ${checked} plugin-relative paths resolve`);
}

// Shell snippets inside skills run in the user's shell, which is often zsh.
// An unquoted glob in a flag value (`--include=*.tsx`) is expanded by zsh before
// grep sees it, and when nothing matches in the current directory zsh errors the
// whole command. The failure is silent in a pipeline: counts come back 0 and a
// skill that measures a codebase reports that it found nothing.
function checkShellGlobQuoting() {
  const OFFENDERS = [
    { re: /--include=(?!['"])\S*\*/g, hint: "--include=*.ext must be quoted: --include='*.ext'" },
    { re: /--exclude=(?!['"])\S*\*/g, hint: "--exclude=*.ext must be quoted: --exclude='*.ext'" },
    { re: /--exclude-dir=(?!['"])\S*\*/g, hint: "--exclude-dir must be quoted when it contains a glob" },
  ];

  let ok = true;
  let scanned = 0;

  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) {
        scanned++;
        const content = fs.readFileSync(full, 'utf8');
        const rel = path.relative(ROOT, full);
        content.split('\n').forEach((line, i) => {
          for (const { re, hint } of OFFENDERS) {
            re.lastIndex = 0;
            if (re.test(line)) {
              log('FAIL', `${rel}:${i + 1}: ${hint}`);
              ok = false;
            }
          }
        });
      }
    }
  };
  walk(PLUGINS_DIR);

  if (ok) log('PASS', `Shell glob quoting: ${scanned} docs clean`);
}

function checkAgents() {
  for (const p of pluginDirs()) {
    const dir = path.join(PLUGINS_DIR, p, 'agents');
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    let ok = true;

    for (const file of files) {
      const fm = parseFrontmatter(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (!fm) {
        log('FAIL', `plugins/${p}/agents/${file}: no frontmatter`);
        ok = false;
        continue;
      }
      for (const field of ['name', 'description']) {
        if (!fm[field]) {
          log('FAIL', `plugins/${p}/agents/${file}: missing required field "${field}"`);
          ok = false;
        }
      }
      const expected = file.replace(/\.md$/, '');
      if (fm.name && fm.name !== expected) {
        log('FAIL', `plugins/${p}/agents/${file}: name "${fm.name}" does not match filename`);
        ok = false;
      }
    }

    if (ok && files.length) log('PASS', `plugins/${p}: ${files.length} agents validated`);
  }
}

function checkNoLegacyArtifacts() {
  const gone = [
    'install.sh', 'install.ps1', 'uninstall.sh', 'uninstall.ps1',
    'scripts/sync.js', 'scripts/uninstall.js', 'skills/manifest.json',
  ];
  let ok = true;
  for (const f of gone) {
    if (fs.existsSync(path.join(ROOT, f))) {
      log('FAIL', `${f} still exists — the copy-based installer was removed in 8.0`);
      ok = false;
    }
  }
  if (ok) log('PASS', 'No pre-8.0 installer artifacts remain');
}

// ---------------------------------------------------------------- run

console.log('Validating autodev marketplace...\n');

checkVersionSync();
checkMarketplace();
checkPluginManifests();
checkSkillFrontmatter();
checkHookWiring();
checkScriptReferences();
checkShellGlobQuoting();
checkAgents();
checkNoLegacyArtifacts();

console.log(`\nSummary: ${passCount} PASS, ${failCount} FAIL, ${warnCount} WARN`);
process.exit(failCount > 0 ? 1 : 0);
