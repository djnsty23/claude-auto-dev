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

Archive eligible completed stories to keep prd.json small while retaining every
unresolved story and every prerequisite that retained work still needs.

## "archive" Command

```
1. Read prd.json
2. Separate stories with isArchivable() from scripts/prd-states.js:
   - ARCHIVE: isArchivable(story) === true, excluding QA and prerequisite
              records referenced by any story that will remain
   - KEEP:    everything else — null, false, "deferred", "needs-setup",
              a MISSING passes key, any unrecognised value, and type="qa"
              (even passed QA stories stay, for re-testing), and completed
              prerequisites still referenced by retained stories
3. PROVE THIS RUN'S SPLIT BEFORE WRITING: selected-active-to-archive count +
   retained-active count must equal the pre-run active count. The two selected
   id sets are disjoint and cover every pre-run active record. Preexisting
   archive records are a separate population, never part of that equation.
   If the invariant fails, STOP — write nothing, report the ids that fell
   through. This runs BEFORE step 4, not after: a loss detected after the
   write is a loss.
4. Create a unique tracked archive or merge an existing one without replacement
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

  "stories": {}
}
```

## Archive File Schema

```json
{
  "archivedAt": "2026-01-22T10:00:00Z",
  "project": "Project Name",
  "version": "1.3.2",
  "stories": {
    "S1-001": { "id": "S1-001", "title": "Completed outcome", "passes": true }
  }
}
```

## When to Archive

| Condition | Action |
|-----------|--------|
| 4+ total sprints | Auto-suggest archive |
| prd.json > 500 lines | Suggest archive |
| prd.json > 50KB | Archive eligible completed records; preserve all other work |
| User says "archive" | Manual archive |
| All stories complete | Archive and start fresh |

Sprint age selects history to inspect, not records to delete. Retain unresolved
stories from every sprint. Remove an old sprint container only after all of its
records were safely archived or explicitly carried forward.

## Archive Process

```
0. PROVE THE DESTINATION IS DURABLE — BEFORE ANY WRITE
   Resolve this loaded plugin's scripts/check-archive-path.js, then run it
   against the chosen archive path in the target project. Do not assume the
   plugin-root environment variable exists in the shell.
   Verify that the actual target is a git worktree and read the checker's
   verdict and stderr, not its exit alone: it returns 0 with NO-REPO for an
   unbacked local path. A missing/unreadable repo or unavailable check does not
   establish durability; preserve the PRD until a real tracked destination is
   verified. Exit 1 means git would ignore the path: stop and write nothing. Do not
   "fix" it with a .gitignore negation — a `!` rule cannot re-include a file
   whose parent directory is excluded, so it looks like an exception and grants
   nothing. Write somewhere outside the ignored tree instead.

1. BACKUP
   mkdir -p prd-archives
   Write a unique backup path; do not overwrite an earlier same-day snapshot
   Inventory all preexisting archive ids and record payloads separately, with
   their paths/hashes, before proposing a monthly merge or updating totals

2. EXTRACT ARCHIVABLE
   Filter with isArchivable() from scripts/prd-states.js (and keep type="qa"
   regardless). KEEP everything it rejects: null, false, "deferred",
   "needs-setup", a missing passes key, any unrecognised value. Keep completed
   prerequisites referenced by retained stories too; propagate that keep-set
   through their blockedBy links until it stops growing. Run workPlan before
   and after the proposed split: archiving must not make a ready story blocked
   by a newly missing dependency. Preserve id-keyed records and all own keys.

3. PROVE THE SPLIT — BEFORE ANY WRITE
   Let A be this run's selected active records and K the retained active records.
   A.size + K.size === preRunActive.size, with zero id overlap and unchanged
   payloads across their union. Existing archives are not included in A.
   On failure, write nothing and name the missing/conflicting records.

4. CREATE ARCHIVE
   Write to a fresh uniquely named file under prd-archives/ (step 0 proved git
   keeps it), or explicitly merge the existing monthly archive by story id.
   Never replace an existing archive with only this run's records. Every prior
   archive record must survive with the same payload. If an incoming id collides
   with a different archived payload, report the conflict and preserve both
   snapshots until its provenance is resolved; do not silently overwrite it.
   On re-archive, preserve files[] without duplicates and compute totalCompleted
   from distinct archived story ids, counting an already-present identical id
   once. Read back the archive before changing the PRD.

5. GENERATE SUMMARY
   Group stories by ID range (10 per group)
   Write 1-line summary per group

6. UPDATE MAIN PRD
   Remove archived stories
   Add/extend "archived" section with summary
   Keep all QA stories (even passed ones for re-testing)

7. VALIDATE
   Report remaining size; a size target never permits dropping retained work
   Re-assert the step-3 invariant using A and K against the written files.
   Confirm every A record is archived with its original payload and every K
   record remains active. Separately confirm every preexisting archive record
   remains unchanged. A monthly archive's full count includes older records
   and cannot substitute for A.size; equal totals alone cannot prove either
   preservation property.
   Re-run step 0 against the archive AS WRITTEN, and confirm `git status`
   actually shows it. Stage the archive and PRD together by explicit path and
   commit together under the existing mandate. Counting stories proves
   completeness, not durability.
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

Measure the actual before/after file size and story population. Archive eligibility
and dependency preservation determine the split; a token budget or sprint count
cannot override them. Report any required retained history even when the PRD
remains larger than the preferred target.

## Proving the run

Two properties, and they fail independently. Assert both.

**Observable 1 — COMPLETENESS: no story is lost.** This run's selected active
records A plus retained active records K exactly reconstruct the pre-run active
PRD by id and payload. Read back every A record from the archive and K from the
PRD. Separately preserve every preexisting archive record. Adding the entire
monthly archive count to the retained active count double-counts old history.

Read both written files and compare the actual id sets and record payloads to
the preserved pre-archive snapshot; counts alone can hide one lost/one duplicate
record. Verify the dependency-ready set stayed intact too.

Check the total before and after and state both numbers. A story dropped during
the move looks exactly like a story that was never there.

**Observable 2 — DURABILITY: the archive is a file git will keep.** Resolve
`archive_path` from the file actually written before running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-archive-path.js" "$archive_path"
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
