# Claude Auto-Dev

Autonomous task management for Claude Code.

## Full Restore (New Machine)

After Windows reinstall or on a new machine, run this to restore everything:

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

This installs:
- `~/.claude/CLAUDE.md` - Global config
- `~/.claude/QUICKSTART.md` - Quick reference
- `~/.claude/rules/*.md` - Coding rules
- `~/.claude/skills/build.md` - Auto-dev skill
- `~/.claude/mcp.json` - MCP server config (uses `${ENV_VAR}` references, no hardcoded secrets)

## Quick Install (Skill Only)

**Windows:**
```powershell
git clone https://github.com/djnsty23/claude-auto-dev $env:USERPROFILE\claude-auto-dev
& $env:USERPROFILE\claude-auto-dev\install.ps1 -Global -Init
```

**Mac/Linux:**
```bash
git clone https://github.com/djnsty23/claude-auto-dev ~/claude-auto-dev
~/claude-auto-dev/install.sh --global --init
```

## Commands

| Say | What Happens |
|-----|--------------|
| `auto` | Work through all tasks, don't stop |
| `continue` | One task, then ask |
| `work on S42` | Do specific task |
| `status` | Show progress |
| `brainstorm` | Generate new stories |
| `adjust` | Reprioritize tasks |
| `stop` | Before closing session |
| `reset` | Clear claims after crash |

## Workflow

```bash
claude "brainstorm"    # Generate tasks
claude "auto"          # Build everything
claude "stop"          # Before closing
```

## Multi-Agent

Run `claude "auto"` in multiple terminals. Each picks unclaimed tasks. 30-minute claim expiry handles abandoned work.

**Best practice:**
```bash
# Terminal 1
claude "auto"

# Wait 10-30 seconds, then Terminal 2
claude "auto"

# Wait 10-30 seconds, then Terminal 3
claude "auto"
```

Stagger starts slightly to avoid collisions. Each agent will:
1. Read prd.json, find first unclaimed task
2. Set `claimedAt` timestamp immediately
3. Work on task
4. Mark `passes: true` when done

**Before closing any terminal:**
```bash
claude "stop"
```
This clears claims so other agents can pick up the work.

## Files

| File | Purpose |
|------|---------|
| `prd.json` | Tasks (`passes: true/false`) |
| `progress.txt` | Learnings log |
| `.claude/briefs/` | Optional detailed specs |

## Task Schema

```json
{
  "id": "S1",
  "title": "Short title",
  "description": "What to build",
  "priority": 1,
  "passes": false,
  "claimedAt": null,
  "completedAt": null,
  "files": ["path/to/file.ts"],
  "acceptanceCriteria": ["Requirement"]
}
```

## API Key Setup

Run the API key wizard to set up environment variables:

**Windows:**
```powershell
& $env:USERPROFILE\claude-auto-dev\setup-keys.ps1
```

**Mac/Linux:**
```bash
~/claude-auto-dev/setup-keys.sh
```

This prompts for:
- `SUPABASE_ACCESS_TOKEN` (required) - MCP server auth
- `GITHUB_PAT` (required) - GitHub integration
- `BRAVE_API_KEY` - Web search
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` - OAuth
- `ELEVENLABS_API_KEY`, `OPENROUTER_API_KEY`, etc.

Keys are stored in:
- **Windows:** System environment variables (persists across reboots)
- **Mac/Linux:** `~/.zshrc` or `~/.bashrc`

The `mcp.json` config uses `${ENV_VAR}` syntax - MCP reads from your system env vars at runtime. **No secrets are hardcoded in the config file.**

## Environment Variables

**Never hardcode API keys.** Use system environment variables.

**Manual setup (Windows Admin):**
```powershell
setx SUPABASE_ACCESS_TOKEN "sbp_..."
setx GOOGLE_CLIENT_ID "..."
setx OPENAI_API_KEY "sk-..."
```

**Project .env.local (project-specific only):**
```env
# Supabase (project-specific)
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...

# System env vars are picked up automatically - no need to repeat
```

**Rules:**
- API keys in system env vars (not .env files)
- .env.local for project-specific URLs only
- Never commit secrets to git
- Use `.env.example` to document required vars (no values)

## Troubleshooting

**Tasks stuck as claimed?**
- Wait 30 min for auto-expiry, or run `reset` to clear all claims

**Agents grabbing same task?**
- Stagger starts by 10-30 seconds
- Or run `reset` then restart agents

**Build keeps failing?**
- Agent stops after 3 failures
- Fix the issue manually, then `auto` again

## Update

```powershell
cd $env:USERPROFILE\claude-auto-dev && git pull && .\install.ps1 -Update
```

## License

MIT
