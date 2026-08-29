# Branch backlog triage

`[measured 2026-08-29T20:01Z-20:45Z]` against `origin/main` at **e68fb99**, VERSION
**8.141.0**, after `git fetch origin --prune`. Re-verify before acting: the tip moves.

**Population: 75 origin heads, 92 pull requests, 0 of them open.**

## Verdict

**74 of 75 branches carry nothing that is not already on main. One carries real
unlanded work.** No branch is mergeable-now in the sense of adding value by being
merged, because the only branch with unlanded content is 9 commits behind main and
must be re-applied rather than merged.

| bucket | count | meaning |
|---|---|---|
| A. tip is an ancestor of main | 65 | merged conventionally, nothing to land |
| B. squash-merged, tip == PR `headRefOid` | 9 | nothing to land |
| C. merged but branch continued past the merge | 0 | none |
| D. PR closed unmerged | 0 | none |
| E. no PR at all | 1 | unlanded work |

## The ten non-ancestors, sorted

The Brain's ancestry evidence reproduced exactly: 10 of 75 heads are not ancestors of
`origin/main`. Nine of the ten are **squash-merged**, which is precisely why ancestry
alone cannot classify them. A squash merge creates a new commit on main and leaves the
branch tip unreachable, so a merged branch and an unmerged one are indistinguishable
by `merge-base --is-ancestor`.

### STALE (nothing to land, deletion candidates) - 9

Each has a MERGED PR whose `headRefOid` equals the branch tip that exists today, and
whose merge commit is an ancestor of main. The branch never continued past its merge,
so there is nothing on it that main lacks.

| branch | PR | merge commit | tip == headRefOid | merge commit ancestor of main |
|---|---|---|---|---|
| `fix/skill-gate-auto-executed-must-run` | #84 | 3234e2663c85 | yes | yes |
| `fix/prd-container-shape` | #85 | 5232d807a11e | yes | yes |
| `claude/practical-panini-48736b` | #86 | 2f6b3e999e43 | yes | yes |
| `fix/watch-panels-stderr-leak` | #87 | e456bce5ead5 | yes | yes |
| `fix/panel-deny-no-private-paths` | #88 | 77ba077ea5fa | yes | yes |
| `fix/archive-prd-durability` | #89 | 08f3dcd9c837 | yes | yes |
| `fix/mutation-coverage-gaps` | #90 | 88944a1df297 | yes | yes |
| `feat/queue-freshness` | #91 | a5a8ce842b3a | yes | yes |
| `docs/handoff-layout-spec-session` | #92 | e68fb994c957 | yes | yes |

`docs/handoff-layout-spec-session` is the clearest case: its merge commit **is** main's
current tip, and `git diff origin/main..origin/docs/handoff-layout-spec-session`
reports identical trees.

**Merging any of these nine would be a revert, not a landing.** Every one is
deletion-dominated against main. Representative shapes:

- `fix/skill-gate-auto-executed-must-run`: 28 files, **+42 / -3103**
- `fix/watch-panels-stderr-leak`: 26 files, **+42 / -3052**
- `fix/prd-container-shape`: 21 files, **+32 / -2895**

The `+42` residue is not unlanded content. It is the branch's older `CHANGELOG.md` and
`VERSION` head. Merging would **delete the 8.141.0 changelog entry and roll VERSION
back**, and would delete live scripts that landed later, among them
`plugins/autodev-core/scripts/check-queue-freshness.js`,
`plugins/autodev-core/scripts/check-archive-path.js`,
`plugins/autodev-core/scripts/fleet-stop-watch.js` and their suites.

### NEEDS-ONE-DECISION - 1

**`claude/prd-container-and-keeplist-tests`** (tip `7a5ba37`, authored
2026-08-29T18:17Z, no PR, never opened).

Adds 888 lines across 4 files, all absent from main:

- `tooling/test-prd-container-class.js` (20 assertions)
- `tooling/test-archive-keeplist-prose.js` (10 assertions)
- `tooling/test-nested-sprints.js` (5 assertions)
- `tooling/README-prd-container-tests.md`

**The decision: re-apply onto main and open a PR, or discard.** It cannot be merged as
it stands. The branch is 9 commits behind, so a merge would delete four files main
gained since it diverged.

Re-applying is already measured, not assumed. Cherry-picked onto e68fb99 in a
throwaway worktree:

- applied clean, zero conflicts, pure addition of 4 files
- gate **baseline on untouched main: 68/72 suites passed, 4 failed**
- gate **with the branch applied: 71/75 suites passed, the same 4 failed**
- the three new suites all PASS, and `check:suites` reports all three **verified able
  to fail**, so they are not in that gate's NO-SUBJECT blind spot

Delta: +3 passing, mutation-verified suites, zero regressions.

## Why `git cherry` must not be used here

`git cherry` compares patch ids. A squash merge rewrites the patch, so every one of the
nine branches above would be reported as carrying unlanded commits. Acting on that
would have proposed nine reverts.

The check that does work is the PR record: a MERGED PR whose `headRefOid` equals the
current branch tip, plus `merge-base --is-ancestor <mergeCommit> origin/main`.

## Probe defects found while running this

**F1. `gh pr list --search <branch>` has a false-negative mode.** For `release/8.136.0`
it returned nothing while `--head` found PR #67. GitHub's search tokenizer splits on
`/` and `.`, so branch names containing them can miss. The same happened for
`feat/queue-freshness`, `fix/archive-prd-durability`, `fix/mutation-coverage-gaps`,
`fix/watch-panels-stderr-leak` and `claude/practical-panini-48736b`. **Use `--head`,
which matches the ref exactly.** A `--search`-only triage scores merged branches as
unmerged, which is the alarming direction.

