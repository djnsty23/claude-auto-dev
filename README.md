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
  "files": ["path/to/file.ts"],
  "acceptanceCriteria": ["Requirement"]
}
```

## Update

```powershell
cd $env:USERPROFILE\claude-auto-dev && git pull && .\install.ps1 -Update
```

## License

MIT
