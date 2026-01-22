# Claude Auto-Dev

Autonomous task management for Claude Code. No scripts to run - just natural language.

## Quick Start

**New project:**
```
"brainstorm"  → Creates prd.json, asks what to build, generates tasks
```

**Existing project:**
```
"auto"    → Work through all tasks
"status"  → Check progress
```

That's it. No installation needed if you already have the skills in `~/.claude/skills/`.

---

## Install (First Time Only)

**Windows:**
```powershell
git clone https://github.com/djnsty23/claude-auto-dev $env:USERPROFILE\claude-auto-dev
& $env:USERPROFILE\claude-auto-dev\install.ps1 -Full
```

**Mac/Linux:**
```bash
git clone https://github.com/djnsty23/claude-auto-dev ~/claude-auto-dev
~/claude-auto-dev/install.sh --full
```

---

## Commands

Works both as natural language AND slash commands (after install):

| Say or Type | What Happens |
|-------------|--------------|
| `brainstorm` or `/brainstorm` | Generate tasks from your description |
| `auto` or `/auto` | Work through all tasks automatically |
| `status` or `/status` | Show progress (X/Y complete) |
| `continue` or `/continue` | One task, then stop |
| `stop` or `/stop` | Save progress, safe to close |
| `reset` or `/reset` | Clear stuck state after crash |
| `archive` or `/archive` | Compact prd.json when too large (>2000 lines) |
| `clean` or `/clean` | Remove screenshots, old backups, temp files |

### Additional Commands

| Say | What Happens |
|-----|--------------|
| `ship` | Build and deploy to Vercel |
| `test` | Run browser tests with agent-browser |
| `fix` | Debug and fix issues |
| `set up` | Initialize new project |

---

## Files

| File | Purpose |
|------|---------|
| `prd.json` | Active tasks + archived summary |
| `prd-archive-YYYY-MM.json` | Completed stories (full detail) |
| `progress.txt` | Append-only learnings log |
| `.claude/screenshots/` | Test screenshots (gitignored) |

### Task Schema

```json
{
  "id": "S1",
  "title": "Short title",
  "description": "What to build",
  "priority": 1,
  "passes": false,
  "files": ["src/file.ts"],
  "acceptanceCriteria": ["Requirement 1"]
}
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
agent-browser snapshot -i     # Get interactive elements with refs
agent-browser click @e1       # Click by ref
agent-browser fill @e2 "text" # Fill input
agent-browser screenshot .claude/screenshots/test.png  # Save to gitignored folder
```

---

## Multi-Agent

Run `claude "auto"` in multiple terminals. Each picks unclaimed tasks automatically.

```bash
# Terminal 1
claude "auto"

# Terminal 2 (wait 10-30 seconds)
claude "auto"
```

**Before closing:** `claude "stop"`

---

## Hooks (Auto-Installed)

| Hook | Purpose |
|------|---------|
| `auto-continue` | Stop hook - auto-continues if tasks remain in prd.json |
| `session-start` | Injects task progress at session start |
| `pre-tool-filter` | Blocks dangerous commands, skips large files |
| `post-tool-typecheck` | Runs typecheck after TS/JS edits |

**Token savings:** 30-60% reduction through context injection and filtering.

---

## Skills

| Skill | Triggers |
|-------|----------|
| build.md | auto, continue, status, brainstorm, stop, reset |
| agent-browser.md | browser, agent-browser, web test |
| test.md | test, verify, e2e |
| ship.md | ship, deploy |
| fix.md | fix, debug |
| setup-project.md | set up, init |
| env-vars.md | env, credentials |
| supabase-schema.md | schema, database, table |

---

## Update

```bash
cd ~/claude-auto-dev && git pull && ./install.ps1 -Update
```

---

## Changelog

### [2.4.0] - 2026-01-22
- **Local plugin** - Slash commands (`/auto`, `/status`, etc.) auto-registered
- **Archive system** - `archive` command compacts prd.json when >2000 lines
- **Clean command** - `clean` removes screenshots, old backups, temp files
- **Screenshot convention** - Save to `.claude/screenshots/` (auto-gitignored)

### [2.3.0] - 2026-01-22
- **Hooks system** for token optimization (30-60% savings)
- SessionStart, PreToolUse, PostToolUse, Stop hooks
- Windows and Unix hook scripts

### [2.2.0] - 2026-01-22
- **agent-browser** skill (5-6x more token-efficient than Playwright MCP)
- Simplified README and templates

### [2.1.0] - 2025-01-15
- Heartbeat monitoring, dependency tracking, pattern storm detection
- Rollback command, enhanced status dashboard

### [2.0.0] - 2025-01-10
- Multi-agent coordination with claim system
- Stop/reset commands for concurrent sessions

[Full changelog](CHANGELOG.md)

---

## License

MIT
