# Branch backlog classification

`[measured 2026-09-07]` against `origin/main` at **25d91dd** (VERSION 8.164.0), after
`git fetch origin --prune`. **Population: 120 origin heads, 39 not merged into `main` by
ancestry, 177 pull requests, 0 of them open.**

Re-verify before acting. This is a snapshot and the tip moves; the classification below is
a statement about `origin/main` at 25d91dd, not a standing property of these branches.

## Verdict

| bucket | count | meaning |
|---|---|---|
| **LANDED** | 34 | `origin/main` already contains this branch's contribution. Merging adds nothing. |
| **UNLANDED** | **0** | content `main` lacks that is still worth landing. There is none. |
| **STALE** | 5 | content `main` lacks that should NOT be landed — rejected, superseded, or expired. |

**Nothing in the branch list is actionable work.** All 39 unmerged heads are noise. That is
the answer to "is there unlanded work hiding here", and it is worth more than the branch
list was worth before, which was nothing.

## Why `git cherry` and ancestry both lie here

39 heads are not ancestors of `main`, and **33 of them are merged pull requests**. This
repo squash-merges, and a squash rewrites the tree into a single new commit with a new
patch id. `git cherry` compares patch ids, so it reports every squash-merged branch as
unlanded. Ancestry reports the same thing for the same reason.

Both failures are silent and both point the same direction: toward re-landing work that is
already in. **The direction of that error is the dangerous one**, because these branches
are also far behind. `claude/prd-container-and-keeplist-tests` is 187 commits behind; its
two-dot diff against main is *34,535 deletions*. "Landing" it is a revert wearing a
merge's clothes.

`[measured 2026-08-30]` a predecessor session recorded this same shape from the other
side — 74 of 75 branches already landed, and ancestry unable to say so. That record is on
`claude/sad-kirch-355c74`, never landed, and is classified STALE below because this
document supersedes its table. The *lesson* survives here; the snapshot does not.

### The worked example

`fix/coordinator-guard-home-prefix` reports `+1` ahead and looks unlanded. It is PR #167,
merged 2026-09-05 as `5711ee5`. The merge probe reports a CONFLICT in
`tooling/test-coordinator-write-guard.js`, which reads like unlanded content and is the
opposite: the diff from *branch to main* is 56 added lines — an `F3` test block that PR
#176 put on `main` **after** #167 merged. Main is a strict superset. Landing the branch
would delete that block.

## The probe, and the control that validates it

Per branch, the decisive question is *what would a merge into `main` actually add*:

```bash
git merge-tree --write-tree origin/main origin/<branch>
git diff --shortstat origin/main <resulting-tree>
```

A three-way merge cannot revert `main`, so this measures the branch's genuine remaining
contribution and is immune to squash rewriting: when the content already landed, both
sides carry the same change, and the result equals `main`.

**A clean answer from this probe was not trusted until the same command shape produced a
dirty one.** The control re-ran it against older bases:

| branch | vs `origin/main` (25d91dd) | vs `main~10` | vs `main~25` | vs `main~40` |
|---|---|---|---|---|
| `claude/awesome-satoshi-a18440` | EMPTY | EMPTY | 42 files, +5193 | 65 files, +9677 |
| `feat/rule-record-size` | EMPTY | EMPTY | EMPTY | 7 files, +1441 |
| `fix/home-repos-portable` | EMPTY | 18 files, +1045 | 49 files, +6382 | 66 files, +10854 |
| `claude/dispatch-readiness` | EMPTY | EMPTY | EMPTY | 7 files, +1677 |

Identical invocation, identical branches, real diffs against older bases and EMPTY only at
current `main`. The EMPTY verdicts are a live measurement, not a mangled pathspec. The
gradient is also the right shape: each branch goes non-empty exactly once the base predates
its own merge.

Three further checks, because one probe is one probe:

1. **Exact `headRefName` match**, not `gh --search`, which matches loosely and returns
   wrong-title hits. Every matched PR was then confirmed to have `baseRefName == main`
   and a `mergeCommit` that is an ancestor of `origin/main`: **35/35**.
