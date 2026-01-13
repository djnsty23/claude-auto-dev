#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

const homeDir = os.homedir();
const claudeDir = path.join(homeDir, '.claude');
const skillsDir = path.join(claudeDir, 'skills');
const templatesDir = path.join(claudeDir, 'templates');

// Source directories (relative to this script)
const srcDir = path.join(__dirname, '..');
const srcSkills = path.join(srcDir, 'skills');
const srcTemplates = path.join(srcDir, 'templates');
const srcPatterns = path.join(srcDir, 'patterns.txt');

console.log('🚀 Claude Auto-Dev Installer\n');

// Create directories
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`  Created: ${dir}`);
  }
}

// Copy files
function copyDir(src, dest) {
  ensureDir(dest);
  const files = fs.readdirSync(src);
  let count = 0;

  for (const file of files) {
    const srcFile = path.join(src, file);
    const destFile = path.join(dest, file);

    if (fs.statSync(srcFile).isFile()) {
      fs.copyFileSync(srcFile, destFile);
      count++;
    }
  }
  return count;
}

// Install
console.log('📁 Installing to ~/.claude/\n');

ensureDir(claudeDir);
const skillCount = copyDir(srcSkills, skillsDir);
const templateCount = copyDir(srcTemplates, templatesDir);

// Copy patterns.txt if it exists
const destPatterns = path.join(claudeDir, 'patterns.txt');
if (fs.existsSync(srcPatterns) && !fs.existsSync(destPatterns)) {
  fs.copyFileSync(srcPatterns, destPatterns);
  console.log('  Created: ~/.claude/patterns.txt (global learnings)');
}

console.log(`\n✅ Installed ${skillCount} skills and ${templateCount} templates\n`);

// Check for --init flag
if (process.argv.includes('--init') || process.argv.includes('-i')) {
  const cwd = process.cwd();
  console.log('📋 Initializing project files...\n');

  // Create prd.json if not exists
  const prdPath = path.join(cwd, 'prd.json');
  if (!fs.existsSync(prdPath)) {
    const prdTemplate = {
      project: path.basename(cwd),
      description: "Project description",
      branchName: "main",
      qualityChecks: ["npm run build"],
      phases: {
        "1": {
          name: "Setup",
          status: "pending",
          stories: "S1-S5"
        }
      },
      stories: [
        {
          id: "S1",
          title: "Example task",
          description: "Replace with your first task",
          priority: 1,
          passes: false,
          claimedAt: null,
          completedAt: null,
          files: [],
          acceptanceCriteria: ["Build passes"]
        }
      ]
    };
    fs.writeFileSync(prdPath, JSON.stringify(prdTemplate, null, 2));
    console.log('  Created: prd.json');
  } else {
    console.log('  Skipped: prd.json (already exists)');
  }

  // Create progress.txt if not exists
  const progressPath = path.join(cwd, 'progress.txt');
  if (!fs.existsSync(progressPath)) {
    const progressTemplate = `# ${path.basename(cwd)} - Progress Log

## Codebase Patterns
- [Add patterns as you discover them]

## Sessions
---
`;
    fs.writeFileSync(progressPath, progressTemplate);
    console.log('  Created: progress.txt');
  } else {
    console.log('  Skipped: progress.txt (already exists)');
  }

  // Create .claude directory
  const projectClaudeDir = path.join(cwd, '.claude');
  ensureDir(projectClaudeDir);

  console.log('');
}

// Print usage
console.log('📖 Usage:\n');
console.log('  auto        - Work through all tasks autonomously');
console.log('  continue    - Do one task, then ask');
console.log('  status      - Show progress');
console.log('  context     - Quick-load project state');
console.log('  stop        - Save session and close');
console.log('  help        - Show all commands');
console.log('');
console.log('🎉 Ready! Say "auto" to start working.\n');
