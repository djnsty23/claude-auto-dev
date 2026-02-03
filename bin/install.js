#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

const homeDir = os.homedir();
const claudeDir = path.join(homeDir, '.claude');
const skillsDir = path.join(claudeDir, 'skills');
const hooksDir = path.join(claudeDir, 'hooks');
const rulesDir = path.join(claudeDir, 'rules');

const srcDir = path.join(__dirname, '..');
const srcSkills = path.join(srcDir, 'skills');
const srcHooks = path.join(srcDir, 'hooks');
const srcRules = path.join(srcDir, 'config', 'rules');
const srcTemplates = path.join(srcDir, 'templates');

const args = process.argv.slice(2);
const fullInstall = args.includes('--full') || args.includes('-f');
const initProject = args.includes('--init') || args.includes('-i');
const showHelp = args.includes('--help') || args.includes('-h');

if (showHelp) {
  console.log(`
Claude Auto-Dev v4.0 Installer

Usage:
  npx claude-auto-dev           Install skills
  npx claude-auto-dev --full    Install everything (skills, hooks, rules)
  npx claude-auto-dev --init    Initialize current project

Options:
  -f, --full    Full install
  -i, --init    Initialize project with project-meta.json
  -h, --help    Show help
`);
  process.exit(0);
}

console.log('Claude Auto-Dev v4.0 Installer\n');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  }
  return false;
}

function copyDirRecursive(src, dest) {
  ensureDir(dest);
  if (!fs.existsSync(src)) return 0;
  const items = fs.readdirSync(src);
  let count = 0;
  for (const item of items) {
    const srcPath = path.join(src, item);
    const destPath = path.join(dest, item);
    if (fs.statSync(srcPath).isDirectory()) {
      count += copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

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

ensureDir(claudeDir);

// Install skills (directory-based)
console.log('Installing skills...');
const fileCount = copyDirRecursive(srcSkills, skillsDir);
console.log(`  ${fileCount} files -> ~/.claude/skills/`);

if (fullInstall) {
  // Install hooks
  console.log('\nInstalling hooks...');
  const isWindows = os.platform() === 'win32';
  const hookExt = isWindows ? '.ps1' : '.sh';
  const hookCount = copyDir(srcHooks, hooksDir, hookExt);
  console.log(`  ${hookCount} hooks -> ~/.claude/hooks/`);

  if (!isWindows && fs.existsSync(hooksDir)) {
    for (const file of fs.readdirSync(hooksDir)) {
      fs.chmodSync(path.join(hooksDir, file), '755');
    }
  }

  // Install rules
  console.log('\nInstalling rules...');
  const ruleCount = copyDir(srcRules, rulesDir);
  console.log(`  ${ruleCount} rules -> ~/.claude/rules/`);
}

// Initialize project
if (initProject) {
  const cwd = process.cwd();
  const projectName = path.basename(cwd);
  console.log(`\nInitializing project: ${projectName}`);

  const metaPath = path.join(cwd, 'project-meta.json');
  if (!fs.existsSync(metaPath)) {
    const meta = {
      name: projectName,
      currentSprint: 'sprint-1',
      totalCompleted: 0,
      sprints: { 'sprint-1': { status: 'active', tasks: 0 } },
      roadmap: []
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    console.log('  Created: project-meta.json');
  } else {
    console.log('  Exists: project-meta.json');
  }

  const progressPath = path.join(cwd, 'progress.txt');
  if (!fs.existsSync(progressPath)) {
    const date = new Date().toISOString().split('T')[0];
    fs.writeFileSync(progressPath, `# ${projectName} - Progress Log\nStarted: ${date}\n`);
    console.log('  Created: progress.txt');
  }
}

console.log('\n' + '='.repeat(40));
console.log('Install complete!');
console.log('='.repeat(40));
console.log(`
Skills:
  /audit       Scan project, create prioritized roadmap
  /brainstorm  Generate work based on project needs
  /sprint      Create or advance sprints
  /status      Show progress (lightweight)
  /verify      Quality checks + mark complete
  /clean       Remove temp files

Get started: say "audit" to scan your project.
`);