2. **`headRefOid` == branch tip today** for all 35. No branch continued past its merge, so
   no merged branch can be hiding a later commit.
3. **A content probe independent of git plumbing**: extract the longest distinctive added
   lines from each branch's contribution and `grep` them in a checkout of `origin/main`.

### Two false verdicts the controls caught

Both are recorded because both would have shipped a wrong table.

- **`git diff A..B -- <file> --numstat`** puts `--numstat` *after* `--`, where git parses
  it as a pathspec. It produced garbage that rendered as a plausible per-file report. Flags
  belong before `--`.
- **`grep -rqF -- "$LINE" <dir> --exclude-dir=.git`** has the same shape: after `--`,
  `--exclude-dir` is a filename. The first content-probe run returned "NOT on main" for
  **7 of 7** branches. A positive control (`grep` for a line certainly on `main`) failed on
  the spot, which is the only reason the run was discarded rather than believed. Every
  subsequent probe run carries that positive control *and* a negative control for an
  invented string.

A probe that answers NO for everything and a probe that answers YES for everything fail the
same way. Neither is detectable from its output alone.

## The table

| branch | tip SHA | +ahead/−behind | PR | verdict | evidence |
|---|---|---|---|---|---|
| `claude/autodev-core-brain-393c08` | `539a92f8d8ae` | +12/−46 | [#136](https://github.com/djnsty23/claude-auto-dev/pull/136) | **LANDED** | PR #136 merged 2026-09-03 into `main`; merge commit `6c5e799d` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `claude/autodev-core-brain-b08311` | `cbc8e54b64e7` | +2/−25 | [#157](https://github.com/djnsty23/claude-auto-dev/pull/157) | **LANDED** | PR #157 merged 2026-09-05 into `main`; merge commit `82a5d1cf` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `claude/awesome-satoshi-a18440` | `f14f07aecff4` | +1/−16 | [#166](https://github.com/djnsty23/claude-auto-dev/pull/166) | **LANDED** | PR #166 merged 2026-09-05 into `main`; merge commit `18703644` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe adds nothing. |
| `claude/brain-role-liveness` | `66d4e339793e` | +4/−31 | [#153](https://github.com/djnsty23/claude-auto-dev/pull/153) | **LANDED** | PR #153 merged 2026-09-04 into `main`; merge commit `5e23092e` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `claude/design-background-craft` | `98659ad75fef` | +1/−41 | [#144](https://github.com/djnsty23/claude-auto-dev/pull/144) | **LANDED** | PR #144 merged 2026-09-03 into `main`; merge commit `dc9f3ad5` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `claude/dispatch-readiness` | `24ed0c49a3d0` | +6/−41 | [#142](https://github.com/djnsty23/claude-auto-dev/pull/142) | **LANDED** | PR #142 merged 2026-09-03 into `main`; merge commit `041ff161` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe adds nothing. |
| `claude/draft-guard-precondition` | `7be982ea643c` | +2/−45 | [#138](https://github.com/djnsty23/claude-auto-dev/pull/138) | **LANDED** | PR #138 merged 2026-09-03 into `main`; merge commit `73869d43` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `claude/draft-guard-third-state` | `d419693f24da` | +2/−44 | [#139](https://github.com/djnsty23/claude-auto-dev/pull/139) | **LANDED** | PR #139 merged 2026-09-03 into `main`; merge commit `fdfb2162` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe adds nothing. |
| `claude/function-hooks-claude-code-7e2853` | `4edc4c613ce5` | +8/−26 | [#156](https://github.com/djnsty23/claude-auto-dev/pull/156) | **LANDED** | PR #156 merged 2026-09-04 into `main`; merge commit `a84eb3e6` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `claude/hook-address-space` | `03e60a16f44d` | +1/−35 | [#147](https://github.com/djnsty23/claude-auto-dev/pull/147) | **LANDED** | PR #147 merged 2026-09-04 into `main`; merge commit `70615ecb` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `claude/infallible-kare-b95181` | `b865f8a078f8` | +11/−47 | [#135](https://github.com/djnsty23/claude-auto-dev/pull/135) | **LANDED** | PR #135 merged 2026-09-03 into `main`; merge commit `b49c4a54` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe adds nothing. |
| `claude/inspiring-maxwell-7494b2` | `77689a823b0a` | +1/−32 | [#151](https://github.com/djnsty23/claude-auto-dev/pull/151) | **LANDED** | PR #151 merged 2026-09-04 into `main`; merge commit `25c3cd13` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `claude/prd-container-and-keeplist-tests` | `7a5ba37e51d5` | +1/−187 | — (no PR) | **LANDED** | No PR, but all four added files are present on `origin/main` via `13a46ad` (2026-08-30) and the merge probe adds nothing. Content probe: found on main. |
| `codex/framework-radar` | `a398c93e5131` | +3/−160 | [#111](https://github.com/djnsty23/claude-auto-dev/pull/111) | **LANDED** | PR #111 merged 2026-08-31 into `main`; merge commit `9847fdb1` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `codex/framework-radar-experiments` | `4ba28ebb7c69` | +1/−159 | [#113](https://github.com/djnsty23/claude-auto-dev/pull/113) | **LANDED** | PR #113 merged 2026-08-31 into `main`; merge commit `2b6d4490` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `docs/brain-cherry-fresh` | `e3cce43855ca` | +1/−8 | [#173](https://github.com/djnsty23/claude-auto-dev/pull/173) | **LANDED** | PR #173 merged 2026-09-06 into `main`; merge commit `3d7bde98` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe adds nothing. |
| `feat/invert-the-coordinator-loop` | `8fc8b2bbcb7b` | +1/−20 | [#162](https://github.com/djnsty23/claude-auto-dev/pull/162) | **LANDED** | PR #162 merged 2026-09-05 into `main`; merge commit `47d41bf2` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe adds nothing. |
| `feat/rule-record-size` | `f9923dd1117e` | +1/−41 | [#141](https://github.com/djnsty23/claude-auto-dev/pull/141) | **LANDED** | PR #141 merged 2026-09-03 into `main`; merge commit `7890f817` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe adds nothing. |
| `feat/the-harness-i-needed` | `363201aeeba0` | +3/−19 | [#163](https://github.com/djnsty23/claude-auto-dev/pull/163) | **LANDED** | PR #163 merged 2026-09-05 into `main`; merge commit `6ce82ad0` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe adds nothing. |
| `fix/artifact-url-in-repo` | `9d8145da2f62` | +1/−23 | [#159](https://github.com/djnsty23/claude-auto-dev/pull/159) | **LANDED** | PR #159 merged 2026-09-05 into `main`; merge commit `cdf420be` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe adds nothing. |
| `fix/coordinator-guard-home-prefix` | `edde038cb33a` | +1/−16 | [#167](https://github.com/djnsty23/claude-auto-dev/pull/167) | **LANDED** | PR #167 merged 2026-09-05 into `main`; merge commit `5711ee59` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `fix/doc-staleness-structural` | `dee4ceffbcd2` | +1/−16 | [#168](https://github.com/djnsty23/claude-auto-dev/pull/168) | **LANDED** | PR #168 merged 2026-09-05 into `main`; merge commit `7f4df8d1` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `fix/draft-guard-partial-coverage` | `671852783cb6` | +3/−46 | [#137](https://github.com/djnsty23/claude-auto-dev/pull/137) | **LANDED** | PR #137 merged 2026-09-03 into `main`; merge commit `cf736817` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `fix/home-repos-portable` | `6b941a4d507b` | +1/−3 | [#176](https://github.com/djnsty23/claude-auto-dev/pull/176) | **LANDED** | PR #176 merged 2026-09-06 into `main`; merge commit `898de3ca` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe adds nothing. |
| `fix/line-level-open-outranks-section` | `6ed0ee64749b` | +1/−8 | [#172](https://github.com/djnsty23/claude-auto-dev/pull/172) | **LANDED** | PR #172 merged 2026-09-06 into `main`; merge commit `523a472e` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe adds nothing. |
| `fix/read-the-repo-not-the-inbox` | `c445bb015474` | +5/−21 | [#161](https://github.com/djnsty23/claude-auto-dev/pull/161) | **LANDED** | PR #161 merged 2026-09-05 into `main`; merge commit `d290b51c` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `fix/refetch-is-per-surface` | `d41e8c97a5f1` | +1/−22 | [#160](https://github.com/djnsty23/claude-auto-dev/pull/160) | **LANDED** | PR #160 merged 2026-09-05 into `main`; merge commit `60c71cd0` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `fix/role-advice-follows-addresses` | `445c45fee29d` | +1/−7 | [#174](https://github.com/djnsty23/claude-auto-dev/pull/174) | **LANDED** | PR #174 merged 2026-09-06 into `main`; merge commit `e0a1db75` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe adds nothing. |
| `fix/shipped-section-over-suppresses` | `cef448af224d` | +2/−13 | [#171](https://github.com/djnsty23/claude-auto-dev/pull/171) | **LANDED** | PR #171 merged 2026-09-05 into `main`; merge commit `a20db31c` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `fix/stale-mechanism-descriptions` | `0cbbf1cd9e7b` | +2/−13 | [#169](https://github.com/djnsty23/claude-auto-dev/pull/169) | **LANDED** | PR #169 merged 2026-09-05 into `main`; merge commit `2359a1c3` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe adds nothing. |
| `fix/test-validate-vs-ci-skip` | `81fd062ff2ee` | +1/−171 | [#101](https://github.com/djnsty23/claude-auto-dev/pull/101) | **LANDED** | PR #101 merged 2026-08-30 into `main`; merge commit `58401904` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `fix/workflow-skip-shapes` | `13295106c470` | +3/−43 | [#140](https://github.com/djnsty23/claude-auto-dev/pull/140) | **LANDED** | PR #140 merged 2026-09-03 into `main`; merge commit `233650b0` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe adds nothing. |
| `release/8.160.0` | `f9e22234a5eb` | +1/−24 | [#158](https://github.com/djnsty23/claude-auto-dev/pull/158) | **LANDED** | PR #158 merged 2026-09-05 into `main`; merge commit `374b7fe5` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `release/next` | `627b209cf4c4` | +2/−17 | [#165](https://github.com/djnsty23/claude-auto-dev/pull/165) | **LANDED** | PR #165 merged 2026-09-05 into `main`; merge commit `161079bf` is an ancestor of `origin/main`. `headRefOid` == branch tip, so the branch never continued past its merge. Merge probe conflicts because main evolved past it. |
| `claude/autodev-core-brain-7cb881` | `95ad11f493d7` | +12/−62 | [#130](https://github.com/djnsty23/claude-auto-dev/pull/130) closed | **STALE** | PR #130 CLOSED unmerged. All 8 files exist on main and main is ahead on every one (`stop-brain-report.js` +125/-11, `brain/SKILL.md` +758/-287); its hook landed via #147. 3/8 probe lines on main. |
| `claude/cloud-design-refinement-5a2623` | `5a6185a80062` | +13/−47 | [#148](https://github.com/djnsty23/claude-auto-dev/pull/148) closed | **STALE** | PR #148 CLOSED unmerged. Every substantive file is IDENTICAL to main (`claude-design-handoff.md`, `isolate/SKILL.md`, `check-skill-collisions.js`, `test-skill-collisions.js`) or a strict main superset (`design/SKILL.md` +7/-0). Remaining delta is VERSION/CHANGELOG release churn. |
| `claude/sad-kirch-355c74` | `2d3808b02d51` | +7/−174 | — | **STALE** | No PR. Adds `BRANCH-TRIAGE.md` + `CI-TRIAGE.md` (626 lines), absent from main and from all of main history. 0/8 probe lines on main. Both are dated snapshots: the branch triage measured 75 heads at VERSION 8.141.0 and is superseded by this document; the CI report describes a billing lock since resolved. |
| `rescue/brain-resume-20260905` | `182ecdfbaaaf` | +1/−17 | — | **STALE** | No PR. Sole delta is `RESUME.md`: branch snapshot 2026-09-05 vs main 2026-09-02. Genuinely newer content, but it names worktrees that no longer exist and lists #165 as open (merged 2026-09-05). |
| `test/brain-panels-vacuity-gaps` | `3f8101f5fee4` | +1/−266 | [#112](https://github.com/djnsty23/claude-auto-dev/pull/112) closed<br>[#51](https://github.com/djnsty23/claude-auto-dev/pull/51) <br>[#50](https://github.com/djnsty23/claude-auto-dev/pull/50)  | **STALE** | PR #112 CLOSED unmerged; older #50/#51 merged with TIP-MOVED. Sole delta is `RESUME.md`, main +25/-56. A machine-state snapshot, not code. |

## Deletion proposals

**Nothing here has been deleted.** Branch refs on `origin` are shared state; this is a
proposal for the Brain, and the two tiers below carry genuinely different risk.

### Tier 1 — 34 LANDED heads. Safe.

Every one is a merged PR (or, for `claude/prd-container-and-keeplist-tests`, content
verified present on `main`). GitHub retains the commits behind a merged PR, so the ref is
recoverable from the PR page after deletion. Deleting these is what makes the branch list
mean something: it removes 34 of the 39 misleading entries.

The SHAs are in the table above. To delete, per branch:

```bash
git push origin --delete <branch>
```

### Tier 2 — 5 STALE heads. Each one loses content.

`main` does **not** contain these. Deleting them is a decision to discard, not a cleanup,
so each is listed with what is lost.

| branch | SHA to delete | what is lost | recoverable from |
|---|---|---|---|
| `claude/autodev-core-brain-7cb881` | `95ad11f493d76de36a986bf92805cd65046c1c69` | An earlier draft of `brain/SKILL.md` and `stop-brain-report.js`; the shipped versions supersede it. | closed PR [#130](https://github.com/djnsty23/claude-auto-dev/pull/130) |
| `claude/cloud-design-refinement-5a2623` | `5a6185a80062721ef7c7cf731248b46fb0735d07` | Nothing substantive — every file is identical to `main` or a subset of it. | closed PR [#148](https://github.com/djnsty23/claude-auto-dev/pull/148) |
| `test/brain-panels-vacuity-gaps` | `3f8101f5fee45f5d6cd2548b0c42c68064f1296e` | A `RESUME.md` snapshot older than `main`'s. | closed PR [#112](https://github.com/djnsty23/claude-auto-dev/pull/112) |
| `rescue/brain-resume-20260905` | `182ecdfbaaaf2f4b57bd560fbdea8506d66b4805` | A `RESUME.md` snapshot **newer** than `main`'s (2026-09-05 vs 2026-09-02) but already expired. | **nothing — no PR** |
| `claude/sad-kirch-355c74` | `2d3808b02d511120589dfe34b5f663848fe383de` | `BRANCH-TRIAGE.md` + `CI-TRIAGE.md`, 626 lines, absent from all of `main` history. | **nothing — no PR** |

**The last two have no PR behind them.** Deleting the ref deletes the only copy on
`origin`. Recommended order: land or discard their content deliberately first, then delete.

Two specifics for that decision:

- `claude/sad-kirch-355c74` carries the only surviving copy of the 2026-08-30 CI incident
  analysis — a five-day CI outage that was a billing lock rather than a test failure, with
  91 runs that recorded as failures and were never executed. Its branch-triage half is
  superseded by this document. If the CI half is worth keeping, it belongs in `docs/` as
  its own evidence file, not on a branch.
- `rescue/brain-resume-20260905` is worth **reading before deleting** for a reason outside
  this mission's scope: `RESUME.md` on `main` was last regenerated 2026-09-02 and is five
  days stale. Neither copy is current. Flagged, not fixed here.

## What this does not settle

- Three branches are owned by a separate chip and were classified but **not touched**:
  `fix/doc-staleness-structural`, `feat/the-harness-i-needed`, `fix/read-the-repo-not-the-inbox`.
  All three are LANDED (PRs #168, #163, #161), so no action was warranted regardless.
- The 81 heads already merged into `main` by ancestry were not examined. They are safe to
  delete by the same argument, but they were never part of the misleading signal.
- This document ages the moment someone merges. It carries its measurement date for that
  reason, and the probe plus its control are written down above so the next session can
  re-run them rather than re-derive them.
