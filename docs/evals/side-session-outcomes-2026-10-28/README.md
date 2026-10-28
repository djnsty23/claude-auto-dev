# Side-session outcomes: results (2026-10-28)

Bars were set in [PREREGISTRATION.md](PREREGISTRATION.md) before any code. All four cleared, and
the source shipped.

Probe: one `sync` into a copy of the live store at a fixed now (2026-10-28 15:00 UTC). GitHub
answers were recorded on the first run and replayed, so before and after read the same facts.

| Code | Probe | Before | After | Bar | Verdict |
|---|---|---|---|---|---|
| B1 | tasks with an attempt on or after 10-15 | 9 | 126 | at least 90 | pass |
| B2 | side tasks holding a PR `work-cost.js` lists as merged, left unaccepted | n/a | 0 of 156 | 0 | pass |
| B3 | headless outcomes, task by task | 275 | 275 identical, 0 missing | identical | pass |
| B4 | planted fixture, 8 sessions labelled before the code | n/a | all 8 as labelled | all | pass |

B4 also covers an unreadable record, a `deleted_` file and an absent directory. Ten defects planted
in the reader (OPEN trusted, unspawned counted, closed PR kept, all-closed left running, the four
budget and cache guards below, and two order and churn guards) each turn
`tooling/test-delivery-outcomes.js` red.

## What the store now says

| Population | Tasks | Decided | Accepted | Stood on day 7 | Day 7 unknown |
|---|---|---|---|---|---|
| Headless workers | 275 | 227 | 124 | 79 | 27 |
| Side sessions | 418 | 415 | 387 | 346 | 41 |
| All | 693 | 642 | 511 | 425 | 68 |

The desktop app holds 2,518 session records. 656 were started by another session, 418 of them
opened a PR, and 238 opened none. No side task merged and then failed its day-7 check. The 28
rejected side tasks closed every PR unmerged.

The side acceptance rate (387 of 415, 93%) is not comparable to the headless first-attempt rate
(124 of 227, 55%). A rework started as a new session is not linked to the first one, so for side
sessions first-attempt acceptance equals acceptance. Cost is unread for side sessions.

## Fitting the observer

brain-clock runs the sync observer under a 90 s timeout. The first real-GitHub sync over the side
sessions needed 893 PR asks and over ten minutes, so it would have been killed with nothing
appended, headless rows included. Three changes, each measured with real `gh` on a copy of the
live store:

| Change | Measured |
|---|---|
| 45 s budget on PR asks, oldest task first | every run 49.6 to 59.5 s, worst case 45 s plus one 20 s call |
| settled answers (closed, merged over 7 days ago) kept in `outcomes.pr-facts.json` | 8 runs drained standing_day7 98, 113, 117, 142, 151, 171, 189, 198 with no stall |
| a stored side attempt already merged skips its OPEN asks, and a budget-skipped read keeps the stored outcome | steady-state sync appends 0 rows (was 24 reason-only rows) |

Before the cache, the drain stalled after three runs. 22 PRs the app shows OPEN were in fact
CLOSED and were re-asked every run, and one task holding more PRs than a budget reads never became
final. The live store was seeded once from the recorded answers, so the observer starts from the
drained state (693 tasks). The live backup is kept outside the repo.

## Limits

1. The app's `claude-code-sessions` records are its own state, not a documented interface. A
   format change reads as unreadable records in the population line, not as zero work.
2. A closed PR that is later reopened and merged is missed, because closed answers are cached.
   None was seen.
3. The brain-clock observer still points at an older plugin cache path, so it runs the old sync
   until the operator config is repointed.
