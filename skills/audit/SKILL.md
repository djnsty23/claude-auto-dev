---
name: audit
description: Rate each aspect of app, auto-create stories from findings
allowed-tools: Bash, Read, Grep, Glob, Task, TaskCreate, TaskUpdate, TaskList, Write, Edit
model: opus
user-invocable: true
---

# Audit

**Philosophy:** Rate each aspect of the app (or specific feature), then auto-create stories from findings.

## Existing Tasks
!`node -e "try{const p=require('./prd.json');Object.entries(p.stories||{}).forEach(([k,v])=>console.log(k,v.passes===true?'done':v.passes==='deferred'?'deferred':'pending',v.title))}catch{}" 2>/dev/null`

## Swarm Architecture

```
User says "audit"
    │
    ├─► Agent 1: Security Audit (Haiku) - secrets, XSS, CORS, injection
    ├─► Agent 2: Performance Audit (Haiku) - memo, effects, re-renders
    ├─► Agent 3: Accessibility Audit (Haiku) - WCAG, keyboard, contrast
    ├─► Agent 4: Type Safety Audit (Haiku) - any, ts-ignore, conflicts
    ├─► Agent 5: UX/UI Audit (Haiku) - states, tokens, feedback
    └─► Agent 6: Test Coverage Audit (Haiku) - critical paths, gaps

    [All run in parallel via Task tool with run_in_background: true]

    ▼
Wait for completion → Aggregate Results → Present Report
```

## Execution

Launch all 6 agents in a single message:

```typescript
Task({ subagent_type: "Explore", model: "haiku", run_in_background: true,
  prompt: "Security audit for [PROJECT_PATH]. Scan: exposed secrets, dangerouslySetInnerHTML, eval(), missing Zod validation, SQL injection, XSS vectors, CORS config. Report: Severity, File:line, Issue, Fix." })

Task({ subagent_type: "Explore", model: "haiku", run_in_background: true,
  prompt: "Performance audit for [PROJECT_PATH]. Scan: missing React.memo on list items, useEffect without cleanup, inline objects in JSX, missing lazy loading, N+1 queries. Report: Severity, File:line, Issue, Fix." })

Task({ subagent_type: "Explore", model: "haiku", run_in_background: true,
  prompt: "Accessibility audit for [PROJECT_PATH]. Scan: images without alt, missing aria-labels, onClick without onKeyDown, missing form labels, hardcoded colors, undersized touch targets. Report: Severity, File:line, Issue, Fix." })

Task({ subagent_type: "Explore", model: "haiku", run_in_background: true,
  prompt: "Type safety audit for [PROJECT_PATH]. Scan: 'any' usage (skip test files), @ts-ignore, type assertions without guards, conflicting type definitions, untyped API responses. Report: Severity, File:line, Issue, Fix." })

Task({ subagent_type: "Explore", model: "haiku", run_in_background: true,
  prompt: "UX/UI audit for [PROJECT_PATH]. Scan: missing loading states, missing empty states, missing error states, hardcoded colors instead of tokens, missing toast feedback. Report: Severity, File:line, Issue, Fix." })

Task({ subagent_type: "Explore", model: "haiku", run_in_background: true,
  prompt: "Test coverage audit for [PROJECT_PATH]. Scan: auth flows without tests, data mutations without tests, hooks without test files, utilities without tests. List critical gaps. Report: Severity, What needs testing, Priority." })
```

## Output Format

```markdown
## Audit Report

**Scan Time:** ~3 min | **Agents:** 6 parallel | **Files Scanned:** ~250

### Summary

| Category | Critical | High | Medium | Low | Total |
|----------|----------|------|--------|-----|-------|
| Security | X | X | X | X | XX |
| Performance | X | X | X | X | XX |
| Accessibility | X | X | X | X | XX |
| Type Safety | X | X | X | X | XX |
| UX/UI | X | X | X | X | XX |
| Test Coverage | X | X | X | X | XX |
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

## Auto-Create Stories

After rating, **automatically create stories** for Critical + High issues.

### Deduplication (REQUIRED)

Before creating any task, check for duplicates:

```typescript
// 1. Get existing tasks
const existing = await TaskList();

// 2. For each finding, check similarity
function isDuplicate(newTitle: string): boolean {
  return existing.some(task =>
    task.subject.toLowerCase().includes(newTitle.toLowerCase().slice(0, 20)) ||
    newTitle.toLowerCase().includes(task.subject.toLowerCase().slice(0, 20))
  );
}

// 3. Only create if not duplicate
if (!isDuplicate("Fix XSS vulnerability")) {
  TaskCreate({
    subject: "Fix XSS vulnerability in user input",
    description: "src/api/auth.ts:45 - dangerouslySetInnerHTML with user data",
    metadata: { type: "security", priority: 0, category: "security" }
  });
}
```

**Skip if:** Task with similar title already exists (pending or in_progress).
```

Then report:
```
Created [X] stories from audit findings.
- [N] Critical (priority 0)
- [N] High (priority 1)

Medium/Low issues logged but not queued.
Say "auto" to start fixing, or "audit [feature]" to audit specific area.
```

## Focused Audit

User can audit specific features:
- `audit auth` → Only scan auth-related files
- `audit dashboard` → Only scan dashboard components
- `audit latest` → Audit files changed in last 3 commits

## Token Cost

- 6 agents × ~15K tokens each = ~90K tokens total
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
| `quality` | Type safety, design tokens, all UI states |
| `code-quality` | React patterns, error handling, type completeness |
| `design` | Color tokens vs hardcoded, typography consistency |
| `preserve-ui` | Structural integrity for UI changes |
| `react-patterns` | Performance optimization patterns |

**UX/UI Agent should check:**
- Hardcoded colors → Reference `design` (NEVER purple gradients, NEVER Inter/Roboto)
- Missing states → Reference `quality` (loading, empty, error)
- Design tokens → Reference `quality` design system rules

**Type Safety Agent should check:**
- Against `code-quality` patterns (single source of truth, complete Records)
- `quality` principles (strict mode, no any)

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
