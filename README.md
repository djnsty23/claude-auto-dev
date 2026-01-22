# Claude Auto-Dev

[![Claude Code](https://img.shields.io/badge/Claude%20Code-Compatible-blueviolet)](https://claude.ai/code)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-2.4.3-blue.svg)](https://github.com/djnsty23/claude-auto-dev/releases)

**Autonomous AI-powered development workflow for Claude Code.** Turn natural language into working software with task loops, automated testing, and deployment automation.

> No scripts to run - just say what you want to build.

## What is Claude Auto-Dev?

Claude Auto-Dev is a **skills-based automation system** for [Claude Code](https://claude.ai/code) that enables:

- **Autonomous task execution** - AI works through your task list automatically
- **Multi-agent coordination** - Run multiple Claude sessions in parallel
- **Automated testing** - Browser automation with agent-browser CLI
- **One-command deployment** - Ship to Vercel/production with `ship`
- **Smart context management** - Hooks reduce token usage by 30-60%

Perfect for solo developers, indie hackers, and teams who want AI to handle the implementation while they focus on product decisions.

## Quick Start

**New project:**
```
"brainstorm"  → Creates prd.json, asks what to build, generates tasks
```

**Existing project:**
```
"auto"    → Work through all tasks automatically
"status"  → Check progress
```

That's it. No installation needed if you already have the skills in `~/.claude/skills/`.

---

## Installation

### Windows (PowerShell)
```powershell
git clone https://github.com/djnsty23/claude-auto-dev $env:USERPROFILE\Downloads\code\claude-auto-dev
Copy-Item "$env:USERPROFILE\Downloads\code\claude-auto-dev\skills\*" "$env:USERPROFILE\.claude\skills\" -Recurse
```

### Mac/Linux
```bash
git clone https://github.com/djnsty23/claude-auto-dev ~/claude-auto-dev
cp -r ~/claude-auto-dev/skills/* ~/.claude/skills/
```

---

## Commands

Works as natural language in any Claude Code session:

| Command | What Happens |
|---------|--------------|
| `brainstorm` | Generate tasks from your description |
| `auto` | Work through all tasks automatically |
| `status` | Show progress (X/Y complete) |
| `continue` | Complete one task, then stop |
| `stop` | Save progress, safe to close |
| `reset` | Clear stuck state after crash |
| `archive` | Compact prd.json when too large |
| `clean` | Remove screenshots, old backups |
| `review` | Code quality + security audit |
| `security` | Pre-push Supabase/RLS/secrets scan |

### Additional Skills

| Command | What Happens |
|---------|--------------|
| `ship` | Build and deploy to Vercel |
| `test` | Run browser tests with agent-browser |
| `fix` | Debug and fix issues |
| `set up` | Initialize new project structure |

---

## How It Works

### Task Management

Claude Auto-Dev uses a simple `prd.json` file to track tasks:

```json
{
  "id": "S1",
  "title": "Add user authentication",
  "description": "Implement login/signup with Supabase Auth",
  "priority": 1,
  "passes": false,
  "files": ["src/auth/login.tsx", "src/lib/supabase.ts"],
  "acceptanceCriteria": ["Users can sign up", "Users can log in"]
}
```

- `passes: false` = pending task
- `passes: true` = completed task
- `passes: null` = new/unstarted task

### Autonomous Loop

When you say `auto`, Claude:

1. Finds next pending task (`passes: false`)
2. Reads the relevant files
3. Implements changes
4. Runs `npm run build` to verify
5. Marks task complete if build passes
6. Continues to next task

Stops when: all tasks done, 3 consecutive failures, or you interrupt.

### Multi-Agent Mode

Run multiple Claude sessions for parallel development:

```bash
# Terminal 1
claude "auto"

# Terminal 2 (wait 10-30 seconds)
claude "auto"
```

Each session claims different tasks. No conflicts.

---

## Browser Testing

Uses **agent-browser** CLI (5-6x more token-efficient than Playwright MCP).

**Install:**
```bash
npm install -g agent-browser
agent-browser install
```

**Usage:**
```bash
agent-browser open http://localhost:3000
agent-browser snapshot -i     # Get interactive elements
agent-browser click @e1       # Click by ref
agent-browser fill @e2 "text" # Fill input
```

---

## Files Created

| File | Purpose |
|------|---------|
| `prd.json` | Active tasks with pass/fail status |
| `prd-archive-YYYY-MM.json` | Archived completed tasks |
| `progress.txt` | Append-only learnings log |
| `.claude/screenshots/` | Test screenshots (gitignored) |

---

## Token Optimization

Claude Auto-Dev includes hooks that reduce token usage by 30-60%:

- **SessionStart** - Injects task context at session start
- **PreToolUse** - Blocks dangerous commands, skips large files
- **PostToolUse** - Runs typecheck after TypeScript edits
- **Stop** - Auto-continues if tasks remain

---

## Tech Stack Compatibility

Works with any stack, optimized for:

- **Frontend:** React, Vue, Svelte, Next.js, Vite
- **Backend:** Node.js, Deno, Supabase Edge Functions
- **Database:** PostgreSQL, Supabase, Firebase
- **Deployment:** Vercel, Netlify, Cloudflare

---

## Update

```bash
cd ~/Downloads/code/claude-auto-dev && git pull
cp skills/*.md ~/.claude/skills/
```

Or just say `update` in any Claude session.

---

## Changelog

### [2.4.3] - 2026-01-22
- Cross-platform archive (Read/Write tools instead of shell)
- Fixed emoji encoding in install.ps1

### [2.4.2] - 2026-01-22
- Skill index injection via manifest.json
- Instant skill discovery from triggers

### [2.4.0] - 2026-01-22
- Archive system for large prd.json files
- Clean command for temp file removal
- Screenshot convention (.claude/screenshots/)

### [2.3.0] - 2026-01-22
- Hooks system (30-60% token savings)
- SessionStart, PreToolUse, PostToolUse hooks

[Full changelog](CHANGELOG.md)

---

## Related Projects

- [Claude Code](https://github.com/anthropics/claude-code) - Official CLI
- [agent-browser](https://www.npmjs.com/package/agent-browser) - Browser automation
- [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) - Plugins & skills

---

## License

MIT - Use it however you want.

---

## Keywords

claude code, autonomous coding, ai development, task automation, claude skills, ai programming assistant, autonomous agent, code generation, ai pair programming, claude code plugins, development automation, ai workflow
