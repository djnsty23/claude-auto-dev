#!/usr/bin/env node
/**
 * validate.js - Consistency checker for claude-auto-dev
 *
 * Validates version sync, manifest integrity, trigger consistency,
 * settings sync, and more across the entire project.
 *
 * Usage: node validate.js
 * Exit codes: 0 = pass, 1 = fail
 */

const fs = require('fs');
const path = require('path');

// Counters
let passCount = 0;
let failCount = 0;
let warnCount = 0;

function log(status, message) {
  console.log(`[${status}] ${message}`);
  if (status === 'PASS') passCount++;
  else if (status === 'FAIL') failCount++;
  else if (status === 'WARN') warnCount++;
}

function parseFrontmatter(content) {
  // Normalize line endings (CRLF → LF)
  content = content.replace(/\r\n/g, '\n');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  const lines = match[1].split('\n');
  let currentKey = null;
  let currentArray = null;
  for (const line of lines) {
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val === '') {
        currentArray = [];
        fm[currentKey] = currentArray;
      } else if (val.startsWith('"')) {
        fm[currentKey] = val.replace(/^"|"$/g, '');
      } else if (val === 'true') {
        fm[currentKey] = true;
      } else if (val === 'false') {
        fm[currentKey] = false;
      } else {
        fm[currentKey] = val;
      }
      currentArray = Array.isArray(fm[currentKey]) ? fm[currentKey] : null;
    } else if (currentArray !== null) {
      const listMatch = line.match(/^\s+-\s+(.*)/);
      if (listMatch) currentArray.push(listMatch[1].trim());
    }
  }
  return fm;
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }
}

