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

Read the repository guidance and actual package scripts. Freeze the complete
implementation as a full `candidate_commit` SHA before running required checks.
If implementation or integration changes it, select the new candidate and repeat
the required verification. Keep this value through evidence archival; a later
artifact commit is not automatically the tested or deployed candidate.

Run the required checks with the detected package manager and test runner, preserving every exit
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

1. The frozen `candidate_commit` SHA/base and evidence that all required checks ran.
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
   deploy ledger. Resolve the scripts through `${CLAUDE_PLUGIN_ROOT}` and generate
   the ledger with `--since "$previous_deployed_commit" --candidate "$candidate_commit"`
   before promotion.
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

**`vercel --yes` IS NOT RELIABLY A PREVIEW.** On a project's *first* deployment
Vercel assigns it to production regardless of flags, and says so only after the
fact:

> "This is the project's first deployment, so it was assigned to production.
> Future deployments will be preview deployments unless you use `--prod`."

`[measured 2026-09-08]` this line of this skill was hit twice in one day — by a
greenfield run on a throwaway project, and by the fleet coordinator by accident,
which created a public production alias for a repo worktree. No pre-check can
prevent it: whether a project has ever deployed is a fact about Vercel's account
state, not about the tree or the flags. So **declare the intent, deploy, then
read the target back.**

**Before the first deploy from any directory**, check what would be uploaded.
The Vercel CLI **does not read `.gitignore`** — see the `.vercelignore` section
below:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-deploy-target.js" --ignore-file .
```

`--dry` shows the real answer rather than a pattern floor. It "inspects the
detected framework preset and source files **without uploading or creating a
deployment**", and in non-TTY output lists every file it would send:

```bash
npx vercel deploy --dry --json      # no upload, no deployment — read the file list
```

Read that list before the first deploy from an unfamiliar directory. The floor
check above is cheap and CLI-free; this one is what the CLI would actually do.

Then deploy and verify the target that came back:

```bash
# Preview INTENDED. --target=preview states it; see the caveat below.
npx vercel deploy --target=preview --yes

# Read the target back from the deploy itself. Exits 1 if it went to production.
npx vercel inspect <deployment-url> --json > /tmp/deploy.json
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-deploy-target.js" \
  --deployment /tmp/deploy.json --intent preview

# Only after the preview is verified, promote deliberately
npx vercel --prod --yes
npx vercel inspect <deployment-url> --json > /tmp/deploy.json
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-deploy-target.js" \
  --deployment /tmp/deploy.json --intent production
```

⚠️ **`--target=preview` is NOT known to override the first-deployment rule.**
Vercel's own message — *"Future deployments will be preview deployments unless
you use `--prod`"* — implies the first one is production whatever you pass. It is
unverified here **deliberately**: the only way to test it is to make a first
deployment, which is the production side effect this whole section exists to
prevent. State the intent with the flag, and let the readback settle it.

| Exit | Meaning | Action |
|---|---|---|
| 0 | target matches the declared intent | Continue |
| 1 | **it already went to production** | Stop. Undo, then tell the user what was exposed |
| 2 | the target could not be read | Treat as unverified. **Never as a preview** |

**If it exits 1 on `--intent preview`, the deploy has already happened.** Undo by
which case it is — `vercel ls` says whether any earlier production deployment
exists:

- **First deployment of a new project** — `vercel remove <project> --yes`.
  `vercel rollback` cannot help here; there is nothing behind it to roll back to.
- **A project that already had production traffic** — `vercel rollback`.

Then check what was uploaded, which is the *separate* defect below, and report
both to the user. A production deploy nobody intended is not undone by removing
it: whatever was served was public while it was up.

### `.vercelignore` — the Vercel CLI does not read `.gitignore`

Independent of the target defect, and the one that turns a harmless mis-deploy
into a disclosure.

`[measured 2026-09-08]` on the accidental deploy above, **423 tracked files and
16 gitignored files were uploaded** — `.claude/settings.local.json`,
`.claude/memory-sessions/*`, `.claude/reports/telemetry-*.jsonl`. With no
framework detected Vercel set the output directory to `.` and **served the tree
statically**:

```
curl /.claude/settings.local.json  ->  HTTP 200     publicly fetchable
curl /                             ->  HTTP 404
```

That instance was low-value — a public repo, no secret-shaped strings in the
uploaded set. The mechanism does not know that. The same command from a product
worktree uploads whatever that repo gitignores.

**Every directory you deploy from needs a `.vercelignore`** covering at minimum
`.claude/`, `.git/`, `node_modules/` and `.env`, plus everything that repo's
`.gitignore` names. `check-deploy-target.js --ignore-file` refuses without one,
and refuses an empty one — the file existing is not the protection, the patterns
in it are.

**`.vercelignore` is not `.gitignore` again.** `.gitignore` decides what is
*tracked*; `.vercelignore` decides what is *uploaded and served*. A file can be
tracked and still be one you would never serve, so matching `.gitignore` is a
**floor, not the rule**. Where a repo names narrow paths because partial tracking
is deliberate, the deploy manifest still takes the wide pattern: over-excluding
costs a missing asset, under-excluding costs a public URL. This repo's own
`.vercelignore` is the worked example.

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
compare that SHA with the frozen `candidate_commit`. Keep it separate from the
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

The ledger enumerates what needs checking. Reuse `${CLAUDE_PLUGIN_ROOT}` and the
immutable `previous_deployed_commit` captured before promotion in Step 4. Do not
resolve the current platform SHA again as the baseline: it now names the new
candidate. Reuse the frozen `candidate_commit` from Step1 as the other end of
that range. The checkout may now contain a later evidence commit; read back the
ledger header and population to verify the explicit candidate is still used.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/deploy-ledger.js" --write --since "$previous_deployed_commit" --candidate "$candidate_commit"
node "${CLAUDE_PLUGIN_ROOT}/scripts/deploy-ledger.js" --verify --since "$previous_deployed_commit" --candidate "$candidate_commit"
```

`--write` records the resolved base and candidate commits and produces
`DEPLOY-LEDGER.md` at the repo root. Each derived surface needs desktop, 390,
414, console and network checks. `--verify` requires every expected row exactly
once, matching changed-file details and five checked cells; it rejects missing,
malformed or stale commit-window records. Run it before calling a deploy verified.

Regeneration preserves checks and metrics only for the same resolved base and
candidate. Changing either commit or loading an older ledger without that
provenance resets them. Without `--candidate`, the CLI uses current HEAD and
still rejects evidence from an earlier candidate. An explicit older candidate
verifies only that historical record, never the newer checkout or deployment.
Commit/archive the evidence separately from a production trigger. If a later
commit is actually promoted, it is a new candidate requiring its own checks and
live readback; do not reuse historical verification to claim that commit passed.

This binds recorded assertions to a commit window, not to the actual
browser, deployed environment or business outcome. Keep those artifacts and
readbacks separately. Independently inventory affected flows from the product
contract and add checks the file/route heuristics cannot derive. Unsupported
Markdown/control characters in a surface path produce an explicit tool gap,
not a checked surface or permission to rename the user's files.

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

- **It does not execute verification.** A human or a browser-driving agent
  records the result. Row/commit validation cannot prove that a browser flow
  ran or its business outcome passed.
- **Its WIDE detection is heuristic.** Known config, token and layout names are
  considered across UI, JavaScript/TypeScript and JSON files, including
  `tailwind.config.js`. Other shared dependencies may still be omitted.
  Independently inspect them; a zero detector count does not prove that no
  user-facing behavior changed.
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
