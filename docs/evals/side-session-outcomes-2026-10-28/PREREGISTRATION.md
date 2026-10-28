# Side-session outcomes: preregistered before any change (2026-10-28)

`delivery-outcomes.js` joins headless worker runs to what stood a week later. Since 10-15 the work moved
to desktop side sessions, which it never reads, so first-attempt acceptance describes 9 tasks out of
the fleet's output.

## Source

The desktop app keeps one JSON record per session under its `claude-code-sessions` directory. A
session started by another session carries `spawnedFrom`, and every session carries `prs`, each with
the app's last-known `state`. This is the app's own state file, not a documented interface, so the
reader treats an unreadable directory or record as absent, never as zero.

Measured before writing code, over sessions spawned since 09-28: 228 sessions, 49 with no PR, 555 PRs
(418 MERGED, 105 CLOSED, 32 OPEN). Against `work-cost.js`'s merged list, 412 of 418 MERGED agree,
and every one of the 11 stale states is an OPEN PR that in fact merged. So MERGED and CLOSED are
trusted, and OPEN is asked of GitHub.

## Model

One side session with at least one PR is one task with one attempt. It is accepted when any of its
PRs merged, and the standing check covers the merged PRs only. It is rejected when every PR closed
unmerged, and abandoned 7 days after that. A session with no PR is counted in the population and
is not a task. A rework started as a new session is not linked to the first, so for side sessions
first-attempt acceptance equals acceptance. Cost is unread (null): desktop transcripts carry no
`total_cost_usd`.

## Bars

| Code | Probe | Adopt if |
|---|---|---|
| B1 | tasks with an attempt started on or after 10-15, from a sync into a copy of the store | at least 10 times the 9 before |
| B2 | side tasks accepted against `work-cost.js`'s merged-PR list | 0 tasks holding a merged PR left unaccepted |
| B3 | the existing headless outcomes after the change | identical, task by task |
| B4 | planted fixture: merged, merged then reverted in the window, all closed and quiet, OPEN that merged, not spawned, no PR | every one classified as labelled before the code |
