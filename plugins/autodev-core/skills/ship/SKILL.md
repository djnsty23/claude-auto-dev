---
name: ship
description: "Deploy, release or promote a change and prove the served version is the one that was tested: gates, security, target identity, then the live check on every entry point. Use whenever a change is about to reach staging or production, or before saying it is live."
when_to_use: "Invoked when the user says \"ship\", \"deploy\", \"release\", \"cut the release\", \"go live\", \"push to prod\", \"prod apply\", \"promote\" or \"is it live\", after a staging or preview deploy that needs its check, and before any report that says a change is deployed or live."
allowed-tools: Bash, Read, Grep, Glob, Task, mcp__Claude_Browser__*
model: opus
user-invocable: true
---

# Ship Workflow

Complete deployment pipeline: pre-flight → security → deploy → verify → report.
For UI verification, use the browser driver actually available in this host and
its exposed schema. Resolve that capability before promising a live check.

## Step 1: Blocking Quality Gates

Read the repository guidance and actual package scripts. Freeze the complete
implementation as a full `candidate_commit` SHA before running required checks.
If implementation or integration changes it, select the new candidate and repeat
the required verification. A later artifact commit is not the tested candidate.

Run the required checks with the detected package manager and test runner,
preserving every exit code and the full output. Checks that share mutable
fixtures run in order. An empty test population is not green.

A required check must have run on the exact candidate. A chained command that
failed early leaves later stages unrun: name them and run them before claiming
full verification. A grep-filtered summary is a report, not the verdict. Keep
scanner failures distinct from vulnerabilities and from a clean result.

If a check fails, compare its failure with the base in an isolated worktree. A
matching base failure establishes ownership, not release readiness. Resolve the
gate or an explicitly authorized exception before deploy, and never call the
failed check passed. Preserve any existing authority to commit or publish
instead of asking again because a new step was reached.

## Step 1b: Evidence for the human reviewer

Before opening a PR, check the `prove` skill's before/after pair exists for
anything with a visible surface or a number that moved, and put it in the PR
body, bound to the tested SHA. Linking it so it renders, and the new-behaviour
case, are in [references/live-verification.md](references/live-verification.md).

## Step 1c: The done bar

For a product with a user-facing surface, load
`${CLAUDE_PLUGIN_ROOT}/skills/ship/references/done-bar.md`. A green gate says the
product works, and working is only the floor. Ship refuses to report such a
product as done while any of the bar's six items lacks evidence on the
candidate. It may still deploy an authorized increment. The report then names
each unmet item, and each one becomes open work in `prd.json`, never a tick.

## Step 1d: The unslop sweep, on any UI change

When the change touches anything a user sees, load the `unslop` skill and run its
sweep on a local build of the candidate before deploying. Its mechanical
findings are done-bar item 3 evidence. A finding at the candidate SHA is open
work: write it to `prd.json` with `unslop-sweep.js stories`, and do not report
item 3 as met while one stands. Vision findings are advisory and block nothing.
A fix made for this step is proven by `unslop-sweep.js compare` saying COUNTS.

## Step 2: Security Scan

