---
name: test
description: Runs unit and browser tests on latest changes. Use after implementing features or fixing bugs.
when_to_use: "Invoked when the user says \"test\", \"e2e\"."
allowed-tools: Bash, Read, Grep, Glob
model: opus
user-invocable: true
argument-hint: "[unit|browser|all]"
---

# Test

> **Browser access.** Prefer the built-in browser tools (`mcp__Claude_Browser__*`)
> when the session has them — that is the default in the desktop app. The
> `agent-browser` commands below are the terminal-only fallback. The `browser`
> skill owns the driver-selection rule; follow it before running either.

Run unit tests AND browser tests. All steps are mandatory.

## Step 1: Unit Tests

```bash
npm test  # or npm run test
```

If tests fail, report failures but CONTINUE to browser tests.

## Step 2: Identify Latest Changes

```bash
# What was recently modified?
git diff --name-only HEAD~3
git log --oneline -5
```

Focus browser tests on:
- New/modified pages
- Changed components with UI
- Updated forms or flows

If no UI changes found, STILL run Step 3 on the main page (smoke test).

## Step 3: Browser Tests

Check prerequisites first:
```bash
# 1. Is agent-browser installed?
command -v agent-browser

# 2. Is dev server running?
curl -s http://localhost:3000 > /dev/null 2>&1 || \
curl -s http://localhost:3001 > /dev/null 2>&1 || \
curl -s http://localhost:5173 > /dev/null 2>&1
```

If no dev server is running, check if a deploy URL exists:
- Check `vercel.json` or `.vercel/` for production URL
- Check git remote for Vercel/Netlify deploy
- If found, test against production URL instead

Run browser tests:
```bash
# Test the changed feature (or main page as smoke test)
agent-browser open http://localhost:3000/[path]
agent-browser snapshot -i

# Verify: no console errors, elements render, no 404s
```

If `agent-browser` is not available, report it as a gap (do not silently skip). On Windows, the daemon may fail — use `npx playwright open <url>` as a fallback for visual checks.

## Step 4: Report

```
Test Results
════════════

Unit Tests: ✓ 47 passed, 0 failed
Browser Tests: ✓ 3 flows verified

Tested Flows:
1. /dashboard - ✓ Loads, shows data
2. /settings - ✓ Form saves correctly
3. /login - ✓ Auth flow works

Console Errors: none (or list)
404s Found: none (or list)

Issues Found:
- None (or list issues)

Ready for: deploy / needs fixes
```

Do not report results after Step 1 alone. The report should include both unit and browser test results.

## Test Patterns

### Auth Flow
```bash
agent-browser open http://localhost:3000/login
agent-browser fill @email "$TEST_USER_EMAIL"
agent-browser fill @password "$TEST_USER_PASSWORD"
agent-browser click @submit
agent-browser snapshot -i  # Verify dashboard
```

### Form Submission
```bash
agent-browser open http://localhost:3000/form
agent-browser snapshot -i
agent-browser fill @name "Test"
agent-browser click @submit
agent-browser snapshot -i  # Verify success
```

### Error States
```bash
agent-browser open http://localhost:3000/page?error=true
agent-browser snapshot -i  # Verify error UI
```

## Auto-Start Dev Server

If dev server not running, start it on an available port:

```bash
# Find first available port (3000, 3001, 3002...)
find_port() {
  for port in 3000 3001 3002 3003; do
    if ! curl -s http://localhost:$port > /dev/null 2>&1; then
      echo $port
      return
    fi
  done
  echo 3000  # fallback
}

PORT=$(find_port)
echo "Starting on port $PORT"

# Start in background (no context cost)
Bash({ command: "npm run dev -- -p $PORT", run_in_background: true })

# Wait for startup
sleep 5

# Use detected port for all tests
export TEST_BASE_URL="http://localhost:$PORT"
agent-browser open http://localhost:$PORT
```

**PowerShell version:**
```powershell
$port = 3000
while ((Test-NetConnection -ComputerName localhost -Port $port -WarningAction SilentlyContinue).TcpTestSucceeded) {
  $port++
}
Write-Host "Starting on port $port"
```

Background servers don't fill context - output goes to file, only read if needed.

**Note:** OAuth flows may fail on non-3000 ports unless redirect URIs are registered. For testing auth, ensure port 3000 is free or use test accounts that bypass OAuth.

## Risk-Shaped Testing

Test effort should match risk, not code volume:

| Code Area | Test Priority | Why |
|-----------|--------------|-----|
| Auth flows (login, signup, password reset) | Critical — 100% | Security boundary, user trust |
| Billing/payment (Stripe, subscriptions) | Critical — 100% | Money, legal liability |
| RLS policies | Critical — 100% | Data access control |
| Data mutations (CRUD operations) | High — 80%+ | Data integrity |
| API routes | High — 80%+ | External contract |
| Hooks with side effects | Medium — 70%+ | Shared logic |
| Pure utility functions | Medium — 70%+ | Easy to test, high reuse |
| UI components (presentational) | Low — optional | Visual, low risk |
| Static pages | Low — optional | Rarely breaks |

### Coverage Thresholds

When coverage tooling is available:
- **Lines:** 70% minimum
- **Branches:** 60% minimum
- **Auth/billing paths:** 100% (non-negotiable)

```bash
# Check coverage
npm run test -- --coverage --watchAll=false 2>/dev/null
```

## Create Stories from Failures

If tests reveal issues, auto-create stories:

```typescript
TaskCreate({
  subject: "Fix failing test: [test name]",
  description: "Test output: [error]\nExpected: [X]\nActual: [Y]",
  metadata: { type: "fix", priority: 1, category: "qa" }
})
```
