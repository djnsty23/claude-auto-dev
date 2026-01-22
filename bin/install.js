#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

const homeDir = os.homedir();
const claudeDir = path.join(homeDir, '.claude');
const skillsDir = path.join(claudeDir, 'skills');
const hooksDir = path.join(claudeDir, 'hooks');
const rulesDir = path.join(claudeDir, 'rules');
const pluginDir = path.join(claudeDir, 'plugins', 'local', 'claude-auto-dev');

// Source directories (relative to this script)
const srcDir = path.join(__dirname, '..');
const srcSkills = path.join(srcDir, 'skills');
const srcHooks = path.join(srcDir, 'hooks');
const srcConfig = path.join(srcDir, 'config');
const srcRules = path.join(srcDir, 'config', 'rules');
const srcPlugin = path.join(srcDir, 'plugin');
const srcTemplates = path.join(srcDir, 'templates');

// Parse args
const args = process.argv.slice(2);
const fullInstall = args.includes('--full') || args.includes('-f');
const initProject = args.includes('--init') || args.includes('-i');
const showHelp = args.includes('--help') || args.includes('-h');

if (showHelp) {
  console.log(`
Claude Auto-Dev Installer

Usage:
  npx claude-auto-dev           Install skills only (minimal)
  npx claude-auto-dev --full    Install everything (skills, hooks, config, plugin)
  npx claude-auto-dev --init    Initialize current project with prd.json
  npx claude-auto-dev --full --init   Full install + init project

Options:
  -f, --full    Full install (skills + hooks + config + plugin)
  -i, --init    Initialize project files in current directory
  -h, --help    Show this help message
`);
  process.exit(0);
}

console.log('Claude Auto-Dev Installer\n');

// Create directories
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  }
  return false;
}

// Copy directory contents
function copyDir(src, dest, ext = null) {
  if (!fs.existsSync(src)) return 0;
  ensureDir(dest);
  const files = fs.readdirSync(src);
  let count = 0;

  for (const file of files) {
    const srcFile = path.join(src, file);
    const destFile = path.join(dest, file);

    if (fs.statSync(srcFile).isFile()) {
      if (!ext || file.endsWith(ext)) {
        fs.copyFileSync(srcFile, destFile);
        count++;
      }
    }
  }
  return count;
}

// Copy single file
function copyFile(src, dest, overwrite = false) {
  if (fs.existsSync(src) && (overwrite || !fs.existsSync(dest))) {
    fs.copyFileSync(src, dest);
    return true;
  }
  return false;
}

// Install
ensureDir(claudeDir);

// Always install skills
console.log('Installing skills...');
const skillCount = copyDir(srcSkills, skillsDir);
console.log(`  ${skillCount} skills -> ~/.claude/skills/`);

if (fullInstall) {
  // Install hooks
  console.log('\nInstalling hooks...');
  const isWindows = os.platform() === 'win32';
  const hookExt = isWindows ? '.ps1' : '.sh';
  const hookCount = copyDir(srcHooks, hooksDir, hookExt);
  console.log(`  ${hookCount} hooks -> ~/.claude/hooks/`);

  // Make hooks executable on Unix
  if (!isWindows && fs.existsSync(hooksDir)) {
    const hookFiles = fs.readdirSync(hooksDir);
    for (const file of hookFiles) {
      const hookPath = path.join(hooksDir, file);
      fs.chmodSync(hookPath, '755');
    }
  }

  // Install rules
  console.log('\nInstalling rules...');
  const ruleCount = copyDir(srcRules, rulesDir);
  console.log(`  ${ruleCount} rules -> ~/.claude/rules/`);

  // Install config files
  console.log('\nInstalling config...');
  if (copyFile(path.join(srcConfig, 'CLAUDE.md'), path.join(claudeDir, 'CLAUDE.md'))) {
    console.log('  CLAUDE.md -> ~/.claude/');
  }

  const settingsFile = isWindows ? 'settings.json' : 'settings-unix.json';
  if (copyFile(path.join(srcConfig, settingsFile), path.join(claudeDir, 'settings.json'))) {
    console.log('  settings.json -> ~/.claude/');
  }

  // Install plugin
  console.log('\nInstalling plugin...');
  if (fs.existsSync(srcPlugin)) {
    ensureDir(pluginDir);
    // Copy plugin files recursively
    function copyDirRecursive(src, dest) {
      ensureDir(dest);
      const items = fs.readdirSync(src);
      for (const item of items) {
        const srcPath = path.join(src, item);
        const destPath = path.join(dest, item);
        if (fs.statSync(srcPath).isDirectory()) {
          copyDirRecursive(srcPath, destPath);
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }
    copyDirRecursive(srcPlugin, pluginDir);
    console.log('  plugin -> ~/.claude/plugins/local/claude-auto-dev/');
  }
}

// Initialize project
if (initProject) {
  const cwd = process.cwd();
  const projectName = path.basename(cwd);
  console.log(`\nInitializing project: ${projectName}`);

  // Create prd.json
  const prdPath = path.join(cwd, 'prd.json');
  if (!fs.existsSync(prdPath)) {
    const prd = {
      project: projectName,
      version: "1.0.0",
      stories: []
    };
    fs.writeFileSync(prdPath, JSON.stringify(prd, null, 2));
    console.log('  Created: prd.json');
  } else {
    console.log('  Skipped: prd.json (exists)');
  }

  // Create progress.txt
  const progressPath = path.join(cwd, 'progress.txt');
  if (!fs.existsSync(progressPath)) {
    const date = new Date().toISOString().split('T')[0];
    const content = `# ${projectName} - Progress Log\n\nStarted: ${date}\n\n## Sessions\n`;
    fs.writeFileSync(progressPath, content);
    console.log('  Created: progress.txt');
  } else {
    console.log('  Skipped: progress.txt (exists)');
  }

  // Create CLAUDE.md from template
  const claudeMdPath = path.join(cwd, 'CLAUDE.md');
  const templateClaudeMd = path.join(srcTemplates, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath) && fs.existsSync(templateClaudeMd)) {
    let content = fs.readFileSync(templateClaudeMd, 'utf8');
    content = content.replace(/\{\{NAME\}\}/g, projectName);
    content = content.replace(/\{\{DATE\}\}/g, new Date().toISOString().split('T')[0]);
    fs.writeFileSync(claudeMdPath, content);
    console.log('  Created: CLAUDE.md');
  } else if (!fs.existsSync(claudeMdPath)) {
    const content = `# ${projectName}\n\nProject-specific instructions for Claude Code.\n`;
    fs.writeFileSync(claudeMdPath, content);
    console.log('  Created: CLAUDE.md');
  } else {
    console.log('  Skipped: CLAUDE.md (exists)');
  }

  // Create .claude directory
  ensureDir(path.join(cwd, '.claude', 'briefs'));
  console.log('  Created: .claude/briefs/');
}

// Summary
console.log('\n' + '='.repeat(50));
if (fullInstall) {
  console.log('Full install complete!');
} else {
  console.log('Skills installed!');
  console.log('Run with --full for hooks, config, and plugin.');
}
console.log('='.repeat(50));

console.log(`
Quick Start:
  brainstorm    Generate tasks from your description
  auto          Work through all tasks automatically
  status        Show progress
  handoff       Save session for later
  resume        Continue from last session

Ready! Open Claude Code and say "brainstorm" to start.
`);
