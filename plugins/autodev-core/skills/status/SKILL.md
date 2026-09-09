---
name: status
description: Shows sprint progress and task status. Use 'progress' (not 'status' - that's a built-in).
when_to_use: "Invoked when the user says \"progress\"."
allowed-tools: Bash, Read
model: haiku
user-invocable: true
---

# Status

Show current progress with minimal token usage.

## Sprint Data

Read the target project's PRD with the shared `workPlan(prd)` documented in
`core`. Report every sprint's records, not just the latest one or a file header.
Keep the current sprint and archived totals as separately labelled views.
Distinguish a missing file from unreadable/invalid data; neither is a clean queue.

## Process

1. Resolve the actual project and read the shared plan. If no PRD exists, report
   that scope and any independently verified active work; do not invent a queue.
2. Show all five state counts plus unrecognised records and the total. Use
   `plan.ready` for executable work and show `plan.blocked` / `plan.invalid`
   reasons. Pending-state count and dependency-ready count are different.
3. Report active owners only from current ownership/worker evidence. A native
   task list may supplement the report if this host actually exposes one, but
   must not override the durable PRD or turn stale activity into a current fact.

```
[project] | [sprints covered] | [ref / working copy inspected]
Done: [N] | Pending: [N] | Failed: [N] | Deferred: [N]
Needs setup: [N] | Unrecognised: [N] | Total: [N]
Ready now: [N] | Dependency blocked: [N] | Invalid: [N]
Next: [id, title] | Active owner: [verified identity or unknown]
Unresolved: [ids and specific blockers]
```

## Proving the run

`done + pending + failed + deferred + needsSetup + unrecognised === total`
for the complete story population. Confirm the reported next story is present
in `plan.ready`. An empty population or no ready work with unresolved records
is not completion. Scores, native task-list emptiness and a green build do not
replace these checks. State the population and inaccessible data explicitly.
