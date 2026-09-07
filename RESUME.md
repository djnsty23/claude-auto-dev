# RESUME — needs-setup as a first-class state, 2026-09-08

Branch `claude/keen-haslett-b76054`, worktree `keen-haslett-b76054`, base `origin/main`
b8eae1f. Context depth passed 300k, so this session stopped after the step below; a fresh
session continues from here.

## Done, and how each was verified

| what | verified by |
|---|---|
| `prd-states.js`: `blockers()`, `isReady()`, `summarise().ready` | `node tooling/test-prd-states.js` → 54/54 |
| `scripts/prd-mark-needs-setup.js` (mark / `--clear` / `--list`, refusals, idempotent) | `node tooling/test-prd-mark-needs-setup.js` → 58/58 (new suite) |
| `check-spec-output.js --spec SPEC.md`: External services section, `type: setup`, `blockedReason` URL, `blockedBy` resolves; fixture `tooling/fixtures/spec/oncall/` | `node tooling/test-check-spec-output.js` → 53/53 (was 21) |
| `hooks/stop-auto-check.js` names blocked-on-operator ids; needs-setup-only backlog reaches approve | `node tooling/test-stop-auto-check.js` → 70/70 |
| `status` and `auto` inline commands print "Blocked on you: N (ids)" | `node tooling/test-skill-prd-commands.js` → 6/6 states |
| skills: auto (Handback section), spec (External services + setup stories + `--spec`), wizard (mark first), core (schema rows), status | `node tooling/check-skill-tool-declarations.js` clean |
| docs: `docs/evidence-needs-setup-2026-09-08.md`, `docs/decisions.md` entry | `check-no-private-names.js` clean (Project A/B/C/D anonymised); `check-claim-provenance.js --check-message` on each → 0 unlabelled |
| `node tooling/validate.js` | 18 PASS, 1 FAIL — the FAIL (`hooks module ./fn/autodev-fn.mjs ... modules entry was not read`) reproduces on a scratch worktree of HEAD; open PRs #182/#184 address it. Not this change. |

Evidence: 36 stories pending >30d across three trunks; 6 live blocked-on-a-human, all in one
client repo (proposal in the evidence doc, no commit there); qr and autodev have no prd.json
on any ref, so nothing to backfill. Two brief premises came from checkouts 353/387 commits
behind their trunks and are corrected in the doc.

## Next, in order

1. `npm test` was started on the dirty tree (log in the session scratchpad); if this file
   is in the tree, it finished and the commit below was made after it.
2. Commit: `git -c user.email=djnsty23@users.noreply.github.com commit -F <msg>` with
   explicit paths (see the branch). Then `npm run gate` on the CLEAN tree — tens of minutes,
   three suites are load-sensitive, re-run a red serially before attributing it. CI runs the
   same gate on the PR.
3. Push, open the PR against `main` (no VERSION bump). If the PR is already open, step 2's
   local gate is the only thing left to confirm.
4. Not done, by the brief's design: applying the six Project C marks (client repo, read-only).

## Seen in passing

`check-spec-output.js` does not read a `backlog` key (the greenfield log noted it);
`storiesOf()` reads `stories` and `sprints[].stories` only. A decision, not a bug.