Run before every deploy (uses `security` skill). The gate is blocking: exit 1
stops the deploy, and exit 2 means it did not run, which is not a pass.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/security-gate.js" --root .
```

After the deploy, run it again with `--url` on the deployed host and `--api` on
each protected path, and add `--invite-only` for an app with no public sign-up.
The static pass cannot see headers a platform adds or strips. Then walk
[references/security-checklist.md](references/security-checklist.md) for what the
gate cannot decide, the auth matrix included.

## Step 3: Auto-detect Deploy Target

Honor an explicit target in the current request first. Otherwise inspect the
actual deployment records and configuration: `vercel.json` / `.vercel/`,
`netlify.toml`, and any changed `supabase/functions/`. Several targets may
coexist, so a directory alone does not choose the environment or authorize
deploying every component. Resolve an unknown target before any platform
command. The absence of config does not authorize creating one on a vendor.

## Step 4: Deploy

Apply the current request and mandate's release authority. An authorized
promotion needs no repeated permission question; another user's historical
permission grants none. Before the deployment, or a push or merge that triggers
one, record:

1. The frozen `candidate_commit` and evidence that all required checks ran on it.
   If merging changes the tested candidate, test the integration result before
   production is triggered.
2. The target's current live commit, read from the platform, saved as
   `previous_deployed_commit` and kept immutable through verification. The
   change range runs from it to the candidate; replacing it with the post-deploy
   SHA erases the change window.
3. The gate results, live verification plan and artifact paths, in the deploy
   ledger (Step 5b), generated before promotion. Ticks are assertions, not proof.
4. The authorized recovery procedure and its trigger. A first deployment has no
   previous version: establish recovery without assuming permission to delete a
   shared project or its state.

Check migrations, access grants, auth, billing and live data changes against
the mandate's exceptions. Do not manufacture permission from a green gate.

**Vercel: a first deployment goes to production whatever the flags say.** Load
[references/vercel.md](references/vercel.md) before any Vercel deploy. Before the
first deploy from a directory, `npx vercel deploy --dry --json` lists the upload
set "without uploading or creating a deployment", and the directory needs a
`.vercelignore` ([references/vercelignore.md](references/vercelignore.md)): the
CLI does not read `.gitignore`. Declare the intent, deploy, then read the target
back with `check-deploy-target.js --deployment <inspect.json> --intent preview`.
Exit 1 means it already went to production; exit 2 is unverified, never a
preview. `--target=preview` is NOT known to override the first-deployment rule.

Netlify: `npx netlify deploy --prod`. Supabase Edge Functions: deploy the
verified affected set, shared imports included, with the project's documented
command, never an unscoped blanket deploy. On every platform, confirm the env
vars are set first (commands in `references/vercel.md`).

## Step 5: Post-Deploy Verification (required, never skip)

A successful deploy does not mean the app works. Read back
`deployed_candidate_sha` and the target environment after promotion and compare
it with the frozen `candidate_commit`, kept separate from
`previous_deployed_commit`. Resolve a mismatch before claiming candidate
verification. The browser session rules and critical paths by app type are in
[references/live-verification.md](references/live-verification.md).

Tracking parity, when the change touches clickable UI: run it BEFORE the merge.
Load [references/tracking-parity.md](references/tracking-parity.md).

| Check | How | Pass Criteria |
|-------|-----|---------------|
| **Page loads** | Open deploy URL | No 404, no blank screen |
| **Every entry point** | Each custom domain, `www` and apex, alias and app-store build users reach, plus every link into a changed route (old sign-in links included) | Each serves `deployed_candidate_sha`; none serves the old route or copy |
| **No console errors** | Available driver console inspection | No new unexplained errors during the tested flow |
| **Auth flow** | Login → protected page → logout, then a RETURNING user: a session from before the deploy reloads, signs out and back in, at phone width | All transitions work, no loop, flicker or forced restart |
| **Critical path** | Complete main user action | End-to-end success |
| **API calls** | Inspect request/response and resulting state | Expected authorization, domain payload, persistence and failure behavior |
| **Mobile layout** | Test supported viewport/device sizes | Intended navigation and content usable, no unintended overflow |

If verification fails: preserve the failed evidence and stop further releases,
run the authorized recovery when its trigger is met and verify the recovered
behaviour, diagnose at the actual boundary (env, CORS and redirects are
hypotheses until the failure supports them), then fix, re-run the candidate
checks and repeat live verification. Keep the failed attempt in the ledger.

## Step 5b: The deploy ledger

The ledger enumerates what needs checking, over the range from the immutable
`previous_deployed_commit` to the frozen `candidate_commit`. Do not re-resolve
the platform SHA as the baseline: it now names the new candidate.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/deploy-ledger.js" --write --since "$previous_deployed_commit" --candidate "$candidate_commit"
node "${CLAUDE_PLUGIN_ROOT}/scripts/deploy-ledger.js" --verify --since "$previous_deployed_commit" --candidate "$candidate_commit"
```

`--write` produces `DEPLOY-LEDGER.md`. Each derived surface needs desktop, 390,
414, console and network checks. `--verify` requires every expected row exactly
once with five checked cells. Run it before calling a deploy verified, after
loading [references/deploy-ledger.md](references/deploy-ledger.md) for
regeneration, the first-deployment case and the baseline fallback.

## Step 6: Rollback (if needed)

Execute the recovery procedure recorded for this deployment. Read back the
recovered version and repeat its critical live checks. A function rollback that
needs old source runs from an isolated worktree (`references/live-verification.md`).

## Step 7: Report

Update prd.json and report to user:

```
Shipped to: [URL]
Platform: Vercel/Netlify
Build: passed
Security: passed
Verification: [pass/fail]
  - Page loads: ✓
  - Console errors: none
  - Auth flow: ✓
  - Critical path: ✓
Done bar: [met | unmet: the items by name]
```

Populate it from actual check artifacts with candidate SHA, environment and
tested scope. Distinguish deployed-but-unverified, recovered and verified. A
missing metric is unmeasured, not zero. Failed or unavailable verification
leaves the live outcome unresolved: list its evidence, owner and next action.

## Integration and learning

Load `review` for code quality, `security` for the vulnerability review, `prove`
for project tests before deploy, and the installed platform skill for its
deployment and rollback guidance.

When something surfaces only at ship time, record the reproduced failure and
why earlier evidence missed it. Load `rule-diagnosis` before proposing a gate:
first check whether an existing check was skipped, pointed at the wrong state,
or had the wrong assertion. A routine unchanged success needs no lesson.
