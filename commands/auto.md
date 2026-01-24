---
description: Work through all tasks in prd.json automatically with maximum parallelism
---

# Auto Mode

Work through ALL pending tasks using MAXIMUM parallelism. Launch up to 5 parallel builder agents.

## CRITICAL: Maximum Parallelism

**DO NOT ask for confirmation between batches. Keep launching agents until done.**

1. Read `prd.json`, find ALL tasks where `passes !== true` AND `blockedBy` are complete
2. Launch up to 5 parallel `builder` agents via Task tool in a SINGLE message
3. When agents complete, immediately launch next batch without asking
4. Continue until no tasks remain

## Parallel Launch Example

```
// Launch 5 agents in ONE message block:
Task({ subagent_type: "builder", description: "Build AI11", prompt: "...", run_in_background: true })
Task({ subagent_type: "builder", description: "Build AI12", prompt: "...", run_in_background: true })
Task({ subagent_type: "builder", description: "Build AI13", prompt: "...", run_in_background: true })
Task({ subagent_type: "builder", description: "Build RPT01", prompt: "...", run_in_background: true })
Task({ subagent_type: "builder", description: "Build RPT02", prompt: "...", run_in_background: true })
```

## Dependency Resolution

- Check `blockedBy` array - skip tasks whose deps aren't `passes: true`
- Tasks WITHOUT blockedBy or with all deps complete → can run in parallel
- Re-check after each batch completes for newly unblocked tasks

## After Each Batch Completes

1. Mark completed tasks in prd.json (`passes: true`)
2. Git commit the changes
3. **IMMEDIATELY** launch next batch of unblocked tasks
4. NO confirmation prompts - just keep going

## Stop Conditions

- No more pending tasks (all `passes: true`)
- All remaining tasks blocked by incomplete dependencies
- User explicitly interrupts (Ctrl+C or "stop")

## Screenshots

Save to `.claude/screenshots/`, never project root.

## Task Visibility

Use TaskUpdate for Claude Code UI:
- Starting: `TaskUpdate({ taskId: "X", status: "in_progress" })`
- Done: `TaskUpdate({ taskId: "X", status: "completed" })`
