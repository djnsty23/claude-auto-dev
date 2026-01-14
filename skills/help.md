---
name: Help
description: Show available commands and skills.
triggers:
  - help
  - commands
  - what can you do
---

# Available Commands

## Auto-Dev System

| Command | What It Does |
|---------|--------------|
| `auto` | Work through all tasks autonomously (with learning loop) |
| `continue` | Do one task, then ask what's next |
| `work on S42` | Work on a specific task by ID |
| `status` | Show progress + learnings count + flag stale tasks |
| `brainstorm` | Generate new stories via questionnaire |
| `adjust` | Reprioritize remaining tasks |
| `skip S42` | Skip a blocked task (with reason) |
| `unskip S42` | Restore a skipped task |
| `archive` | Move completed phases to prd-archive.json |
| `stop` | Generate handoff + save learnings, safe to close |
| `reset` | Clear all claims after crash |
| `rollback` | Undo last task changes (git-based) |
| `deps` / `tree` | Show task dependencies |
| `review` | Code quality, security, dependency check |
| `update` / `sync` | Pull latest system updates |

## Learning System

| Command | What It Does |
|---------|--------------|
| `learn [description]` | Manually add a learning to learnings.json |
| `ux review` | Run UX checklist, test flows, log issues |

## Context Management

| Command | What It Does |
|---------|--------------|
| `context` | Quick-load project state + check env vars |
| `save context` | Update context.json with current state |
| `context clear` | Fresh start, rebuild context |

## Development

| Command | What It Does |
|---------|--------------|
| `fix [issue]` | Debug and fix a problem |
| `test` | Run tests, auto-fix failures |
| `ship` / `deploy` | Build and deploy to production |
| `set up` | Initialize new project with CLAUDE.md + Supabase |

## Database

| Command | What It Does |
|---------|--------------|
| `create table [name]` | Design and create Supabase table |
| `schema` | Show or modify database schema |

## Environment

| Command | What It Does |
|---------|--------------|
| `env` / `credentials` | Set up environment variables |

---

## Files to Know

| File | Purpose |
|------|---------|
| `prd.json` | Task list (`passes: true/false` is source of truth) |
| `progress.txt` | Learnings log (human-readable, append-only) |
| `learnings.json` | Structured learnings (machine-readable, searchable) |
| `CLAUDE.md` | Project configuration |
| `.claude/context.json` | Quick-load state cache |
| `.claude/handoff.md` | Session continuity notes |

---

## Learning Loop Flow

```
Error occurs → Search learnings.json → Found? Apply known fix
                                     → Not found? Try new solution

After 2+ attempts to fix → Create learning entry
                        → If universal, add to ~/.claude/patterns.txt
```

## UX Review Checklist (run with `ux review`)

- **Visibility**: Elements on screen, popups in viewport
- **Persistence**: Dismissed dialogs stay dismissed (localStorage)
- **Navigation**: Buttons at end of content, no dead ends
- **Empty States**: Helpful message + skip option
- **AI-First**: Pre-filled optimal defaults, user tweaks

---

## Tips

- **Cold start?** Say `context` to quickly load project state
- **Stuck?** System auto-detects doom loops after 3 attempts
- **Found a fix?** Say `learn [what you learned]` to save it
- **Before shipping?** Say `ux review` to catch human friction
- **Closing session?** Say `stop` to save handoff + learnings
- **After crash?** Say `reset` to clear stale claims
- **System outdated?** Say `update` to pull latest from GitHub
- **Task blocked?** Say `deps` to see what's blocking it
- **Made a mess?** Say `rollback` to undo task changes
