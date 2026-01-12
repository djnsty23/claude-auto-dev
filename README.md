# Claude Auto-Dev

Autonomous task management for Claude Code.

## Install

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

## Environment Variables

**Never hardcode API keys.** Use system environment variables.

**Windows (set once, available everywhere):**
```powershell
# Run as Admin
setx SUPABASE_ACCESS_TOKEN "sbp_..."
setx GOOGLE_CLIENT_ID "..."
setx OPENAI_API_KEY "sk-..."
```

**Project .env.local (reference system vars):**
```env
# Supabase (project-specific)
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...

# These come from system env vars - no values in repo
# GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
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
