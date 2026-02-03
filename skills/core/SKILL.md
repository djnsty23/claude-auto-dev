---
name: core
description: Hybrid task system - prd.json + native Tasks + resolution learning
allowed-tools: Read, Write, Edit, TaskCreate, TaskUpdate, TaskList, Grep, Glob
model: sonnet
user-invocable: false
---

# Hybrid Task System

## Two Layers

| Layer | Tool | Purpose |
|-------|------|---------|
| **Long-term** | prd.json | Sprint history, resolutions | Git-tracked |
| **Short-term** | Native Tasks | Active work | Session only |

**Rule:** Work with native Tasks during session, batch-update prd.json at end.

## prd.json Story Schema

```json
{
  "id": "S26-001",
  "title": "Fix tooltip clipping",
  "priority": 1,
  "passes": null,
  "type": "fix",
  "category": "components",
  "notes": "",
  "resolution": ""
}
```

| Field | Values |
|-------|--------|
| `passes` | `null` (pending), `true` (done), `false` (failed), `"deferred"` |
| `type` | fix, feature, refactor, qa, perf |
| `priority` | 0=critical, 1=high, 2=medium, 3=low |
| `resolution` | HOW it was fixed (learning) |

## Resolution Learning

When completing bug fixes, document HOW:

```
[PATTERN]: [SPECIFIC FIX]
```

Examples:
- `null-check: Added optional chaining at line 45`
- `missing-import: Added import for DateRange`
- `type-mismatch: Changed Record<string, T> to Partial<Record<K, T>>`
- `overflow: Added max-h + overflow-auto`

### Mistake Categories

| Category | Fix Pattern |
|----------|-------------|
| `null-check` | `obj?.prop` |
| `missing-import` | `import { X } from 'y'` |
| `type-mismatch` | Correct type annotation |
| `missing-key` | Add missing Record key |
| `overflow` | `overflow-auto + max-h` |

## Context Optimization

| Action | Do This |
|--------|---------|
| Check status | Read prd.json header (30 lines) |
| Start task | Grep specific story |
| Track progress | Native TaskUpdate |
| Complete work | Batch edit prd.json at session end |

## Archive Trigger

When `completedStories > 500` or `prd.json > 100KB`:
→ Archive to `prd-archive-YYYY-MM.json`
