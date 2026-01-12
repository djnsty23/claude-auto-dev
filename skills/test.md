---
name: Test / Verify
description: Comprehensive testing with test generation, Playwright MCP, and coverage tracking.
triggers:
  - test
  - verify
  - check
  - e2e
  - playwright
---

# Test Workflow

## Test Philosophy

Tests are generated from THREE sources (3-Pass System):
1. **Story-based:** From acceptanceCriteria and testSpec
2. **Code-based:** From analyzing implementation files
3. **Integration-based:** From cross-story dependencies

---

## Story Schema with Testing

Every story should have a `testSpec` field:

```json
{
  "id": "S1",
  "title": "User Login",
  "description": "Users can log in with email/password",
  "priority": 1,
  "passes": true,
  "completedAt": "2024-01-15T10:00:00Z",
  "testedAt": null,
  "files": ["src/app/auth/login/page.tsx", "src/app/api/auth/login/route.ts"],
  "acceptanceCriteria": [
    "User can enter email and password",
    "Valid credentials redirect to dashboard",
    "Invalid credentials show error message"
  ],
  "testSpec": {
    "preconditions": [
      "Dev server running on localhost:3000",
      "Test user exists in database"
    ],
    "happyPath": [
      {
        "name": "Successful login",
        "steps": [
          "Navigate to /auth/login",
          "Enter nvision.tester@gmail.com",
          "Enter valid password",
          "Click Login button"
        ],
        "expected": "Redirect to /dashboard, user session created"
      }
    ],
    "errorCases": [
      {
        "name": "Invalid password",
        "steps": ["Enter valid email", "Enter wrong password", "Click Login"],
        "expected": "Error message: Invalid credentials"
      },
      {
        "name": "Empty fields",
        "steps": ["Click Login with empty form"],
        "expected": "Validation error messages"
      }
    ],
    "edgeCases": [
      {
        "name": "SQL injection attempt",
        "input": "'; DROP TABLE users; --",
        "expected": "Rejected, no database impact"
      },
      {
        "name": "XSS in email field",
        "input": "<script>alert('xss')</script>",
        "expected": "Sanitized, no script execution"
      }
    ],
    "networkChecks": [
      { "endpoint": "/api/auth/login", "method": "POST", "expectedStatus": 200 }
    ],
    "consoleChecks": {
      "noErrors": true,
      "noWarnings": false
    }
  },
  "testResults": null
}
```

---

## Test Generation (3-Pass System)

### On "test" or "test generate"

#### Pass 1: Story-Based Tests
```
For each story with passes: true AND testedAt: null:
  1. Read acceptanceCriteria
  2. Read existing testSpec (if any)
  3. Generate test cases for each criterion:
     - Happy path: How to verify it works
     - Error case: How it should fail gracefully
     - Edge case: Boundary conditions
```

#### Pass 2: Code-Based Tests
```
For each file in story.files:
  1. Analyze the code:
     - API routes: Check all response codes
     - Forms: Check all validation rules
     - Components: Check all props/states
     - Database: Check all queries

  2. Generate additional test cases:
     - Null/undefined handling
     - Empty arrays/objects
     - Type boundaries (max int, long strings)
     - Auth/permission checks
```

#### Pass 3: Integration Tests
```
For stories with dependencies:
  1. Identify cross-story flows
  2. Generate integration tests:
     - S1 (login) + S2 (dashboard) = "Logged in user sees dashboard"
     - S3 (create item) + S4 (list items) = "Created item appears in list"
```

---

## Test Execution Flow

### Full Test Suite

