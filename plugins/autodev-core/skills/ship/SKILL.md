---
name: ship
description: Pre-deploy checklist with review, security, and test verification. Use when ready to deploy.
when_to_use: "Invoked when the user says \"ship\"."
allowed-tools: Bash, Read, Grep, Glob, Task, mcp__Claude_Browser__*
model: opus
user-invocable: true
---

# Ship Workflow

For UI verification, use the browser driver actually available in the current
host and its exposed schema. Resolve that capability before promising a live
check; another host's historical tool names are not an available API.

Complete deployment pipeline: pre-flight → security → deploy → verify → report.

## Step 1: Blocking Quality Gates

Read the repository guidance and actual package scripts. Run its required
checks with the detected package manager and test runner, preserving every exit
code and the full output. Independent checks may run in parallel; checks that
share mutable fixtures or depend on another stage run in order. Do not add
Jest-only flags to another runner or interpret an empty test population as green.

A required check must have run on the exact candidate. A chained command that
failed early leaves later stages unrun; name those stages and execute them
before claiming full verification. A grep-filtered audit/build summary is a
report, not the command's verdict. Keep scanner/tool failures distinct from
vulnerabilities or a clean result.

If a check fails, compare its actual failure with the base in an isolated
worktree. A matching base failure establishes ownership, not release readiness.
Resolve the required gate or an explicitly authorized exception before deploy;
record the exception without calling the failed check passed. Fix owned defects
and commit them. Preserve any existing authority to commit/publish instead of
asking again merely because a new workflow step was reached.

## Step 1b: Evidence for the human reviewer

The gates above are for the machine. Before opening a PR, check the `prove`
skill's before/after pair exists for anything with a visible surface or a number
that moved, and put it in the PR body.

A relative path does not reliably render there. After the branch is pushed, use
the raw URL:
`https://raw.githubusercontent.com/<owner>/<repo>/<tested-commit-sha>/.claude/evidence/<slug>/after.png`

Bind the artifact to the tested candidate SHA and environment, and read back the
link with the reviewer's intended access. A mutable branch can later display
different evidence. For a private repository, use its supported authenticated
artifact/review link; do not publish private evidence to make a raw URL render.

For new behavior, record that no earlier implementation existed and capture the
new acceptance evidence. Additive code still needs verification through its real
entry point; a missing historical screenshot does not waive that check.

## Step 2: Security Scan

Run before every deploy (uses `security` skill):

- [ ] No hardcoded API keys, tokens, or secrets in code
- [ ] Inspect the actual staged paths and candidate commit for secret-bearing
      `.env` files and credentials, allowing only reviewed placeholder examples.
      `.gitignore` prevents new untracked additions; it does not remove a file
      that is already tracked or prove the candidate contains no secrets.
