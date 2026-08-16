---
name: ship
description: Pre-deploy checklist with review, security, and test verification. Use when ready to deploy.
when_to_use: "Invoked when the user says \"ship\"."
allowed-tools: Bash, Read, Grep, Glob, Task
model: opus
user-invocable: true
---

# Ship Workflow

> **Browser access.** Prefer the built-in browser tools (`mcp__Claude_Browser__*`)
> when the session has them — that is the default in the desktop app. The
> `agent-browser` commands below are the terminal-only fallback. The `browser`
> skill owns the driver-selection rule; follow it before running either.

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

### Visual Verification (agent-browser — preferred)

```bash
agent-browser open [DEPLOY_URL]
agent-browser snapshot -i
# Check mobile
agent-browser viewport 375 812
agent-browser snapshot -i
```

### Fallback: Playwright (more capabilities, higher token cost)

```bash
npx playwright open [DEPLOY_URL]
```

### Verification Checklist

| Check | How | Pass Criteria |
|-------|-----|---------------|
| **Page loads** | Open deploy URL | No 404, no blank screen |
| **No console errors** | agent-browser snapshot | Zero errors in console |
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
