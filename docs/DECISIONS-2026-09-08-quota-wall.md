# Decisions — 2026-09-08, the quota-wall work (PR #200)

Calls made without asking during the operator's away window (`AWAY.md`,
scope qr and autodev). Session worktree `beautiful-ramanujan-918fa1`, branch
`claude/beautiful-ramanujan-918fa1`, base `origin/main` 7b157a8.

## D1. Branch 1 — the merge of #200 is the Brain's, not this session's

The closing panel recommended "review and merge #200" and the away hook said
to take the recommended option. `AWAY.md` is the standing rule above it: *the
Brain holds merge authority on qr and autodev; sessions still do not merge
their own PRs.* So this session did not merge. The PR, its gate output and the
rebased `npm test` result were messaged to the Brain, which decides.

## D2. Branch 2 — rebase onto the moved base and keep both decisions entries

`origin/main` moved twice while the gate ran (#184, #191, #192, #195). The
branch was rebased rather than merged, the one conflict (`docs/decisions.md`,
two entries dated 2026-09-08) was resolved by keeping both with this branch's
first, and `npm test` was re-run on the result (116/116). Reversible: the
pre-rebase commit d032c79 carried the full gate and is in the reflog.

## D3. Branch 2 — re-stamp the committer instead of amending

The first push was declined for email privacy because `git rebase` sets the
committer from local config. The fix was a forced rebase under
`-c user.email=<noreply>`, never `--amend` (CLAUDE.md forbids amend here).
Recorded in memory so the next session passes the identity to rebase too.

## D4. Branch 2 — scope down to detection when the re-measurement is empty

The brief said to scope to detection if the loss rate had dropped to noise.
It had not dropped; it had not been sampled (0 runs since 2026-08-25). The
brief's own Step 1 rule was applied to the nearest case: detection shipped,
the phase rule shipped with its measured serial cost, and the Stop note
shipped only because the resume was verified correct on the one real run.
