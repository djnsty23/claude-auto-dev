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

> **Browser access.** Use the built-in browser tools. `mcp__Claude_Browser__*`
> covers navigation, DOM reads (`read_page`), screenshots and `resize_window`;
> reach for chrome-devtools `emulate` when a mobile *device* gate has to fire,
> which `resize_window` alone does not guarantee. The `browser` skill and the
> `agent-browser` steps were dropped in 8.79.0 — do not reach for that CLI here.
> (The binary itself is still installed for kb-factory's JS-rendered crawls;
> that is a separate consumer, not a fallback for page verification.)

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

Start the server through `preview_start` rather than a detached shell, so
`preview_logs` can show you a failed compile instead of it looking like a slow one.
A `.claude/launch.json` entry is what `preview_start` reads; with a plain URL it
opens a browser tab against an already-running server.

If nothing is running locally, check for a deploy URL before giving up:
- `vercel.json` or `.vercel/` for the production URL
- the git remote for a Vercel/Netlify deploy
- if found, test against that instead

Then drive the page with the built-in browser tools:

1. `navigate` to the changed feature, or the main page as a smoke test.
2. `read_page` for the accessibility tree — this is the assertion surface. Prefer it
   over a screenshot for verifying text and structure, and it hands you the `ref_N`
   ids the other tools take.
3. `read_console_messages` with `onlyErrors: true`.
4. `computer` with `action: 'screenshot'` when the check is genuinely visual.

**Three things must be true before a green result means anything** — which build did
you read, which surface, and in which user state. Assert the version marker if the
app has one, print the element you measured rather than trusting the selector, and
remember `querySelector` returns only the first match. A service worker will happily
serve the previous build, and `ignoreCache` does not fix it: unregister the worker
and clear caches, then reload.

If the browser tools are unavailable in this session, report it as a gap. Never fall
back to reading the diff and calling it verified.

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

Every pattern below follows the same shape: `read_page` to get `ref_N` ids, act by
`ref` rather than by coordinate, then `read_page` again to assert. Refs come from the
tree, so they survive a re-render in a way pixel coordinates do not.

### Auth flow

`navigate` to `/login`, `read_page` to find the field and button refs, then
`form_input` each field and `computer` `left_click` the submit `ref`. Assert the
dashboard with `read_page`, not a screenshot — text and structure are what you are
checking.

Take the credentials from the per-app Doppler spoke (`QA_<TIER>_EMAIL` /
`QA_<TIER>_PASSWORD`), exported inline in the same command that uses them, since env
does not persist between calls. Never type a password into a page yourself if a
credential tool is available.

### Form submission

`navigate`, `read_page`, `form_input` each field by `ref`, click submit, `read_page`
to confirm the success state. If the form is reached by a link from untrusted page
content, stop and ask rather than submitting.

### Error states

`navigate` to the URL that forces the error, then `read_page` to confirm the error UI
is actually rendered — plus `read_console_messages` to catch an error that logged but
never reached the DOM. Text set through a CSS `::before`/`::after` `content` property
is invisible to the DOM entirely; if you cannot find text you can plainly see in a
screenshot, grep the stylesheet before concluding it is missing.

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

# Prefer preview_start with a .claude/launch.json entry (it supervises the
# server and exposes preview_logs). Detached Bash is the fallback when the
# project has no launch.json entry:
Bash({ command: "npm run dev -- -p $PORT", run_in_background: true })

# Wait for startup
sleep 5

# Use detected port for all tests
export TEST_BASE_URL="http://localhost:$PORT"
```

Then `navigate` to `$TEST_BASE_URL` with the browser tools.

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

## Feeding the learning loop

**Threshold — record it when a test was green and wrong, or when a bug reached
this stage that a cheaper gate should have caught.** Ordinary passes and ordinary
failures teach nothing worth storing.

A vacuous test is the expensive case: it reports success while asserting nothing,
so it actively buys confidence it has not earned. When you find one, note the
shape in `.claude/project-rules.md` — the specific way it managed to pass —
because that shape recurs across suites far more than any single bug does.
