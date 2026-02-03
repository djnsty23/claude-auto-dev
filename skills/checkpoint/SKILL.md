---
name: checkpoint
description: Save context state before /clear - 50-70% token savings
allowed-tools: Read, Write, TaskList, Grep
model: sonnet
user-invocable: true
---

# Context Checkpoint

Save critical context before `/clear`. Enables 50-70% token savings.

## When to Checkpoint

- After 5+ tasks completed
- Before switching feature areas
- After resolving complex bugs
- When context feels bloated

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

Tell user:
```
Checkpoint saved. Run /clear to free ~50-70% context.
I'll restore from checkpoint automatically.
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

~60% reduction on 2-hour sessions via 2-3 strategic clears.
