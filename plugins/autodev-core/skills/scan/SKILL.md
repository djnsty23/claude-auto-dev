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

> **Browser access.** Use the built-in browser tools. `mcp__Claude_Browser__*`
> covers navigation, DOM reads (`read_page`), screenshots and `resize_window`;
> reach for chrome-devtools `emulate` when a mobile *device* gate has to fire,
> which `resize_window` alone does not guarantee. The `browser` skill and the
> `agent-browser` steps were dropped in 8.79.0 — do not reach for that CLI here.
> (The binary itself is still installed for kb-factory's JS-rendered crawls;
> that is a separate consumer, not a fallback for page verification.)

Catches what typecheck and build cannot: visual bugs, broken links, console
errors, accessibility violations, performance regressions.

Drivers, in preference order:

- **Built-in browser tools** — the default. `navigate` + `read_page` +
  `read_console_messages` cover unauthenticated scanning, and the user can watch.
- **chrome-devtools `emulate`** — when a mobile device gate has to fire, not just a width.
- **Playwright script** — only for auth flows the other two cannot complete
  (OAuth redirects, SSO, 2FA), or when you need a repeatable checked-in script.

## Usage

| Command | What It Does |
|---------|-------------|
| `scan` | Detect URL from project, run quick scan on key pages |
| `scan http://localhost:3000` | Scan specific URL |
| `scan full` | Deep scan — all pages, all categories |
| `scan auth` | Login via Playwright, then scan authenticated pages |
| `scan compare` | Scan and compare against last baseline |
| `scan errors` | Console + network errors only |
| `scan a11y` | axe-core accessibility audit |
| `scan perf` | Lighthouse performance only |
| `scan mobile` | Mobile viewport screenshots + responsive check |

## Step 1: Detect or Start Target URL

Check in order:
1. User provided a URL → use it
2. Dev server already running → check ports 3000, 3001, 5173, 8080:
   ```bash
   for port in 3000 3001 5173 8080; do curl -s http://localhost:$port > /dev/null 2>&1 && echo "http://localhost:$port" && break; done
   ```
3. **No server running → auto-start one:**
   ```bash
   node -e "const p=require('./package.json');const s=p.scripts||{};console.log(s.dev||s.start||'')"
   ```
   If a dev script exists, start it with `preview_start` (preferred — it
   supervises the server and exposes `preview_logs`). Only when the project has
   no `.claude/launch.json` entry, fall back to a detached Bash:
   ```
   Bash({ command: "npm run dev", run_in_background: true })
   ```
   Wait 5 seconds, then re-check ports.
4. Vercel preview → check `.vercel/` or recent deploy URL
5. Production URL → check `package.json` homepage or CLAUDE.md

If nothing found after all checks, ask the user.

## Step 2: Discover Site Structure

```bash
# Fetch homepage, extract internal links
curl -sL "$TARGET_URL" | grep -oE 'href="[^"]+"' | sed 's/href="//;s/"$//' | sort -u | head -30
```

Better, on the built-in path: `navigate` to `$TARGET_URL`, then `read_page` —
it returns the nav structure with refs already attached, so discovery and the
first interaction step share one read.

`navigate` to the target, then `read_page` with `filter: 'interactive'` for the
controls and links. Use `find` to locate a specific element in that tree rather than
re-reading it.

**Priority pages** (scan these first):
1. Landing/home page
2. Auth pages (login, signup)
3. Dashboard/main app page
4. Settings/profile
5. Any page with forms

## Step 3: Run Scans (Unauthenticated)

### Quick Scan (default) — built-in path

For each priority page:

1. `navigate` to the page URL.
2. `read_console_messages` with `onlyErrors: true`. **A page that renders
   correctly but logs an error has failed this scan.**
3. `read_page` — check the page has a single `h1`, that images carry alt text,
   and that no interactive element is unlabelled.
4. `computer` with `action: "screenshot"` for the desktop view.
5. `resize_window` with `preset: "mobile"`, reload, screenshot again.
6. `resize_window` back to `preset: "desktop"` before the next page.

