---
name: Audit
description: Parallel swarm audit across 6 specializations - tested and working
triggers:
  - audit
  - full audit
  - quality check
  - review all
---

# Audit Command (Tested v1.0)

**Philosophy:** Launch 6 parallel specialized agents, each focused on one aspect. Aggregate results into actionable report with severity ratings.

## Audit Swarm Architecture

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

## Execution (Copy-Paste Ready)

When user says "audit", launch these 6 agents in parallel:

```typescript
// All 6 in a single message with run_in_background: true
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

## Output Format (Tested)

```markdown
## 🔍 Audit Report

**Scan Time:** ~3 min | **Agents:** 6 parallel | **Files Scanned:** ~250

### Summary

| Category | Critical | High | Medium | Low | Total |
|----------|----------|------|--------|-----|-------|
| 🔒 Security | X | X | X | X | XX |
| ⚡ Performance | X | X | X | X | XX |
| ♿ Accessibility | X | X | X | X | XX |
| 📝 Type Safety | X | X | X | X | XX |
| 🎨 UX/UI | X | X | X | X | XX |
| 🧪 Test Coverage | X | X | X | X | XX |
| **TOTAL** | **X** | **X** | **X** | **X** | **XX** |

### 🚨 Critical Issues (Fix Immediately)
[Table of critical issues with file locations]

### High Priority Issues (Top 10)
[Numbered list]

### Ratings
[Score table 1-10 per category]
```

## Severity Definitions

| Severity | Definition | Example |
|----------|------------|---------|
| **Critical** | Security vulnerability or app-breaking | XSS, auth bypass, crash |
| **High** | Significant UX degradation or major debt | 5s load, no error handling |
| **Medium** | Noticeable but not blocking | Missing loading state |
| **Low** | Nice to have, polish | Console.log left in |

## Real Results (From Test Run)

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

## Post-Audit Actions

Offer user:
1. `"critical"` → Create stories for critical issues
2. `"security"` → Create security-focused stories
3. `"tests"` → Create test coverage stories
4. Specific numbers → Create stories for those issues

## Token Cost

- 6 agents × ~15K tokens each = ~90K tokens total
- Time: 2-4 minutes (parallel execution)
- Context efficient: agents run in background, results aggregated