```
1. PRE-FLIGHT
   ├── Verify build passes: npm run build
   ├── Check dev server: curl localhost:3000
   └── Verify test user exists

2. COLLECT TESTS
   ├── Load all stories from prd.json
   ├── Filter: passes === true
   ├── Sort by: testedAt (null first), then priority
   └── Generate test matrix

3. EXECUTE (per story)
   │
   ├── PRECONDITIONS
   │   └── Verify all preconditions met
   │
   ├── HAPPY PATH (run first)
   │   ├── Execute each step
   │   ├── Capture network requests
   │   ├── Capture console logs
   │   ├── Take snapshot
   │   └── Verify expected outcome
   │
   ├── ERROR CASES
   │   └── Same flow, expect failures handled gracefully
   │
   ├── EDGE CASES
   │   └── Same flow, test boundaries
   │
   └── RECORD RESULTS
       ├── Update story.testedAt
       ├── Update story.testResults
       └── Log to progress.txt

4. REPORT
   └── Generate test report (see format below)
```

---

## Playwright MCP Commands Reference

### Navigation & State
```javascript
browser_navigate({ url: "http://localhost:3000/path" })
browser_snapshot()  // Capture accessibility tree
browser_take_screenshot({ filename: "step-1.png" })
```

### Interaction
```javascript
browser_click({ element: "Login button", ref: "[ref-from-snapshot]" })
browser_type({ element: "Email input", ref: "[ref]", text: "test@example.com" })
browser_fill_form({ fields: [
  { name: "email", type: "textbox", ref: "[ref]", value: "test@test.com" },
  { name: "password", type: "textbox", ref: "[ref]", value: "password" }
]})
browser_select_option({ element: "Country", ref: "[ref]", values: ["US"] })
```

### Monitoring
```javascript
browser_network_requests({ includeStatic: false })
browser_console_messages({ level: "error" })
```

### Waiting
```javascript
browser_wait_for({ text: "Dashboard" })      // Wait for text to appear
browser_wait_for({ textGone: "Loading..." }) // Wait for text to disappear
browser_wait_for({ time: 2 })                // Wait 2 seconds
```

---

## Test Story Format (Output)

Each test generates a Test Story:

```markdown
## Test Story: S1 - User Login
**Date:** 2024-01-15T14:30:00Z
**Duration:** 12.5s
**Status:** PASS | FAIL | PARTIAL

### Preconditions
- [x] Dev server running
- [x] Test user exists

### Happy Path: Successful Login
| Step | Action | Result | Time |
|------|--------|--------|------|
| 1 | Navigate to /auth/login | Page loaded | 0.5s |
| 2 | Enter email | Field populated | 0.1s |
| 3 | Enter password | Field populated | 0.1s |
| 4 | Click Login | Redirect to /dashboard | 1.2s |
**Result:** PASS

### Error Case: Invalid Password
| Step | Action | Result | Time |
|------|--------|--------|------|
| 1 | Enter valid email | OK | 0.1s |
| 2 | Enter wrong password | OK | 0.1s |
| 3 | Click Login | Error displayed | 0.8s |
**Result:** PASS (error handled correctly)

### Edge Case: SQL Injection
| Input | Result |
|-------|--------|
| `'; DROP TABLE users; --` | Rejected by validation |
**Result:** PASS (no injection possible)

### Network Activity
| Endpoint | Method | Status | Time |
|----------|--------|--------|------|
| /api/auth/login | POST | 200 | 145ms |
| /api/user/me | GET | 200 | 89ms |

### Console
- Errors: 0
- Warnings: 1 (React dev mode warning - OK)

