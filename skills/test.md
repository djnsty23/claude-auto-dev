---
name: Test / Verify
description: Comprehensive testing using Playwright MCP with network/console monitoring.
triggers:
  - test
  - verify
  - check
  - e2e
  - playwright
---

# Test Workflow

## On "test" or "verify"

### Step 1: Pre-Flight Checks
```bash
# 1. Verify build passes
npm run build

# 2. Check dev server is running
# If not, use start-server script or notify user
```

### Step 2: Determine Test Scope
```
question: "What should I test?"
options:
  - { label: "Full E2E suite", description: "All user flows" }
  - { label: "Auth flow", description: "Login/logout/signup" }
  - { label: "Specific feature", description: "I'll describe it" }
  - { label: "Regression", description: "Test recent changes" }
```

---

## Playwright MCP Testing Protocol

### Test Story Format

Every test generates a **Test Story** with this structure:

```markdown
## Test Story: [Feature Name]
**Date:** [timestamp]
**URL:** [tested URL]
**Status:** PASS | FAIL | PARTIAL

### Actions Performed
1. [Action]: [Result]
2. [Action]: [Result]
...

### Network Activity
| Request | Method | Status | Time |
|---------|--------|--------|------|
| /api/... | GET | 200 | 45ms |

### Console Logs
| Level | Message |
|-------|---------|
| error | [message] |
| warn | [message] |

### Screenshots
- [step]: [filename or description]

### Verdict
[Summary of what passed/failed and why]
```

---

## Core Testing Flows

### 1. Navigation Test
```
Actions:
1. browser_navigate({ url: "http://localhost:3000" })
2. browser_snapshot() → Capture initial state
3. browser_network_requests() → Check for failed requests
4. browser_console_messages({ level: "error" }) → Check for errors

Pass Criteria:
- Page loads without errors
- No failed network requests
- No console errors
- Key elements visible in snapshot
```

### 2. Authentication Flow
```
Actions:
1. browser_navigate({ url: "http://localhost:3000/auth/login" })
2. browser_snapshot() → Verify login form exists
3. browser_fill_form({
     fields: [
       { name: "email", type: "textbox", ref: "[email-input-ref]", value: "nvision.tester@gmail.com" },
       { name: "password", type: "textbox", ref: "[password-input-ref]", value: "${TEST_USER_PASSWORD}" }
     ]
   })
4. browser_click({ element: "Login button", ref: "[submit-ref]" })
5. browser_wait_for({ text: "Dashboard" }) OR browser_wait_for({ time: 3 })
6. browser_snapshot() → Verify dashboard loaded
7. browser_network_requests() → Check auth API calls
8. browser_console_messages() → Check for auth errors

Pass Criteria:
- Login form renders correctly
- Form submission succeeds (200/201 response)
- Redirects to dashboard
- User session established
- No auth errors in console
```

### 3. API Integration Test
```
Actions:
1. browser_navigate({ url: "http://localhost:3000/dashboard" })
2. browser_wait_for({ time: 2 }) → Allow API calls to complete
3. browser_network_requests() → Capture all API calls
4. browser_console_messages({ level: "error" })

Analysis:
- Check each API request status
- Verify expected endpoints were called
- Check response times
- Flag any 4xx/5xx errors
```

### 4. Form Submission Test
```
Actions:
1. browser_navigate({ url: "[form-url]" })
2. browser_snapshot() → Capture empty form
3. browser_fill_form({ fields: [...] })
4. browser_snapshot() → Capture filled form
5. browser_click({ element: "Submit", ref: "[submit-ref]" })
6. browser_wait_for({ text: "Success" }) OR check network
7. browser_network_requests() → Verify POST request
8. browser_snapshot() → Capture result state

Pass Criteria:
- Form fields accept input
- Validation works (if applicable)
- Submit triggers correct API call
- Success/error feedback displays
```

### 5. CRUD Operations Test
```
For each operation (Create, Read, Update, Delete):

CREATE:
1. Navigate to create form
2. Fill required fields
3. Submit
4. Verify new item appears
5. Check network for POST request

READ:
1. Navigate to list view
2. Verify items load
3. Check network for GET request
4. Click item to view details

UPDATE:
1. Navigate to edit form
2. Modify fields
3. Submit
4. Verify changes saved
5. Check network for PUT/PATCH

DELETE:
1. Click delete button
2. Confirm dialog (if any)
3. Verify item removed
4. Check network for DELETE request
```

