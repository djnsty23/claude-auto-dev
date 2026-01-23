# Claude Auto-Dev

[![Claude Code](https://img.shields.io/badge/Claude%20Code-Compatible-blueviolet)](https://claude.ai/code)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-2.5.2-blue.svg)](https://github.com/djnsty23/claude-auto-dev/releases)

**Autonomous AI-powered development workflow for Claude Code.** Turn natural language into working software with task loops, session management, and deployment automation.

> No scripts to run - just say what you want to build.

---

## Complete Setup Guide (For Beginners)

### Prerequisites

You need these installed on your computer:

| Tool | Check if installed | Install |
|------|-------------------|---------|
| **Node.js 18+** | `node --version` | [nodejs.org](https://nodejs.org/) |
| **npm** | `npm --version` | Comes with Node.js |
| **Git** | `git --version` | [git-scm.com](https://git-scm.com/) |

### Step 1: Install Claude Code

Claude Code is Anthropic's official CLI for coding with Claude AI.

**Mac/Linux:**
```bash
npm install -g @anthropic-ai/claude-code
```

**Windows (PowerShell as Administrator):**
```powershell
npm install -g @anthropic-ai/claude-code
```

**Verify it works:**
```bash
claude --version
```

### Step 2: Authenticate Claude Code

```bash
claude
```

This opens a browser window to log in with your Anthropic account. You need:
- An Anthropic account ([console.anthropic.com](https://console.anthropic.com))
- Claude Pro, Team, or API credits

### Step 3: Install Claude Auto-Dev

**Clone and run install script:**

```bash
# Mac/Linux
git clone https://github.com/djnsty23/claude-auto-dev ~/claude-auto-dev
cd ~/claude-auto-dev && chmod +x install.sh && ./install.sh --full

# Windows (PowerShell)
git clone https://github.com/djnsty23/claude-auto-dev $env:USERPROFILE\Downloads\code\claude-auto-dev
cd $env:USERPROFILE\Downloads\code\claude-auto-dev
.\install.ps1 -Full
```

**Or manual copy (minimal):**
```bash
# Mac/Linux
mkdir -p ~/.claude/skills && cp -r skills/* ~/.claude/skills/

# Windows (PowerShell)
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude\skills"
Copy-Item "skills\*" "$env:USERPROFILE\.claude\skills\" -Recurse -Force
```

> **Note:** This is NOT an npm package. It's markdown files that Claude Code loads automatically.

### Step 4: Start Using It

```bash
# Navigate to any project
cd ~/my-project

# Start Claude Code
claude

# Type this in the Claude prompt:
brainstorm
```

Claude will ask what you want to build, generate tasks, and work through them automatically.

---

## Quick Reference

```
brainstorm  →  Generate tasks from your description
auto        →  Work through all tasks automatically
status      →  Check progress
handoff     →  Save session for later
resume      →  Continue from last session
```

---

## What Gets Installed

| Component | Location | Purpose |
|-----------|----------|---------|
| **Skills** | `~/.claude/skills/` | Command instructions (auto, brainstorm, ship, etc.) |
| **Hooks** | `~/.claude/hooks/` | Auto-run scripts on session events |
| **Config** | `~/.claude/` | Global CLAUDE.md, rules, settings.json |

---

## Verify Installation

```bash
ls ~/.claude/skills/   # Should show: build.md, ship.md, test.md, etc.
```

---

## Your First Session

```bash
# 1. Navigate to any project
cd ~/my-project

# 2. Start Claude Code
claude

# 3. Type: brainstorm
# 4. Describe what you want to build
# 5. Type: auto
# 6. Claude works through all tasks automatically
```

---

## The Core Loop

```
"brainstorm"  →  What do you want to build?  →  generates tasks
"auto"        →  Works through all tasks automatically
"polish"      →  Suggests improvements  →  asks what's next
```

That's the full development cycle. No scripts, no config files to edit.

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
| `polish` | **Visual verification** + static analysis + direction picker | After all tasks complete |
| `review` | Build + TODOs + npm audit + security + **UX audit** | Code review before merge |
| `security` | Supabase advisors + RLS check + secrets scan | **Before every deploy** |
| `ship` | Builds and deploys to Vercel | Ready to go live |
| `test` | Runs browser tests with agent-browser | Verify features work |
| `fix` | Debug and fix a specific issue | Something's broken |

### UI/UX Quality (v2.5.2)

Built-in checks to catch design issues before they ship:

**Static Analysis (ux-audit):**
- Hardcoded colors → Use semantic tokens
- Inline styles → Use Tailwind classes
- Placeholder content → Replace Lorem ipsum
- Generic AI copy → Use specific language
- Accessibility gaps → Add alt/aria attributes

**Visual Verification (polish):**
- Screenshots key routes automatically
- Checks for clipping, overflow, spacing
- Detects empty states, missing loading UI
- Flags generic-looking components

**UI Gate (auto):**
- Component changes require screenshot verification
- Catches visual bugs before marking task complete

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

**Example:**
```
You: "handoff"
Claude: "Handoff saved to handoff-2026-01-22-1430.md

        This session:
        - Completed: S1, S2, S3
        - In progress: S4 (Add user settings)
        - Files: src/App.tsx, src/hooks/useAuth.ts

        Start new session and say 'resume' to continue."
```

### `resume`

Continues from your last handoff with full context restored.

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

**What it checks:**
- TODO/FIXME comments
- console.log statements
- Missing error boundaries
- Accessibility gaps (aria-labels)
- `any` types in TypeScript

**Direction picker:**
```
All tasks complete! Found 3 polish items.

What's next?
  ○ Polish & continue (Recommended)  →  Adds items to prd.json, runs auto
  ○ New feature                       →  Runs brainstorm
  ○ Ship it                           →  Runs security, then ship
  ○ Done for now                      →  Runs handoff, then stop
```

### `security`

Pre-deploy security audit. **Run before every push.**

**Checks:**
1. Supabase advisors (security + performance)
2. Secrets scan (no hardcoded passwords/keys in code)
3. Function audit (search_path set, SECURITY DEFINER where needed)
4. RLS check (all tables have row-level security)

**Output:**
```
✓ Supabase advisors: 0 issues
✓ No hardcoded secrets
✓ RLS: all tables protected
✗ ISSUE: Table 'user_sessions' missing RLS policy

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

## Common Workflows

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

### 6. Multi-Agent Mode (Parallel Development)
```bash
# Terminal 1
claude "auto"

# Terminal 2 (wait 10-30 seconds)
claude "auto"
```
Each session claims different tasks. No conflicts.

---

## Architecture

### Files in ~/.claude/ (Global - installed once)

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

### Files in Project Root (per project)

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
  "acceptanceCriteria": ["User can log in", "User can log out"]
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

## Model Routing (Automatic)

Opus is best at coding. Offload non-coding tasks to Haiku (60x cheaper).

| Task | Model | Why |
|------|-------|-----|
| `brainstorm`, `auto`, `continue` | **Opus** | Coding quality matters |
| `review`, `security`, `fix` | **Opus** | Deep analysis |
| `test` (browser clicks) | **Haiku** | Simple click/verify |
| `status`, `ledger`, `stats` | **Haiku** | Read + display data |
| `handoff`, `stop`, `reset` | **Haiku** | Session file ops |
| `archive`, `clean`, `update` | **Haiku** | File maintenance |

**Philosophy:** Don't sacrifice code quality for cost savings. Haiku handles non-coding tasks.

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

## Browser Testing (Optional)

Uses **agent-browser** CLI for automated browser testing.

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

**Via source:**
```bash
# Mac/Linux
cd ~/claude-auto-dev && git pull && ./install.sh --full

# Windows (PowerShell)
cd $env:USERPROFILE\Downloads\code\claude-auto-dev
git pull
.\install.ps1 -Full
```

**Via Claude:**
Just say `update` in any Claude session.

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

## Troubleshooting

### "claude: command not found"
Claude Code isn't installed. Run:
```bash
npm install -g @anthropic-ai/claude-code
```

### "Skills not loading"
Check skills are installed:
```bash
ls ~/.claude/skills/
```
If empty, reinstall from source:
```bash
cd ~/claude-auto-dev && ./install.sh --full  # Mac/Linux
.\install.ps1 -Full                           # Windows
```

### "brainstorm doesn't work"
Make sure you're in a Claude Code session (run `claude` first), then type `brainstorm`.

### "Task stuck"
Say `reset` to clear claimed state, then `auto` to continue.

### "Context too large"
Say `handoff` to save session, then start fresh with `resume`.

---

## Changelog

### [2.5.2] - 2026-01-23
- **UI/UX Quality Checks**: `ux-audit` static analysis, visual verification in `polish`
- **UI Gate**: Screenshot verification for component changes in `auto`
- **Expanded Haiku Routing**: All non-coding tasks (handoff, status, etc.) use Haiku

### [2.5.0] - 2026-01-22
- **Session Management**: `handoff` saves session state, `resume` continues later
- **Ledger System**: `ledger.json` tracks cross-session analytics
- **Mistake Learning**: Auto-logs build failures to `.claude/mistakes.md`
- **Session Analytics**: `ledger` / `stats` shows completion rates, hot files

### [2.4.4] - 2026-01-22
- Added `polish` command with direction picker

### [2.4.0] - 2026-01-22
- Archive system for large prd.json files

### [2.3.0] - 2026-01-22
- Hooks system (30-60% token savings)

[Full changelog](CHANGELOG.md)

---

## Related Projects

- [Claude Code](https://github.com/anthropics/claude-code) - Official CLI by Anthropic
- [agent-browser](https://www.npmjs.com/package/agent-browser) - Browser automation CLI
- [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) - Community plugins & skills

---

## License

MIT - Use it however you want.
