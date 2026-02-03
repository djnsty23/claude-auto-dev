---
name: checkpoint
description: Save context state - auto-triggered every 5 tasks
allowed-tools: Read, Write, TaskList, Grep
model: sonnet
user-invocable: false
---

# Context Checkpoint

Save critical context before `/clear`. Enables 50-70% token savings.

## When to Checkpoint

- **Every 3 tasks** (aggressive - preserves tokens)
- Before switching feature areas
- After resolving complex bugs
- When response feels slow (context bloat sign)

## Checkpoint Format

Write to `.claude/checkpoint.md`:

```markdown
# Checkpoint: [TIMESTAMP]

## Sprint Status
[Sprint X: N/M complete]

## Completed This Session
- [Task]: [what was done]

## Key Learnings
- [Bug pattern]: [resolution]

## Next Priority
[Next task ID and title]

## Files Modified
- [file paths]
```

## After Saving

Tell user (be urgent):
```
💾 Checkpoint saved.

⚠️  Run /clear NOW to reclaim ~50% tokens.
Context auto-restores. Don't wait - clear often for long sessions.
```

## Auto-Restore

After `/clear`, read `.claude/checkpoint.md` and continue.

## What to Preserve

| Keep | Skip |
|------|------|
| Task progress | File contents |
| Learnings | Error traces |
| Next priority | Tool call logs |

## Token Savings

| Clears | Session Length | Savings |
|--------|----------------|---------|
| 2-3 | 2 hours | ~60% |
| 4-5 | 4 hours | ~70% |
| 6+ | 5+ hours | ~80% |

**Rule:** Clear after every checkpoint. Don't accumulate.
