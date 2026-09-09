# Deploy pre-authorisation: the evidence, and three sentences to choose between

`[measured 2026-09-08]` read-only, on the three product repos this operator runs
(the live product at ~3k MAU, the no-users product, the personal product), on the
Vercel account (`vercel ls`, `vercel inspect`) and on the live product's Supabase
Management API (function list only). Window: 60 days, 2026-07-10 to 2026-09-08.
Nothing was deployed, promoted, rolled back or typed into a credential field.

**This document makes no decision.** The Brain capability analysis listed this
sixth of six because it is a decision, not a tool: *"Write the deploy
pre-authorisation down in one sentence either way."* The operator's away window
was active while this was written (until 2026-09-08T06:52Z, scope "the no-users
product and autodev only"), and production policy is the irreducible class in that
window's own text, so the panel raised at the end of this session is logged as
BLOCKED on the operator and the pull request stays open with the three options.

## The gap, stated precisely

`ship` can deploy to Vercel, Netlify and Supabase, verify after deploy, keep a
deploy ledger and roll back. `auto` says, after a commit: deploy changed edge
functions, run `supabase db push` for migrations, push to trigger the Vercel build.
The Brain's standing rule escalates *"money, production mutations, deletions of
shared state, client work, and anything irreversible and outward-facing"*. On
2026-09-05 the operator said pushes and merges to his own repos need no approval.
So a production deploy is autonomous by tooling and escalated by policy, and the
two have never been reconciled in one sentence.

One fact reframes the question before any sentence is drafted: **on the live
product, a merge to main IS a production deploy.** Vercel's git integration builds
production from every push to main. The 2026-09-05 merge grant therefore already
pre-authorised the frontend deploy, whether or not anyone said the word.

## Step 1: how deploys happen today

### 1a. What deploys production, per repo

| | live product | no-users product | personal product |
|---|---|---|---|
| frontend | Vercel git integration, push to main, `ignoreCommand` skips docs-only pushes | Vercel git integration, push to main (live since 2026-08-27; a CLI path before that) | `npm run deploy -- <session>`: machine-wide lock, preflight, `vercel deploy --prod`, polls the site for its own version label |
| backend | 101 Supabase edge functions, deployed ONLY by a hand-run `npx supabase functions deploy` (its CLAUDE.md: *"nothing automates this deploy, not Vercel, not a workflow"*) | none (Next.js routes ship with the frontend) | none beyond the frontend build |
| migrations | `supabase db push` or Management API by hand; the ledger drifted (22 applied-out-of-band migrations measured 2026-08-22) | Management API by hand; no Supabase CLI on this machine | Supabase migrations by hand (5 files, none in the window) |
| gate before a production build | Test Gate on PRs, 5.5 min median; `gate:ci` is 27 steps, local `gate` adds a Playwright suite (~8 min); Release Gate `disabled_manually` since 2026-08-21 | `gate.yml` on PR and push to main, 1.9 min, one step = `npm run gate` | preflight, 4.3 min, on PR and push; `npm run deploy` refuses to ship on a red preflight |
| who triggers, in the sample | a merge made by a session or the Brain (20 of 20, below) | a merge or a direct push by a session | a session, batched into release waves by the operator's 2026-07-15 rule |

### 1b. Counts, each with its command

Run from each repo against `origin/main` after `git fetch origin`.

| count | live | no-users | personal | command |
|---|---|---|---|---|
| commits, 60 days | 1,144 | 213 | 6,457 (app state is committed as JSON) | `git log origin/main --since='60 days ago' --oneline \| wc -l` |
| first-parent commits on main (each is a Vercel build candidate) | 785 | 179 | 3,649 | `git log origin/main --since='60 days ago' --first-parent --oneline \| wc -l` |
| PR-shaped merges among those | 200 | 9 | 127 | first-parent subjects ending `(#N)` or starting `Merge pull request` |
| direct pushes to main | 585 | 170 | — | first-parent minus PR-shaped |
| commits whose message names "deploy" | 231 | 46 | 275 | `git log origin/main --since='60 days ago' -i --grep=deploy --oneline \| wc -l` |
| release commits (`chore(release)`) | — | — | **384** | `git log origin/main --since='60 days ago' -i --grep='chore(release)' --oneline \| wc -l` |
| commits naming rollback, revert, outage, hotfix or incident | 220 | 25 | 77 | `git log origin/main --since='60 days ago' -i -E --grep='rollback\|roll back\|revert\|outage\|hotfix\|incident' --oneline \| wc -l` |
| `Revert`-prefixed commits | 19 | 1 | 13 | `git log origin/main --since='60 days ago' -E --grep='^[Rr]evert' --oneline \| wc -l` |
| commits whose body contains `vercel rollback` | **0** | **0** | **0** | `git log origin/main --since='60 days ago' --format=%B \| grep -c 'vercel rollback'` |
| commits whose body contains `--no-verify` | 10 | 0 | 3 | `git log origin/main --since='60 days ago' -i --grep='--no-verify' --oneline \| wc -l` |
| PRs created in the window / merged | 276 / 258 | — | — | `gh pr list --state all --search 'created:>=2026-07-10'` |
| PRs whose title or body names rollback, revert, outage, hotfix or incident | 96 | — | — | same list, regex over title and body |

**The "deploy" grep is noise, and the numbers above it are the ones that
matter.** 231 of 1,144 live-product commits mention "deploy" because the word
appears in bodies ("NOT DEPLOYED", "needs `supabase functions deploy`", "a deploy
would have reverted it"). Not one of them is a commit that performed a production
deploy; on this repo the deploy is the merge, and the merge is the first-parent
commit. Every `--no-verify` mention on the live product is either the
`--no-verify-jwt` flag on the edge deploy command (which is unrelated) or a
2026-08-20 note about a pre-commit hook that failed with MODULE_NOT_FOUND on every
branch except the one that added it. The three on the personal product are commits
that ADD commit-time gates. **Zero production deploys were pushed past a red gate
with a bypass flag in any of the three repos** — and see 1d, because "no bypass"
is not the same as "gated".

**No `vercel rollback` has ever been run from a commit in any repo**, and the
Vercel CLI here (59.1.3) has both `vercel rollback` and `vercel promote`, so the
capability exists and has an empty history. The 19 `Revert` commits on the live
product were read: they are forward reverts of code (a revert of a CI deploy-wait
step on 2026-08-02, a revert of a wrong rail fix on the personal product twice on
2026-08-19 and 2026-08-22, a session restoring a deploy script it had overwritten).
Rollback here has always meant "a new commit", never "re-alias the previous build".

### 1c. The sample of 20, live product, joined to the commit that caused each

`vercel ls --prod` lists the last 20 production deployments; `vercel inspect` gives
each one's creation time and status. Each was joined to the nearest first-parent
commit on `origin/main` within 15 minutes. **All 20 joined, and 20 of 20 are git
integration builds fired by a PR merge: the build was created 3 to 6 seconds after
the merge commit.** The Vercel "creator" column says the same username for all 20
and cannot distinguish a git build from a CLI one; the join can.

| build created (UTC) | status | cause | merge |
|---|---|---|---|
| 09-07 08:36 | Ready | git, PR merge, +4s | docs(resume) handoff (two builds, same commit) |
| 09-06 09:06 | Ready | git, PR merge, +4s | fix(generation) page-exit (#687) |
| 09-05 15:49 | Ready | git, PR merge, +5s | docs(seo) dry run |
| 09-05 15:36 | Canceled | git, PR merge, +4s | docs(decisions) standing push authorisation (#684) |
| 09-05 15:27 | Canceled | git, PR merge, +4s | docs re-apply D9-D11 (#682) |
| 09-05 15:14 | Ready | git, PR merge, +4s | fix(perf) CLS refuted |
| 09-05 14:41 | Ready | git, PR merge, +5s | fix(cron) heartbeats (#677) |
| 09-05 14:32 | Ready | git, PR merge, +4s | fix(email) recovery mail (#681) |
| 09-05 13:42 | Ready | git, PR merge, +4s | fix(generation) bound the save stage (two builds) |
| 09-05 13:34 | Canceled | git, PR merge, +4s | docs(resume) |
| 09-05 13:33 | Canceled | git, PR merge, +4s | docs(stripe) webhook outage closed (#678) |
| 09-05 09:53 | Canceled | git, PR merge, +4s | docs duplicate references (#674) |
| 09-05 07:32 | Ready | git, PR merge, +4s | fix(spotify) count issued requests (#675) (two builds) |
| 09-05 06:25 | Ready + Canceled | git, PR merge, +6s | fix(spotify) fan-out bound (#672) |
| 09-04 20:43 | Ready | git, PR merge, +4s | test(edge) rate-limit boundary (#670) |
| 09-04 20:11 | Canceled | git, PR merge, +4s | fix(types) regenerate |

13 Ready, 7 Canceled. The cancellations are `vercel.json`'s `ignoreCommand` refusing
docs-only pushes, which only runs inside a git-integration build, so the
cancellations are themselves proof of the source. Every Ready build took 6 to 7
minutes of build CPU.

**Classification of the 20:** human command 0, autonomous CLI deploy 0, git
integration firing on a merge a session or the Brain made 20. Git cannot say which
of the two made each merge: the Brain skill's own section "AN ACTOR FIELD DOES NOT
DISTINGUISH THE OPERATOR FROM A SESSION" applies, and every author in the window
is the operator's GitHub account. What CAN be said: the Brain holds merge
authority on the operator's repos since 2026-09-05 (D12 in the live repo's
decisions file, transcribing *"same as before, and treat [the live product] as
standing"*), and 13 first-parent commits a day is not a human clicking merge.

**Edge functions, the other production surface, are deployed by CLI and the
evidence says by sessions.** The Management API lists 101 functions with only
five distinct `updated_at` minutes: 78 functions from one bulk deploy at
2026-09-02T21:46Z, then 1, 2, 15 and 5 on 09-04 and 09-05. The version counters
run to 570 on the most-deployed function. Three PR bodies place a session at the
keyboard: #491 (a webhook deployed at v98 *"from a tree missing"* the fix, which
*"lost a race with a deploy at 08:01"*), #541 (a branch *"live in production and
had never been pushed"*, recoverable only from one machine), #658 (all 101
functions carrying the 09-02 timestamp while #654 had merged on 09-03, so *"the
campaign banner has advertised an auto-applied discount that checkout does not
apply, on the payment path, for over a day"*).

### 1d. Incidents in the window, each read

"Incident" here means a production defect with a user-facing or money-facing
consequence, found by reading the 96 matching PR bodies and the commit list rather
than counting them. Deploy-caused means the deploy mechanism, not the code, was the
proximate cause.

| date | repo | what happened | deploy-caused? | gate at the time |
|---|---|---|---|---|
| 08-16 | live | AI provider key outage; a secret was updated and a real generation succeeded 4 s later, before any redeploy | no (credential) | n/a |
| 08-19 | live | **Curator benched 10.5 h** by an uncapped `Retry-After` (#441). The Release Gate's smoke suite ran 20 times between 09:04 and 11:18 on a merge burst, ~80 real generations, exhausted the per-app rate limit and *"took every playlist save down for hours"* | **partly: the post-deploy real-request check was the amplifier** | Release Gate green on each run; Test Gate green |
| 08-19 to 08-21 | live | **Stripe webhook rejected every delivery for ~2 days**; one live purchase paid, delivered and never recorded (#491). The fix was committed at 06:27 and *"lost a race with a deploy at 08:01"* from a tree that lacked it; deployed function was v98 | **yes: a CLI deploy from the wrong tree** | tests green on both trees; Test Gate disabled that day (billing) |
| 08-21 | live | Saves dead 6 h behind a single curator with a 5.7 h penalty (#470) | no (upstream) | — |
| 08-21 to 08-29 | live | Test Gate `disabled_manually` after the Actions budget ran out (3,148 min across 23 days against a 3,000 allowance). **216 first-parent commits reached main, and production, with no CI gate at all** | not an incident by itself; a window with no gate | none |
| 08-23 | live | **Production was AHEAD of main**: an entitlement fix deployed from a branch that was never pushed (#541). *"A deploy from main would have reverted a live entitlement fix"* | **yes: a CLI deploy from an unpushed branch** | green on both sides; the union failed one test |
| 08-25 | live | `origin/main`'s own layout-regression gate was red (6 failures) while merges continued to deploy (#567) | no; a red gate that did not block | local gate red, CI not running it |
| 08-28 | live | `npm run gate` red on an unchanged tree because a generated header carried the platform's PostgREST version; three sessions went looking for a schema change that did not exist | no; a false red | red |
| 08-31 onward | live | Edge Mutation Sweep red with 16 survivors in rate limiting, token signing and the Stripe webhook, and unread until 09-04 (#661); deploys continued | no; a red gate nobody reads | red |
| 09-01 to 09-03 | live | The only database backup failed three nights (#655); merged fix *"does nothing until it deploys"* | no (code), but the fix's PR had to say out loud that merge ≠ deploy | green |
| 09-03 to 09-04 | live | **Merged edge function never deployed for over a day** (#654 / #658); the discount banner promised what checkout did not apply, on the payment path. The drift monitor built for this was silent for two independent reasons | **yes, in the other direction: an UNDER-deploy** | green |
| 09-04 | live | Saves down from 13:15Z, an upstream lockout; the session's own recommended fix would have reverted a considered cap and reproduced the 10.5 h outage, and it refused it (D1, 09-05) | no | green |
| 08-02 | personal | Two sessions deployed around the advisory lock in one day: duplicate version labels from one baseline, and *"a failed merge shipped conflict markers to production"* (header of `scripts/deploy.js`) | **yes: a session skipped the lock and the gate** | preflight existed; skipped |
| 08-22 | personal | CI failed to START for 28 h (billing block); 48 commits merged during it, three on auth paths, each red X reading like a test failure | no gate for 28 h | none |
| 08-28 | no-users | **Seven migrations on main and unapplied**; every code creation would fail against the live schema. The session marked it BLOCKING and escalated rather than applying (commit 85dcde5). Applied 2026-09-01 by a session via the Management API | an escalation, correctly | 1.9 min gate green |
| 08-29 | no-users | #4 merged before review; an ordinary EU checkout could poison the webhook endpoint for 3 days, and a goodwill refund revoked Pro (#5, URGENT) | no; a merge without review | green (gate existed but did not run on PRs until 08-29, D35) |
| 09-01 | no-users | **Cross-account analytics leak for ~3 h**: migration 0029 made a wrapper `SECURITY DEFINER`, which silently removed the RLS filter. Found from a screenshot. Both Management-API probes lied in opposite directions. The mitigation *"broke production for a minute"* | **yes: a migration applied by a session, same morning** | green; no test could see it |

Totals: **five deploy-caused incidents in 60 days**, four of them on a CLI path a
session ran by hand (wrong tree, unpushed branch, skipped lock, a migration), and
one an under-deploy. **Zero came through the git-integration path in the 20-sample
or in the read PR bodies.** Three further items are red gates that did not stop
anything, and two are windows with no gate.

### 1e. What a gate says before a deploy today

**The live product's `qa:release-gate`** is `qa:monitor && qa:smoke && test:live &&
check:migration-ledger`: a critical-error monitor over the last 30 minutes of
production, a Playwright smoke suite that performs four REAL generations against
production (1,175 lines), the live test suite, and a migration-ledger check. It has
never run on this machine in the window. Its CI form, `release-gate.yml`, ran on
every push to main from 2026-08-02, measured 5 to 6 minutes when the smoke suite
ran and 0.5 minutes when debounced, and has been `disabled_manually` since
2026-08-21T13:12Z, its last run a failure. Its workflow references 23 secrets of
which 10 were already missing when the rest were deleted from CI on 2026-08-28. So
the only gate that observes production after a deploy is off, and CLAUDE.md there
says reviving it is not worth its blast radius until it is needed.

**`gate:ci`** is 27 steps: dependency, mock-specifier, visibility, colour, link,
label, prompt, coverage, refund-latch, analytics, live-test-placement, phantom
column, SQL forward-ref, filter-test, campaign-wiring and secret checks; typecheck
(three tsconfigs); lint; unit tests; edge tests; edge parse and type checks; a
types-drift gate; cron-logging, view-invoker, absolute-path and vacuous-token
checks. Test Gate runs it on PRs in 5.5 minutes median (last 20 runs: 19 success,
1 skipped). It is entirely static and local: it reads no production surface.

**The no-users product's `gate`** is typecheck, lint, a slop check, tests, build, a
prerender check and an SEO snapshot, 1.9 minutes in CI (last 10: 8 success, 1
failure, 1 cancelled). **The personal product's preflight** is 4.3 minutes and is
also the deploy script's step 3 of 7, so a red preflight cannot be deployed through
the one command; the 08-02 incident is the day two sessions went around the
command.

**Has a production deploy happened with the gate red?** Not through a bypass flag.
It has happened with the gate ABSENT (216 commits over 8 days on the live product,
48 over 28 hours on the personal product), with the gate red and not blocking
(08-25, 08-31 onward), and with a false red that cost three sessions a day
(08-28).

### 1f. The cost side, because every sentence below moves it

**Waiting.** If only the operator promoted, and did so once per active day at the
end of that day, the wait per first-parent commit on the live product would be a
mean of 7.4 hours, median 6.0, 90th percentile 20.5, across 53 promotions instead of
785 pushes. On the no-users product: mean 7.0 hours, median 4.8, p90 21.1, across
11 promotions instead of 179. `[inferred]` The model assumes he promotes at the
last push of each active day; git cannot show when he is at the keyboard, so this
is the cheapest defensible shape, not a measurement of him.

**Build CPU.** The personal product already batches: 384 releases against 3,649
first-parent commits and 127 PR merges, under a rule the operator set on
2026-07-15 because *"build CPU is most of the Vercel bill"*. The live product does
not: 13 of 20 sampled pushes built, at 6 to 7 minutes each. Extrapolated over 785
first-parent commits at 65% built, `[inferred]` roughly 55 build-hours in 60 days.

**Under-deploys.** The 09-03 discount incident is the cost of a deploy that needs
a human: it waited over a day for a command nobody ran, on the payment path.

## Step 2: the sentence, three ways

Each form is stated, then run against the 20-sample and the incident table, then
placed: where it lives, who may invoke it, what makes a deploy ineligible whatever
the form says, and what an after-the-fact check over the ledger would assert.

### Form A: escalate always

> **No session promotes to production. A session may build a preview; only the
> operator promotes it, and only the operator runs an edge-function deploy or
> applies a migration.**

**On the sample.** All 20 sampled deployments were merges to a branch the platform
promotes on push, so A cannot be adopted by writing the sentence: it needs a
production branch that is not main (or the git integration turned off) on the live
and no-users products, and the Brain's 2026-09-05 merge grant would deploy nothing
until the operator advanced that branch. The 13 Ready builds would have waited a
mean of 7.4 hours each under the once-a-day model, 53 promotions in 60 days.

**On the incidents.** Prevents #491, #541, the 08-02 lock skip and the 0029 leak,
because no session deploys. Does nothing for the 08-19 smoke burst (a CI gate, not
a session), and makes the 09-03 under-deploy the normal state: every edge-function
merge waits for the operator, and the discount would still have advertised what
checkout did not apply until he ran the command. On the personal product it
reverses a rule he set himself on 2026-07-15 and that sessions have followed 384
times in 60 days.

**Where it lives.** `brain/SKILL.md`, "Never, regardless of who asks", one bullet;
and `ship/SKILL.md` Step 4 replaces `npx vercel --prod` with preview only. Nothing
repo-specific, so nothing goes to the machine-local rules directory.

**Who may invoke.** The operator, in his own session or a panel answer. Not a
session, not the Brain, not a relay.

**Ineligible regardless.** Everything: that is the form.

**After the fact.** A check over the platform's deployment list asserts that no
production deployment was created by a CLI token a session holds, and that the
production branch received only the operator's pushes. On the live product the
Vercel listing cannot distinguish creators (1c), so the check needs the git
integration pointed at a branch only he writes to, or it asserts nothing.

### Form B: pre-authorised on a green gate

> **A session may promote to production when the repo's named gate exits 0 on the
> exact commit being deployed, that commit is on the default branch, the deploy
> ledger records the commit, the gate's output and the post-deploy verification,
> and the rollback command for this deploy is written into the ledger before the
> promotion. A deploy that touches anything on the ineligible list is escalated
> whatever the gate says.**

**On the sample.** All 13 Ready builds were PR merges that Test Gate passed, on
main, so all 13 are eligible. None of the 20 has a ledger row, because the ledger
has never been used in any product repo (0 mentions in 60 days of history in all
three). B makes the sample legal and, today, unrecorded.

**On the incidents.** #491: the deployed commit was not the tree on main → not
eligible → escalated or refused, prevented. #541: an unpushed branch → not on the
default branch → prevented. 08-02 lock skip: no ledger row, no gate output →
prevented if the rule is enforced, and the personal product's own history says a
prose rule was skipped twice in one day until the lock moved into the command.
0029 leak: a migration that changes a security-definer or RLS surface is on the
ineligible list → escalated → prevented. #5 webhook: billing code → ineligible →
escalated. 09-03 under-deploy: the merge of #654 would have carried its edge
deploy, prevented. 08-19 smoke burst: unchanged, it is a CI gate on push. The
216-commit no-gate window: a local `npm run gate` run and recorded satisfies "the
named gate exits 0", so B still deploys through a CI outage, with the output in the
ledger where the outage is visible.

**Where it lives.** The sentence in `brain/SKILL.md` "Escalate rather than
resolve", beside the 2026-09-05 push grant it extends; the mechanism in
`ship/SKILL.md` Step 4, which today says "if preview looks good, promote". The
ineligible list is portable and lives with the sentence. Any per-repo gate name or
project reference goes to the machine-local rules directory, per CLAUDE.md's
public-repo test.

**Who may invoke.** A session on a repo the operator owns, and the Brain when it
merges to a branch the platform promotes. Not on client repos. Not by relay: a
peer saying "the gate was green" is not the gate output in the ledger.

**Ineligible regardless.** Migrations that drop or rename a column, change a grant,
an RLS policy or a `SECURITY DEFINER` (0029 is the measured instance); billing,
checkout, webhook and entitlement code (#5, #491); auth (the personal product's 48
commits on auth paths during its CI outage); anything the Brain's never-list
covers: money, deletion of shared state, credentials, client work. A change that
touches live rows, which is the operator's own line on 2026-09-05: *"A UI change is
fine; anything touching live rows is not."*

**After the fact.** A check over the ledger asserts, for each production
deployment the platform lists (Vercel deployments, Supabase function versions and
`updated_at`), that a ledger row exists whose commit is an ancestor of the default
branch, whose gate exit code is 0 with the output attached, whose verification
section is filled, and whose rollback command was written before the promotion
timestamp. A platform deployment with no row is the violation, and the 09-02 bulk
edge deploy of 78 functions would have been the first one it found.

### Form C: pre-authorised with a canary

> **As B, and after promotion the session runs the repo's real-request check
> against production within a bounded window; if it fails, the session executes
> the rollback command already in the ledger, without asking, and escalates the
> failure.**

**On the sample.** As B for eligibility. The real-request check on the live
product is the smoke suite: four real generations per run. At 13 first-parent
pushes a day, a canary per deploy is the 2026-08-19 burst (20 runs in two hours,
~80 generations, every save down for hours) as a daily steady state. The debounce
that now exists (`should-run-smoke.mjs`, 30-minute minimum) was written because of
that, so C's canary on this repo is either read-only or it is the incident.

**On the incidents.** As B, plus: #491 is not caught, because a Stripe webhook
cannot be canaried without a real payment. The 08-19 outage is reproduced by the
mechanism unless the check is read-only. Autonomous rollback carries its own
measured hazard: the Release Gate's own comment records a false red from a lazy
chunk 404 while Vercel swapped assets mid-run, and D1 on 2026-09-05 records a
session whose recommended fix would have reverted a correct cap; a rollback that
fires on a false red is a good deploy undone, and a migration has no `vercel
rollback` at all (the 0029 mitigation *"broke production for a minute"* on its own).

**What it costs to build, in lines.** What `ship` has: `deploy-ledger.js`, 274
lines, a surface checklist that derives rows from the diff and refuses to tick
them; prose for `vercel rollback` and a three-command edge rollback (checkout the
previous commit, redeploy). What it does not have: a canary runner (the live
product's is 1,175 lines and specific to it; a portable one that hits the ledger's
listed surfaces and asserts status and a version marker is `[inferred]` ~200
lines), a rollback executor with the bounded window and the two platform shapes
(~150 lines), a ledger check for B (~150 lines), and suites for all three
(~300 lines). Roughly 800 lines of new harness plus a per-repo canary definition,
against 0 lines for A and ~300 for B (the ledger row format and its check).

**Where it lives, who may invoke, ineligible.** As B. The canary definition is
per repo and goes to the machine-local rules directory or the repo itself.

**After the fact.** As B, plus: each ledger row carries the canary result and, on
a failure, the rollback timestamp and the deployment it re-aliased. The check
asserts a failed canary is followed by a rollback within the window, and that no
rollback happened without a failed canary before it.

### Side by side

| | A: escalate always | B: green gate + ledger | C: B + canary + auto-rollback |
|---|---|---|---|
| sampled deploys that would have waited | 13 of 13 (mean 7.4 h) | 0 | 0 |
| deploy-caused incidents prevented (of 5) | 4 | 4, given the ineligible list holds | 4 |
| the under-deploy (09-03) | made permanent | prevented | prevented |
| the 08-19 real-request burst | unchanged | unchanged | reproduced unless read-only |
| reverses an operator rule | 2026-07-15 (personal batching), 2026-09-05 (merges) | none; extends 2026-09-05 | none |
| new harness code | 0 | ~300 lines | ~800 lines + per-repo canaries |
| enforcement is | structural (branch he alone writes) | a ledger check; prose until it runs | a ledger check plus a rollback with its own false-red risk |
| ledger usage today | — | 0 uses in 60 days, all repos | 0 |

**What the evidence does and does not decide.** It says that the fleet has been
deploying the live product's frontend autonomously about 13 times a day since the
merge grant, that none of the five deploy-caused incidents came through that path,
and that all four session-caused ones came through a hand-run CLI path with no
record of the tree, the branch, the lock or the gate. B is the sentence that
describes what already happens and adds the record that would have caught those
four. A is the sentence that stops it, at a measured 7.4-hour mean wait and against
two of the operator's own rules. C is B plus the one component with a measured
outage to its name. Whether the live product's ~3k users warrant A's wait anyway is
his call, not a number's, which is why the panel carries all three and the
recommendation label on B states this paragraph as its reason.

## Step 3: what this session did, and what is blocked

- Wrote this document and opened a PR against main with the three sentences and
  their numbers.
- Raised one panel with the three forms. The away window was active; the panel
  hook self-resolves panels in that window, and production policy is the
  irreducible class in the hook's own text, so a self-resolution is NOT the
  operator's decision. Logged as BLOCKED on the operator in
  `docs/DECISIONS-2026-09-08-deploy-authorisation.md`. Not written into
  `brain/SKILL.md` or `ship/SKILL.md`. No `decisions.md` entry until he answers.
- When he answers, the chosen sentence goes into the place Step 2 names for it,
  tagged `[stated <date>]` with his words, in a second commit on the same branch,
  and `decisions.md` gets the entry.

Re-verify before acting on any number here: the tip of every repo moved while this
was written, and the Vercel listing is the last 20, not the window.
