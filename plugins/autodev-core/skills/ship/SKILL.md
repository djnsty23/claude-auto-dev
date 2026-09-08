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

# All functions
supabase functions deploy --project-ref [ref]
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

## Step 5b: The deploy ledger — what changed, and was each surface looked at

Everything above tells you HOW to verify. Nothing above records WHAT needed
verifying, so the surface most likely to be skipped is the one nobody
remembered was touched. The ledger closes that.

```bash
node plugins/autodev-core/scripts/deploy-ledger.js --write    # derive from the diff
node plugins/autodev-core/scripts/deploy-ledger.js --verify   # exit 1 while a box is empty
```

`--write` reads `<last deploy>..HEAD` and produces `DEPLOY-LEDGER.md` at the
repo root: one row per affected surface, each needing a desktop pass, 390, 414,
console clean and network clean. `--verify` refuses while any box is empty. Run
it before calling a deploy verified, and re-run `--write` afterwards — existing
ticks survive a regenerate, because a tool that wipes your work is a tool nobody
re-runs.

The last deploy is read from `--since`, then `.claude/last-deploy`, then the
most recent tag. **If none resolves it refuses with exit 2 rather than
diffing against something arbitrary** — "no surfaces changed" and "I could not
tell what changed" are opposite answers and must not print the same.

Three things it deliberately does not do:

- **It does not decide whether a check passed.** A human or a browser-driving
  agent ticks the boxes; `--verify` only asks whether they are ticked. A checker
  that both generates and satisfies its own checklist proves nothing.
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

```bash
# Vercel - instant rollback to previous
vercel rollback

# Netlify
netlify rollback

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