### Verdict
All 4 test cases passed. Story S1 fully tested.
```

---

## Test Commands

| Say | Action |
|-----|--------|
| `test` | Test all untested stories |
| `test all` | Test ALL stories (including already tested) |
| `test S1` | Test specific story |
| `test auth` | Test all auth-related stories |
| `test generate` | Generate testSpec for stories without them |
| `test generate S1` | Generate testSpec for specific story |
| `test report` | Show last test results |

---

## Incremental Testing

For efficiency, tests track what's been tested:

```json
{
  "testedAt": "2024-01-15T10:00:00Z",
  "testResults": {
    "total": 12,
    "passed": 11,
    "failed": 1,
    "duration": "45.2s",
    "failedTests": [
      {
        "name": "Edge case: Long email",
        "error": "Input truncated at 255 chars",
        "severity": "low"
      }
    ]
  }
}
```

### When to Re-Test
- `testedAt` is null → Never tested
- Story files modified after `testedAt` → Code changed
- Dependencies changed → Related story updated
- `test all` command → Force full re-test

---

## Test Suites (Cross-Story Tests)

For complex flows spanning multiple stories:

```json
{
  "testSuites": [
    {
      "id": "TS1",
      "name": "Full User Journey",
      "stories": ["S1", "S2", "S5", "S8"],
      "flow": [
        { "story": "S1", "action": "Login" },
        { "story": "S2", "action": "View dashboard" },
        { "story": "S5", "action": "Create item" },
        { "story": "S8", "action": "Logout" }
      ],
      "testedAt": null
    }
  ]
}
```

---

## Auto-Generation Rules

When generating testSpec automatically:

### From Accept Criteria
```
"User can enter email and password"
→ happyPath: Fill form with valid data
→ errorCase: Empty fields, invalid format
→ edgeCase: Max length, special characters
```

### From Code Analysis
```javascript
// API route with validation
if (!email.includes('@')) throw new Error('Invalid email')
→ errorCase: Test email without @

// Database query
await db.users.findUnique({ where: { email } })
→ edgeCase: Email not found, duplicate email
```

### From Component Props
```typescript
interface Props {
  maxLength?: number;  // → edgeCase: Test at maxLength
  required?: boolean;  // → errorCase: Test empty when required
  disabled?: boolean;  // → edgeCase: Test interaction when disabled
}
```

---

## Test Account

**CRITICAL:** Always use:
- **Email:** nvision.tester@gmail.com
- **Password:** `${TEST_USER_PASSWORD}` env var

**NEVER** use andy@nvision-data.com for automated tests.

---

## Performance Optimization

### Parallel Execution
```
Independent tests can run in parallel:
- S1 tests + S5 tests (no dependency)
- NOT: S1 + S2 if S2 requires login from S1
```

### Smart Ordering
```
1. Smoke tests (critical paths) - 30 seconds
2. Feature tests (story-specific) - 2-3 minutes
3. Edge cases (boundaries) - 1-2 minutes
4. Integration tests (cross-story) - 2-3 minutes
```

### Caching
```
- Cache authentication state
- Reuse logged-in session across tests
- Only re-login when auth tests fail
```

---

## Integration with prd.json

### On Story Completion (in build.md)
```
When marking story passes: true:
1. Generate testSpec from acceptanceCriteria
2. Analyze files for additional test cases
3. Add testSpec to story
4. Set testedAt: null (needs testing)
```

### On Test Failure
```
1. If auto-fixable:
   - Fix immediately
   - Re-run failed test
   - Log to progress.txt

2. If needs new story:
   - Create bug story in prd.json
   - Link to original story
   - Set high priority
```

---

## Example: Full Test Run

```
User: "test"

Claude:
1. Loading prd.json... Found 15 stories (12 passed, 3 in progress)
2. Filtering untested... 4 stories need testing

Testing S1: User Login
├── Preconditions: ✓ All met
├── Happy path: ✓ Login successful
├── Error cases: ✓ 3/3 passed
├── Edge cases: ✓ 2/2 passed
├── Network: ✓ All 200s
└── Console: ✓ No errors
Result: PASS (8/8 tests)

Testing S2: Dashboard
├── Preconditions: ✓ Logged in from S1
├── Happy path: ✓ Dashboard loads
├── Error cases: ✓ 2/2 passed
└── Network: ✓ API calls successful
Result: PASS (5/5 tests)

...

## Test Report
- Stories tested: 4
- Total tests: 24
- Passed: 23
- Failed: 1
- Duration: 1m 42s

Failed:
- S3/Edge case: Long title truncation
  Expected: Error message
  Actual: Truncated silently
  → Created story S16 to fix
```
