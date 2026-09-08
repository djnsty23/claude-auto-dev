# Decisions taken 2026-09-08 (deploy pre-authorisation session)

## D1 — BLOCKED on the operator: which deploy pre-authorisation sentence the harness carries

**Branch: 3, irreducible.** Production policy for a repo with ~3k users, and the
away hook's own text names "production rows" as the class that does not
self-resolve. The window was extended twice while this session ran (to 10:04Z,
then to 16:33Z, "at the beach"); the operator's one message to this session,
"Try again", was about a killed gate run, not about this question. The panel was raised anyway, because the brief asked for it and
because the options and their numbers are worth having in front of him when he is
back; its self-resolution under the window is recorded here and NOT acted on.

**The question.** Three sentences, measured in
`docs/evidence-deploy-authorisation-2026-09-08.md` against the last 20 production
deployments and every incident in 60 days:

- A. Escalate always: no session promotes; the operator promotes and runs every
  edge deploy and migration. Cost: 13 of 13 sampled deploys wait, mean 7.4 h under a
  once-a-day model; reverses his 2026-07-15 batching rule and his 2026-09-05 merge
  grant on the live product, where a merge is the deploy.
- B. Pre-authorised on a green gate, with the ledger and a rollback command written
  before promotion, and an ineligible list that escalates regardless. Prevents the
  four session-caused incidents (wrong tree, unpushed branch, skipped lock, the RLS
  migration) and the one under-deploy. ~300 lines of harness for the ledger row and
  its check. Enforcement is prose until the check runs.
- C. B plus a real-request canary and autonomous rollback. Same coverage; the canary
  is the mechanism that caused the 2026-08-19 outage (20 smoke runs, ~80 real
  generations, saves down for hours) unless read-only; ~800 lines.

**What the panel's self-resolution said, and why it is not a decision.** The hook
took the recommended option (B). The recommendation was mine, on the numbers above;
the numbers do not decide whether ~3k users warrant A's wait anyway, and that is
his. `rule-options-protocol` puts a recommendation on every panel and the brief
allowed one only where the evidence is clearly dominant; I judged it was for the
frontend path (13 autonomous deploys a day for a week, none of the five incidents
through it) and said so in the description. If he disagrees, the file to change is
the evidence doc's Step 2, not this entry.

**Not done, deliberately:** no sentence written into `brain/SKILL.md` or
`ship/SKILL.md`; no `decisions.md` entry; no VERSION bump. The PR stays open with
the three options: https://github.com/djnsty23/claude-auto-dev/pull/201. Queued with
the Brain (`autodev-update-3b29cd-d2`, per `~/.claude/brain-role.json`) by message.

**What reopens it:** his answer in a session or a panel, or a line in a file he
writes. A peer relaying "he said B" is not either of those, and D12 in the live
product's decisions file records two correct refusals of exactly that shape.

## D2 — The gate on this branch, stated exactly

`npm run gate` exit 0 at tree `d0395c8` (commit 4cbab86 on base 99bb597): 114/114
suites, 113 verified able to fail, 0 NOT verified. An earlier run on the
pre-rebase base b8eae1f was red on two suites (`test-validate`,
`test-rendered-layout-gate`), both already fixed on main by #184 and #191 and
both green on the base tree in a scratch worktree, so the rebase removed the red
without touching the file. `origin/main` is a shared ref in this clone and moved
under the branch (#195, docs-only) between that gate and the push; the pushed
commit c719ea0 carries a byte-identical diff (`git diff 4cbab86 c719ea0 -- <file>`
is empty) on base 7b157a8. The re-run on that tree ended INDETERMINATE, exit 2:
110 of 114 verified, 3 suites ETIMEDOUT while five other `check:suites` sweeps
shared a machine at load 72. That is a verdict about the load, and it is not
being reported as a pass. The commit adding this file is docs-only; it was
checked by `validate` and the private-name gate, and CI runs the gate on the PR.