Save screenshots the user should keep under
`.claude/screenshots/$(date +%Y-%m-%d)/` and reference them in the report.

### Quick scan — per page

For each page: `navigate`, `computer` `screenshot`, `resize_window`
`{preset: 'mobile'}`, screenshot again, then `read_console_messages`
`{onlyErrors: true}` and `read_network_requests` for failed loads.

Screenshots come back to the session rather than being written to a path, so record
findings as you go — note the page, the viewport and what was wrong. A scan whose
output is 40 unlabelled images is not a report.

Dismiss any tour or consent overlay **before** the screenshot and assert it is gone;
an overlay that appears between the action and the capture changes the screen you
thought you measured. On consent banners, decline non-essential cookies.

### Full Scan (all pages)

Loop over discovered URLs, scanning each. Cap at 20 pages to keep scan time reasonable (~5-10 min).

## Step 4: Authenticated Scan (Playwright)

The browser tools handle a simple form login via `form_input` and a click. Use
Playwright for OAuth, Google SSO, 2FA, or any redirect-heavy flow — it behaves more
like a real user.

**A stored session can strip demo mode.** If `?demo=1` appears to do nothing, that is
usually a guard clearing the demo flag because a real session exists, which is
correct behaviour. Scan from a fresh context rather than the signed-in profile, and
re-assert that state after every navigation — it does not always survive one.

Create `.claude/scripts/auth-scan.js`:
```javascript
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });  // headless:false lets you complete 2FA/SSO manually once
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();

  // Capture errors as they happen
  const errors = [];
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', e => errors.push(`UNCAUGHT: ${e.message}`));
  page.on('response', r => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));

  // Login
  await page.goto(process.env.LOGIN_URL);
  await page.fill('input[type="email"]', process.env.TEST_USER_EMAIL);
  await page.fill('input[type="password"]', process.env.TEST_USER_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(url => !url.pathname.includes('login'), { timeout: 30000 });

  // Save auth state for reuse
  await ctx.storageState({ path: '.claude/auth-state.json' });

  // Scan protected pages
  const pages = (process.env.PAGES || '/dashboard').split(',');
  for (const path of pages) {
    await page.goto(new URL(path, process.env.BASE_URL).href);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: `.claude/screenshots/auth-${path.replace(/\//g, '_')}.png`, fullPage: true });
  }

  require('fs').writeFileSync('.claude/screenshots/auth-errors.txt', errors.join('\n'));
  await browser.close();
})();
```

Run it:
```bash
LOGIN_URL=http://localhost:3000/login \
TEST_USER_EMAIL=$TEST_USER_EMAIL \
TEST_USER_PASSWORD=$TEST_USER_PASSWORD \
BASE_URL=http://localhost:3000 \
PAGES=/dashboard,/settings,/profile \
node .claude/scripts/auth-scan.js
```

For Google SSO: launch with `headless: false`, complete the login manually the first time, and `storageState` persists the session. Subsequent runs can use `storageState: '.claude/auth-state.json'` in the context options.

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

Install once: `npm install -D @axe-core/playwright`

## Step 7: Performance (Lighthouse)

Standalone, no MCP needed:
```bash
npx lighthouse "$PAGE_URL" --only-categories=performance --chrome-flags="--headless" --output=json --output-path=.claude/lighthouse.json
node -e "const r=require('./.claude/lighthouse.json');console.log('Perf:',r.categories.performance.score*100,'LCP:',r.audits['largest-contentful-paint'].displayValue)"
```

For mobile: add `--preset=perf --emulated-form-factor=mobile`.

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

Save JSON with: URLs scanned, error counts per page, Lighthouse scores, axe violation counts, screenshot paths.

Compare with previous baseline — report regressions and resolutions.

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
- Don't create stories for Lighthouse scores above 90 — focus on real issues
- Console errors are always critical — fix them before anything else
- Save scan results to `.claude/scans/` for future comparisons
- For OAuth/SSO, use Playwright with `storageState` — don't try to automate password entry on Google
