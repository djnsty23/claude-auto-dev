---
description: Show task progress from prd.json
---

# Status

Show current task progress.

## Process

1. Read `prd.json` (if fails due to size, suggest `archive`)
2. Count complete (`passes: true`) vs pending
3. Include archived count if `archived` section exists
4. Report: "X/Y active + Z archived. Next: [title]"

## Example Output

```
Status: 15/23 active + 88 archived
Next: QA01 - Google OAuth Sign-In Flow
```
