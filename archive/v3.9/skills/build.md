---
name: Build Coordinator
description: Routes commands to their handlers. See commands/*.md for details.
---

# Command Router

Commands are defined in `commands/*.md`. This file coordinates execution.

## Core Commands
| Command | File | Action |
|---------|------|--------|
| auto | commands/auto.md | Parallel task execution |
| brainstorm | commands/brainstorm.md | Generate tasks |
| status | commands/status.md | Show progress |
| continue | commands/continue.md | One task only |

## Session Commands
| Command | File | Action |
|---------|------|--------|
| stop | commands/stop.md | Save and exit |
| reset | commands/reset.md | Clear locks |
| handoff | commands/handoff.md | Export context |
| resume | commands/resume.md | Load handoff |

## Quality Commands
| Command | File | Action |
|---------|------|--------|
| review | commands/review.md | Code audit |
| sprint | commands/sprint.md | Timed cycles |
| preflight | commands/preflight.md | Pre-checks |

## Maintenance Commands
| Command | File | Action |
|---------|------|--------|
| archive | commands/archive.md | Compact prd.json |
| clean | commands/clean.md | Remove temp files |
| sync | commands/sync.md | Update plugin |

## Execution Flow

```
User says "auto"
  → Load commands/auto.md
  → Load skills/core.md (prd.json schema)
  → Execute
```

## Mistake Learning

On build failure (2+ times same error):
1. Classify: null-check, missing-import, type-mismatch
2. Log to `.claude/mistakes.md`
3. Inject warnings on next session start

## Context Budget

Before loading skills, check context:
- < 30%: Load full skill
- 30-60%: Load minimal version
- > 60%: Suggest /compact first
