---
name: Core Reference
description: Canonical prd.json schema and file structure. Loaded once per session.
---

# prd.json Schema

## Required Fields
```json
{
  "id": "TYPE-NAME01",
  "title": "Verb-first action (Add X, Fix Y, Implement Z)",
  "description": "What and why - include business context",
  "priority": 1,
  "type": "feature|bugfix|ux|ai|integration|performance|tech-debt",
  "passes": null,
  "blockedBy": [],
  "files": ["src/file.ts"],
  "acceptanceCriteria": ["Specific, testable criterion"]
}
```

## Field Rules

| Field | Rule | Example |
|-------|------|---------|
| `id` | TYPE-NAME## format | `AI-CHAT01`, `BUG-AUTH02` |
| `title` | Start with verb | "Add mock mode" not "Mock mode" |
| `files` | 2-4 files optimal | >5 = split task |
| `acceptanceCriteria` | 5-7 items optimal | <3 = too vague, >8 = too broad |
| `blockedBy` | ALWAYS populate | Empty array if none |

## Status Values
- `passes: null` = pending
- `passes: true` = complete
- `passes: false` = failed (include error in description)

## Task Scoping Rules

**Split if:**
- >5 files affected
- >8 acceptance criteria
- Multiple unrelated concerns

**Combine if:**
- <3 acceptance criteria
- Single file, trivial change

## Files

| File | Purpose |
|------|---------|
| prd.json | Active tasks |
| progress.txt | Append-only log |
| .claude/mistakes.md | Error patterns (categorized) |
| .claude/decisions.md | Autonomous decisions with rationale |
| handoff-*.md | Session exports |
| ledger.json | Analytics (gitignored) |

# Model Routing

| Task | Model |
|------|-------|
| auto, brainstorm, fix | Opus |
| status, clean, archive | Haiku |
| test (browser) | Haiku |
