---
description: Compact prd.json by archiving completed stories
---

# Archive

Compact prd.json when it gets too large (>2000 lines).

## Process

1. Backup: `cp prd.json prd-backup-YYYYMMDD.json`
2. Separate: completed (`passes: true`, not QA) vs active
3. Write archive: `prd-archive-YYYY-MM.json`
4. Update prd.json with `archived` summary section
5. Keep only active/QA stories in main file

## Token Savings

Typically 50-60% reduction in token usage.

## When to Use

- prd.json > 2000 lines
- Read fails due to token limit
- Manual cleanup needed
