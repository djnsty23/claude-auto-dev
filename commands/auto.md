---
description: Work through all tasks in prd.json automatically
---

# Auto Mode

Work through all pending tasks until complete or blocked.

## Process

1. Read `prd.json`
2. Find next task where `passes !== true` AND `blockedBy` tasks are all complete
3. Use `TaskUpdate` to mark task `in_progress` (shows in Claude Code UI)
4. Read files listed in task
5. Implement changes
6. Run `npm run build`
7. If passes: mark `passes: true` in prd.json, `TaskUpdate` to `completed`
8. If fails 3x: ask user
9. Loop to step 2

## Dependency Resolution

- Check `blockedBy` array before starting a task
- Skip tasks whose dependencies aren't complete (`passes: true`)
- This enables safe parallel execution if multiple agents run

## Task Visibility

Use Claude's built-in task system for UI visibility:

```
// Starting a task
TaskUpdate({ taskId: "X", status: "in_progress" })

// Completing a task
TaskUpdate({ taskId: "X", status: "completed" })
```

## Stop Conditions

- No more pending tasks (all `passes: true`)
- All remaining tasks are blocked by incomplete dependencies
- 3 consecutive failures on same task
- User interrupts

## Screenshots

Save any screenshots to `.claude/screenshots/` folder, not project root.

Load full instructions from `~/.claude/skills/build.md` for details.
