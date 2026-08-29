---
name: archive-prd
description: Archives completed stories from prd.json to reduce token usage.
when_to_use: "Invoked when the user says \"archive\", \"compact prd\", \"prd too large\"."
allowed-tools: Read, Write, Edit, Bash
model: haiku
user-invocable: true
argument-hint: "[status|S-ID|unarchive S-ID]"
---

# PRD Archival System

Archive completed stories to keep prd.json fast and small. Keep only last 3 sprints active.

## "archive" Command

```
1. Read prd.json
2. Separate stories with isArchivable() from scripts/prd-states.js:
   - ARCHIVE: isArchivable(story) === true  (passes===true, i.e. isDone)
   - KEEP:    everything else — null, false, "deferred", "needs-setup",
              a MISSING passes key, any unrecognised value, and type="qa"
              (even passed QA stories stay, for re-testing)
3. PROVE THE SPLIT BEFORE WRITING: archive-count + keep-count must equal the
   before-count, and no story id may appear in both sets or in neither.
   If the invariant fails, STOP — write nothing, report the ids that fell
   through. This runs BEFORE step 4, not after: a loss detected after the
   write is a loss.
4. Create archive file: prd-archives/prd-archive-YYYY-MM.json (a TRACKED path)
5. Update main prd.json with summary
6. Report: "Archived X stories, Y remain active" with both counts and the total
```

**Why the two-bucket version was destructive:** the old split (ACTIVE:
false|null|qa / COMPLETED: true) matched neither bucket for `"deferred"`,
`"needs-setup"`, and keyless stories — they were written to neither file and
silently deleted. `isArchivable()` exists because of exactly that incident (its
own comment block records it); route through it rather than re-deriving buckets.

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
    "files": ["prd-archives/prd-archive-2026-01.json"],
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
| 4+ total sprints | Auto-suggest archive |
| prd.json > 500 lines | Suggest archive |
| prd.json > 50KB | Force archive |
| User says "archive" | Manual archive |
| All stories complete | Archive and start fresh |

Keep only the last 3 sprints in prd.json. Archive everything older.

## Archive Process

```
0. PROVE THE DESTINATION IS DURABLE — BEFORE ANY WRITE
   node ${CLAUDE_PLUGIN_ROOT}/scripts/check-archive-path.js prd-archives/prd-archive-$(date +%Y-%m).json
   Exit 1 means git would ignore the path: STOP and write nothing. Do not
   "fix" it with a .gitignore negation — a `!` rule cannot re-include a file
   whose parent directory is excluded, so it looks like an exception and grants
   nothing. Write somewhere outside the ignored tree instead.

1. BACKUP
   mkdir -p prd-archives
   cp prd.json prd-archives/prd-backup-$(date +%Y%m%d).json

2. EXTRACT ARCHIVABLE
   Filter with isArchivable() from scripts/prd-states.js (and keep type="qa"
   regardless). KEEP everything it rejects: null, false, "deferred",
   "needs-setup", a missing passes key, any unrecognised value.

3. PROVE THE SPLIT — BEFORE ANY WRITE
   archiveCount + keepCount === beforeCount, zero id overlap, zero ids in
   neither set. On failure: stop, write nothing, name the ids that fell
   through. (After the write this check can only report a loss, not prevent
   one.)

4. CREATE ARCHIVE
   Write to: prd-archives/prd-archive-YYYY-MM.json  (step 0 proved git keeps it)
   If prd.json already has an "archived" section, this is a RE-archive:
   append to files[] and ADD to totalCompleted — never overwrite it.

5. GENERATE SUMMARY
   Group stories by ID range (10 per group)
   Write 1-line summary per group

6. UPDATE MAIN PRD
   Remove archived stories
   Add/extend "archived" section with summary
   Keep all QA stories (even passed ones for re-testing)

7. VALIDATE
   Ensure main prd.json < 1500 lines
   Re-assert the step-3 invariant against the files as written
   Re-run step 0 against the archive AS WRITTEN, and confirm `git status`
   actually shows it. Counting stories proves completeness, not durability.
```

Note the shape this must survive: real projects store `stories` as an OBJECT
keyed by id (never `.filter()` it — `Object.values()` first), and `archived`
is a top-level key the archive itself adds, so a re-archive must not treat an
already-archived file as un-archived.

## Accessing Archived Stories

If you need details on an archived story:

```
User: "What was S15 about?"
Claude:
1. Check archived.summary for S15 range
2. Read prd-archives/prd-archive-2026-01.json if needed
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
| Full prd.json (70+ stories, 10 sprints) | ~25,000+ |
| After archive (current sprint + 2) | ~3,000-5,000 |
| With summary | +500 |
| **Total Savings** | **~80%** |

**Real example:** a long-running project can grow to 800+ rows / 10 sprints / ~20K tokens. After archiving to keep only the current sprint + 2 prior, prd.json drops to ~150 rows / ~3K tokens.

## Proving the run

Two properties, and they fail independently. Assert both.

**Observable 1 — COMPLETENESS: no story is lost.** Stories in the archive plus
stories left in prd.json equals the count before archiving.

```bash
node -e "const a=require('./prd.json');…"   # or just read both files and add up
```

Check the total before and after and state both numbers. A story dropped during
the move looks exactly like a story that was never there.

**Observable 2 — DURABILITY: the archive is a file git will keep.**

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/check-archive-path.js <the archive you wrote>
git status --short <the archive you wrote>     # it must appear
```

⚠️ **Counting is not durability, and this is how the archive was lost.**
`[measured 2026-08-29]` a project archived 159 completed stories, and its count
check passed *correctly* — both files existed at that moment. The archive had
been written to `.claude/archives/`, a gitignored path, so `git add -A` skipped
it in silence and the commit carried only the deletion from prd.json. The archive
and the backup taken beside it lived on one machine's disk and nowhere else.
The count check could never have caught it: it measures completeness while the
failure mode is durability. A check that reports green about a property it does
not examine is this project's signature failure — see `skills/rule-gate-integrity`.

**If an archive was already lost this way, it is probably recoverable.**
Archiving REMOVES stories from a tracked `prd.json`, so the commit *before* the
archive commit holds the complete pre-archive state — every story with its full
`verified` record:

```bash
git log --oneline -S'"archived"' -- prd.json    # find the archive commit
git show <archive-commit>^:prd.json             # the real backup
```

That recovered the full 164-story file in the incident above. Do **not** send
anyone to the archive path for recovery: under the conditions that lose the
archive, that file is exactly what does not exist.
