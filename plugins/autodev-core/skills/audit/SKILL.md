---
name: audit
description: Parallel quality audit with 7 specialized agents (Opus). Finds bugs, violations, and quality issues. Use audit for fixes, brainstorm for features.
when_to_use: "Invoked when the user says \"audit\"."
allowed-tools: Bash, Read, Grep, Glob, Task, TaskCreate, Write, Edit
model: opus
user-invocable: true
argument-hint: "[scope: full|auth|dashboard|latest]"
---

# Audit

Find bugs, violations, and quality issues. Creates fix stories in prd.json.

**Scope:** Audit owns all bug/violation/quality findings. Brainstorm owns feature ideas and architecture improvements. No overlap.

## Existing Tasks
!`node -e "try{const p=require('./prd.json');const sp=p.sprints?p.sprints[p.sprints.length-1]:p;Object.entries(sp.stories||p.stories||{}).forEach(([k,v])=>console.log(k,v.passes===true?'done':v.passes==='deferred'?'deferred':'pending',v.title))}catch(e){}"`

## Swarm Architecture

```
User says "audit"
    │
    ├─► Agent 1: Security Audit (Opus) - secrets, XSS, CORS, injection
    ├─► Agent 2: Performance Audit (Opus) - memo, effects, re-renders
    ├─► Agent 3: Accessibility Audit (Opus) - WCAG, keyboard, contrast
    ├─► Agent 4: Type Safety Audit (Opus) - any, ts-ignore, conflicts
    ├─► Agent 5: UX/UI Audit (Opus) - states, tokens, feedback
    ├─► Agent 6: Test Coverage Audit (Opus) - critical paths, gaps
    └─► Agent 7: Deploy Readiness Audit (Opus) - PWA, env vars, runtime

    [All run in parallel via Task tool with run_in_background: true]

    ▼
Wait for completion → Aggregate Results → Present Report
```

## Known-Safe Framework Patterns (Do Not Flag)

Before launching the swarm, load `references/known-safe-patterns.md`. Include its "SKIP — NOT A BUG" list inside every audit agent prompt. Common false positives: shadcn label nesting, React 19 server actions, Supabase RLS `auth.uid()` pattern, `console.error`, `as const`, `.test.*` / `.spec.*` / `.d.ts` files.

After aggregation, drop any finding that matches a known-safe pattern before writing to prd.json.

## Agent Memory (read before scanning)

Before launching the swarm, read `.claude/agent-memory/audit-patterns.md` if it exists. This file contains:

- **Accepted noise** — patterns previously marked as intentional (e.g., test-only console.log). Agents should skip these.
- **Recurring issues** — items already captured as prd.json stories. Deduplicate against these.
- **Hotspots** — files/directories that consistently surface issues. Agents can prioritize these.

If the file doesn't exist, create it with this seed (first audit only):
```markdown
# Audit Patterns (auto-maintained)

## Accepted Noise
<!-- Patterns marked as intentional — don't re-report. Format: path pattern | reason -->

## Recurring Issues
<!-- Issues already in prd.json. Format: file:line | prd-id | title -->

## Hotspots
<!-- Files with 3+ findings across audits. Format: file | count | last-seen -->
```

Pass the content of this file into each agent's prompt under a "KNOWN PATTERNS — SKIP THESE" section so agents don't re-report them.

After the swarm completes and before writing to prd.json, append any new hotspots (files with 3+ new findings) and mark accepted-noise items if the user explicitly dismisses a class of finding.

## Execution

### Size Gate (choose agent count by codebase size)

Before launching agents, count source files:
```bash
find src/ app/ packages/ -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' 2>/dev/null | wc -l
```

| Files | Strategy | Agents |
|-------|----------|--------|
| < 50 | **Compact** — single Opus agent, all 7 checks sequentially | 1 |
| 50-200 | **Medium** — 3 agents (security+types, perf+a11y, UX+tests+deploy) | 3 |
| 200+ | **Full swarm** — all 7 agents in parallel | 7 |

For **compact** mode (< 50 files), use a single agent with all checks combined:
```typescript
Agent({ subagent_type: "Explore", model: "opus",
  prompt: "Full quality audit for [PROJECT_PATH]. Limit to 80 tool calls. Check ALL of: 1) Security (secrets, XSS, injection, RLS), 2) Performance (memo, effects, re-renders), 3) Accessibility (alt, aria, keyboard), 4) Type safety (any, ts-ignore, console.log), 5) UX/UI (loading/error/empty states, hardcoded colors, responsive), 6) Test gaps, 7) Deploy readiness (env vars, asset paths). Report: Severity, File:line, Issue, Fix." })
```

For **medium** mode (50-200 files), launch 3 combined agents.

For **full swarm** (200+ files), launch all 7 agents below.

Replace `[PROJECT_PATH]` with the actual working directory path.

**Important:** Each agent is capped at ~80 tool calls to avoid rate limits. Scope scans to specific directories.

