---
name: Ship
description: Build, deploy, and verify the application.
triggers:
  - ship
---

# Ship Workflow

## Step 1: Pre-flight Checks
```bash
npm run build              # Must pass
git status --short         # Warn if dirty
```

If build fails: STOP, fix errors first.

## Step 1.5: Security Check (REQUIRED)

Run security scan before deploy:
- Secrets scan (no hardcoded keys)
- .env files not committed
- RLS enabled on all tables
- Input validation present

If critical issues: **STOP** - fix before deploying.

## Step 2: Auto-detect Target

**Check in order:**
1. `vercel.json` exists → Vercel
2. `netlify.toml` exists → Netlify
3. User specified "ship to X" → Use X
4. None found → Default to Vercel

**NEVER ask which platform** - detect or default.

## Step 3: Deploy

**Vercel:**
```bash
npx vercel --prod
```

**Netlify:**
```bash
npx netlify deploy --prod
```

## Step 4: Post-deploy Verify

```bash
# Detect port or use deployment URL
agent-browser open [URL]
agent-browser snapshot -i
# Check: page loads, no console errors
```

## Step 5: Log Result

```
Append to progress.txt:
"[DATE]: Shipped to [URL] - [pass/fail]"
```

## Rollback

```bash
# Vercel
vercel rollback

# Netlify
netlify rollback
```
