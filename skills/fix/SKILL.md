---
name: fix
description: Debugs and fixes issues systematically. Use when something is broken, throwing errors, or behaving unexpectedly.
user-invocable: true
triggers:
  - fix
  - debug
  - broken
  - error
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
model: opus
argument-hint: "[error or file]"
---

# Fix Workflow

## On "fix" or "debug"

### Step 1: Identify the Problem
```
question: "What's the issue?"
options:
  - { label: "Build error", description: "npm run build fails" }
  - { label: "Runtime error", description: "App crashes or throws" }
  - { label: "UI bug", description: "Something looks wrong" }
  - { label: "I'll describe it", description: "Custom issue" }
```

### Step 2: Gather Context

**Build error:**
```bash
npm run build 2>&1
# Capture and parse error output
```

**Runtime error:**
```bash
# Check browser console (if agent-browser available and dev server running)
agent-browser open http://localhost:3000
agent-browser errors
# Or check server logs
npm run dev 2>&1 | tail -50
```

**UI bug:**
```bash
# Take screenshot (if agent-browser available)
agent-browser open http://localhost:3000/[page]
agent-browser screenshot .claude/screenshots/bug-$(date +%s).png
agent-browser snapshot -i
```

Note: agent-browser daemon fails on Windows. Use `npx playwright open <url>` as fallback for visual checks.

### Step 3: Analyze Root Cause

Common patterns:
| Error Type | Likely Cause |
|------------|--------------|
| `Cannot find module` | Missing import or package |
| `Type 'X' is not assignable` | TypeScript mismatch |
| `undefined is not a function` | Null/undefined access |
| `Hydration mismatch` | Server/client render diff |
| `CORS error` | API endpoint config |
| `401 Unauthorized` | Auth token issue |

For library-specific errors (unfamiliar API, deprecated method, version-specific behavior), query Context7 before guessing or WebSearching:
```
mcp__plugin_context7_context7__resolve-library-id({ libraryName: "<lib>", query: "<error description>" })
mcp__plugin_context7_context7__query-docs({ libraryId: "<id>", query: "<specific error or API>" })
```
Version-pinned docs beat cached training data for libraries that move fast (Next.js, Supabase, Stripe, Trigger.dev).

### Step 4: Fix

1. Make the minimal change needed
2. Don't refactor unrelated code
3. Don't add "improvements"
4. Test the fix immediately

### Step 5: Verify
```bash
npm run build
npm run test -- --watchAll=false --passWithNoTests 2>/dev/null | tail -5
# If passes, test the specific feature
```

If build or feature test fails, return to Step 4 with updated error info. Maximum 3 fix attempts — if still failing after 3 tries, escalate to the user with a clear report of what was tried and what's still broken. Do not silently skip or defer.

### Step 5b: Regression Test

After fixing, add a test that would have caught the bug:
```bash
# If test file exists for the module, add a test case
# If no test file exists, create one for critical paths (auth, billing, data mutations)
```

For non-critical code, a manual verification is sufficient. For auth/billing/RLS, a test is mandatory.

### Step 6: Document
```
Append to .claude/decisions.md:
"## [DATE]: Fixed [issue]
- Root cause: [explanation]
- Solution: [what was changed]
- Files: [list of modified files]"
```

## Quick Fix Commands

| Say | Action |
|-----|--------|
| `fix build` | Run build, auto-fix errors |
| `fix types` | Fix TypeScript errors only |
| `fix [file]` | Focus on specific file |

## Common Auto-Fixes

**Missing import:**
```typescript
// Add at top of file
import { Thing } from './path'
```

**Null safety:**
```typescript
// Before
obj.property
// After
obj?.property
```

**Type assertion:**
```typescript
// When type is known but TS doesn't infer
(value as ExpectedType)
```

## When to Stop

Stop and ask user if:
- Fix requires architectural change
- Multiple valid approaches exist
- Fix might break other features
- Root cause is unclear after 3 attempts
