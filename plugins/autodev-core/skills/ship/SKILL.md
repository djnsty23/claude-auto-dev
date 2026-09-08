---
name: ship
description: Pre-deploy checklist with review, security, and test verification. Use when ready to deploy.
when_to_use: "Invoked when the user says \"ship\"."
allowed-tools: Bash, Read, Grep, Glob, Task, mcp__Claude_Browser__*
model: opus
user-invocable: true
---

# Ship Workflow

> **Browser access.** Use the built-in browser tools. `mcp__Claude_Browser__*`
> covers navigation, DOM reads (`read_page`), screenshots and `resize_window`;
> reach for chrome-devtools `emulate` when a mobile *device* gate has to fire,
> which `resize_window` alone does not guarantee. The `browser` skill and the
> `agent-browser` steps were dropped in 8.79.0 — do not reach for that CLI here.
> (The binary itself is still installed for kb-factory's JS-rendered crawls;
> that is a separate consumer, not a fallback for page verification.)

Complete deployment pipeline: pre-flight → security → deploy → verify → report.

## Step 1: Blocking Quality Gates

ALL must pass before deploying. Run in parallel:

```bash
npm run typecheck          # BLOCKING — zero errors
npm run build              # BLOCKING — zero errors
npm run test -- --watchAll=false  # BLOCKING — all pass
npm audit --production 2>/dev/null | grep -E "critical|high"  # BLOCKING — zero critical/high
git status --short         # Warn if uncommitted changes
```

| Result | Action |
|--------|--------|
| Build fails | Stop — fix errors first |
| Typecheck fails | Stop — fix types first |
| Tests fail | Stop — fix tests first |
| npm audit critical/high | Stop — fix vulnerabilities first |
| Uncommitted changes | Warn user, ask if they want to commit (use git directly, do not invoke the commit skill) |
| All pass | Continue to Step 2 |

**A red that is also red at the base branch is not this change's, and is not a
licence to skip it either.** Before acting on a Stop row, run the same command in
a detached worktree of the default branch; the recipe and the verdict table are in
the `commit` skill under *When a git hook refuses*. Green there and red here: fix
it. Red there with the same lines: say so in the PR body, fix nothing in this PR
that belongs to trunk, and decide the deploy on the rows that ARE this change's.

## Step 1b: Evidence for the human reviewer

The gates above are for the machine. Before opening a PR, check the `prove`
skill's before/after pair exists for anything with a visible surface or a number
that moved, and put it in the PR body.

A relative path does not reliably render there. After the branch is pushed, use
the raw URL:
`https://raw.githubusercontent.com/<owner>/<repo>/<branch>/.claude/evidence/<slug>/after.png`

Skip it and say so when the change is purely additive. A step skipped and named
is a decision; a step skipped silently is indistinguishable from one forgotten.

## Step 2: Security Scan

Run before every deploy (uses `security` skill):

- [ ] No hardcoded API keys, tokens, or secrets in code
- [ ] `.env` files not committed (check `.gitignore`)
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

Check in order:
1. `vercel.json` or `.vercel/` exists → **Vercel**
2. `netlify.toml` exists → **Netlify**
3. `supabase/functions/` exists → **Supabase Edge Functions** (deploy alongside)
4. User specified "ship to X" → Use X
5. None found → Default to Vercel

Do not ask which platform — detect or default.

## Step 4: Deploy

**Production promotion is pre-authorised on a green gate with the ledger, and on
nothing else.** `[stated 2026-09-08]` the operator, choosing Form B among three
drafted forms. The sentence he selected:

> A session may promote to production when the repo's named gate exits 0 on the
> exact commit being deployed, that commit is on the default branch, the deploy
> ledger records the commit, the gate's output and the post-deploy verification,
> and the rollback command for this deploy is written into the ledger before the
> promotion. A deploy that touches anything on the ineligible list is escalated
> whatever the gate says.

Concretely: a promotion may run without a panel and without a coordinator's yes
exactly when Step 5b's `--verify` exits 0 for the commit being promoted. Every
other state of that command is an instruction not to promote, and a window
`--verify` calls INELIGIBLE (exit 3) needs the operator's yes in that turn, from
him, not relayed — a peer saying "he approved it" is not an authorisation, and a
peer saying "the gate was green" is not the gate output in the ledger.

