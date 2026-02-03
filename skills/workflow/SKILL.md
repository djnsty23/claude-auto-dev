---
name: workflow
description: Skill orchestration - how skills connect
user-invocable: false
model: haiku
---

# Workflow Overview

## Skill Sequence

```
┌─────────────────────────────────────────────────────────┐
│                    SESSION START                         │
├─────────────────────────────────────────────────────────┤
│  "status"      → See current sprint progress            │
│  "brainstorm"  → Scan codebase, propose improvements    │
│  "audit"       → 6-agent parallel quality scan          │
│  "sprint X"    → Create sprint from description         │
├─────────────────────────────────────────────────────────┤
│                    DEVELOPMENT                           │
├─────────────────────────────────────────────────────────┤
│  "auto"        → Execute all tasks autonomously         │
│                  (includes verify, checkpoint triggers) │
├─────────────────────────────────────────────────────────┤
│                    COMPLETION                            │
├─────────────────────────────────────────────────────────┤
│  "verify"      → Confirm task is production-ready       │
│  "checkpoint"  → Save context before /clear             │
│  "deploy"      → Build and ship to production           │
│  "clean"       → Remove screenshots, temp files         │
└─────────────────────────────────────────────────────────┘
```

## Auto-Applied Skills (Always Active)

| Skill | Purpose |
|-------|---------|
| core | Task system (prd.json + native Tasks) |
| quality | Code judgment principles |
| react-patterns | React/Next.js optimization |

## Task Lifecycle

```
TaskCreate (brainstorm/sprint/audit)
    ↓
TaskUpdate status: in_progress (auto)
    ↓
Implement → Typecheck → Build → Verify
    ↓
TaskUpdate status: completed + prd.json passes: true
    ↓
Next task (auto continues)
```

## When Build Fails

1. Read last 20 lines of error
2. Fix the specific issue (don't refactor)
3. `npm run typecheck && npm run build`
4. If still fails after 2 retries → mark `passes: false`, continue

## Quick Reference

| Want to... | Say |
|------------|-----|
| See progress | `status` |
| Generate tasks | `brainstorm` or `audit` |
| Work autonomously | `auto` |
| Check quality | `verify` |
| Save before /clear | `checkpoint` |
| Ship to prod | `deploy` |
