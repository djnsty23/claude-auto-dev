---
description: Remove screenshots, old backups, and temp files
---

# Clean

Remove Claude Code artifacts to reduce clutter.

## Process

1. Delete `.claude/screenshots/*.png`
2. Delete `prd-backup-*.json` older than 7 days
3. Delete `.playwright-mcp/` folder
4. Report: "Cleaned X files, freed Y MB"

## Safe to Run

Only removes temporary/generated files. Never touches:
- Source code
- prd.json (active tasks)
- prd-archive files
- Configuration
