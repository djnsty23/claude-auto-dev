# Unattributed spend: results (2026-10-28)

Bars were set in [PREREGISTRATION.md](PREREGISTRATION.md) before any code. All five cleared, and
the breakdown shipped in `work-cost.js`.

Probe: `work-cost.js --days 30 --json`, the shipped version and the version on `main` run back to
back on the live transcripts (5,287 read, 3,526 sessions with usage, 2,529 desktop session records).

| Code | Probe | Result | Bar | Verdict |
|---|---|---|---|---|
| U1 | kinds summed against the unattributed total | $2,762.41 and $2,762.41, diff $0.00 | within $0.01 | pass |
| U2 | merged and not-merged dollars, before and after | merged diff 0.013%, not merged 0.000% | within 0.5% | pass |
| U3 | `repo trunk` plus `no cwd` | $62.50, 0.48% of $13,003 | under 5% | pass |
| U4 | 20 sessions drawn with a fixed seed, kind checked by hand | 20 of 20 | at least 18 | pass |
| U5 | suite fixture, ten sessions across six kinds, plus ten planted defects | all as labelled, 10 of 10 red | all | pass |

The U4 draw is by session, so it holds mostly short scratch and routine runs. A second draw of 20,
weighted by cost, also read correct on all 20. Eight of its `branch` sessions were checked with
`gh pr list --head <branch> --state all`: none of those branches ever had a PR.

## What the 21% was

| Kind | Cost | Share of all spend | Sessions | What it is |
|---|---|---|---|---|
| routine | $939 | 7.2% | 860 | 43 scheduled tasks. The board tick and board requests pickup alone are $333 |
| branch | $867 | 6.7% | 133 | worktree sessions whose branch never got a PR merged in the span |
| scratch | $574 | 4.4% | 2,097 | temp-dir runs, almost all of them skill trigger evals |
| outside repo | $320 | 2.5% | 24 | tools, comms and client folders with no GitHub remote |
| repo trunk | $62 | 0.5% | 22 | a repo checkout on trunk with nothing linked |
| no cwd | $0 | 0% | 0 | |

About 11.6% of all spend is overhead by design (routines and evals), and 9.2% is work that ships
nowhere a PR can show (branches with no merged PR and non-repo work).

Ten planted defects in the classifier each turn `tooling/test-work-cost.js` red. They cover
precedence, the temp-dir test both ways, the deleted-dir walk-up through a linked temp dir, the
missing-cwd case, a record without a task id, linked spend leaking into a kind, routine
aggregation, the `--sessions-dir` flag and the per-kind count.

## Limits

1. `branch` includes worktrees on a non-GitHub remote. A client repo on Bitbucket reads as
   `branch` even when its work shipped there, because only GitHub PRs are asked.
2. `branch` does not separate a branch with an open or closed PR from one that never had a PR.
   That needs one `gh pr list --state all` per repo, and the merged list stays the only `gh` call.
3. Desktop records are the app's own state, not a documented interface. An absent dir is printed
   as absent, and routines then read as `branch`, `repo trunk` or `outside repo`.
4. Records whose file name starts with `deleted_` are not read, matching `delivery-outcomes.js`.