function readJson(filePath) {
  const content = readFile(filePath);
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

// CHECK 1: VERSION SYNC
function checkVersionSync() {
  const versionContent = readFile('VERSION');
  if (!versionContent) {
    log('FAIL', 'VERSION file not found');
    return;
  }

  const version = versionContent.trim();
  const files = [];
  let allMatch = true;

  // package.json (x.y → x.y.0)
  const pkg = readJson('package.json');
  if (pkg && pkg.version) {
    const semver = pkg.version.split('.').slice(0, 2).join('.');
    if (semver === version) {
      files.push('package.json');
    } else {
      log('FAIL', `Version mismatch in package.json: expected ${version}.x, got ${pkg.version}`);
      allMatch = false;
    }
  }

  // manifest.json
  const manifest = readJson('skills/manifest.json');
  if (manifest && manifest.version === version) {
    files.push('manifest.json');
  } else {
    log('FAIL', `Version mismatch in manifest.json: expected ${version}, got ${manifest?.version}`);
    allMatch = false;
  }

  // README.md
  const readme = readFile('README.md');
  if (readme && readme.includes(`v${version}`)) {
    files.push('README.md');
  } else {
    log('FAIL', `Version v${version} not found in README.md`);
    allMatch = false;
  }

  // CHANGELOG.md
  const changelog = readFile('CHANGELOG.md');
  if (changelog && changelog.includes(`[${version}]`)) {
    files.push('CHANGELOG.md');
  } else {
    log('FAIL', `Version [${version}] not found in CHANGELOG.md`);
    allMatch = false;
  }

  // commands.md
  const commands = readFile('skills/commands.md');
  if (commands && commands.includes(`v${version}`)) {
    files.push('commands.md');
  } else {
    log('FAIL', `Version v${version} not found in commands.md`);
    allMatch = false;
  }

  // install.sh
  const installSh = readFile('install.sh');
  if (installSh && installSh.includes(version)) {
    files.push('install.sh');
  } else {
    log('FAIL', `Version ${version} not found in install.sh`);
    allMatch = false;
  }

  // install.ps1
  const installPs1 = readFile('install.ps1');
  if (installPs1 && installPs1.includes(version)) {
    files.push('install.ps1');
  } else {
    log('FAIL', `Version ${version} not found in install.ps1`);
    allMatch = false;
  }

  // session-start.js
  const sessionJs = readFile('hooks/session-start.js');
  if (sessionJs && sessionJs.includes(version)) {
    files.push('session-start.js');
  } else {
    log('FAIL', `Version ${version} not found in session-start.js`);
    allMatch = false;
  }

  if (allMatch) {
    log('PASS', `Version sync: ${version} across ${files.length} files`);
  }
}

// CHECK 2: MANIFEST INTEGRITY
function checkManifestIntegrity() {
  const manifest = readJson('skills/manifest.json');
  if (!manifest || !manifest.skills) {
    log('FAIL', 'manifest.json not found or invalid');
    return;
  }

  const skillNames = Object.keys(manifest.skills);
  let allMatch = true;
  let missingFiles = [];
  let extraFiles = [];

  // Check each manifest entry has a corresponding SKILL.md
  for (const skillName of skillNames) {
    const skillPath = `skills/${skillName}/SKILL.md`;
    if (!fs.existsSync(skillPath)) {
      missingFiles.push(skillName);
      allMatch = false;
    }
  }

  // Check each SKILL.md directory has a manifest entry
  if (fs.existsSync('skills')) {
    const dirs = fs.readdirSync('skills', { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const dir of dirs) {
      const skillPath = `skills/${dir}/SKILL.md`;
      if (fs.existsSync(skillPath) && !manifest.skills[dir]) {
        extraFiles.push(dir);
        allMatch = false;
      }
    }
  }

  if (missingFiles.length > 0) {
    log('FAIL', `Manifest integrity: missing SKILL.md files: ${missingFiles.join(', ')}`);
  }

  if (extraFiles.length > 0) {
    log('FAIL', `Manifest integrity: SKILL.md without manifest entry: ${extraFiles.join(', ')}`);
  }

  if (allMatch) {
    log('PASS', `Manifest integrity: ${skillNames.length} skills, all matched`);
  }
}

// CHECK 3: TRIGGER CONSISTENCY
function checkTriggerConsistency() {
  const manifest = readJson('skills/manifest.json');
  if (!manifest || !manifest.skills) return;

  let allMatch = true;

  for (const [skillName, skillMeta] of Object.entries(manifest.skills)) {
    const skillPath = `skills/${skillName}/SKILL.md`;
    const content = readFile(skillPath);
    if (!content) continue;

    const fm = parseFrontmatter(content);
    const manifestTriggers = skillMeta.triggers || [];
    const fmTriggers = fm.triggers || [];

    // Order-independent comparison
    const manifestSet = new Set(manifestTriggers);
    const fmSet = new Set(fmTriggers);

    const match = manifestSet.size === fmSet.size &&
                  [...manifestSet].every(t => fmSet.has(t));

    if (!match) {
      log('FAIL', `Trigger mismatch: ${skillName} — manifest has ${manifestTriggers.length}, SKILL.md has ${fmTriggers.length}`);
      allMatch = false;
    }
  }

  if (allMatch) {
    log('PASS', 'Trigger consistency: all skills match');
  }
}

// CHECK 4: DESCRIPTION CONSISTENCY
function checkDescriptionConsistency() {
  const manifest = readJson('skills/manifest.json');
  if (!manifest || !manifest.skills) return;

  let allMatch = true;

  for (const [skillName, skillMeta] of Object.entries(manifest.skills)) {
    const skillPath = `skills/${skillName}/SKILL.md`;
    const content = readFile(skillPath);
    if (!content) continue;

    const fm = parseFrontmatter(content);

    if (skillMeta.description !== fm.description) {
      log('FAIL', `Description mismatch: ${skillName}`);
      allMatch = false;
    }
  }

  if (allMatch) {
    log('PASS', 'Description consistency: all skills match');
  }
}

// CHECK 5: FRONTMATTER COMPLETENESS
function checkFrontmatterCompleteness() {
  const manifest = readJson('skills/manifest.json');
  if (!manifest || !manifest.skills) return;

  let missingRequired = [];
  let missingAllowedTools = [];
  let missingModel = [];

  for (const skillName of Object.keys(manifest.skills)) {
    const skillPath = `skills/${skillName}/SKILL.md`;
    const content = readFile(skillPath);
    if (!content) continue;

    const fm = parseFrontmatter(content);

    if (!fm.name || !fm.description || fm['user-invocable'] === undefined) {
      missingRequired.push(skillName);
    }

    if (!fm['allowed-tools']) {
      missingAllowedTools.push(skillName);
    }

    if (!fm.model) {
      missingModel.push(skillName);
    }
  }

  if (missingRequired.length > 0) {
    log('FAIL', `Missing required frontmatter fields: ${missingRequired.join(', ')}`);
  } else {
    log('PASS', 'Frontmatter required fields: all complete');
  }

  if (missingAllowedTools.length > 0) {
    log('WARN', `Missing allowed-tools: ${missingAllowedTools.join(', ')}`);
  }

  if (missingModel.length > 0) {
    log('WARN', `Missing model: ${missingModel.join(', ')}`);
  }
}

// CHECK 6: COMMANDS.MD COMPLETENESS
function checkCommandsCompleteness() {
  const manifest = readJson('skills/manifest.json');
  if (!manifest || !manifest.skills) return;

  const commands = readFile('skills/commands.md');
  if (!commands) {
    log('FAIL', 'commands.md not found');
    return;
  }

  let missingInCommands = [];
  let shouldNotBeInCommands = [];

  for (const [skillName, skillMeta] of Object.entries(manifest.skills)) {
    const skillPath = `skills/${skillName}/SKILL.md`;
    const content = readFile(skillPath);
    if (!content) continue;

    const fm = parseFrontmatter(content);
    const userInvocable = fm['user-invocable'];

    // Check if any trigger appears in commands.md
    const triggers = fm.triggers || [];
    const appearsInCommands = triggers.some(t => {
      const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`\`${escaped}\`|${escaped}\\b`, 'i');
      return pattern.test(commands);
    });

    if (userInvocable && !appearsInCommands) {
      missingInCommands.push(skillName);
    }

    if (!userInvocable && appearsInCommands) {
      shouldNotBeInCommands.push(skillName);
    }
  }

  if (missingInCommands.length > 0) {
    log('FAIL', `User-invocable skills missing from commands.md: ${missingInCommands.join(', ')}`);
  }

  if (shouldNotBeInCommands.length > 0) {
    log('WARN', `Non-user-invocable skills in commands.md: ${shouldNotBeInCommands.join(', ')}`);
  }

  if (missingInCommands.length === 0 && shouldNotBeInCommands.length === 0) {
    log('PASS', 'commands.md completeness: all user-invocable skills present');
  }
}

// CHECK 7: SETTINGS SYNC
function checkSettingsSync() {
  const settings = readJson('config/settings.json');
  const settingsUnix = readJson('config/settings-unix.json');

  if (!settings || !settingsUnix) {
    log('FAIL', 'Settings files not found');
    return;
  }

  let allMatch = true;

  // Check deny rules
  const denyRules1 = settings.permissions?.deny || [];
  const denyRules2 = settingsUnix.permissions?.deny || [];

  if (JSON.stringify(denyRules1.sort()) !== JSON.stringify(denyRules2.sort())) {
    log('FAIL', 'Settings sync: deny rules differ between settings.json and settings-unix.json');
    allMatch = false;
  }

  // Check hook events
  const hooks1 = Object.keys(settings.hooks || {});
  const hooks2 = Object.keys(settingsUnix.hooks || {});

  if (JSON.stringify(hooks1.sort()) !== JSON.stringify(hooks2.sort())) {
    log('FAIL', 'Settings sync: hook events differ between settings files');
    allMatch = false;
  }

  if (allMatch) {
    log('PASS', 'Settings sync: deny rules and hooks match');
  }
}

// CHECK 8: REQUIRES CHAINS
function checkRequiresChains() {
  const manifest = readJson('skills/manifest.json');
  if (!manifest || !manifest.skills) return;

  const skillNames = Object.keys(manifest.skills);
  let allValid = true;

  for (const [skillName, skillMeta] of Object.entries(manifest.skills)) {
    const requires = skillMeta.requires || [];

    for (const reqSkill of requires) {
      if (!skillNames.includes(reqSkill)) {
        log('FAIL', `Invalid requires chain: ${skillName} requires non-existent skill "${reqSkill}"`);
        allValid = false;
      }
    }
  }

  if (allValid) {
    log('PASS', 'Requires chains: all valid');
  }
}

// CHECK 9: HOOK FILES EXIST
function checkHookFilesExist() {
  const settings = readJson('config/settings.json');
  if (!settings || !settings.hooks) {
    log('FAIL', 'settings.json hooks section not found');
    return;
  }

  let allExist = true;
  const hookFiles = new Set();

  // Extract hook file paths from settings command strings
  // In JSON-stringified text, backslashes are doubled (\\hooks\\file.ps1)
  const hookFileRegex = /hooks[\\\/]+([\w-]+\.(?:sh|ps1|js))/g;
  const settingsStr = JSON.stringify(settings);
  let hookMatch;
  while ((hookMatch = hookFileRegex.exec(settingsStr)) !== null) {
    hookFiles.add(`hooks/${hookMatch[1]}`);
  }

  for (const hookFile of hookFiles) {
    if (!fs.existsSync(hookFile)) {
      log('FAIL', `Hook file missing: ${hookFile}`);
      allExist = false;
    }
  }

  if (allExist) {
    log('PASS', `Hook files exist: ${hookFiles.size} files verified`);
  }
}

// CHECK 10: AGENT FILES
function checkAgentFiles() {
  const agentsDir = 'agents';
  if (!fs.existsSync(agentsDir)) {
    log('WARN', 'agents/ directory not found');
    return;
  }

  const agentFiles = fs.readdirSync(agentsDir)
    .filter(f => f.endsWith('.md'));

  if (agentFiles.length === 0) {
    log('WARN', 'No agent files found in agents/');
    return;
  }

  let allValid = true;
  const requiredFields = ['name', 'description'];

  for (const file of agentFiles) {
    const content = readFile(path.join(agentsDir, file));
    if (!content) continue;

    const fm = parseFrontmatter(content);
    const missing = requiredFields.filter(f => !fm[f]);

    if (missing.length > 0) {
      log('FAIL', `Agent ${file}: missing required fields: ${missing.join(', ')}`);
      allValid = false;
    }

    // Validate name matches filename (without .md)
    const expectedName = file.replace('.md', '');
    if (fm.name && fm.name !== expectedName) {
      log('FAIL', `Agent ${file}: name "${fm.name}" doesn't match filename "${expectedName}"`);
      allValid = false;
    }
  }

  if (allValid) {
    log('PASS', `Agent files: ${agentFiles.length} agents validated`);
  }
}

// RUN ALL CHECKS
console.log('Running claude-auto-dev validation...\n');

checkVersionSync();
checkManifestIntegrity();
checkTriggerConsistency();
checkDescriptionConsistency();
checkFrontmatterCompleteness();
checkCommandsCompleteness();
checkSettingsSync();
checkRequiresChains();
checkHookFilesExist();
checkAgentFiles();

console.log(`\nSummary: ${passCount} PASS, ${failCount} FAIL, ${warnCount} WARN`);

process.exit(failCount > 0 ? 1 : 0);
