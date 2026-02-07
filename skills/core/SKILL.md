---
name: core
description: prd.json schema and task system - auto-loaded when prd.json exists
allowed-tools: Read, Write, Edit, TaskCreate, TaskUpdate, TaskList, Grep, Glob
model: opus
user-invocable: false
---

# Hybrid Task System

## Sprint Summary
!`node -e "try{const p=require('./prd.json');const sp=p.sprints?p.sprints[p.sprints.length-1]:p;const s=Object.values(sp.stories||p.stories||{});const name=sp.id||sp.name||p.sprint||'unknown';const done=s.filter(x=>x.passes===true).length;const pending=s.filter(x=>x.passes===null||x.passes===false).length;const deferred=s.filter(x=>x.passes==='deferred').length;console.log('Sprint:',name,'| Done:',done,'| Pending:',pending,'| Deferred:',deferred,'| Total:',s.length)}catch(e){console.log('No prd.json')}"`

**Do NOT read the full prd.json into context.** Use `Grep` to find specific stories or `Read` with offset/limit for targeted sections.

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

When **3+ completed sprints** or `prd.json > 500 lines` or `prd.json > 50KB`:
→ Run `archive` to move old sprints to `prd-archive-YYYY-MM.json`
→ Keep only current sprint + 2 previous in prd.json
