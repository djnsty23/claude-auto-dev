---
name: core
description: prd.json schema and task system - auto-loaded when prd.json exists
allowed-tools: Read, Write, Edit, TaskCreate, TaskUpdate, TaskList, Grep, Glob
model: opus
user-invocable: false
disable-model-invocation: true
---

# Hybrid Task System

## Sprint Summary
!`node -e "try{const p=require('./prd.json');const sp=p.sprints?p.sprints[p.sprints.length-1]:p;const s=Object.values(sp.stories||p.stories||{});const name=sp.id||sp.name||p.sprint||'unknown';const done=s.filter(x=>x.passes===true).length;const pending=s.filter(x=>x.passes===null||x.passes===false).length;const deferred=s.filter(x=>x.passes==='deferred').length;console.log('Sprint:',name,'| Done:',done,'| Pending:',pending,'| Deferred:',deferred,'| Total:',s.length)}catch(e){console.log('No prd.json')}"`

For large prd.json (100+ stories), use `Grep` to find specific stories. For typical sizes (<50 stories), reading the full file is fine with 1M context.

## When to Sprint

- **5+ related tasks** — create a sprint in prd.json
- **< 5 tasks or single fixes** — work directly, no sprint or stories needed
- **Design/creative work** — iterate freely, skip planning overhead
- **Quick fixes** — just fix, verify, done

Sprints are for tracking, not for ceremony. If the work is small, skip the overhead.

## Two Layers

| Layer | Tool | Purpose |
|-------|------|---------|
| Long-term | prd.json | Sprint history, resolutions (Git-tracked) |
| Short-term | Native Tasks | Active work (session only) |

Work with native Tasks during session, batch-update prd.json at end.

## prd.json Story Schema

```json
{
  "id": "S26-001",
  "title": "Fix tooltip clipping",
  "priority": 1,
  "passes": null,
  "realness": null,
  "type": "fix",
  "category": "components",
  "notes": "",
  "resolution": ""
}
```

| Field | Values |
|-------|--------|
| `passes` | `null` (pending), `true` (done), `false` (failed), `"deferred"` |
| `realness` | 0-100 (optional, see below). `null` = not rated yet |
| `type` | fix, feature, refactor, qa, perf |
| `priority` | 0=critical, 1=high, 2=medium, 3=low |
| `resolution` | HOW it was fixed (learning) |

### Realness Scale (0-100)

`passes: true` is binary and hides the difference between "wired up" and "works in production." Fill in `realness` when closing non-trivial stories so the sprint summary reflects reality.

| Score | Meaning |
|-------|---------|
| 20 | Stubbed — UI exists, no backend |
| 40 | Wired — frontend and backend connected, happy path works in dev |
| 60 | Functional — handles the obvious edge cases, one real end-to-end test |
| 80 | Production-ready — error handling, empty/loading/error states, observability |
| 100 | Battle-tested — used by real users, edge cases caught and fixed |

Rules:
- Bug fixes default to 80 (fixing a real issue is usually production-ready).
- Features require a manual rating — don't auto-assign 100 just because `passes: true`.
- When in doubt, pick the lower number.
- Sprint summaries report the AVERAGE realness of closed stories, not just the pass count.

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

## Context Tips

With 1M context, aggressive token saving is unnecessary. Prefer clarity over brevity.

| Action | Do This |
|--------|---------|
| Check status | Read prd.json header or use dynamic context injection |
| Start task | Grep specific story |
| Track progress | Native TaskUpdate |
| Complete work | Batch edit prd.json at session end |

## Archive Trigger

When ANY of these are true, run `archive` before starting new work:
- 4+ total sprints exist in prd.json
- prd.json > 500 lines
- prd.json > 50KB
- Starting a new sprint while previous sprint's stories are all complete

Do not ask — just archive. Archive keeps only last 3 sprints active. Completed stories move to `.claude/archives/prd-archive-YYYY-MM.json`.
