---
name: scan
description: Live site QA in a real browser. Scans pages for visual, console, accessibility, and performance regressions, and compares against baselines. Use when testing a running site or after deploying.
when_to_use: "Invoked when the user says \"scan\", \"scan it\", \"test it\", \"qa\", \"visual qa\"."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, mcp__Claude_Browser__*
model: opus
user-invocable: true
argument-hint: "[url or scope]"
---

# Scan — Live Site QA

Use an available browser driver with its actual schema; inspect capabilities
before naming tools/arguments. Reuse supported navigation, DOM, console/network
and screenshot tools, or an existing project browser suite. A missing preferred
driver is not proof that all browser execution is unavailable.

Catches what typecheck and build cannot: visual bugs, broken links, console
errors, accessibility violations and performance regressions. Page loading is
only one check: exercise the affected user flow and relevant state transitions.
Use device emulation when pointer/touch/DPR/UA matters; width alone does not
establish those conditions. Load `rule-local-first` for browser provenance.

## Usage

| Command | What It Does |
|---------|-------------|
| `scan` | Detect URL from project, run quick scan on key pages |
| `scan http://localhost:3000` | Scan specific URL |
| `scan full` | Inventory routes and scan the declared population; report any cap/exclusions |
| `scan auth` | Verify the intended account/role, then exercise protected flows |
| `scan compare` | Scan and compare against last baseline |
| `scan errors` | Console + network errors only |
| `scan a11y` | axe-core accessibility audit |
| `scan perf` | Lighthouse performance only |
| `scan mobile` | Mobile viewport screenshots + responsive check |

## Step 1: Detect or Start Target URL

1. Resolve the requested URL or the project’s startup configuration. Confirm
   process ownership, cwd and build identity before reusing a local server.
   A response on port 3000/5173/etc. can belong to another project.
2. If needed, start the real project command through available supervision or an
   owned background process. Retain PID/logs and poll readiness with a deadline;
   fixed sleeps and HTTP status alone do not prove the expected app loaded.
3. Identify the deployed revision for a preview/live target. An old deployment
   cannot verify uncommitted local code. Preserve the current authorization for
   external actions and use isolated test data. If no target can be established,
   record that gap and continue independent checks.

## Step 2: Discover Site Structure

Enumerate routes from source/config plus the live navigation and intended user
journeys. Record the population, excluded paths and reason. A grep of the first
30 links misses hydrated, authenticated and unlinked routes; empty output can
mean the fetch failed. Use the available DOM/browser tools and retain request
failures. Test reachability through the real navigation as well as direct URLs.

Prioritize landing/home, auth, the main app, settings/profile, changed pages and
forms according to the task. For each flow name the role, data state, expected
outcome and cleanup. Track loading/empty/error/success states where applicable.

## Step 3: Run Scans (Unauthenticated)

### Quick scan example for Claude Browser

The named tools/arguments below are examples for a host exposing that driver.
Confirm its actual schema or adapt the same checks to the available driver.
For each priority page:

1. `navigate` to the page URL.
2. Capture relevant console and network failures using supported tools.
   Investigate their source, impact and whether they predate the change; retain
   unresolved application failures. Do not turn every console line or expected
   negative-test HTTP response into a critical defect.
3. Read the DOM/accessibility tree — check meaningful headings, image alternatives,
   and that no interactive element is unlabelled.
4. `computer` with `action: "screenshot"` for the desktop view.
5. `resize_window` with `preset: "mobile"`, reload, screenshot again.
6. `resize_window` back to `preset: "desktop"` before the next page.

Store durable before/after proof according to `prove` and
`rule-file-organization`; `.claude/screenshots/` is disposable in some projects.
Reference artifacts with URL, revision, viewport, role and state.

Record findings as you go with page, viewport, role and observed state.
Screenshots alone are not a report; retain the flow assertions and relevant
network failures alongside them.

Check the initial tour/consent state when part of the journey. For an
unobstructed layout check, dismiss it deliberately and assert it is gone before
capturing. On consent banners, decline non-essential cookies unless the test
requires another already authorized choice. Record the state you measured.

### Full Scan (all pages)

Scan the declared route/state population within the run budget. If capped
(for example at 20 pages), list the remaining routes/states and retain them as
unverified work. Do not call a capped sample “all pages” or infer coverage from
the page count.

## Step 4: Authenticated Scan

Use the supported browser driver or the project’s Playwright suite with an
approved QA account. Assert the expected principal/role after login and on each
protected page; a redirect away from `/login` is not a success assertion.
Confirm the expected page/data state before screenshots; a login page, spinner
or error page is not proof of protected content. A session cookie alone does
not prove the current account or permissions.