---

## Network Request Monitoring

### Using browser_network_requests()

```
# Get all requests (excluding static assets)
browser_network_requests({ includeStatic: false })

# Response format:
[
  {
    "url": "/api/users",
    "method": "GET",
    "status": 200,
    "statusText": "OK",
    "duration": 45
  }
]
```

### What to Check

| Check | Pass | Fail |
|-------|------|------|
| API status | 2xx | 4xx, 5xx |
| Auth endpoints | 200/201 | 401, 403 |
| Response time | < 1000ms | > 3000ms |
| Required calls | All made | Missing |

### Common Issues

| Status | Meaning | Fix |
|--------|---------|-----|
| 401 | Not authenticated | Check auth token |
| 403 | Not authorized | Check permissions |
| 404 | Endpoint not found | Check API route |
| 500 | Server error | Check server logs |
| CORS | Cross-origin blocked | Check API config |

---

## Console Log Monitoring

### Using browser_console_messages()

```
# Get errors only
browser_console_messages({ level: "error" })

# Get warnings and errors
browser_console_messages({ level: "warning" })

# Get all logs
browser_console_messages({ level: "debug" })
```

### Severity Levels

| Level | Action |
|-------|--------|
| **error** | FAIL - Must fix |
| **warning** | REVIEW - May need fix |
| **info** | PASS - Informational |
| **debug** | IGNORE - Dev only |

### Common Console Errors

| Error Pattern | Likely Cause |
|---------------|--------------|
| `Hydration failed` | SSR/client mismatch |
| `Cannot read property of undefined` | Null reference |
| `Failed to fetch` | Network/CORS issue |
| `Invalid hook call` | React hook rules |
| `ChunkLoadError` | Bundle/deploy issue |

---

## Test Execution Flow

### Full E2E Suite

```
1. Start test session
   - Verify dev server running
   - Clear previous test data (if needed)

2. Run core flows in order:
   a. Homepage loads
   b. Navigation works
   c. Auth flow (login)
   d. Protected routes accessible
   e. Core features work
   f. Auth flow (logout)

3. After each flow:
   - Capture network requests
   - Capture console logs
   - Take snapshot
   - Record in test story

4. Generate report
```

### Quick Commands

| Say | Action |
|-----|--------|
| `test` | Full E2E suite |
| `test auth` | Auth flow only |
| `test api` | API integration check |
| `test [page]` | Specific page test |
| `test network` | Check all network calls |
| `test console` | Check for console errors |

---

## Test Account

**CRITICAL:** Always use the test account:
- **Email:** nvision.tester@gmail.com
- **Password:** `${TEST_USER_PASSWORD}` env var

**NEVER** use andy@nvision-data.com for automated tests.

---

## Test Report Format

After testing, generate a report:

```markdown
# Test Report: [Project Name]
**Date:** [timestamp]
**Duration:** [time]
**Result:** PASS | FAIL | PARTIAL

## Summary
- Total Flows: X
- Passed: Y
- Failed: Z
- Warnings: W

## Test Stories
[Include each test story]

## Network Summary
- Total Requests: N
- Failed: X (list URLs)
- Slow (>1s): Y (list URLs)

## Console Summary
- Errors: X
- Warnings: Y

## Issues Found
1. [Issue]: [Severity] - [Description]
   - Steps to reproduce
   - Expected vs Actual
   - Suggested fix

## Auto-Fixed
1. [Issue]: [What was fixed]

## Needs User Input
1. [Issue]: [Why it can't be auto-fixed]
```

---

## Integration with prd.json

When testing reveals issues:

1. **For auto-fixable issues:**
   - Fix immediately
   - Log in progress.txt
   - Continue testing

2. **For complex issues:**
   - Create new story in prd.json:
   ```json
   {
     "id": "SXXX",
     "title": "Fix: [issue description]",
     "description": "Found during testing: [details]",
     "priority": 1,
     "passes": false,
     "acceptanceCriteria": ["Issue no longer occurs"]
   }
   ```

3. **For blocked tests:**
   - Document why blocked
   - Note dependencies needed
   - Skip and continue
