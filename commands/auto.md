---
description: Work through all tasks in prd.json automatically
---

# Auto Mode

Work through all pending tasks until complete or blocked.

## Process

1. Read `prd.json`
2. Find next task where `passes !== true`
3. Read files listed in task
4. Implement changes
5. Run `npm run build`
6. If passes: mark `passes: true`, continue
7. If fails 3x: ask user

## Stop Conditions

- No more pending tasks
- 3 consecutive failures on same task
- User interrupts

Load full instructions from `~/.claude/skills/build.md` for details.
