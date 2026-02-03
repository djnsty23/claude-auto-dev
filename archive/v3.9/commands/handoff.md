---
description: Export session context for continuity between sessions
argument-hint: "[--sprint] [--full]"
---

# Handoff

Generate a handoff document for session continuity.

## Usage

```bash
handoff           # Standard handoff
handoff --sprint  # After sprint, includes metrics
handoff --full    # Includes all decisions and context
```

## Output File

Creates: `handoff-YYYY-MM-DD-HHMM.md`

## Standard Handoff Format

```markdown
# Session Handoff - [DATE]

## Summary
[2-3 sentences describing what was accomplished]

## Completed This Session
- [TASK-ID]: Brief description
- [TASK-ID]: Brief description

## In Progress (Not Complete)
- [TASK-ID]: What's done, what remains
  - Files touched: [list]
  - Current state: [description]

## Blocked / Needs Attention
- [TASK-ID]: Blocked by [reason]
- [Issue]: Description

## Key Decisions Made
- [Decision 1]: Chose X because Y
- [Decision 2]: Implemented using Z approach

## Files Modified
- src/components/X.tsx (new)
- src/hooks/useY.ts (modified)
- prd.json (updated tasks)

## Next Steps
1. [First priority task]
2. [Second priority task]

## Context for Next Session
[Any important context the next session needs to know]
```

## Sprint Handoff (--sprint)

Adds metrics section:

```markdown
## Sprint Metrics
- Duration: 2h 47m
- Cycles completed: 2
- Tasks completed: 23
- Tasks failed: 2
- Commits made: 8
- Type errors fixed: 12
- Security issues fixed: 3

## Error Patterns Found
See `.claude/mistakes.md` for details:
- "Property does not exist" (5 occurrences)
- "Module not found" (2 occurrences)
```

## Full Handoff (--full)

Includes all decisions from `.claude/decisions.md`:

```markdown
## All Decisions Log
1. [10:23] Chose React Query over SWR for data fetching
2. [10:45] Used semantic tokens instead of hardcoded colors
3. [11:12] Implemented optimistic updates for better UX
...
```

## Auto-Handoff

In sprint mode, handoff is auto-generated at:
- Sprint completion
- Context reaching 80%
- Before `/compact`

## Reading Previous Handoffs

```bash
ls handoff-*.md | tail -5  # List recent handoffs
```

New session starts by reading latest handoff:
```
Starting session... Found handoff-2025-01-25-1430.md
Resuming from: 23 tasks complete, 7 remaining
Last worked on: AI-NLQ01, AI-RCA01
```
