---
name: test
description: Run all tests - npm test + browser tests on latest changes
allowed-tools: Bash, Read, Grep, Glob, TaskCreate
model: sonnet
user-invocable: true
---

# Test

Run both unit tests and browser tests on latest implementations.

## Execution

### Step 1: Unit Tests
```bash
npm test  # or npm run test
```

If tests fail, report failures and stop.

### Step 2: Identify Latest Changes

```bash
# What was recently modified?
git diff --name-only HEAD~3
git log --oneline -5
```

Focus browser tests on:
- New/modified pages
- Changed components with UI
- Updated forms or flows

### Step 3: Browser Tests

For each relevant change, run agent-browser:

```bash
# Start if not running
# (User should have dev server running externally)

# Test the changed feature
agent-browser open http://localhost:3000/[path]
agent-browser snapshot -i

# Verify expected elements exist
# Check for errors in console
# Verify responsive behavior if UI change
```

### Step 4: Report

```
Test Results
════════════

Unit Tests: ✓ 47 passed, 0 failed
Browser Tests: ✓ 3 flows verified

Tested Flows:
1. /dashboard - ✓ Loads, shows data
2. /settings - ✓ Form saves correctly
3. /login - ✓ Auth flow works

Issues Found:
- None (or list issues)

Ready for: deploy / needs fixes
```

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

## When Dev Server Not Running

```
Dev server not detected on port 3000/8080.
Skipping browser tests.

Unit tests: ✓ Passed
Browser tests: ⏭ Skipped (start dev server to run)
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
