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
  "verified": null,
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
- `passes: null` = pending (not started)
- `passes: true` = code complete (but may not be verified)
- `passes: false` = failed (include error in description)

## Verification (NEW)
- `verified: null` = not yet tested
- `verified: "build"` = npm run build passes
- `verified: "browser"` = manually tested in browser
- `verified: "test"` = unit/integration tests pass
- `verified: "e2e"` = end-to-end test passes

**A task is truly DONE when:**
```
passes: true AND verified: "browser"|"test"|"e2e"
```

**Code complete but unverified:**
```
passes: true AND verified: null|"build"
```

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
