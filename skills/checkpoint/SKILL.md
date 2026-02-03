---
name: checkpoint
description: Save context state before /clear - enables 50-70% token savings without losing critical information
allowed-tools: Read, Write, TaskList, Grep
model: haiku
user-invocable: true
---

# Context Checkpoint

Save critical context before suggesting `/clear` to the user. This enables 50-70% token savings while preserving important state.

## When to Suggest Checkpoint

Trigger checkpoint when ANY of these conditions are met:

1. **After completing a major milestone** (3+ tasks done)
2. **Before switching to a different feature area**
3. **After resolving a complex bug** (save the learnings)
4. **When context feels bloated** (lots of file reads, errors, iterations)

## Checkpoint Process

### Step 1: Save Current State

Write to `.claude/checkpoint.md`:

```markdown
# Checkpoint: [TIMESTAMP]

## Sprint Status
[Read from project-meta.json or TaskList]

## Completed This Session
- [Task 1]: [brief what was done]
- [Task 2]: [brief what was done]

## Key Learnings
- [Any bug fixes with resolution pattern]
- [Any important discoveries about codebase]

## Next Priority
[What should be worked on next]

## Files Modified
[List of files changed this session]

## Open Issues
[Any unresolved problems to remember]
```

### Step 2: Suggest Clear

After saving checkpoint, tell the user:

```
Checkpoint saved to .claude/checkpoint.md

Suggestion: Run /clear to free ~50-70% of context.
The checkpoint preserves:
- Sprint progress
- Session learnings
- Next priorities

To restore context after /clear, I'll read the checkpoint automatically.
```

### Step 3: Auto-Restore After Clear

When session starts fresh (detected by reading checkpoint):

1. Read `.claude/checkpoint.md`
2. Read `project-meta.json` for sprint info
3. Call `TaskList` for current task state
4. Continue from where checkpoint left off

## What Gets Preserved

| Preserved | Lost (OK to lose) |
|-----------|-------------------|
| Task progress | File contents (re-read as needed) |
| Key learnings | Error messages (already fixed) |
| Next priorities | Iteration history |
| Modified files list | Tool call logs |

## What NOT to Checkpoint

- Full file contents (re-read when needed)
- Build/test output (re-run when needed)
- Detailed error traces (issue was fixed)

## Automatic Checkpoint Triggers

Consider checkpoint after:
- 5+ tasks completed
- 20+ file reads in session
- Major refactor completed
- Sprint milestone reached

## Example Checkpoint

```markdown
# Checkpoint: 2026-02-03T14:30:00

## Sprint Status
Sprint 10: 12/20 complete

## Completed This Session
- S10-005: Fixed tooltip overflow (overflow: Added max-h + overflow-auto)
- S10-006: Added loading state to dashboard
- S10-007: Migrated auth to new API

## Key Learnings
- Tooltip components need max-h-[calc(100vh-200px)] for viewport safety
- Dashboard uses React Query - invalidate cache after mutations

## Next Priority
S10-008: Add error boundary to settings page

## Files Modified
- src/components/Tooltip.tsx
- src/pages/Dashboard.tsx
- src/lib/auth.ts

## Open Issues
None
```

## Integration with Session Hooks

The session-start hook can auto-detect and restore checkpoints:

```bash
if [ -f ".claude/checkpoint.md" ]; then
  echo "Checkpoint found - restoring context..."
  cat .claude/checkpoint.md
fi
```

## Token Savings

| Scenario | Without Checkpoint | With Checkpoint |
|----------|-------------------|-----------------|
| 2-hour session | ~150K tokens | ~60K tokens |
| Context resets | 0 | 2-3 |
| Savings | Baseline | **60%** |

## Security

- Checkpoint files are local only (in .claude/)
- No credentials or secrets in checkpoints
- Add `.claude/checkpoint.md` to .gitignore
