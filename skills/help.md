---
name: Help
description: Show available commands.
triggers:
  - help
  - commands
---

# Commands

| Say | Does |
|-----|------|
| `auto` | Work through all tasks without stopping |
| `continue` | Do one task, then ask |
| `status` | Show progress (X/Y complete) |
| `brainstorm` | Generate new stories |
| `generate` | Same as brainstorm |
| `stop` | Save session, safe to close |
| `reset` | Clear stuck state after crash |
| `review` | Build + code quality check |
| `update` | Pull latest system from GitHub |
| `sync` | Same as update |

## Other Skills

| Say | Does |
|-----|------|
| `fix [issue]` | Debug and fix a problem |
| `test` | Run tests |
| `ship` | Build and deploy |
| `set up` | Initialize new project |

## Files

| File | Purpose |
|------|---------|
| `prd.json` | Task list (`passes: true/false`) |
| `progress.txt` | Session log (append-only) |
| `CLAUDE.md` | Project config |

## Tips

- **Starting work?** Say `status` to see what's next
- **Done for now?** Say `stop` to save progress
- **Stuck?** I'll ask after 3 failed attempts
- **After crash?** Say `reset` to clear state
