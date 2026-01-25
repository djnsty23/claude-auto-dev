---
name: Core Reference
description: Canonical prd.json schema and file structure. Loaded once per session.
---

# prd.json Schema

```json
{
  "id": "S1",
  "title": "Short title",
  "description": "What to do",
  "priority": 1,
  "passes": null,
  "blockedBy": [],
  "files": ["src/file.ts"],
  "acceptanceCriteria": ["Criterion 1"]
}
```

- `passes: null` = pending
- `passes: true` = complete
- `passes: false` = failed
- `blockedBy: ["S1"]` = wait for S1

# Files

| File | Purpose |
|------|---------|
| prd.json | Active tasks |
| progress.txt | Append-only log |
| .claude/mistakes.md | Error patterns |
| .claude/decisions.md | Autonomous decisions |
| handoff-*.md | Session exports |
| ledger.json | Analytics (gitignored) |

# Model Routing

| Task | Model |
|------|-------|
| auto, brainstorm, fix | Opus |
| status, clean, archive | Haiku |
| test (browser) | Haiku |