```typescript
Task({ subagent_type: "security-scanner", model: "opus", run_in_background: true,
  prompt: "Security audit for [PROJECT_PATH]. Limit to 80 tool calls. Scan: exposed secrets (check src/ AND supabase/migrations/ for hardcoded keys, passwords, service_role, cron secrets), dangerouslySetInnerHTML, eval(), missing Zod validation, SQL injection, XSS vectors, CORS config. ALSO check: 1) Supabase RLS policy LOGIC — not just enabled, but correct: flag always-true USING clauses, INSERT WITH CHECK (true), tables with PII allowing SELECT without auth.uid(). 2) Fail-open auth — if (session) allow without default deny. 3) SSRF — user URLs passed to fetch without private IP validation. 4) Missing middleware — /dashboard/*, /api/* routes without auth checks. 5) Unsafe casts — 'as unknown as Type' on DB/API data without Zod validation. 6) Fire-and-forget fetch — fetch() without res.ok check or try/catch. Report: Severity, File:line, Issue, Fix." })

Task({ subagent_type: "Explore", model: "opus", run_in_background: true,
  prompt: "Performance audit for [PROJECT_PATH]. Limit to 80 tool calls. Scan: missing React.memo on list items, useEffect without cleanup, inline objects in JSX, missing lazy loading, N+1 queries. Report: Severity, File:line, Issue, Fix." })

Task({ subagent_type: "Explore", model: "opus", run_in_background: true,
  prompt: "Accessibility audit for [PROJECT_PATH]. Limit to 80 tool calls. Scan: images without alt, missing aria-labels, onClick without onKeyDown, missing form labels, hardcoded colors, undersized touch targets (<44px), div/span with onClick (should be button), outline-none without focus-visible replacement, user-scalable=no or maximum-scale=1, missing autocomplete on form inputs, inputs without correct type/inputmode, onPaste with preventDefault, missing prefers-reduced-motion support, autoFocus without justification. SKIP false positives: transition-all is perf not a11y (report as Low/perf if at all), console.error is acceptable (only flag console.log), test files don't need strict a11y. Report: Severity, File:line, Issue, Fix." })

Task({ subagent_type: "code-reviewer", model: "opus", run_in_background: true,
  prompt: "Type safety + code quality audit for [PROJECT_PATH]. Limit to 80 tool calls. Scan: 'any' usage (skip test files and type declaration files), @ts-ignore, type assertions without guards ('as unknown as'), conflicting type definitions, untyped API responses. ALSO scan: console.log/warn statements (NOT console.error — that's acceptable), count per file, report top 5 offenders. Empty catch blocks, API calls without error handling (missing res.ok check or try/catch). SKIP: test files for strict typing, .d.ts files, node_modules. Report: Severity, File:line, Issue, Fix." })

Task({ subagent_type: "Explore", model: "opus", run_in_background: true,
  prompt: "UX/UI audit for [PROJECT_PATH]. Limit to 80 tool calls. Scan: missing loading states, missing empty states, missing error states, hardcoded colors instead of tokens (exception: hardcoded colors on gradient/themed surfaces are OK), missing toast feedback, images without width/height (causes CLS), missing loading=lazy on below-fold images, large lists without virtualization (50+ items .map). ALSO check responsive layout: sidebars without mobile hide/toggle (must use hidden md:block pattern), grids without mobile breakpoints (need grid-cols-1 md:grid-cols-2), fixed-width containers that overflow on mobile, touch targets under 44px, missing mobile navigation (hamburger/drawer), modals not full-screen on mobile. ALSO check: hardcoded date/number formats (should use Intl.*), missing text truncation on user-generated content, flex children without min-w-0. Report: Severity, File:line, Issue, Fix." })

Task({ subagent_type: "Explore", model: "opus", run_in_background: true,
  prompt: "Test coverage audit for [PROJECT_PATH]. Limit to 80 tool calls. Scan: auth flows without tests, data mutations without tests, hooks without test files, utilities without tests. List critical gaps. Report: Severity, What needs testing, Priority." })

Task({ subagent_type: "Explore", model: "opus", run_in_background: true,
  prompt: "Deploy readiness audit for [PROJECT_PATH]. Limit to 80 tool calls. Scan for runtime issues that unit tests miss: 1) PWA manifest (manifest.json/site.webmanifest) - check every icon/screenshot path references a file that actually exists in public/. 2) Environment variables - check all process.env/import.meta.env references have values set (no trailing newlines/whitespace). 3) Supabase config - check anon key for trailing newline characters that break WebSocket URLs. 4) Asset references - grep for paths like /icons/, /images/, /screenshots/ in source and verify the files exist in public/. 5) next.config/vercel.json - check for mismatched rewrites or missing headers. Report: Severity, File:line, Issue, Fix." })
```

## Output Format

