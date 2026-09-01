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

```bash
# Preview first (recommended)
npx vercel --yes

# If preview looks good, promote to production
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
