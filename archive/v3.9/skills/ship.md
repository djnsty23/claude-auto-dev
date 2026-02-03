---
name: Ship / Deploy
description: Build, deploy, and verify the application.
triggers:
  - ship
  - deploy
  - publish
---

# Ship Workflow

## On "ship" or "deploy"

### Step 1: Pre-flight Checks
```
1. Run: npm run build (or project's build command)
2. If build fails: STOP, report errors
3. Check for uncommitted changes: git status
4. If dirty: Ask user to commit or stash
```

### Step 2: Determine Deployment Target
```
question: "Where should I deploy?"
options:
  - { label: "Vercel", description: "Recommended for Next.js" }
  - { label: "Netlify", description: "Static sites, serverless" }
  - { label: "Custom", description: "I'll provide the command" }
```

### Step 3: Deploy

**Vercel:**
```bash
npx vercel --prod
```

**Netlify:**
```bash
npx netlify deploy --prod
```

**Custom:**
Ask user for deployment command.

### Step 4: Verify
```
1. Get deployment URL from output
2. Use Playwright MCP to open URL
3. Check: page loads, no console errors
4. Report: "Deployed to [URL]. Verified: [status]"
```

### Step 5: Update Progress
```
Append to progress.txt:
"## [DATE]: Shipped
- Deployed to [URL]
- Build: success
- Verification: [pass/fail]"
```

## Quick Ship (No Prompts)

If user says "ship to vercel" or "deploy to netlify":
- Skip the target question
- Run the appropriate command directly

## Rollback

If user says "rollback":
```
1. Check deployment platform
2. Vercel: vercel rollback
3. Netlify: netlify deploy --prod --alias previous
4. Report rollback status
```
