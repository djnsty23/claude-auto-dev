# DECISIONS — 2026-09-08 — mutation-count reconciliation

Operator AWAY (window to 2026-09-08T06:52:24Z, scope: qr and autodev only).
Both decisions below resolved under branch 2 of the away protocol — reversible
and not covered by a standing rule — and are logged here rather than queued.

## D1 — Corrected "Never three" on main. (branch 2: reversible)

`docs/DECISIONS-2026-09-07-landed-check-rescue.md` stated that the mutation
count in 60a5eaf's commit message "does not survive measurement" and concluded
"Never three." A guarded three-way re-measurement disproves the universal:

| mutant | brain-brief.js change | result |
|---|---|---|
| clean | — | 177 passed, 0 failed |
| full revert of the hunk | all original prose restored | 173 passed, **4 failed** |
| half-applied | cherry line added alongside the tool | 176 passed, **1 failed** |
| the author's actual mutant | cherry line back AND primitive sentence removed | 174 passed, **3 failed** |

Guard: the subject had to differ from `HEAD` or the run was discarded. Subject
restored byte-identical afterwards, confirmed by an empty `git status` and a
177/0 re-run.

All three counts are real. Three is what the author's mutant yields, and it is
neither of the two the rescuing session tried: the empty-PR-search assertion
stays green because that prose was left intact, so three fail rather than four.

**The commit message's defect was its DESCRIPTION, not its number.** It said
"reinstating the cherry line", which alone is the half-applied row and yields
one. A reader re-measuring from that sentence gets 1 or 4, matches neither, and
reasonably concludes the count was invented.

The generalisable form, which is the reason this was worth a commit rather than
a reply: **a mutation result is reproducible only if the MUTANT is stated, not
just the score.** "N assertions went red" describes an experiment nobody else
can run. Two sessions measured honestly here and got different true numbers
because only the score crossed between them.

Reversible: one doc, no code, and it lands as a DRAFT PR the Brain merges.

## D2 — Took no new work. (branch 2, erring toward stopping)

The Brain named two unowned items — the `./fn/autodev-fn.mjs` validate failure
and chip `task_c7c801f2` — and asked that anyone confirm with it before
starting. `SendMessage` is not available in this session (verified: ToolSearch
returns no match), so confirmation is impossible and both are owned-adjacent.
Starting either risks colliding with a live session in a shared clone.

## Measured this session, for whoever picks those up

- **Trunk gate at b8eae1f: GATE_EXIT=1, 110/113.** Failures: `test-rendered-layout-gate`,
  `test-validate`, `validate`. Exactly three, run serially — `test-hook-execution-evidence`,
  `test-path-filter-deadlock` and `test-quota-tripwire` all PASSED here, independently
  corroborating that their reds under load are contention rather than defects.
- **`validate`'s `fn/autodev-fn.mjs` failure is host-shaped.** `validate.js:435`
  fails when `claude plugin validate` prints no `hooks:` scan line. This host's
  claude 2.1.233 prints only "Validating plugin manifest / ✔ Validation passed"
  — no component scan at all — so the check reports the repo's hooks module as
  broken while measuring the host CLI's output format. CI never sees it: CI does
  not install `claude`, so the check returns `skipped`. The check therefore has
  three behaviours by host — pass, skip, fail — and only one is about the repo.
- **The background-task summary reports a redirect's status, not the command's.**
  Three gate runs this session were announced as "exit code 0" while the real
  status was 1. CLAUDE.md documents this for `| tail`; it also arrives through
  the task-notification layer, which CLAUDE.md does not mention. Write the exit
  code to a FILE and read it back; do not trust the summary line.
