# Claude Auto-Dev

[![Claude Code](https://img.shields.io/badge/Claude%20Code-Compatible-blueviolet)](https://claude.ai/code)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-2.5.0-blue.svg)](https://github.com/djnsty23/claude-auto-dev/releases)

**Autonomous AI-powered development workflow for Claude Code.** Turn natural language into working software with task loops, session management, and deployment automation.

> No scripts to run - just say what you want to build.

---

## What Gets Installed

| Component | Location | Purpose |
|-----------|----------|---------|
| **Skills** | `~/.claude/skills/` | Command instructions (auto, brainstorm, ship, etc.) |
| **Hooks** | `~/.claude/hooks/` | Auto-run scripts on session events |
| **Config** | `~/.claude/` | Global CLAUDE.md, rules, settings.json |
| **Plugin** | `~/.claude/plugins/local/` | Slash commands (/auto, /resume) |
| **Templates** | Project root | Project CLAUDE.md, prd.json, progress.txt |

---

## Installation

### Option 1: npx (Easiest)

```bash
# Install skills only (works everywhere)
npx claude-auto-dev

# Full install (skills + hooks + config + plugin)
npx claude-auto-dev --full

# Initialize current project
npx claude-auto-dev --init

# Full install + init project
npx claude-auto-dev --full --init
```

### Option 2: Full Install (From Source)

Installs everything: skills, hooks, config, plugin, and prompts for API keys.

**Windows (PowerShell):**
```powershell
git clone https://github.com/djnsty23/claude-auto-dev $env:USERPROFILE\Downloads\code\claude-auto-dev
cd $env:USERPROFILE\Downloads\code\claude-auto-dev
.\install.ps1 -Full
```

**Mac/Linux:**
```bash
git clone https://github.com/djnsty23/claude-auto-dev ~/claude-auto-dev
cd ~/claude-auto-dev && chmod +x install.sh
./install.sh --full
```

### Option 3: Skills Only (Minimal)

Just installs the skill files, no hooks or config.

**Windows:**
```powershell
cd $env:USERPROFILE\Downloads\code\claude-auto-dev
.\install.ps1 -Global
```

**Mac/Linux:**
```bash
cd ~/claude-auto-dev
./install.sh --global
```

### Option 3: Manual (Copy Skills Only)

```bash
# Mac/Linux
mkdir -p ~/.claude/skills
cp -r ~/claude-auto-dev/skills/* ~/.claude/skills/

# Windows (PowerShell)
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude\skills"
Copy-Item "$env:USERPROFILE\Downloads\code\claude-auto-dev\skills\*" "$env:USERPROFILE\.claude\skills\" -Recurse -Force
```

---

## Initialize a Project

After global install, initialize any project:

**Windows:**
```powershell
cd C:\path\to\your\project
& "$env:USERPROFILE\Downloads\code\claude-auto-dev\install.ps1" -Init
```

**Mac/Linux:**
```bash
cd /path/to/your/project
~/claude-auto-dev/install.sh --init
```

This creates:
- `CLAUDE.md` - Project-specific instructions
- `prd.json` - Task list (empty)
- `progress.txt` - Learnings log
- `.claude/briefs/` - Task brief storage

---

## Verify Installation

```bash
# Check skills installed
ls ~/.claude/skills/
# Should show: build.md, ship.md, test.md, fix.md, manifest.json, etc.

# Check hooks installed (full install only)
ls ~/.claude/hooks/
# Should show: session-start.sh, pre-tool-filter.sh, post-tool-typecheck.sh, auto-continue.sh

# Check plugin installed (full install only)
ls ~/.claude/plugins/local/claude-auto-dev/
```

---

## The Loop

```
"brainstorm"  →  What do you want to build?  →  generates tasks
"auto"        →  Works through all tasks automatically
"polish"      →  Suggests improvements  →  asks what's next
```

That's it. No scripts, no config files to edit.

---

## Complete Command Reference

### Core Loop Commands

| Command | What It Does | When To Use |
|---------|--------------|-------------|
| `brainstorm` | Asks what you want to build, generates 3-10 tasks, adds to prd.json | Starting a new feature or project |
| `auto` | Loops through ALL pending tasks automatically until done | You want Claude to work autonomously |
| `continue` | Completes ONE task, then stops and waits | You want control over each task |
| `status` | Shows "X/Y complete. Next: [task title]" | Check progress anytime |
| `stop` | Saves session to ledger.json, safe to close terminal | Done for the day |
| `reset` | Clears all "claimed" task states | Task got stuck or crashed |

### Session Management (v2.5)

| Command | What It Does | When To Use |
|---------|--------------|-------------|
| `handoff` | Saves full session context to handoff-*.md file | Before closing a long session |
| `resume` | Loads last handoff + injects mistake warnings | Starting new session after handoff |
| `ledger` / `stats` | Shows session analytics (tasks, files, blockers) | Review your productivity |

### Quality & Deployment

| Command | What It Does | When To Use |
|---------|--------------|-------------|
| `polish` | Finds improvements (TODOs, console.logs, any types) + direction picker | After all tasks complete |
| `review` | Runs build + checks TODOs + npm audit + security | Code review before merge |
| `security` | Supabase advisors + RLS check + secrets scan | **Before every deploy** |
| `ship` | Builds and deploys to Vercel | Ready to go live |
| `test` | Runs browser tests with agent-browser | Verify features work |
| `fix` | Debug and fix a specific issue | Something's broken |

### Maintenance

| Command | What It Does | When To Use |
|---------|--------------|-------------|
| `archive` | Moves completed tasks to prd-archive-*.json | prd.json getting too large |
| `clean` | Removes screenshots, old backups, temp files | Disk cleanup |
| `update` | Pulls latest claude-auto-dev from GitHub | Get new features |

---

## Command Details

### `handoff`

Saves your complete session context so you can continue seamlessly in a new session.

**What it saves:**
- Tasks completed this session
- Current task in progress
- Key decisions made
- Blockers/issues encountered
- Files modified
- Recommended next steps

**Output files:**
- `handoff-2026-01-22-1430.md` - Full session details
- `ledger.json` - Updated with session stats
- `progress.txt` - Appended summary

**Example:**
```
You: "handoff"
Claude: "Handoff saved to handoff-2026-01-22-1430.md

        This session:
        - Completed: S1, S2, S3
        - In progress: S4 (Add user settings)
        - Files: src/App.tsx, src/hooks/useAuth.ts
        - Decisions: Switched to React Query for data fetching

        Start new session and say 'resume' to continue."
```

### `resume`

Continues from your last handoff with full context restored.

**What it does:**
1. Finds latest handoff-*.md file
2. Displays summary of previous session
3. Reads .claude/mistakes.md for recent errors
4. Injects warnings: "Avoid these recent issues: [list]"
5. Reports next task

**Example:**
```
You: "resume"
Claude: "Resuming from Jan 22, 2:30 PM:

        - Completed: S1, S2, S3
        - Next: S4 - Add user settings page
        - Avoiding: null-check errors (user?.profile)

        Ready. Starting S4..."
```

### `polish`

Analyzes codebase for improvements and presents a direction picker.

**Step 1 - Find improvements (max 4):**
- TODO/FIXME comments
- console.log statements
- Missing error boundaries
- Accessibility gaps (aria-labels)
- `any` types in TypeScript

**Step 2 - Direction picker:**
```
All tasks complete! Found 3 polish items.

What's next?
  ○ Polish & continue (Recommended)  →  Adds items to prd.json, runs auto
  ○ New feature                       →  Runs brainstorm
  ○ Ship it                           →  Runs security, then ship
  ○ Done for now                      →  Runs handoff, then stop
```

### `ledger` / `stats`

Shows session analytics from ledger.json.

**Example output:**
```
┌─ Session Analytics ────────────────────────┐
│ Last 7 days:                               │
│                                            │
│ Sessions: 12                               │
│ Tasks completed: 47/52 (90%)               │
│ Avg tasks/session: 3.9                     │
│ Build success rate: 94%                    │
│                                            │
│ Hot files (most modified):                 │
│   src/App.tsx (8x)                         │
│   src/hooks/useData.ts (6x)                │
│                                            │
│ Common blockers:                           │
│   - Type errors (5x)                       │
│   - Missing imports (3x)                   │
└────────────────────────────────────────────┘
```

### `security`

Pre-deploy security audit. **Run before every push.**

**Checks:**
1. Supabase advisors (security + performance)
2. Secrets scan (no hardcoded passwords/keys in code)
3. Function audit (search_path set, SECURITY DEFINER where needed)
4. RLS check (all tables have row-level security)
5. Token security (proper generation, expiry columns)

**Output:**
```
✓ Supabase advisors: 0 issues
✓ No hardcoded secrets
✓ Functions: search_path set
✓ RLS: all tables protected
✗ ISSUE: Table 'user_sessions' missing RLS policy → Enable RLS

BLOCKING: Fix issues before deploy.
```

---

## Decision Guide

| You want to... | Say this |
|----------------|----------|
| Start a new feature | `brainstorm` |
| Let Claude work autonomously | `auto` |
| Do one task with control | `continue` |
| Check where you are | `status` |
| Stop for the day | `stop` |
| Save session for later | `handoff` |
| Continue from yesterday | `resume` |
| See your productivity | `ledger` |
| Find improvements | `polish` |
| Review before merge | `review` |
| Check security before deploy | `security` |
| Deploy to production | `ship` |
| Fix something broken | `fix` |
| Run browser tests | `test` |
| Clear stuck state | `reset` |
| Compact large task file | `archive` |
| Remove temp files | `clean` |
| Update the system | `update` |

---

## Workflows

### 1. Build a New Feature
```
brainstorm → auto → polish → ship
```

### 2. Continue Yesterday's Work
```
resume → auto → handoff
```

### 3. Quick Single Task
```
continue → stop
```

### 4. Long Session (3+ hours)
```
auto → (after 3 tasks, Claude suggests handoff) → handoff → /clear → resume → auto
```

### 5. Pre-Deploy Checklist
```
security → review → ship
```

### 6. Multi-Agent Mode
```bash
# Terminal 1
claude "auto"

# Terminal 2 (wait 10-30 seconds)
claude "auto"
```
Each session claims different tasks. No conflicts.

---

## Architecture

### Files in ~/.claude/ (Global)

```
~/.claude/
├── skills/              # Command instructions
│   ├── build.md         # Core loop (auto, brainstorm, status, etc.)
│   ├── ship.md          # Deployment
│   ├── test.md          # Browser testing
│   ├── fix.md           # Debugging
│   └── manifest.json    # Skill index
├── hooks/               # Auto-run scripts
│   ├── session-start.sh # Injects task progress
│   ├── pre-tool-filter.sh # Blocks dangerous commands
│   ├── post-tool-typecheck.sh # Runs typecheck after edits
│   └── auto-continue.sh # Auto-continues if tasks remain
├── rules/               # Always-applied rules
│   ├── security.md
│   └── design-system.md
├── plugins/local/claude-auto-dev/  # Plugin for slash commands
├── CLAUDE.md            # Global user instructions
├── settings.json        # Hooks configuration
└── mcp.json            # MCP server config
```

### Files in Project Root

```
your-project/
├── CLAUDE.md           # Project-specific instructions
├── prd.json            # Task list
├── progress.txt        # Append-only learnings log
├── ledger.json         # Session analytics (gitignored)
├── handoff-*.md        # Session handoffs (gitignored)
├── prd-archive-*.json  # Archived completed tasks
└── .claude/
    ├── briefs/         # Task briefs
    ├── mistakes.md     # Learned error patterns (gitignored)
    └── screenshots/    # Test screenshots (gitignored)
```

---

## Hooks (Full Install Only)

Hooks reduce token usage by 30-60% by automating common tasks:

| Hook | Trigger | What It Does |
|------|---------|--------------|
| `session-start` | Session begins | Injects task progress, skill index, recent mistakes |
| `pre-tool-filter` | Before tool use | Blocks dangerous commands, skips large files |
| `post-tool-typecheck` | After file edit | Runs `npm run typecheck` after TS/JS changes |
| `auto-continue` | After tool use | Auto-continues if tasks remain in prd.json |

---

## How It Works

Tasks live in `prd.json`:

```json
{
  "id": "S1",
  "title": "Add user authentication",
  "description": "Implement login/logout with Supabase Auth",
  "priority": 1,
  "passes": false,
  "files": ["src/auth/login.tsx", "src/hooks/useAuth.ts"],
  "acceptanceCriteria": ["User can log in", "User can log out", "Session persists"]
}
```

**Task states:**
- `passes: null` = new task (not started)
- `passes: false` = in progress
- `passes: true` = done

**Auto loop:**
```
Find task → Read files → Implement → Build → Pass? → Mark done → Next task
                                      ↓
                                    Fail? → Log to mistakes.md → Fix → Retry (max 3)
```

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

## Update

**Update skills only:**
```bash
cd ~/claude-auto-dev && git pull
./install.sh --update   # or .\install.ps1 -Update on Windows
```

**Full update (all components):**
```bash
cd ~/claude-auto-dev && git pull
./install.sh --full     # or .\install.ps1 -Full on Windows
```

Or just say `update` in any Claude session.

---

## Uninstall

```bash
# Remove global installation
rm -rf ~/.claude/skills/
rm -rf ~/.claude/hooks/
rm -rf ~/.claude/plugins/local/claude-auto-dev/

# Remove project files (optional)
rm prd.json progress.txt ledger.json handoff-*.md prd-archive-*.json
rm -rf .claude/
```

---

## Changelog

### [2.5.0] - 2026-01-22
- **Session Management**: `handoff` saves session state, `resume` continues later
- **Ledger System**: `ledger.json` tracks cross-session analytics
- **Mistake Learning**: Auto-logs build failures to `.claude/mistakes.md`
- **Session Analytics**: `ledger` / `stats` shows completion rates, hot files
- **Context Reminders**: Suggests handoff after 3+ tasks

### [2.4.4] - 2026-01-22
- Added `polish` command with direction picker

### [2.4.0] - 2026-01-22
- Archive system for large prd.json files
- Clean command for temp file removal

### [2.3.0] - 2026-01-22
- Hooks system (30-60% token savings)

[Full changelog](CHANGELOG.md)

---

## Related Projects

- [Claude Code](https://github.com/anthropics/claude-code) - Official CLI
- [agent-browser](https://www.npmjs.com/package/agent-browser) - Browser automation
- [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) - Plugins & skills

---

## License

MIT - Use it however you want.