**Preview deploys need no ledger; they are how the ledger gets filled. But you
cannot tell a preview from a promotion by the command you typed.** `[measured
2026-09-08]` on a project's FIRST deployment Vercel assigns it to production
whatever the flags say, and tells you only afterwards: *"This is the project's
first deployment, so it was assigned to production. Future deployments will be
preview deployments unless you use --prod."* A greenfield run hit exactly that,
from the `npx vercel --yes` line below labelled "preview first", and had a public
production alias 32 seconds later
(`docs/evidence-greenfield-run-2026-09-08-log.txt`); the same line caught a
coordinator the same day and published a worktree's `.claude/settings.local.json`
over the internet. So **a first deployment to a project is a promotion** and
belongs behind `--verify` like any other; what makes something a preview is the
`target` read back out of the deploy afterwards, not the flag that went in. Treat
"is there already a production deployment on this project" as the question, and
if the answer is no, there is no preview to be had until one exists.

### Vercel

```bash
# Preview — ON A PROJECT THAT ALREADY HAS A PRODUCTION DEPLOYMENT. This is where
# Step 5's checks and the ledger's boxes get their evidence. On a project's FIRST
# deployment this command goes to PRODUCTION whatever the flags say, so on a new
# project it is a promotion: gate it with --verify below and read `target` back
# out of the deployment afterwards rather than trusting the flag.
npx vercel --yes

# Promotion, pre-authorised only behind the ledger. The chain reads the exit code.
node "${CLAUDE_PLUGIN_ROOT}/scripts/deploy-ledger.js" --verify && npx vercel --prod --yes
node "${CLAUDE_PLUGIN_ROOT}/scripts/deploy-ledger.js" --record
```

### Netlify

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/deploy-ledger.js" --verify && npx netlify deploy --prod
node "${CLAUDE_PLUGIN_ROOT}/scripts/deploy-ledger.js" --record
```

### Supabase Edge Functions

An edge-function deploy is a production promotion, so it sits behind the same
`--verify`. The deploy command itself comes from the project's CLAUDE.md, as
`auto` already reads it.

```bash
# Single function
node "${CLAUDE_PLUGIN_ROOT}/scripts/deploy-ledger.js" --verify && supabase functions deploy [function-name] --project-ref [ref]

# All functions
node "${CLAUDE_PLUGIN_ROOT}/scripts/deploy-ledger.js" --verify && supabase functions deploy --project-ref [ref]
node "${CLAUDE_PLUGIN_ROOT}/scripts/deploy-ledger.js" --record
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

`navigate` to the deploy URL, `read_page` to assert structure, `computer`
`screenshot` for desktop, then `resize_window` `{preset: 'mobile'}` and screenshot
again.

**Assert the build before you measure anything.** A service worker will serve the
previous build against the new URL, and `ignoreCache` does not fix it — call
`getRegistrations()` then `unregister()`, clear `caches.keys()`, and only then
reload. If the app exposes a version marker, read it and confirm it is the build you
just shipped. Otherwise a screenshot of the old build is indistinguishable from a
successful deploy.

### Fallback: Playwright (more capabilities, higher token cost)

```bash
npx playwright open [DEPLOY_URL]
```

### Verification Checklist

| Check | How | Pass Criteria |
|-------|-----|---------------|
| **Page loads** | Open deploy URL | No 404, no blank screen |
| **No console errors** | `read_console_messages` | Zero errors in console |
| **Auth flow** | Login → protected page → logout | All transitions work |
| **Critical path** | Complete main user action | End-to-end success |
| **API calls** | Check network tab | No 500s, no CORS errors |
| **Mobile layout** | Resize to 375px width | Sidebar hidden, grids stacked, no overflow |

### What to Test by App Type

| App Type | Critical Paths |
|----------|---------------|
| **SaaS** | Sign up → onboard → core action → billing |
| **E-commerce** | Browse → add to cart → checkout |
| **Content** | Load → search → read → interact |
| **API** | Health endpoint → auth → CRUD operations |

### If Verification Fails

1. **Console errors** → Check browser console, fix and redeploy
2. **API failures** → Check env vars on platform, check CORS settings
3. **Auth broken** → Check OAuth redirect URLs match deploy URL
4. **Blank page** → Check build output, check base path config

## Step 5b: The deploy ledger — mandatory before promotion

