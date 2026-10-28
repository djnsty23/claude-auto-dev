# Unattributed spend: preregistration (2026-10-28)

`work-cost.js --days 30` reported 21 to 22% of list-price spend as unattributed: sessions with no
`gh pr create`, commit branch, checkout branch or `gh pr merge` that resolves to work. The report
gives that spend no breakdown, so nobody can say whether it is waste, overhead or work that ships
some other way.

## Change

Every unattributed session gets exactly one kind, from evidence the script can read without a
model or an extra `gh` call. The first match wins:

1. `routine`: the desktop session record has a `scheduledTaskId`.
2. `branch`: the session's rows were written on a non-trunk branch with no PR merged in the span.
3. `scratch`: the cwd is under the OS temp dir and in no GitHub repo.
4. `outside repo`: the cwd is in no GitHub repo.
5. `repo trunk`: the cwd is a GitHub repo, on trunk, with no link.
6. `no cwd`: the transcript names no cwd.

Linked spend (merged and not merged) is untouched.

## Bars, set before any code

| Code | Probe | Bar |
|---|---|---|
| U1 | live 30-day run: the kinds sum to the unattributed total | within $0.01 |
| U2 | live 30-day run, before and after back to back: merged and not-merged dollars | within 0.5% (only rows written between the runs differ) |
| U3 | live 30-day run: `repo trunk` plus `no cwd`, the spend with no evidence of what it was | under 5% of total spend |
| U4 | 20 unattributed sessions drawn with a fixed seed, kind checked by hand against the session's record title and cwd | at least 18 of 20 correct |
| U5 | suite fixture: one planted session per kind, plus the precedence cases | every one as labelled, and each planted defect in the classifier turns the suite red |

If U3 fails, the breakdown still ships when U1, U2, U4 and U5 pass, and the residual is reported as
the open item.
