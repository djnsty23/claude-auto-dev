# Claude Auto-Dev

[![Claude Code](https://img.shields.io/badge/Claude%20Code-Compatible-blueviolet)](https://claude.ai/code)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-2.5.0-blue.svg)](https://github.com/djnsty23/claude-auto-dev/releases)

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

```
"brainstorm"  → What do you want to build? → generates tasks
"auto"        → Works through all tasks automatically
"polish"      → Suggests improvements → asks what's next
```

That's the full loop. No scripts to run.

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
| `polish` | Find improvements + direction picker |
| `handoff` | Save session for later resume |
| `resume` | Continue from last handoff |
| `ledger` | Show session analytics |

### Additional Skills

| Command | What Happens |
|---------|--------------|
| `ship` | Build and deploy to Vercel |
| `test` | Run browser tests with agent-browser |
| `fix` | Debug and fix issues |
| `set up` | Initialize new project structure |

---

## Workflows

### 1. New Project

```
You: "brainstorm"
Claude: "What do you want to build?"
You: "A dashboard with user auth and analytics"
Claude: Generates 8 tasks → adds to prd.json

You: "auto"
Claude: Implements all 8 tasks automatically

You: "polish"
Claude: "All tasks done! Found 3 improvements:
         • Add error boundary to Dashboard
         • Remove console.logs
         • Add aria-labels to buttons

         What's next?"
         ○ Polish & continue
         ○ New feature
         ○ Ship it
         ○ Done for now
```

### 2. Existing Project

```
You: "status"
Claude: "5/12 complete. Next: Add user settings page"

You: "auto"
Claude: Completes remaining 7 tasks

You: "polish" → direction picker
```

### 3. Pre-Deploy

```
You: "security"
Claude: Checks Supabase advisors, RLS, hardcoded secrets
        ✓ No issues found

You: "ship"
Claude: Builds → deploys to Vercel → reports URL
```

### 4. Maintenance

```
"archive"  → prd.json too large? Move completed tasks to archive
"clean"    → Remove screenshots, old backups
"reset"    → Stuck? Clear claimed tasks and retry
```

### 5. Multi-Agent Mode

Run multiple Claude sessions for parallel development:

```bash
# Terminal 1
claude "auto"

# Terminal 2 (wait 10-30 seconds)
claude "auto"
```

Each session claims different tasks. No conflicts.

### 6. Long Sessions (v2.5)

```
You: "auto"
Claude: Completes 3 tasks...
        "Context getting large. Consider 'handoff' to save progress."

You: "handoff"
Claude: Saves session state to handoff-2026-01-22-1430.md
        "Start new session and say 'resume' to continue."

# Later, new Claude session:
You: "resume"
Claude: "Resuming from Jan 22:
         - Completed: S1, S2, S3
         - Next: S4 - Add user settings
         - Avoiding: null-check errors (from mistakes.md)"
```

### 7. Session Analytics

```
You: "ledger"
Claude: Shows last 7 days:
        - Sessions: 12
        - Tasks completed: 47/52 (90%)
        - Hot files: src/App.tsx (8x)
        - Common blockers: Type errors (5x)
```

---

## How It Works

Tasks live in `prd.json`:

```json
{
  "id": "S1",
  "title": "Add user authentication",
  "passes": false,
  "files": ["src/auth/login.tsx"]
}
```

- `passes: null` = new task
- `passes: false` = in progress
- `passes: true` = done

**Auto loop:** Find task → Read files → Implement → Build → Mark done → Repeat

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
| `ledger.json` | Session analytics (gitignored) |
| `handoff-*.md` | Session handoff docs (gitignored) |
| `.claude/mistakes.md` | Learned error patterns (gitignored) |
| `.claude/screenshots/` | Test screenshots (gitignored) |

---

## Hooks (Auto-Installed)

Hooks reduce token usage by 30-60%:

| Hook | Purpose |
|------|---------|
| `session-start` | Injects task progress at session start |
| `pre-tool-filter` | Blocks dangerous commands, skips large files |
| `post-tool-typecheck` | Runs typecheck after TS/JS edits |
| `auto-continue` | Auto-continues if tasks remain in prd.json |

Before closing: `claude "stop"` to save progress.

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

### [2.5.0] - 2026-01-22
- **Session Management**: `handoff` saves session state, `resume` continues later
- **Ledger System**: `ledger.json` tracks cross-session analytics
- **Mistake Learning**: Auto-logs build failures to `.claude/mistakes.md`
- **Session Analytics**: `ledger` / `stats` shows completion rates, hot files
- **Context Reminders**: Suggests handoff after 3+ tasks

### [2.4.4] - 2026-01-22
- Added `polish` command with direction picker (like Lovable's "What's next?" flow)
- Options: Polish & continue, New feature, Ship it, Done for now

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