Everything above tells you HOW to verify. Nothing above records WHAT needed
verifying, so the surface most likely to be skipped is the one nobody
remembered was touched. The ledger closes that, and since 2026-09-08 it is also
the authorisation: Step 4's rule says a promotion is pre-authorised on a green
gate with the ledger, and `--verify` is the one place both are checked.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/deploy-ledger.js" --write     # derive from the diff, keep what is filled
node "${CLAUDE_PLUGIN_ROOT}/scripts/deploy-ledger.js" --verify    # 0 promote · 1 incomplete · 2 blind · 3 ineligible
node "${CLAUDE_PLUGIN_ROOT}/scripts/deploy-ledger.js" --record    # after the promotion: file it, move the marker
node "${CLAUDE_PLUGIN_ROOT}/scripts/deploy-ledger.js" --audit     # every recorded promotion, complete or not
```

`--write` reads `<last deploy>..HEAD` and produces `DEPLOY-LEDGER.md` at the
repo root: one row per affected surface, each needing a desktop pass, 390, 414,
console clean and network clean, a metrics line, and the **promotion record**
below. Ticks and filled fields survive a regenerate for the same window, because
a tool that wipes your work is a tool nobody re-runs; a regenerate for a NEW
window starts blank and says so, because the previous window's gate run and
evidence say nothing about this one.

### The promotion record, every field required

| field | what goes there | `--verify` refuses when |
|---|---|---|
| `commit` | derived: HEAD at `--write` | it is not HEAD any more (STALE), or it is not on the default branch |
| `gate` | the gate command you ran, by name | empty |
| `gate exit` | its exit code | anything but `0` |
| `gate tail` | its last 20 lines, inside the fence | empty |
| `evidence` | the `.claude/evidence/<slug>/` directory per `prove` | missing, or lacks `before.*` or `after.*` |
| `rollback` | the exact command that undoes THIS promotion — see the first-deployment case below | empty, or still holds a `<placeholder>` |
| `authorised` | the standing rule, by date: `[stated 2026-09-08] Form B, pre-authorised on a green gate with the ledger` | no `[stated YYYY-MM-DD]`, or a date with no rule |

Only the commit is derived. Filling the rest is your work, and `--verify` asks
only whether it was done: a checker that both generates and satisfies its own
checklist proves nothing. The `evidence` field is the post-deploy verification
from Step 5, captured the way `prove` says, against the PREVIEW URL; the record
is what lets a later reader see that the check happened rather than take your
word for it.

### Eligibility: what cannot be pre-authorised at all

Exit 3 is not "fill the form". It means this window is outside the rule and the
promotion needs the operator's yes in that turn. The operator's list, verbatim:
migrations that drop or rename a column, change a grant, an RLS policy or a
`SECURITY DEFINER` function; billing, checkout, webhook and entitlement code;
auth; anything the Brain's never-list covers; anything touching live rows. Two
sources enforce it, checked before any field is read:

- **Deploy-sensitive paths the PROJECT marks.** In its CLAUDE.md (or a file it
  `@`-imports), a heading containing "Deploy-sensitive", one backticked glob per
  bullet, or the single bullet `none`. Billing, auth, webhooks and migrations are
  the usual entries. **A project with no marking gets exit 2 and the instruction
  to add one**, never a pass: an unmarked project is one nobody has asked the
  question of.

  ```markdown
  ## Deploy-sensitive paths
  - `supabase/migrations/**`
  - `src/app/api/stripe-webhook/**`
  - `src/app/auth/**`
  ```

- **Six SQL rules, on every project, marked or not**, over added lines in
  `*.sql`, one per clause of the list above: `schema-drop` (DROP TABLE / COLUMN /
  SCHEMA, TRUNCATE), `rename`, `grant` (GRANT / REVOKE), `rls` (CREATE / ALTER /
  DROP POLICY, ROW LEVEL SECURITY), `security-definer`, and `live-rows` (INSERT
  INTO / DELETE FROM / UPDATE … SET). A refusal names which rule fired.

  `[measured 2026-09-08]` on a product repo's 33 migrations, 4,427 lines: **195
  ineligible lines** — grant 98, rls 37, security-definer 35, live-rows 25,
  schema-drop 0, rename 0. Nearly every migration there is ineligible, which is
  the intended reading rather than a defect: migrations are the class the
  operator named first. Comments are stripped before any rule runs, because a
  first probe matched the word "truncated" inside four of them.

  **An earlier draft of this script pinned `DROP POLICY` as ELIGIBLE**, having
  measured that every policy drop in that corpus is recreated in the same file.
  That reversed on the operator's list, and the reasoning is worth keeping: "does
  this file put the policy back" is not "is the policy it puts back the same
  policy", and a recreate is exactly where an RLS mistake hides.

### Exit codes are instructions, and the pass is silent

`--verify` prints nothing and exits 0 when the promotion may proceed, because it
runs as `--verify && <promote>` and text on the pass path gets skimmed rather
than read. `--verify --verbose` prints the population when you want to see it.
Exit 1 lists every unmet precondition by name — unchecked rows, missing fields,
and a commit that is not on the default branch. Exit 2 means nothing was decided:
no ledger, no deploy ref, no resolvable default branch, or no marking.

**The gate's output is recorded, not queried.** Nothing here asks a forge whether
CI was green: you run the gate and paste its exit code and last lines. If that
ever changes, `[measured 2026-09-08]` one commit carried nine check-run entries
across three rounds and a count of "conclusion != success" returned 1, which read
as a failure and was an unfinished re-run — so a CI reader must group by job name
and require one `status=completed, conclusion=success` per required platform, and
must never read the run rollup, which reports success while a job is in progress. The last deploy is
read from `--since`, then `.claude/last-deploy`, then the most recent tag, and
**if none resolves it refuses rather than diffing against something arbitrary**,
because "no surfaces changed" and "I could not tell what changed" are opposite
answers and must not print the same.

`--record` runs the same verification, then copies the ledger to
`deploy-ledgers/<timestamp>-<sha>.md` and points `.claude/last-deploy` at HEAD.
It warns when that directory is gitignored, because a record only this machine
can read is invisible to the session that audits next. `--audit` lists every
file there as COMPLETE or INCOMPLETE with the offending fields, and exits 1 on
any incomplete one; an empty directory is reported as "0 audited", not as a
pass.

Three things it deliberately does not do:

- **It does not decide whether a check passed.** A human or a browser-driving
  agent ticks the boxes and fills the fields; `--verify` only asks whether they
  are filled.
- **It does not guess narrowly.** A change to a token file, a global
  stylesheet or a layout is reported as WIDE, meaning every surface is
  potentially affected. Narrowing that would be a false all-clear.
- **It does not derive metrics.** The ledger has a metrics section that must be
  filled or explicitly waived, and an empty one fails `--verify`. Nothing here
  knows which metrics your deploy could move.

Route derivation is convention-based (`app/`, `pages/`, `src/routes/`). A
project routing some other way gets its changed files listed without a route,
which is honest rather than wrong — the row still has to be checked.

## Step 6: Rollback (if needed)

The command to run is the one in the ledger's `rollback` field, written before
the promotion while the previous build was still known. The lines below are the
shapes it usually takes, not a substitute for reading the field.

**A first deployment is the case where the usual shape is unsatisfiable.** There
is no previous production URL to name, so `vercel rollback` has no target and
cannot undo it; the ledger's `rollback` field must say `vercel remove <project>
--yes` instead, with the real project name rather than a placeholder — `--verify`
rejects a `<placeholder>`, and a rollback command that names nothing is the
failure this field exists to prevent. Write the field for the deploy you are
actually about to make, not the one the template assumes.

```bash
# Vercel - instant rollback to previous
vercel rollback