- [ ] Supabase RLS enabled on all public tables
- [ ] Input validation on all user-facing forms
- [ ] No `dangerouslySetInnerHTML` without sanitization
- [ ] Auth checks on protected routes
- [ ] Fail-closed auth (deny by default, not allow by default)
- [ ] No SSRF vectors (user URLs validated against private IPs)
- [ ] Middleware covers all /dashboard/* and /api/* routes
- [ ] HTTP security headers set (X-Frame-Options, CSP, X-Content-Type-Options)
- [ ] Rate limiting on auth endpoints

If critical issues found, fix before deploying.

## Step 3: Auto-detect Deploy Target

Honor an explicit target in the current request first. Otherwise inspect the
actual deployment records and configuration: `vercel.json` / `.vercel/`,
`netlify.toml`, and any `supabase/functions/` surface that changed. Several targets
may coexist, so directory existence alone does not choose the environment or
authorize deploying every component. If no target is known, resolve it before
invoking a platform command.

Reuse the configured/requested platform. Resolve ordinary setup within the
existing mandate; ask only if an unresolved target entails a materially different
external commitment. The absence of config does not authorize creating one on a
particular vendor.

## Step 4: Deploy

Apply the current request and mandate's release authority. An authorized ordinary
promotion does not need a repeated permission question; a historical account of
another user's permission grants none. Use Brain's current scope/exception rules.
Before the deployment, or a push/merge that triggers one, record:

1. The exact tested candidate SHA/base and evidence that all required checks ran.
   A default-branch name or a prior run on an earlier SHA cannot replace this.
   If merging changes the tested candidate, test the integration result before
   production is triggered or use the platform's supported promotion procedure.
2. Before any promotion or deploy-triggering push/merge, read the actual target
   platform/project/environment and save its current live commit as
   `previous_deployed_commit` in the deployment record. Keep this value immutable
   through verification; a tag/local marker is only a candidate baseline until
   its live meaning is checked. Plan the full change range from that saved SHA
   to the tested candidate. Replacing the baseline with the post-deploy SHA
   would erase the change window.
3. The gate command/results, live verification plan and artifact paths in the
   deploy ledger. Resolve `autodev_core_root` from the loaded plugin and generate
   the ledger using the saved `previous_deployed_commit` before promotion.
   Checklist ticks are recorded assertions, not independent proof.
4. The specific authorized recovery procedure, previous artifact/version where
   one exists, and the conditions that trigger recovery. A first deployment has
   no previous version: establish its recovery without assuming permission to
   delete a shared project or its state.

Check migrations, access grants, auth/billing/entitlements and live data changes
against the current mandate's exceptions. Resolve missing authority or an
ineligible action after preparing the reviewable result; continue independent
eligible work. Do not manufacture permission from a green gate.

Commands below are examples only after the target and installed CLI syntax are
verified. A first deployment can become production even when a command is called
preview; inspect the platform behavior before taking that step.

### Vercel

```bash
# Preview first (recommended)
npx vercel --yes

# After exact-candidate preview acceptance passes and production is authorized
npx vercel --prod --yes
```

### Netlify

```bash
npx netlify deploy --prod
```

### Supabase Edge Functions

```bash
# Single function
supabase functions deploy [function-name] --project-ref [ref]

# Multiple functions: deploy the verified affected set, including shared imports;
# use the project's documented command rather than an unscoped blanket deploy
```

### Environment Variables

Before deploying, verify env vars are set on the platform:

```bash
# Vercel
vercel env ls

# Netlify
netlify env:list

# Supabase
supabase secrets list --project-ref [ref]
```

**Missing env vars = broken deploy.** Check before shipping.

## Step 5: Post-Deploy Verification (required - never skip)

A successful deploy does not mean the app works. Verify after deploying.

### Visual verification

Use an actually available browser driver and its exposed schema to navigate,
inspect the DOM, capture desktop/mobile views and operate the affected flows.
Public and internal/admin UI both need live behavior checks with the appropriate
role, console/network inspection and resulting data/reload verification.

Read back `deployed_candidate_sha` and the target environment after promotion;
compare that SHA with the exact tested candidate. Keep it separate from the
saved `previous_deployed_commit`, which remains the ledger baseline. If the
readback differs, resolve the mismatch before claiming candidate verification.
Use a fresh isolated
verification session where appropriate. If service-worker/cache behavior is part
of the product, verify its supported update path too; deleting the user's caches
to get a passing screenshot can hide an upgrade defect. A browser window opened
for a human is not autonomous verification without an agent-controllable driver.
If the necessary driver or credential is unavailable, report that verification
as unresolved and continue checks that can actually run.

### Verification Checklist

| Check | How | Pass Criteria |
|-------|-----|---------------|
| **Page loads** | Open deploy URL | No 404, no blank screen |
| **No console errors** | Available driver console inspection | No new unexplained errors during the tested flow |
| **Auth flow** | Login → protected page → logout | All transitions work |
| **Critical path** | Complete main user action | End-to-end success |
| **API calls** | Inspect request/response and resulting state | Expected authorization, domain payload, persistence and failure behavior |
| **Mobile layout** | Test supported viewport/device sizes | Intended navigation and content usable, no unintended overflow |

### What to Test by App Type

| App Type | Critical Paths |
|----------|---------------|
| **SaaS** | Sign up → onboard → core action → billing |
| **E-commerce** | Browse → add to cart → checkout |
| **Content** | Load → search → read → interact |
| **API** | Health endpoint → auth → CRUD operations |

### If Verification Fails

1. Preserve the failed evidence and stop subsequent releases.
2. Execute the authorized recovery procedure when its trigger is met, then
   verify the recovered live behavior.
3. Reproduce and diagnose the failure at the actual boundary; env/CORS/redirect
   settings are hypotheses until the observed failure supports them.
4. Fix, re-run the required candidate checks, and repeat live verification. Keep
   the failed attempt in the ledger rather than overwriting it with a later pass.

## Step 5b: The deploy ledger — what changed, and was each surface looked at

The ledger enumerates what needs checking. Reuse `autodev_core_root` and the
immutable `previous_deployed_commit` captured before promotion in Step 4. Do not
resolve the current platform SHA again as the baseline: it now names the new
candidate. Run against the same tested candidate checkout, then read back the
ledger header and affected population to verify the saved range is still used.

```bash
node "$autodev_core_root/scripts/deploy-ledger.js" --write --since "$previous_deployed_commit"
node "$autodev_core_root/scripts/deploy-ledger.js" --verify --since "$previous_deployed_commit"
```

`--write` reads `<last deploy>..HEAD` and produces `DEPLOY-LEDGER.md` at the
repo root: one row per affected surface, each needing a desktop pass, 390, 414,
console clean and network clean. `--verify` checks empty boxes only in rows
still present in the written ledger; it does not prove expected rows were kept.
Independently inventory affected flows from the actual changed files and product
contract, reconcile every required surface against the ledger, and add omitted
checks before relying on its verdict. A deleted row can otherwise disappear from
verification entirely. Run
it before calling a deploy verified. Existing ticks survive regeneration, so
bind each result to its tested SHA/environment and invalidate stale checks when
code or the base changes. The tool does not perform that evidence binding for
you. Re-read the written ledger; preserved ticks alone are not a fresh test.

For a verified first deployment there is no prior deployed commit. Treat the
entire candidate as the affected surface inventory; the current ledger CLI
requires a commit baseline and cannot derive that first-release case from an
empty tree. Record that tool limitation and perform the complete first-release
acceptance checks; do not invent a deployed SHA or use HEAD to make it pass.

The CLI falls back from `--since` to `.claude/last-deploy`, then the most recent
tag. This workflow supplies the saved verified baseline explicitly; fallback
resolution is not evidence that a marker/tag was actually deployed. **If none resolves it refuses with exit 2 rather than
diffing against something arbitrary** — "no surfaces changed" and "I could not
tell what changed" are opposite answers and must not print the same.

Three things it deliberately does not do:

- **It does not decide whether a check passed.** A human or a browser-driving
  agent ticks the boxes; `--verify` only asks whether they are ticked. A checker
  that both generates and satisfies its own checklist proves nothing.
- **Its WIDE detection is incomplete.** It tests only files selected by its UI
  extension filter. A changed `tailwind.config.js` can report one changed file
  but zero UI files and zero WIDE effects. Independently inspect shared config,
  tokens, data and layout dependencies; a zero detector count is not proof
  that no user-facing behavior changed.
- **It does not derive metrics.** The ledger has a metrics section that must be
  filled or explicitly waived, and an empty one fails `--verify`. Nothing here
  knows which metrics your deploy could move.

Route derivation is convention-based (`app/`, `pages/`, `src/routes/`). A
project routing some other way gets its changed files listed without a route,
which is honest rather than wrong — the row still has to be checked.

## Step 6: Rollback (if needed)

Execute the recovery procedure recorded for this deployment and platform. Read
back the recovered version and repeat its critical live checks. For a function
rollback needing old source, create an isolated worktree at the verified previous
commit and deploy only the intended affected functions from there. Do not check
old files into a worker's active checkout or overwrite its uncommitted changes.

## Step 7: Quality Metrics (non-blocking, report only)

Report metrics from the completed check artifacts with the measured population,
commit and conditions. Run additional metrics only when they answer a relevant
question, using the actual runner and preserved exit status. A missing metric is
unmeasured, not zero; a subjective score is not a completion condition.

## Step 8: Report

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
```

Populate the report from actual check artifacts with candidate SHA, environment
and tested scope. Distinguish deployed-but-unverified, recovered and verified
outcomes. Failed or unavailable verification leaves the promised live outcome
unresolved; list its evidence, owner and next action.

---

## Integration

| Skill | Role in Ship |
|-------|-------------|
| `review` | Explicitly load for code quality review |
| `security` | Explicitly load for the applicable vulnerability review |
| `test` | Explicitly load for project tests before deploy |
| Platform skill actually installed | Load its current deployment/rollback guidance |

## Feeding the learning loop

Record a lesson when the release exposes a gap or establishes a useful new
contract, verification method or recovery result. A routine unchanged success
needs no separate learning entry; a clean release can still provide new evidence.

When something surfaces only at ship time, record the reproduced failure and
why earlier evidence missed it. Load `rule-diagnosis` before proposing a gate:
first check whether an existing check was skipped, pointed at the wrong state,
or had the wrong assertion. Add machinery only when the demonstrated class
warrants it, and preserve the evidence in the project's durable decision record.
