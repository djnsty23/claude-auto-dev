---
name: Autonomous Build Loop (Simplified)
description: Core task loop - no fluff, just what works.
triggers:
  - auto
  - continue
  - status
  - brainstorm
  - generate
  - stop
  - reset
  - review
  - update
  - sync
---

# Core Loop

## "status"
```
1. Read prd.json (if read fails due to token limit → suggest "archive")
2. Count: complete (passes=true) vs pending (passes=false/null)
3. Include archived count if archived section exists
4. Report: "X/Y active + Z archived. Next: [title]"
```

## "auto"
```
LOOP until no pending tasks:
  1. Find next task (passes=false/null, not skipped)
  2. Read the files listed
  3. Implement changes
  4. Run: npm run build
  5. If build fails: fix errors, retry (max 3)
  6. If build passes: mark passes=true
  7. Continue to next task

STOP CONDITIONS:
- No more pending tasks
- 3 consecutive failures on same task → ask user
- User interrupts
```

## "continue"
```
Same as auto, but stop after 1 task completed.
```

## "brainstorm" / "generate"
```
1. Ask: "What do you want to build?"
2. Generate 3-10 stories based on answer
3. Show list, confirm before adding
4. Add to prd.json with passes=null
```

## "stop"
```
1. Append summary to progress.txt
2. Report what was done
3. Safe to close
```

## "reset"
```
1. Clear all claimedAt fields in prd.json
2. Report: "Reset complete"
```

## "review"
```
1. npm run build
2. Check for TODO/FIXME
3. npm audit (if exists)
4. Report findings
```

## "update" / "sync"
```
1. cd ~/Downloads/code/claude-auto-dev && git pull
2. cp skills/*.md ~/.claude/skills/
3. Report: "Updated to version X"
```

## "archive"
```
When prd.json > 2000 lines or read fails:
1. Backup prd.json → prd-backup-YYYYMMDD.json (use Read+Write, not shell copy)
2. Parse JSON, separate: completed (passes=true, type!="qa") vs active
3. Write completed to: prd-archive-YYYY-MM.json
4. Update prd.json:
   - Add "archived" section with summary
   - Keep only active/QA stories
5. Report: "Archived X stories, Y remain active"

NOTE: Use Read/Write tools for file operations, not shell commands (cross-platform).
```

## "clean"
```
Remove Claude Code artifacts to reduce clutter:
1. Delete .claude/screenshots/*.png (test screenshots)
2. Delete prd-backup-*.json older than 7 days
3. Delete .playwright-mcp/ folder
4. Report: "Cleaned X files, freed Y MB"
```

## "docs" / "update docs"
```
Sync all documentation:
1. Copy local skills to claude-auto-dev repo
2. Update CHANGELOG.md with new version
3. Update README.md
4. Bump VERSION
5. Commit and push
```

---

# Files

| File | Purpose |
|------|---------|
| prd.json | Active tasks + archived summary. `passes: true/false` is truth. |
| prd-archive-YYYY-MM.json | Completed stories (full detail). |
| progress.txt | Append-only log. Human readable. |
| CLAUDE.md | Project context. |

---

# prd.json Schema (Minimal)

```json
{
  "id": "S1",
  "title": "Short title",
  "description": "What to do",
  "priority": 1,
  "passes": false,
  "files": ["src/file.ts"],
  "acceptanceCriteria": ["Criterion 1", "Criterion 2"]
}
```

That's it. No heartbeat, no dependencies, no metrics.
Just: Read → Do → Check → Done.

---

# When Stuck (Max 3 attempts)

```
Attempt 1: Try obvious fix
Attempt 2: Read error carefully, try different approach
Attempt 3: Search codebase for similar patterns

Still stuck? Ask user. Don't loop forever.
```

---

# Quick Reference

| Say | Does |
|-----|------|
| `auto` | Work through all tasks |
| `continue` | One task, then stop |
| `status` | Show progress |
| `brainstorm` | Create new tasks |
| `stop` | Save and exit |
| `reset` | Clear stuck state |
| `review` | Check code quality |
| `update` | Pull latest system |
| `archive` | Compact prd.json (move completed to archive) |
| `clean` | Remove screenshots, old backups, temp files |
| `docs` | Sync and push documentation updates |

---

# Official Claude Code Plugins (Complementary)

Use these alongside claude-auto-dev when helpful:

| Plugin | When to Use |
|--------|-------------|
| `/feature-dev` | Complex new feature (7-phase workflow with agents) |
| `/ralph-loop` | Stuck debugging ("keep trying until it works") |
| `/commit-push-pr` | Git workflow (commit + push + create PR) |
| `/code-review` | Deep PR review with 5 parallel agents |

**Install plugins**: See https://github.com/anthropics/claude-code/tree/main/plugins
