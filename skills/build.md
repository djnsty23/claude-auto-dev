---
name: Build Coordinator
description: Hybrid task management - prd.json for history, native Tasks for active work
---

# Hybrid Task Management (v2.0)

## Philosophy

- **prd.json** = Long-term memory (sprints, history, verification notes)
- **Native Tasks** = Short-term memory (current session work)
- **Minimize context cost** by reading prd.json only when necessary

## Command Routing

| Command | Action | Reads prd.json? | Skill File |
|---------|--------|-----------------|------------|
| `auto` | Load pending → create Tasks → execute | Header + grep pending | - |
| `status` | Show progress | Header only (30 lines) | - |
| `continue` | One task from native Tasks | No | - |
| `stop` | Sync Tasks back to prd.json | Write only | - |
| `brainstorm` | **Proactively propose improvements** | No | brainstorm.md |
| `audit` | **Parallel swarm audit (6 agents)** | No | audit.md |

## Core Commands

### `auto` - Execute pending work
```
1. Read prd.json header (lines 1-30) for sprint info
2. Grep for "passes": null to find pending stories
3. Create native Tasks via TaskCreate for current batch (max 10)
4. Work through native Tasks (TaskUpdate as you go)
5. On completion: update prd.json story status
```

### `status` - Quick progress check
```
1. Read prd.json lines 1-30 only
2. Report: Sprint name, completed/pending counts
3. List active native Tasks if any
```

### `brainstorm` - Propose improvements (NEW)
**You propose ideas, user doesn't ask.** See brainstorm.md

```
1. Parallel scans: TODOs, console.logs, performance, a11y
2. Analyze gaps vs ideal state
3. Present 3-5 concrete scenarios with impact/effort
4. Offer to create stories for selected ideas
```

### `audit` - Parallel quality swarm (NEW)
**6 specialized agents run simultaneously.** See audit.md

```
1. Launch parallel agents:
   - Security (secrets, XSS, injection)
   - Performance (bundle, renders, queries)
   - Accessibility (WCAG, keyboard, contrast)
   - Type Safety (any, ts-ignore, coverage)
   - UX/UI (loading, empty, error states)
   - Test Coverage (critical paths)
2. Aggregate results by severity
3. Present report with actionable fixes
4. Offer to create stories or fix immediately
```

### `stop` - End session cleanly
```
1. List native Tasks
2. For each completed: update prd.json passes: true
3. For each in_progress: leave as passes: null
4. Clear native Tasks
```

## Context Budget

| Scenario | Old Cost | New Cost | Savings |
|----------|----------|----------|---------|
| Quick fix | 75K tokens | 0 tokens | 100% |
| Sprint work | 75K tokens | ~5K tokens | 93% |
| Status check | 75K tokens | ~1K tokens | 99% |
| Brainstorm | N/A | ~3K tokens | - |
| Audit (6 agents) | N/A | ~10K tokens | - |

## Native Task Format

When creating native Tasks from prd.json:
```
TaskCreate:
  subject: "[S26-001] Fix AI chat tooltip clipping"
  description: "From prd.json story S26-001. Files: src/components/ProductTour.tsx"
  activeForm: "Fixing AI chat tooltip"
```

## Mistake Learning

On build failure (2+ times same error):
1. Classify: null-check, missing-import, type-mismatch
2. Log to `.claude/mistakes.md`
3. Inject warnings on next session start

## Archive Strategy

Trigger archive when:
- completedStories > 500
- prd.json > 100KB

Archive moves completed stories to `prd-archive-YYYY-MM.json`
