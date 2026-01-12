---
name: Test / Verify
description: Run tests and verify application functionality using Playwright.
triggers:
  - test
  - verify
  - check
---

# Test Workflow

## On "test" or "verify"

### Step 1: Build Check
```
1. Run: npm run build
2. If fails: Categorize TypeScript errors
3. Attempt auto-fix for common issues
4. Report unfixable errors to user
```

### Step 2: Determine Test Type
```
question: "What should I test?"
options:
  - { label: "Full test suite", description: "Run all tests" }
  - { label: "UI walkthrough", description: "Playwright visual test" }
  - { label: "Specific feature", description: "I'll tell you what" }
  - { label: "Auth flow", description: "Login/logout/signup" }
```

### Step 3: Execute Tests

**Full test suite:**
```bash
npm test
# or
npm run test:e2e
```

**UI walkthrough (Playwright MCP):**
```
1. browser_navigate to localhost:3000
2. browser_snapshot to capture state
3. Click through main navigation
4. Check for console errors
5. Verify key elements exist
```

**Auth flow:**
```
1. Navigate to login page
2. Enter test credentials (TEST_USER_PASSWORD env var)
3. Verify redirect to dashboard
4. Check user session exists
5. Test logout
6. Verify redirect to home
```

### Step 4: Categorize Results
```
- PASS: Feature works as expected
- FAIL: Bug found, needs fix
- FLAKY: Sometimes passes, investigate
- BLOCKED: Can't test (missing dependency, etc.)
```

### Step 5: Auto-Fix Attempt

For common issues:
- Missing imports → Add import
- Type errors → Fix type
- Null checks → Add guard
- Missing env vars → Report to user

### Step 6: Report
```
"Test Results:
- Total: X tests
- Passed: Y
- Failed: Z
- Auto-fixed: N issues

Failed tests:
1. [test name]: [error]
2. ...

Unfixable (need user input):
1. [issue]: [reason]"
```

## Quick Commands

| Say | Action |
|-----|--------|
| `test auth` | Test authentication flow only |
| `test build` | Just run build check |
| `test [feature]` | Test specific feature |

## Using Test Account

**IMPORTANT:** Always use the test account for automated testing:
- Email: nvision.tester@gmail.com
- Password: `process.env.TEST_USER_PASSWORD`

**NEVER** use the admin account (andy@nvision-data.com) for automated tests.
