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

## D8. The fix's own not-on-PATH branch had the defect it was fixing

`[measured 2026-09-08, CI]` `3ccd51b`'s not-on-PATH branch matched on the shell's English
plus exit 127/9009. It was written and verified on macOS, and CI went red on BOTH
ubuntu-latest and windows-latest — the sole failing suite on either, `113/114`, with
`validate` itself printing `19 PASS, 0 FAIL, 1 WARN` on both.

| shell | status | what it says |
|---|---|---|
| macOS `/bin/sh` | 127 | `claude: command not found` |
| Ubuntu `dash` | 127 | `claude: not found` — no "command" |
| Windows `cmd.exe` | **1** | `'claude' is not recognized as an internal or external command,` |

A check written against one host's wording, failing on hosts that word it differently, is
precisely the defect this branch exists to fix, one layer down. It read as WARN either way
so it never risked a false FAIL — only the reason was wrong — but the assertion was right
and the implementation was not.

Replaced with the CLI's own first line: a `claude` that ran always prints `Validating ...`
first, and no shell authors that string. Checked AFTER the spawn, never before — returning
early on a host that might still validate something is the ordering bug that sank the
version-threshold approach, and it would have been easy to reintroduce here.

`claudeOnPath()` resolves the binary directly, but is used ONLY to word the reason, never
to decide whether to spawn, so a resolution it misses costs a less precise sentence.

Reversible: the suite now emulates all three shells, so any future narrowing goes red on a
mac instead of in CI.

## D9. A speculative false-FAIL recorded and NOT mitigated, because the obvious control kills the gate

Raised in review of #184: `SCAN_SECTION` matches `hooks|calls|skills|agents|commands`, and
the FAIL fires when any component section printed but no `hooks:` line. A CLI that scans
skills/agents/commands but has never heard of hooks MODULES would print `skills: 58`, no
`hooks:`, and take that FAIL — the exact class this branch fixes, in a narrower version
window. Plausible if `modules` arrived in 2.1.259. Unobservable here: 2.1.233 prints no
sections at all (measured), 2.1.259 prints `hooks:` (measured by the author of a84eb3e).

The suggested control — treat a missing `hooks:` as a finding only when the host printed a
`hooks:` section for some OTHER plugin in the same run — is **not** applied, and the reason
is measurable rather than a matter of taste:

    autodev-core   modules=1
    autodev-memory modules=0
    autodev-stack  no hooks.json

`[measured 2026-09-08]` autodev-core is the ONLY plugin here with a `modules` entry. If a
host prints `hooks:` only for modules, no other plugin can ever satisfy that control and
the FAIL branch becomes **permanently dead** — a gate that cannot fail, which
`rule-gate-integrity` §1 names as the worse outcome. Whether a host prints `hooks:` for
shell hooks too is exactly the unmeasured fact the mitigation would depend on. Trading a
speculative false FAIL for a certain dead gate is the wrong direction.

What is done instead, at zero behavioural risk: the FAIL message NAMES the alternative
explanation and the host version, so if it ever does fire spuriously the reader is pointed
at the right question in one line rather than editing a healthy module. A suite assertion
pins that the version appears, so the diagnostic cannot be dropped silently.

Revisit when a CLI in the 2.1.233–2.1.259 window is actually available to measure. Until
then this is a recorded risk with a named falsifier, not a fix deferred.

## D10. Third macOS-only verification miss in one session, in the control itself

`[measured 2026-09-08, CI run 34193900645]` `e3b0ea3` turned ubuntu-latest GREEN — the
shell-wording fix worked — and windows-latest still failed, on a DIFFERENT assertion:

    FAIL  control: the stub really did emit a hooks:-shaped bullet to be fooled by
          ""

The control spawned `claude.cmd` with no `shell: true`. Node cannot execute a `.cmd`
directly, so it returned empty output. `scanHooksModule`'s own comment, eleven lines
away, says exactly this: *"`claude` on PATH is a shim (a .cmd on Windows), which spawnSync
cannot run without a shell"*. The production code knew; the control written to guard it
did not.

Fixed by running the stub's JS through `process.execPath`. The control needs the stub's
OUTPUT, not its shim, and node runs the same file on every platform. Re-verified as a
real known-positive by mutation: renaming the stub's `hooks:` bullet to `author:` turns
exactly that control red.

The pattern is the point, and it is the same one three times in one session: the CI red
in D8, the shim here, and — one level up — the original defect itself. Each was written
and verified on macOS by someone who had just finished explaining why that is not enough.
A rule of thumb worth keeping: when a suite spawns anything, the spawn is the part most
likely to be platform-specific, and it is the part a green local run says least about.
