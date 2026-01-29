---
name: core
description: Hybrid task system - prd.json for history, native Tasks for active work, resolution learning
allowed-tools: Read, Write, Edit, TaskCreate, TaskUpdate, TaskList, Grep, Glob
model: sonnet
---

# Hybrid Task System (v2.0)

## Two-Layer Architecture

| Layer | Tool | Purpose | Persistence |
|-------|------|---------|-------------|
| **Long-term** | prd.json | Sprint history, verification notes, roadmap | Git-tracked, survives sessions |
| **Short-term** | Native Tasks | Current work, real-time progress | Session only |

## When to Use Each

### Use Native Tasks (TaskCreate/TaskUpdate)
- Active work in current session
- Showing real-time progress to user
- Quick fixes not worth adding to prd.json
- Parallel task tracking during implementation

### Use prd.json
- Sprint planning and history
- Verification notes (why something passed/failed)
- Cross-session persistence
- Audit trail for completed work
- **Resolution learning** (how issues were fixed)

## prd.json Story Schema

```json
{
  "id": "S26-001",
  "title": "Fix AI chat tooltip clipping",
  "priority": 1,
  "passes": null,
  "type": "fix",
  "category": "components",
  "notes": "",
  "resolution": ""
}
```

### Field Definitions

| Field | Purpose | Example |
|-------|---------|---------
| `id` | Unique identifier | `S26-001` |
| `title` | What to do (verb-first) | `Fix tooltip overflow` |
| `priority` | 0=critical, 1=high, 2=medium, 3=low | `1` |
| `passes` | Status (see below) | `true` |
| `type` | fix, feature, refactor, qa, perf | `fix` |
| `category` | components, hooks, pages, infra | `components` |
| `notes` | Verification details, why it passed/failed | `VERIFIED: uses clamp()` |
| `resolution` | **HOW it was fixed** (learning) | `Added bottom overflow check` |

### Status Values
- `passes: null` = pending
- `passes: true` = complete
- `passes: false` = failed
- `passes: "deferred"` = blocked/skipped

## Resolution Learning System

### Purpose
Prevent repeat mistakes by documenting HOW issues were fixed, not just THAT they were fixed.

### When to Add Resolution
Add `resolution` field when completing a story that involved:
- Bug fix (what caused it, what fixed it)
- Build error (what was wrong, exact fix)
- Type error (pattern that caused it)
- Performance fix (before/after, technique used)

### Resolution Format
```
[PATTERN]: [SPECIFIC FIX]
```

Examples:
- `null-check: Added optional chaining at line 45`
- `missing-import: Added import for DateRange from types/reports`
- `type-mismatch: Changed Record<string, T> to Partial<Record<K, T>>`
- `overflow: Added max-h-[calc(100vh-200px)] and overflow-auto`
- `n+1-query: Batched property fetches using Promise.all`

### Injection on Similar Errors

When a build fails, check `.claude/mistakes.md` and prd.json resolutions for similar patterns:

```
1. Classify error: null-check, missing-import, type-mismatch, etc.
2. Search resolutions: grep prd.json for matching pattern
3. Inject warning: "Similar issue fixed in S25-003: [resolution]"
```

## Workflow

### Starting Session
```
1. Read prd.json header (lines 1-30) for sprint info
2. If user says "auto": grep pending stories, create native Tasks
3. Work via native Tasks (faster, no file I/O)
```

### During Work
```
1. TaskUpdate status: "in_progress" when starting
2. TaskUpdate status: "completed" when done
3. Batch update prd.json at end (not per-task)
```

### Completing a Story
```
1. Update passes: true
2. Add notes: verification method
3. Add resolution: how it was fixed (if applicable)
```

### Ending Session
```
1. TaskList to see completed work
2. Single prd.json edit to update all completed stories
3. Include resolution for bug fixes
```

## Context Optimization

| Action | Old Approach | Hybrid Approach |
|--------|--------------|-----------------|
| Check status | Read 293KB file | Read 30 lines |
| Start task | Read full file | Grep specific story |
| Track progress | Edit file per task | Native TaskUpdate |
| Complete work | Edit file | Batch edit at end |
| Learn from past | None | Search resolutions |

## Mistake Categories

When logging to mistakes.md or resolution field:

| Category | Pattern | Example |
|----------|---------|---------|
| `null-check` | Accessing potentially undefined | `obj?.prop` |
| `missing-import` | Forgot to import type/function | `import { X } from 'y'` |
| `type-mismatch` | Wrong type assignment | `as unknown as Type` |
| `missing-key` | Record missing union member | Added missing key to Record |
| `hook-rules` | Hook called conditionally | Moved hook to component level |
| `overflow` | Content clips viewport | Added overflow-auto + max-h |
| `z-index` | Element behind another | Increased z-index |
| `async-race` | Race condition in async code | Added AbortController |

## Archive Strategy

Trigger archive when:
- completedStories > 500
- prd.json > 100KB

Archive moves completed stories to `prd-archive-YYYY-MM.json`
