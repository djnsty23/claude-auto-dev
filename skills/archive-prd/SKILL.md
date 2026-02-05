---
name: archive-prd
description: Compact prd.json by archiving completed stories to reduce token usage
triggers:
  - archive
  - compact prd
  - prd too large
user-invocable: true
disable-model-invocation: true
---

# PRD Archival System

When prd.json exceeds ~20k tokens (2000+ lines), archive completed stories.

## "archive" Command

```
1. Read prd.json
2. Separate stories:
   - ACTIVE: passes=false OR passes=null OR type="qa"
   - COMPLETED: passes=true AND type!="qa"
3. Create archive file: prd-archive-YYYY-MM.json
4. Update main prd.json with summary
5. Report: "Archived X stories, Y remain active"
```

## New prd.json Schema (After Archive)

```json
{
  "project": "Project Name",
  "version": "1.3.2",
  "lastUpdated": "2026-01-22",
  "roadmapPhase": "Current Phase",

  "archived": {
    "totalCompleted": 41,
    "lastArchived": "2026-01-22",
    "files": ["prd-archive-2026-01.json"],
    "summary": {
      "S01-S10": "Core foundation - registry, funnels, OAuth, caching",
      "S11-S20": "Navigation, QA, dashboard, exports, favorites",
      "S21-S30": "Time granularity, GA4 schema, accessibility, mobile",
      "S31-S41": "Token refresh, metrics, documentation, scope rules"
    }
  },

  "stories": [
    // Only active/pending stories here
  ]
}
```

## Archive File Schema

```json
{
  "archivedAt": "2026-01-22T10:00:00Z",
  "project": "Project Name",
  "version": "1.3.2",
  "stories": [
    // Full story objects for reference
  ]
}
```

## When to Archive

| Condition | Action |
|-----------|--------|
| prd.json > 2000 lines | Suggest archive |
| prd.json read fails (token limit) | Force archive |
| User says "archive" | Manual archive |
| All stories complete | Archive and start fresh |

## Archive Process

```
1. BACKUP
   cp prd.json prd-backup-$(date +%Y%m%d).json

2. EXTRACT COMPLETED
   Filter: passes=true AND type!="qa"

3. CREATE ARCHIVE
   Write to: prd-archive-YYYY-MM.json

4. GENERATE SUMMARY
   Group stories by ID range (10 per group)
   Write 1-line summary per group

5. UPDATE MAIN PRD
   Remove archived stories
   Add "archived" section with summary
   Keep all QA stories (even passed ones for re-testing)

6. VALIDATE
   Ensure main prd.json < 1500 lines
   Ensure all story IDs accounted for
```

## Accessing Archived Stories

If you need details on an archived story:

```
User: "What was S15 about?"
Claude:
1. Check archived.summary for S15 range
2. Read prd-archive-2026-01.json if needed
3. Report story details
```

## Quick Reference

| Say | Action |
|-----|--------|
| `archive` | Archive completed stories |
| `archive status` | Show archive stats |
| `archive S15` | Show archived story S15 |
| `unarchive S15` | Restore story to active |

---

## Token Optimization

| State | Estimated Tokens |
|-------|-----------------|
| Full prd.json (70 stories) | ~25,000 |
| After archive (30 QA only) | ~10,000 |
| With summary | +500 |
| **Total Savings** | **~60%** |
