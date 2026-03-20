---
name: scan
description: Live site QA via audiq MCP — scans pages, catches visual/functional issues, compares with baselines. Use when testing a live site or after deploying.
triggers:
  - scan
  - scan it
  - test it
  - qa
  - visual qa
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, mcp__audiq__scan_page, mcp__audiq__start_scan, mcp__audiq__scan_status, mcp__audiq__scan_results, mcp__audiq__cancel_scan, mcp__audiq__get_console_errors, mcp__audiq__get_network_issues, mcp__audiq__run_lighthouse, mcp__audiq__check_accessibility, mcp__audiq__get_report, mcp__audiq__screenshot_page, mcp__audiq__analyze_visual, mcp__audiq__generate_fix_plan, mcp__audiq__login_and_scan, mcp__audiq__recommend_design, mcp__audiq__discover_site, mcp__audiq__qa_audit, mcp__audiq__get_dashboard_report
model: opus
user-invocable: true
argument-hint: "[url or scope]"
---

# Scan — Live Site QA

Automated QA using audiq MCP. Catches what typecheck and build cannot: visual bugs, broken links, console errors, accessibility violations, performance regressions.

## Usage

| Command | What It Does |
|---------|-------------|
| `scan` | Detect URL from project, run quick scan on key pages |
| `scan http://localhost:3000` | Scan specific URL |
| `scan full` | Deep scan — all pages, all categories |
| `scan auth` | Scan authenticated pages (asks for credentials) |
| `scan compare` | Scan and compare against last baseline |
| `scan design` | Visual design analysis + recommendations |

## Step 1: Detect or Start Target URL

Check in order:
1. User provided a URL → use it
2. Dev server already running → check ports 3000, 3001, 5173, 8080:
   ```bash
   for port in 3000 3001 5173 8080; do curl -s http://localhost:$port > /dev/null 2>&1 && echo "http://localhost:$port" && break; done
   ```
3. **No server running → auto-start one:**
   ```bash
   # Detect the right command from package.json
   node -e "const p=require('./package.json');const s=p.scripts||{};console.log(s.dev||s.start||'')"
   ```
   If a dev script exists, start it in the background:
   ```
   Bash({ command: "npm run dev", run_in_background: true })
   ```
   Wait 5 seconds, then re-check ports. Report which port was detected.
4. Vercel preview → check `.vercel/` or recent deploy URL
5. Production URL → check `package.json` homepage or CLAUDE.md

If nothing found after all checks, ask the user.

## Step 2: Discover Site Structure

```
mcp__audiq__discover_site({ url: TARGET_URL, maxPages: 20 })
```

This maps all pages, forms, and interactive elements. Use the result to prioritize which pages to scan.

**Priority pages** (scan these first):
1. Landing/home page
2. Auth pages (login, signup)
3. Dashboard/main app page
4. Settings/profile
5. Any page with forms

## Step 3: Run Scans

### Quick Scan (default)

For each priority page, run in parallel:
```
mcp__audiq__scan_page({ url: PAGE_URL, profile: "quick" })
mcp__audiq__screenshot_page({ url: PAGE_URL, viewport: "desktop" })
mcp__audiq__screenshot_page({ url: PAGE_URL, viewport: "mobile" })
```

### Full Scan

```
mcp__audiq__start_scan({ url: TARGET_URL, maxPages: 50 })
```

Poll with `mcp__audiq__scan_status` until complete, then retrieve with `mcp__audiq__scan_results`.

### Authenticated Scan

```
mcp__audiq__login_and_scan({
  loginUrl: "http://localhost:3000/login",
  url: "http://localhost:3000/dashboard",
  username: "$TEST_USER_EMAIL",
  password: "$TEST_USER_PASSWORD",
  profile: "deep"
})
```

### Design Analysis

For visual quality assessment:
```
mcp__audiq__analyze_visual({ url: PAGE_URL, viewport: "desktop" })
mcp__audiq__analyze_visual({ url: PAGE_URL, viewport: "mobile" })
```

For design improvement suggestions:
```
mcp__audiq__recommend_design({ url: PAGE_URL })
```

## Step 4: Analyze Screenshots

When screenshots are returned, analyze them for:

**Layout issues:**
- Content overflow or clipping
- Elements overlapping
- Broken responsive layout on mobile
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

## Step 5: Compare with Baseline (if available)

Check for previous scan results:
```bash
ls .claude/scans/ 2>/dev/null
```

If a baseline exists, compare:
- Score changes (performance, a11y, SEO, best practices)
- New issues not in baseline
- Resolved issues from baseline
- Visual differences in screenshots

**Auto-save baseline on first scan:**
```bash
mkdir -p .claude/scans
```

If no previous scan exists in `.claude/scans/`, this is the baseline. Save it with a clear label:
```bash
# First scan → save as baseline
.claude/scans/baseline-YYYY-MM-DD.json

# Subsequent scans → save as timestamped
.claude/scans/scan-YYYY-MM-DD.json
```

The baseline is never overwritten — it's the reference point for all future `scan compare` runs. Include scores, issue counts, and screenshot references in the JSON.

## Step 6: Generate Fix Plan

```
mcp__audiq__generate_fix_plan({ format: "claude-code", minSeverity: "high" })
```

## Step 7: Report

```
Scan Results: [URL]
═══════════════════

Pages scanned: [N]
Scan time: [T]

| Category | Score | Issues |
|----------|-------|--------|
| Performance | XX/100 | N issues |
| Accessibility | XX/100 | N issues |
| SEO | XX/100 | N issues |
| Best Practices | XX/100 | N issues |

Critical Issues:
1. [Category] [page] — [issue] → [fix]
2. ...

Visual Issues (from screenshots):
1. [page] — [what's wrong visually]
2. ...

Design Quality: [assessment]

Compared to baseline: [improved/regressed/new scan]
- Performance: +5 (was 72, now 77)
- New issues: 3
- Resolved: 7
```

## Quick Commands

| Shortcut | Equivalent |
|----------|-----------|
| `scan it` | Quick scan of detected URL |
| `scan errors` | Console errors + network issues only |
| `scan a11y` | Accessibility audit only |
| `scan perf` | Lighthouse performance only |
| `scan mobile` | Mobile screenshots + responsive check |

### scan errors (lightweight)
```
mcp__audiq__get_console_errors({ url: TARGET_URL })
mcp__audiq__get_network_issues({ url: TARGET_URL })
```

### scan a11y
```
mcp__audiq__check_accessibility({ url: TARGET_URL })
```

### scan perf
```
mcp__audiq__run_lighthouse({ url: TARGET_URL, categories: ["performance"], device: "mobile" })
```

## Integration with Other Skills

| Skill | How Scan Integrates |
|-------|-------------------|
| `ship` | Run `scan` as post-deploy verification |
| `auto` | After UI tasks, `scan` the affected page |
| `fix` | When fixing UI bugs, `scan` to verify the fix |
| `design` | Use `scan design` to assess visual quality |

## Rules

- Always scan both desktop AND mobile viewports
- Screenshot every page you scan — visual issues are invisible to code analysis
- Compare with baselines when available — regressions matter more than absolute scores
- Don't create stories for scores above 90 — focus on real issues
- Console errors are always critical — fix them before anything else
- Save scan results to `.claude/scans/` for future comparisons
