# RESUME — needs-setup as a first-class state, 2026-09-08

Branch `claude/keen-haslett-b76054`, PR #194 against `main`. HEAD 2515cfb on origin.
This session passed 400k context after the third merge of main; a fresh session continues
from here. The evidence is `docs/evidence-needs-setup-2026-09-08.md`; the decision entry is
at the top of `docs/decisions.md`.

## Done, and how each was verified

| commit | what | verified by |
|---|---|---|
| 6298b62 | (a) `spec` setup manifest + `check-spec-output.js --spec`; (b) `prd-mark-needs-setup.js` + auto/wizard Handback; (c) "Blocked on you" in status/auto and the Stop hook; `prd-states.js` `blockers()/isReady()/ready` (a DERIVED bucket, not a sixth `passes` value) | test-prd-states 54/54 · test-prd-mark-needs-setup 58/58 · test-check-spec-output 53/53 · test-stop-auto-check 70/70 · test-skill-prd-commands 6/6 states |
| d0e2c3a | merge origin/main (#184, #191) and mirror `ready` into `hooks/fn/sprint-status.mjs` — the parity red that made all three CI platforms fail | `node tooling/test-hooks-module.js` → 108 passed, 0 failed |
| 28dab85 | merge origin/main (8.165.0, #181) | full `npm run gate` → 119/119 suites, check:suites 118 verified able to fail, 0 NOT verified, gate exit 0; CI on 28dab85 green on all three platforms (2 completed-success each, job-level) |
| cd4a9c1 + 2515cfb | merge origin/main (#198, #207); decisions.md entry re-inserted (the merge resolution had dropped it) | `awk '/^## /{if(prev!~/^$/&&prev!="")print}' docs/decisions.md` prints nothing; `npm run check:agents-md` → OK, 16 rules; CI on 2515cfb: every platform ≥1 completed-success; local seven-step gate: step 1 `npm test` exit 0 (118 suites); steps 2–7 see the exit files noted below |

Local seven-step gate at 2515cfb, each step run on its own with its exit code to a file:
`test` 0 (120/120 suites) · `check:suites` 0 (120 suites, 119 verified able to fail, 0 NOT
verified, 1 canaried elsewhere) · `check:probe-shapes` 0 (17/17) · `check:population` 0 ·
`check:entrypoints` 0 · `check:skill-tools` 0 · `check:agents-md` 0 (16 rules).

## Not done, by design

- **Not self-merged.** `~/claude-memory/MERGE-POLICY.md` keeps review for anything under
  `plugins/` that ships; this PR changes `stop-auto-check.js` (a Stop hook) and five
  skills. A review session (chip "Review PR #194 before merge") was started by the operator.
- **Client-repo backfill** is a proposal in the evidence doc (six marks, two `blockedBy`
  chains). Each names a person to confirm; it stays with the operator.
- **qr and autodev**: no `prd.json` on any ref, nothing to backfill.
- `~/.claude/brain-role.json` names a peer that is not a live session; the Stop hook says so
  every turn. Operator's to refresh (`scripts/check-brain-role.js --status`).

## Next, in order (chosen by the operator 2026-09-08)

1. Review lands or requests changes on #194; act on findings. Merge per policy: job-level
   check-runs grouped by name, ≥1 `completed`/`success` per platform, never the rollup.
2. Client repo: apply the six marks on a branch after confirming each with its person.
3. Client repo: `blockedBy` S3-010→S3-009 and S4-008→S4-004.
4. Decide whether `storiesOf()` should read a `backlog` key (greenfield run's held-back
   stories were invisible to the checker).

Never amend; commit with `git -c user.email=98432064+djnsty23@users.noreply.github.com commit -F <file>`.
