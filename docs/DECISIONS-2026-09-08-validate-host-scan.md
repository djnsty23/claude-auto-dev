# DECISIONS — 2026-09-08 — validate.js hooks-module scan

Scoped filename because another session logged an unrelated 2026-09-08 window under
the bare `DECISIONS-2026-09-08.md`; both records are real and neither supersedes the
other, so this follows the `DECISIONS-<date>-<topic>.md` precedent already in `docs/`.

Calls made inside the operator's away window (branch 2: reversible, not covered by a
standing rule). Session worktree `practical-jackson-0e4983`, base `origin/main` b8eae1f.

## D1. The premise is tested against the host's OUTPUT, not its version number

`scanHooksModule` read "validation passed, no `hooks:` line" as an unread `modules`
entry. That is sound only on a host that prints a component scan. The obvious fix — and
the one `5fa045b` took — is to compare `claude --version` against a floor. Rejected here
because it leaves the check inferring the host's BEHAVIOUR from its VERSION, which is the
same shape of error one level down.

Measured against a stub `claude`, four host shapes:

| host | `5fa045b` | this branch |
|---|---|---|
| 2.1.233, prints no scan | WARN | WARN |
| 2.1.300, prints no scan | **FAIL** | WARN |
| `--version` unparseable, no scan | **FAIL** | WARN |
| 2.1.300, prints a scan | PASS | PASS |

Rows two and three are the original defect on hosts the threshold lets through. The
threshold is also a boundary nobody measured: `docs/function-hooks/README.md` records
that 2.1.259 HAS hooks modules, not that it is the first version to, and the scan sits
behind a rollout flag that defaults to off.

Reversible: the version gate can be restored in one commit if a host is ever found where
output-shape detection is wrong and a version test is right.

## D2. The control counts components from DISK, not from the output being graded

The `skipped` reason names the skills and agents the host went unmentioned for, read from
the filesystem. A control derived from the same output it grades shrinks whenever that
output does — `rule-gate-integrity` §3, same-source canaries. This one cannot.

## D3. A second defect fixed in the same commit rather than deferred

Under `shell: true` a missing `claude` never reaches `r.error`; the shell exits 127 or
9009. The ENOENT branch was unreachable on POSIX, so the case EVERY CI run takes was
reported as "printed neither verdict". In scope because it is the same function, the same
class of error (reporting the output instead of the cause), and it was found BY the new
suite's own no-CLI case rather than looked for.

## D4. Review posted to #182 rather than held for the operator

The Brain assigned a review of `5fa045b`; the away protocol's branch 2 resolved the panel
to posting it. A PR comment is reversible and the review is measured, not opinion.
Posted: djnsty23/claude-auto-dev#182 comment 5575755930. Neither PR merged — #184 is a
draft, and merging is the Brain's call.

## D5. Nothing else touched

No `VERSION` bump, no release, no branch deleted, no push to anyone else's branch.
CLAUDE.md's stale component counts (says 43 skills / 4 agents; disk has 58 / 5) were left
alone and filed as a separate task chip rather than folded into a validate fix.

## D6. The same class of defect, found in my own fix and fixed rather than argued away

The control asks whether the host printed any component-scan section. `[measured
2026-09-07]` on 2.1.233 a warning bullet is formatted `❯ <field>: <text>` — the same
shape a scan line uses — so a `plugin.json` warning on a field literally named `hooks`
would have been read as "the host listed hooks", reporting an UNSCANNED module as a
PASS. That is the silent direction: a false FAIL blocks a push and gets looked at.

Excluded by structure (everything under a `Found N warnings:` / `Found N errors:`
header) rather than by guessing field names. Found while measuring what 2.1.233 still
catches for the #182 review, and reported to that PR in the same comment as the finding
against it, rather than kept as an advantage.

## D7. Pushed with the gate red, because the red is measured as not mine

`npm run gate` exits 1 on this machine: `test-rendered-layout-gate`, `FAIL 2 of 282`,
assertions `--json parses` and `--json groups the snapshots by page`. Attributed before
touching anything — identical `FAIL 2 of 282`, exit 1, at `origin/main` b8eae1f and at
this branch's HEAD. It is the macOS 64 KiB pipe-truncation defect that #182's other half
fixes, and it cannot go green here until that lands.

This is NOT a `--no-verify` bypass: the pre-push hook runs `validate`, which exits 0.

Consequence worth naming, because it is a gate-integrity problem in its own right:
`gate` is six steps chained with `&&`, so a pre-existing red in step 1 means steps 2-6
never run and their verdicts are silently withheld. `check:suites` was therefore run
separately, on the clean committed tree. It returned exit **2 — INDETERMINATE**, not a
pass: `test-all.js (runner canary run) did not run (ETIMEDOUT)` under fleet load, with
`Re-run when the tree is quiet`. The line that matters was still recorded:
`✓ test-validate-host-scan.js ok` — the new suite is independently verified able to
fail. It also flagged `✗ test-rendered-layout-gate.js RED — already failing`.