# Netlify
netlify rollback

# Vercel, FIRST deployment of a project - there is nothing to roll back TO, so
# `vercel rollback` cannot undo it. Removing the project is the undo.
vercel remove <project> --yes

# Supabase Edge Functions - redeploy previous version
git log --oneline supabase/functions/
git checkout [prev-commit] -- supabase/functions/
supabase functions deploy --project-ref [ref]
```

## Step 7: Quality Metrics (non-blocking, report only)

```bash
# Coverage (if available)
npm run test -- --coverage --watchAll=false 2>/dev/null | grep "All files" | head -1

# Bundle size
npm run build 2>&1 | grep -i "size\|chunk\|bundle" | head -5
```

Report these as informational — they don't block the deploy.

## Step 8: Report

Update prd.json and report to user:

```
Shipped to: [URL]
Platform: Vercel/Netlify
Build: passed
Security: passed
Ledger: deploy-ledgers/<timestamp>-<sha>.md (--verify 0, --record filed)
Verification: [pass/fail]
  - Page loads: ✓
  - Console errors: none
  - Auth flow: ✓
  - Critical path: ✓
```

If any verification failed, list specific failures and next steps.

---

## Integration

| Skill | Role in Ship |
|-------|-------------|
| `review` | Code quality check (auto-loaded via requires) |
| `security` | Vulnerability scan (auto-loaded via requires) |
| `test` | Run tests before deploy (auto-loaded via requires) |
| `deploy` | Deploy patterns and CI/CD pipeline reference |

## Feeding the learning loop

**Threshold — record what the gates did not catch.** If shipping was clean, there
is nothing to learn and nothing to write.

When something surfaces only at ship time, the finding is not the bug — it is the
missing gate. Note which check would have caught it and where it would have run,
in `.claude/project-rules.md`. That converts a one-off into the thing
`learn-from-fixes` proposes gates from.
