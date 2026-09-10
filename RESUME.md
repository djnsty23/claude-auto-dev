# RESUME — per-story runtime flow check (PR #206)

Written 2026-09-08 at the 300k context line. Session affectionate-antonelli-3bafae.

## Done

- PR #206, branch `claude/affectionate-antonelli-3bafae`, rebased onto origin/main at 38ab642, two commits:
  eaa6a25 (the feature) and 433f40e (un-glues a `docs/decisions.md` heading main's 38ab642 had joined to the previous paragraph).
- Evidence: `docs/evidence-flow-verification-2026-09-08.md`. Decision: top entry of `docs/decisions.md`.
- 2026-09-10: the two P2 findings from the relayed Codex audit (PR comment of 2026-09-09 06:53) are fixed: a required
  `commit` field checked for reachability from `--at <sha>` (default HEAD), and screenshot paths resolved from the repository
  root. Suite grew from 42 to 62 checks, all driven as subprocesses against a throwaway repository.
- Ships: `plugins/autodev-core/scripts/flow-evidence.js` + `tooling/test-flow-evidence.js` (62 checks);
  `scripts/mine-fixes.js --since=<git date>` + cases in `tooling/test-mine-fixes.js`;
  `skills/auto/SKILL.md` "Runtime flow check" section and three verification rows; `verify-tags.md` `flow` tag;
  one dated sentence in `rule-verification`; `learn-from-fixes` flag mention. `stop-auto-check.js` unchanged. No VERSION bump.

## Verified, and by what

- `npm run gate` on 433f40e, clean tree: exit 0. `npm test` 119/119; `check:suites` 118 verified able to fail, 0 NOT verified,
  both new suites ok; probe-shapes, population, entrypoints, skill-tools exit 0. Log was in the session scratchpad only.
- CI on 433f40e: `gh api repos/djnsty23/claude-auto-dev/commits/433f40e/check-runs` grouped by name — macos, ubuntu, windows
  each have a completed success.
- Replay 3 of 3 (parent of fix red, fix green) and the 30-commit ceiling (4 yes / 3 with data / 23 no) are in the evidence doc.
- The live product repo (Project C) was read-only throughout; replay worktrees removed; the QR repo's throwaway branch deleted;
  Project A untouched.

## Not done, and why

- Not merged. MERGE-POLICY.md keeps review for anything under `plugins/` that ships; this PR changes three skills and two scripts there.
  A review chip was spawned ("Review PR #206: per-story runtime flow check", task_e794acc9) with the exact checks to run.
- The two full `auto` sprints (5 stories with / without) were not run; the cost table measures the check per story instead, and the doc says why.

## Known incident from this session

- At about 13:00 this session removed eight `check-suites-wt-*` worktrees from tmpdir; some belonged to other sessions' in-flight
  sweeps, which will have reported INDETERMINATE / "did not run" without a cause. Not repeated; kill by pid, never by pattern.

## Next

1. The review session merges or comments (see the chip). If main moves first, rebase with
   `git -c user.email=djnsty23@users.noreply.github.com rebase origin/main` and re-run the gate after the rebase.
2. On 2026-10-08, run section 6 of the evidence doc to measure the effect.
