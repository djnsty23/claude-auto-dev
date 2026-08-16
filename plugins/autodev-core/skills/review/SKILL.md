---
name: review
description: Code quality check with adaptive effort scaling. Includes security scanning.
when_to_use: "Invoked when the user says \"review\", \"verify\", \"check\"."
allowed-tools: Bash, Read, Grep, Glob, Task
model: opus
user-invocable: true
argument-hint: "[quick|deep]"
---

# Review

> **Browser access.** Prefer the built-in browser tools (`mcp__Claude_Browser__*`)
> when the session has them — that is the default in the desktop app. The
> `agent-browser` commands below are the terminal-only fallback. The `browser`
> skill owns the driver-selection rule; follow it before running either.

Quality check on current/recent changes. Scales effort to the task.

## Depth Levels

| Command | What It Does | When to Use |
|---------|-------------|-------------|
| `review` | Adaptive effort based on change type (default) | Before committing |
| `review quick` | Build + typecheck only | Typos, one-liners, low-risk changes |
| `review deep` | Full 7-step verification + UI check | After implementing features, before shipping |

## Effort Scaling (Default Mode)

| Task Type | Review Depth |
|-----------|--------------|
| Typo, one-liner | Does it work? Ship it. |
| Feature, component | Build + types + looks right |
| Architecture, refactor | All above + system impact |

More review for: money, security, user data, unfamiliar code.
Less review for: isolated changes, low risk, well-understood code.

## Quick Mode

After any change:
1. `npm run typecheck && npm run build` — must pass
2. Does it solve the problem?
3. Would you approve this PR?

If yes to all, move on.

## Default Mode (4 steps)

### 1. Check what changed
```bash
git diff --name-only HEAD~3
git diff --staged --name-only
```

### 2. Run quality checks
```bash
npm run typecheck
npm run build
npm run lint  # If available
```

### 3. Run tests
```bash
npm test -- --watchAll=false --passWithNoTests 2>/dev/null | tail -10
```

### 4. Scan changed files for issues
For each changed file, check:
- `any` types or `@ts-ignore`
- console.log statements
- Hardcoded colors (text-white, bg-gray-*)
- Missing error handling
- TODO/FIXME comments
- `as unknown as` unsafe casts on API/DB data
- `fetch()` without error handling (missing `res.ok` check or try/catch)
- Form inputs without `<label>` or `aria-label`
- Fail-open auth patterns (`if (session)` without default deny)

### 5. npm Audit
```bash
npm audit --production 2>/dev/null | grep -E "critical|high" | head -5
```

### 6. Breaking Change Detection
For each changed file, check:
- Exported function signatures changed (parameter types, return types)
- Removed exports that other files may import
- Changed API response shapes

### 7. Hardening Scan
Scan the diff for these 12 patterns:
```bash
# Run on staged/changed files only
git diff --name-only HEAD~3 | xargs grep -n "as unknown as\|fetch(.*)\.\(then\|catch\)\?$\|dangerouslySetInnerHTML\|eval(\|innerHTML\|document.write\|console\.log\|text-white\|bg-black\|text-gray-" 2>/dev/null | head -20
```

### 8. Report
```
Review: [X files changed]
==========================

Build: Pass/Fail
Types: Pass/Fail
Lint: Pass/Fail (or N/A)

Issues Found:
- src/component.tsx:45 - console.log left in
- src/hook.ts:12 - Missing error handling

Suggestions:
- Consider extracting duplicate logic in X and Y

Overall: Ready to commit / Needs fixes
```

## Deep Mode (7-step verification)

Confirm the work is done well, not just done. A task is complete when it works, solves the actual problem, and is production-ready.

### What "Complete" Means

1. It works — build passes, types check, feature functions.
2. It solves the actual problem — not just the literal requirements.
3. It's production-ready — handles errors, edge cases, real-world conditions.

Flag opportunities to improve UX, performance, or error messages — but do not implement them during review. Report them as findings for a future task.

### For UI Tasks

Verify visually:
- Does it look right at desktop and mobile (375px)?
- Do all states work? (loading, error, empty, content)
- Is sidebar hidden on mobile with a toggle?
- Do grids stack to single column on mobile?
- No horizontal overflow or clipped content?

Use `agent-browser` for verification when helpful:
```bash
for port in 3000 3001 5173 8080; do
  curl -s http://localhost:$port > /dev/null && break
done
agent-browser open http://localhost:$port/path
agent-browser snapshot -i
```

### 7-Step Checklist

Run each check in order. Stop and fix on any failure.

**0. Optional: Specialist agent review (for significant diffs)**

If the diff touches 5+ files or includes auth/billing/data-mutation code, spawn a code-reviewer agent in parallel with steps 1-6:
```typescript
Task({ subagent_type: "code-reviewer", model: "opus", run_in_background: true,
  prompt: "Review staged changes in [PROJECT_PATH] for bugs, logic errors, security vulnerabilities, and convention drift. Limit to 60 tool calls. Focus on: the diff (git diff --staged), what the change is supposed to do vs. what it actually does, edge cases the author may have missed. Report only high-confidence findings — skip style nits. Format: Severity, File:line, Issue, Why it matters." })
```
Read its findings before issuing a verdict. Skip for typos/one-liners.

**1. Build Check**
```bash
npm run build 2>&1 | tail -20
```
Zero errors required. Note warnings.

**2. Type Safety**
```bash
npm run typecheck 2>/dev/null || npx tsc --noEmit 2>/dev/null
```
Zero type errors required.

**3. Test Suite**
```bash
npm test -- --passWithNoTests --watchAll=false 2>/dev/null
```
All tests pass. Report: X passed, Y failed, Z skipped.

**4. Code Hygiene Scan**
```bash
grep -rn "console\.log\|console\.warn\|debugger\|TODO\|FIXME\|HACK" src/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v "\.test\." | head -20
```
Report count and locations. console.error is acceptable.

**5. UI Quality Scan**
```bash
grep -rn "text-white\|text-black\|bg-white\|bg-black\|text-gray-\|bg-gray-" src/ --include="*.tsx" | grep -v node_modules | head -20
grep -rn "<img\|<Image" src/ --include="*.tsx" | grep -v "width\|height\|fill" | head -10
```

**6. Diff Review**
```bash
git diff --stat
git diff --name-only
```
Only expected files modified. Flag unexpected changes.

**7. Verdict**

```
## Verification Result

| Check | Status | Notes |
|-------|--------|-------|
| Build | PASS/FAIL | |
| Types | PASS/FAIL | X errors |
| Tests | PASS/FAIL | X passed, Y failed |
| Hygiene | PASS/WARN | X debug statements |
| UI Quality | PASS/WARN | X hardcoded colors |
| Diff | PASS/WARN | X files modified |

**Overall: PASS / FAIL**
```

If PASS: "Ready for commit."
If FAIL: list specific items to fix.

## Quality Framework Reference

Apply principles from related skills when reviewing:

| Skill | Check For |
|-------|-----------|
| `standards` | Type safety, design tokens, all UI states, React patterns |
| `design` | Avoid AI slop (no purple gradients, no Inter/Roboto) |
| `security` | Secrets, RLS, input validation, XSS |

## The Standard

Would a senior developer approve this PR? If not, improve it.
