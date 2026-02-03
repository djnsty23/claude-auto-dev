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

| Command | Action | Reads prd.json? |
|---------|--------|-----------------|
| `auto` | Load pending → create Tasks → execute ALL | Header + grep pending |
| `status` | Show progress | Header only (30 lines) |
| `continue` | One task from native Tasks | No |
| `stop` | Sync Tasks back to prd.json | Write only |
| `brainstorm` | Proactively propose improvements | No |
| `audit` | Parallel swarm audit (6 agents) | No |

## Core Commands

### `auto` - Execute ALL pending work

**CRITICAL: DO NOT STOP until all tasks are complete.**

```
1. Read prd.json header (lines 1-30) for sprint info
2. Grep for "passes": null to find pending stories
3. Create native Tasks via TaskCreate for current batch (max 10)
4. Work through ALL native Tasks (TaskUpdate as you go)
5. When batch complete: check for more pending stories
6. REPEAT until zero pending stories remain
7. On completion: update prd.json story status

IMPORTANT:
- Do NOT pause for user confirmation between tasks
- Do NOT ask "should I continue?" - just continue
- Only stop for actual errors or blockers
- If build fails, fix it and continue
```

### `status` - Quick progress check
```
1. Read prd.json lines 1-30 only
2. Report: Sprint name, completed/pending counts
3. List active native Tasks if any
```

### `continue` - Single task mode
```
1. Take ONE task from native Tasks
2. Complete it
3. Ask user what's next
```

### `brainstorm` - Propose improvements
**You propose ideas, user doesn't ask.** See brainstorm.md

```
1. Parallel scans: TODOs, console.logs, performance, a11y
2. Analyze gaps vs ideal state
3. Present 3-5 concrete scenarios with impact/effort
4. Offer to create stories for selected ideas
```

### `audit` - Parallel quality swarm
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

## Autonomous Mode Behavior

When user says "auto", Claude MUST:

1. **Keep working until done** - No pauses, no confirmations
2. **Self-recover from errors** - Fix build failures and continue
3. **Batch updates** - Only write to prd.json at end
4. **Report progress** - Brief status after each task
5. **Stop only when**:
   - All tasks complete
   - Unrecoverable error (user must intervene)
   - User explicitly says "stop"

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