**F2. `%(refname:short)` of `refs/remotes/origin/HEAD` is `origin`, not
`origin/HEAD`.** A loop filtering `^origin/HEAD$` lets it through, then tests a
nonexistent `origin/origin` and scores it a non-ancestor. The first pass here reported
**76 heads and 11 non-ancestors**; `git ls-remote --heads origin | wc -l` says **75**.
Cross-check any branch census against `ls-remote`.

## F3. main's gate is red on Windows, and main is not broken

`npm test` on a clean checkout of e68fb99 with no local changes: **68/72, 4 failed.**
All four are platform artifacts, from three distinct mechanisms:

| suite | mechanism |
|---|---|
| `test-skill-prd-commands` | `execFileSync('/bin/sh', ...)` hardcoded |
| `test-skill-prd-commands-selftest` | same |
| `test-claude-paths` | expects XDG or macOS session-store layout, gets `AppData\Roaming` |
| `test-session-sweep` | builds `projects\C:\Users\...`, a drive letter nested inside a path, ENOENT |

Proved rather than inferred. On this machine `fs.existsSync('/bin/sh')` is `false` and
`execFileSync('/bin/sh', ...)` throws `ENOENT` with **`status=null`**, which is exactly
the `__EXITED__ null` the gate prints before concluding the command "exits non-zero on
a VALID prd.json".

**Consequence for anyone verifying here: absolute green is not available on Windows, so
use the delta against a baseline captured on the same machine.** That is why the branch
result above is stated as 68/72 to 71/75 rather than as a pass.

## Proposals, none executed

**P1. Delete the 9 STALE branches.** Measured empty by the table above. Not done:
deleting a remote branch is not reversible enough to do unasked. All nine merged today,
so there is no urgency.

**P2. Re-apply `claude/prd-container-and-keeplist-tests` onto main and open a PR.**
Verified to apply clean and to add 3 mutation-verified passing suites. Not done: it is
another session's branch and opening a PR is outward-facing.

**P3. Consider whether the 65 already-merged ancestor branches should be pruned too.**
Out of the stated scope, but they are the same class and the same evidence covers them.

## Follow-ups

- **U1.** `RESUME.md` on main says "two merged, two open and green". `gh pr list`
  reports **0 open PRs**; #91 and #92 merged about three minutes after that sentence was
  written. Stale in the tense-trap way, harmless now, worth correcting on the next touch
  of that file.
- **U2.** The four Windows failures in F3 make `npm test` unable to go green on this
  platform. Either fix them (portable spawn instead of `/bin/sh`, path construction, XDG
  assumptions) or record them as known-platform-red so a future session does not read
  them as a regression.
- **U3.** `check-suites-can-fail.js` reports the three F3-failing suites as `RED
  already failing - fix it before trusting this result`. That wording is correct and
  load-bearing: those three suites are currently unverifiable here.

## F4. PR #84 did not break the trunk. It stopped a gate from lying on this platform.

`[measured 2026-08-29T20:40Z]`, added after the Brain independently reported the same
four failures. Two things came out of checking it.

**No branch holds an unmerged fix for any of the four.** Of the ten, only
`fix/skill-gate-auto-executed-must-run` touches them, and that is PR **#84, already
merged** at `3234e26`. The interesting finding is the inverse of the one being looked
for: #84 is what turned those two suites red here, and it was right to.

Ran `tooling/test-skill-prd-commands.js` at `3234e26^` in a throwaway worktree. Before
#84, on this platform:

```
population: 60 SKILL.md scanned, 11 inline command(s) found, 7 of them read prd.json
NOT RUNNABLE on a valid fixture (illustrative, truncated, or broken) - not checked, not clean:
  [all 7, including all 5 auto-executed]
PASS: all 0 runnable prd.json command(s) change output for every one of the 6 states.
EXIT=0
```

**A green over an empty set.** All seven commands were excused as unrunnable and the
gate printed PASS having verified zero. That is the pattern `rule-gate-integrity`
documents, and it was live on this platform until this morning. #84 removed the excuse
for `[auto-executed]` on the correct reasoning that a command running at skill load
and injecting its output cannot be illustrative.

So the trunk did not regress. A gate stopped lying. What is genuinely still wrong is
that the gate cannot tell "this command is broken" from "this machine has no
`/bin/sh`", and reports the second as the first.

The cheapest tell that the failure is platform and not content is already inside the
gate's own output: **the selftest's deliberately-healthy fixture fails**
(`FAIL healthy auto-executed command passes, expected exit 0, got 1`). A real defect
in 5 skills cannot make a synthetic known-good command fail. The failure is total, not
selective, which is what a missing shell looks like.

**U4, revising U2.** Fixing this means a portable spawn, or detecting that no POSIX
shell is reachable and reporting UNVERIFIABLE-ON-THIS-PLATFORM. A hard red is wrong
because it is indistinguishable from a real defect. A silent skip would be worse: it
reinstates precisely the vacuous green #84 just removed. Name the platform in the
output either way.

**U5. Two sessions on one machine are not two measurements.** This session and the
Brain measured the same four failures in different worktrees. That corroborates the
failure set and says nothing about whether the trunk is broken, because both runs share
the platform that causes it. The discriminating run is a POSIX one, and neither session
can do it here.
