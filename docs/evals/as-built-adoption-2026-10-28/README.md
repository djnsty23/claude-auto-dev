# As-built adoption: results (2026-10-28)

Bars were set in [PREREGISTRATION.md](PREREGISTRATION.md) before any change. Three of five
candidates cleared their bar and shipped. Two were already covered and were not adopted.

| Code | Probe | Before | After | Verdict |
|---|---|---|---|---|
| D1 | brain-clock `passes.jsonl` full read | 23 ms, about 300 KB a day | n/a | not adopted, two orders under the 250 ms bar |
| D2 | 80 real subagent pushes replayed through the hook, each with a planted twin aimed at `main` | no guard: 0 of 78 planted twins blocked | 0 of 80 real blocked, 78 of 78 executable twins blocked | adopted |
| D3 | `check-rules-size.js` | 32,183 bytes, over 32,000 | 31,970 bytes, no rule dropped | adopted (operator config, mirrored) |
| D4 | `delivery-outcomes.js report` cost coverage by week | complete for tasks settled after 10-15 | n/a | not adopted, the sync observer already closes the gap |
| D5 | conveyor brief for an idea, text outside the data fence | the H1 carried the idea title | 0 bytes of idea text outside the fence | adopted |

D2 detail. The two unblocked twins put the push inside a quoted JavaScript string that the shell never
runs, so allowing them is correct. The suite (`tooling/test-coordinator-write-guard.js`, section M)
adds 21 cases: eight refspec forms that must block (`main`, `HEAD:main`, `+main`,
`refs/heads/master`, `:main`, after `-o`, via `-C`, after `cd`), `--all` and `--mirror`, a bare push
and `origin HEAD` read from a real repo on `main`, and seven allows, including the same bare push on a
`claude/*` branch as the control. The guard holds with no role file and never judges the main thread.

D5 detail. The planted check in `tooling/test-idea-conveyor.js` failed on the unchanged tree with the
title in the H1 and passed after the H1 switched to the idea key. The worker ledger title still carries
the idea title, because the ledger never reaches the worker's prompt.

## Autodev measured

Window: PRs merged 2026-09-28 to 2026-10-28, priced from transcripts by `work-cost.js --days 30`.
Cost is a list-price equivalent, not a bill.

| Measure | Value |
|---|---|
| PRs merged | 741 in 19 repos |
| Spend linked to merged PRs | $7,222 of $12,894 (56%), 22% to unmerged work, 22% unattributed |
| Median cost per merged PR | $5.9 |
| Median by week, from 09-28 | $8.1, $6.3, $3.9, $5.3, $4.8 (last week partial, 94 PRs in 3 days) |
| Merged PRs by type | 297 `fix`, 304 `feat`, 140 other |
| Reverted | 2 of 741 |
| Unattended worker passes | 194 of 229 tasks succeeded on the first pass, 35 never did |

| Repo | PRs | Cost | Median per PR |
|---|---|---|---|
| Product A | 349 | $2,862 | $4.8 |
| Product B | 115 | $682 | $4.3 |
| this harness | 80 | $1,867 | $10.4 |
| Product C | 63 | $566 | $7.9 |
| Product D | 50 | $468 | $8.1 |

Delivery outcomes (`delivery-outcomes.js report`, store computed 10-26) cover the headless workers
only. 227 of 275 tasks are decided. 124 of 227 (55%) were accepted on the first attempt, and 79 of
the 97 accepted tasks whose day-7 state is known still stood. Only 9 headless tasks started after
10-15, because the work moved to desktop side sessions, so this store no longer describes most of
the fleet.

What the numbers say:

1. The harness repo costs about twice the product median per PR and holds most of the top-ten
   list. Release and merge-lock PRs dominate it.
2. A fifth of all spend has no PR, issue or branch link, so the value of that work cannot be judged.
3. The outcome store needs a side-session source before first-attempt acceptance means anything
   for the current fleet.
