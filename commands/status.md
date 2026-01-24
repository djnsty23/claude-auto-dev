---
description: Show task progress from prd.json
---

# Status

Show current task progress.

## Process

1. Read `prd.json` (if fails due to size, suggest `archive`)
2. Count complete (`passes: true`) vs pending
3. Count blocked tasks (have incomplete `blockedBy` dependencies)
4. Include archived count if `archived` section exists
5. Also run `TaskList` to show Claude Code's task view
6. Report combined status

## Example Output

```
Status: 15/23 active + 88 archived
Ready: 3 tasks (no blockers)
Blocked: 5 tasks (waiting on dependencies)
Next: QA01 - Google OAuth Sign-In Flow
```

## Blocked Tasks

Show which tasks are blocked and what they're waiting for:

```
Blocked:
- S5: "API endpoints" blocked by [S3: DB schema]
- S6: "UI components" blocked by [S5: API endpoints]
```

## Quick View

If prd.json is too large, show summary only:
- Total / Complete / Blocked / Ready
- Next available task
- Suggest `archive` if >50 completed tasks