```markdown
## Audit Report

**Scan Time:** ~3 min | **Agents:** 7 parallel | **Files Scanned:** ~250

### Summary

| Category | Critical | High | Medium | Low | Total |
|----------|----------|------|--------|-----|-------|
| Security | X | X | X | X | XX |
| Performance | X | X | X | X | XX |
| Accessibility | X | X | X | X | XX |
| Type Safety | X | X | X | X | XX |
| UX/UI | X | X | X | X | XX |
| Test Coverage | X | X | X | X | XX |
| Deploy Ready | X | X | X | X | XX |
| **TOTAL** | **X** | **X** | **X** | **X** | **XX** |

### Critical Issues (Fix Immediately)

| # | Category | File:Line | Issue | Fix |
|---|----------|-----------|-------|-----|
| 1 | Security | src/api/auth.ts:45 | Exposed API key | Move to env var |
| 2 | A11y | src/components/Button.tsx:12 | No keyboard handler | Add onKeyDown |

### High Priority (Top 10)

1. [Category] File:line - Issue
2. ...

### Ratings

| Category | Score | Notes |
|----------|-------|-------|
| Security | 5/10 | 2 critical vulnerabilities |
| Performance | 7/10 | Missing memoization |
| Accessibility | 6/10 | Keyboard nav gaps |
| Type Safety | 7/10 | 12 'any' types |
| UX/UI | 6/10 | Missing loading states |
| Test Coverage | 2/10 | 95% hooks untested |
| **Overall** | **5.5/10** | |
```

## Severity Definitions

| Severity | Definition | Example |
|----------|------------|---------|
| **Critical** | Security vulnerability or app-breaking | XSS, auth bypass, crash |
| **High** | Significant UX degradation or major debt | 5s load, no error handling |
| **Medium** | Noticeable but not blocking | Missing loading state |
| **Low** | Nice to have, polish | console.log left in |

## Persist Findings to prd.json

After aggregating results, load `references/persist-findings.md` — it covers the full 8-step flow:
1. Read current prd.json (bash one-liner)
2. Deduplicate against existing stories (25-char title match)
3. Batch trivial findings (don't inflate story count)
4. Add new stories with the `S{sprint}-AUD-{n}` ID format + category/priority mapping
5. Create session Tasks so `auto` can immediately start fixing
6. Report
7. Score tracking to `.claude/sprint-history.md`
8. `npm audit --production` alongside the agent swarm

## Focused Audit

User can audit specific features:
- `audit auth` → Only scan auth-related files
- `audit dashboard` → Only scan dashboard components
- `audit latest` → Audit files changed in last 3 commits

## Quick Validation (No Agents)

For consistency checks only (triggers, descriptions, versions, frontmatter), run:
```bash
node validate.js
```
This is instant and free — use it before committing. The full agent audit is for deep analysis (security, UX, performance) that static checks can't find.

## Token Cost

- 7 parallel Opus agents. Token cost varies by codebase size.
- Time: 2-4 minutes (parallel execution)
- Context efficient: agents run in background, results aggregated

## Real Results (From Production Test)

Last audit of Data Globe (247 files):

| Category | Critical | High | Total |
|----------|----------|------|-------|
| Security | 2 | 5 | 14 |
| Performance | 0 | 4 | 8 |
| Accessibility | 2 | 5 | 7 |
| Type Safety | 1 | 2 | 8 |
| UX/UI | 3 | 4 | 10 |
| Test Coverage | 23 | 15 | 38 |
| **Overall Score** | **5.5/10** | - | **85 issues** |

Key findings:
- Test coverage is the biggest gap (95% hooks untested)
- 68 components use hardcoded colors
- Edge Functions lack input validation
- 530 console statements in production

## Quality Framework Reference

When rating findings, apply principles from related skills:

| Skill | What to Reference |
|-------|-------------------|
| `standards` | Type safety, design tokens, all UI states, React patterns, error handling |
| `design` | Color tokens vs hardcoded, typography consistency, structural integrity for UI changes |

**UX/UI Agent should check:**
- Hardcoded colors → Reference `design` (avoid purple gradients, avoid Inter/Roboto)
- Missing states → Reference `standards` (loading, empty, error)
- Design tokens → Reference `standards` design system rules

**Type Safety Agent should check:**
- Against `standards` patterns (single source of truth, complete Records, strict mode, no any)

## Log Patterns to Mistakes

When audit finds repeated issues (3+ files):
```markdown
## Pattern: [Category]
- **Task:** Audit finding
- **Root cause:** Why pattern violated
- **Prevention:** Rule to add
```
Log to `.claude/mistakes.md` for future reference.

## Plan Mode for Critical Fixes

When audit finds 5+ Critical/High severity issues, suggest plan mode:

**Suggestion format:**
```
⚠️ Found [N] Critical/High issues across [M] files.

These fixes may have cascading effects. Would you like me to enter plan mode to:
1. Analyze dependencies between fixes
2. Design fix order to prevent regressions
3. Identify shared root causes

Say "plan" to design fix strategy, or "auto" to fix immediately.
```

**In plan mode:**
1. Group related issues by root cause
2. Identify fix order (security first, then stability)
3. Map file dependencies
4. Present staged fix plan
5. Execute fixes in safe order