Use a fresh context for signed-out/demo checks. Inspect auth and URL state after
navigation; if demo parameters disappear, investigate the actual guard rather
than assuming the cause. Complete account setup/2FA only through available,
authorized mechanisms; a missing factor is a specific blocked step.

For repeatable scripts: validate required config, register console/pageerror/
response listeners before navigation, wait for an application-specific readiness
assertion, exercise the flow, assert persisted results, and clean up owned test
records/context in `finally`. `networkidle` alone can hang on a healthy realtime
app and cannot establish that a mutation succeeded. Retain raw diagnostics and
make failed assertions produce a nonzero exit.

Treat any saved browser storage state as credentials: keep it in a verified
ignored/private path, never in screenshots/reports or public evidence. Reuse it
only for the intended account and clear it when no longer needed.

## Step 5: Analyze Screenshots

Read the saved PNGs directly. Look for:

**Layout issues:**
- Content overflow or clipping
- Elements overlapping
- Broken responsive layout on mobile (horizontal scroll, squashed grids)
- Missing content or blank sections
- Misaligned elements

**Design quality:**
- Generic/bland aesthetic (AI slop indicators)
- Inconsistent spacing or typography
- Poor color contrast
- Missing visual hierarchy
- No clear call-to-action

**Functional issues:**
- Error states visible
- Missing images or broken icons
- Loading spinners stuck
- Empty states without guidance

## Step 6: Accessibility (axe-core)

Inject axe-core into Playwright to get WCAG violations:
```javascript
const { AxeBuilder } = require('@axe-core/playwright');
const results = await new AxeBuilder({ page }).analyze();
console.log(JSON.stringify(results.violations, null, 2));
```

Prefer the project’s existing axe integration. If absent, record the missing
check or add a reviewed dev dependency when setup is within scope; a scan does
not silently install arbitrary versions into the project.

## Step 7: Performance (Lighthouse)

Standalone, no MCP needed:
```bash
npx --no-install lighthouse "$PAGE_URL" --only-categories=performance --chrome-flags="--headless" --output=json --output-path=.claude/lighthouse.json
node -e "const r=require('./.claude/lighthouse.json');console.log('Perf:',r.categories.performance.score*100,'LCP:',r.audits['largest-contentful-paint'].displayValue)"
```

Inspect the installed Lighthouse version’s supported mobile/desktop options.
Create the output directory and retain command exit status before reading the
JSON. Use `perf` for lab/field distinctions; a Lighthouse score is not INP.

## Step 8: Compare with Baseline

```bash
ls .claude/scans/ 2>/dev/null
```

**Auto-save baseline on first scan:**
```bash
mkdir -p .claude/scans
# First scan → baseline-YYYY-MM-DD.json
# Subsequent → scan-YYYY-MM-DD.json
```

Save JSON with: tested revision/build, time, route/state population, actual
checks and outcomes, errors with attribution, tool versions/settings, scores
only where measured, artifacts and unverified gaps.

Compare like-for-like conditions with the previous baseline. Preserve its
identity and do not overwrite a red baseline just to make a regression disappear.

## Step 9: Report

```
Scan Results: [URL]
═══════════════════

Pages scanned: [N]
Scan time: [T]

| Category | Score | Issues |
|----------|-------|--------|
| Performance (Lighthouse) | XX/100 | N issues |
| Accessibility (axe) | N violations | critical: N |
| Console errors | N pages affected | |
| Network errors | 4xx/5xx count | |

Critical Issues:
1. [page] — [issue] → [fix]
2. ...

Visual Issues (from screenshots):
1. [page] — [what's wrong visually]
2. ...

Compared to baseline: [improved/regressed/new scan]
- Performance: +5 (was 72, now 77)
- New issues: 3
- Resolved: 7
```

## Integration with Other Skills

| Skill | How Scan Integrates |
|-------|-------------------|
| `ship` | Run `scan` as post-deploy verification |
| `auto` | After UI tasks, `scan` the affected page |
| `fix` | When fixing UI bugs, `scan` to verify the fix |
| `design` | Review screenshots for visual quality and AI slop indicators |

## Rules

- Always scan both desktop AND mobile viewports
- Screenshot every page you scan — visual issues are invisible to code analysis
- Compare with baselines when available — regressions matter more than absolute scores
- Triage reproduced impact regardless of Lighthouse score; a score above 90
  does not rule out a broken or slow critical flow.
- Prioritize console/network findings by demonstrated impact and source; keep
  unexplained application failures unresolved without calling every log critical.
- Save scan results to `.claude/scans/` for future comparisons
- For OAuth/SSO, follow the actual provider flow and current authorization;
  saved state does not verify a fresh login.
