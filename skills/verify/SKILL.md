---
name: verify
description: Verifies work completeness with outcome-focused checks. Use after implementing features to ensure quality.
triggers:
  - verify
allowed-tools: Bash, Read, Grep, Glob, TaskUpdate, TaskList
model: sonnet
user-invocable: true
---

# Verify

Confirm the work is done well, not just done.

## Quick Verification

```bash
npm run typecheck && npm run build
```

If these fail, fix them first. No exceptions.

## What "Complete" Means

A task is complete when:

1. **It works.** Build passes, types check, feature functions.

2. **It solves the actual problem.** Not just the literal requirements, but the underlying need.

3. **It's production-ready.** Handles errors, edge cases, and real-world conditions.

## Beyond Acceptance Criteria

Acceptance criteria are the **minimum**. If you see opportunities to:
- Make the UX better
- Improve performance
- Add helpful error messages
- Fix related issues you discover

**Do it.** A capable developer doesn't stop at "meets requirements."

## For UI Tasks

Verify visually:
- Does it look right at desktop AND mobile (375px)?
- Do all states work? (loading, error, empty, content)
- Is sidebar hidden on mobile with a toggle/hamburger?
- Do grids stack to single column on mobile?
- No horizontal overflow or clipped content?

Use `agent-browser` for verification when helpful:
```bash
# Detect running dev server port
for port in 3000 3001 5173 8080; do
  curl -s http://localhost:$port > /dev/null && break
done

agent-browser open http://localhost:$port/path
agent-browser snapshot -i
```

## Marking Complete

**PASS:**
```
TaskUpdate({
  taskId: "[id]",
  status: "completed",
  metadata: { passes: true, verified: "build" }
})
```

**FAIL:**
- Report what's wrong
- Keep task in_progress
- Fix and re-verify

## Verification Checklist

Run each check in order. Stop and fix on any FAIL.

### 1. Build Check
```bash
npm run build 2>&1 | tail -20
```
Must complete with zero errors. Warnings are acceptable but note them.

### 2. Type Safety
```bash
npm run typecheck 2>/dev/null || npx tsc --noEmit 2>/dev/null
```
Zero type errors required.

### 3. Test Suite
```bash
npm test -- --passWithNoTests --watchAll=false 2>/dev/null
```
All tests must pass. Report: X passed, Y failed, Z skipped.

### 4. Code Hygiene Scan
```bash
# Find leftover debug statements
grep -rn "console\.log\|console\.warn\|debugger\|TODO\|FIXME\|HACK" src/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v "\.test\." | head -20
```
Report count and locations. console.error is acceptable.

### 5. UI Quality Scan
```bash
# Hardcoded colors (should use tokens)
grep -rn "text-white\|text-black\|bg-white\|bg-black\|text-gray-\|bg-gray-\|text-red-\|bg-red-\|text-blue-\|bg-blue-" src/ --include="*.tsx" | grep -v node_modules | head -20

# Missing loading states (async without loading)
grep -rn "useQuery\|useMutation\|useState.*loading\|isLoading" src/ --include="*.tsx" --include="*.ts" | head -10

# Images without dimensions
grep -rn "<img\|<Image" src/ --include="*.tsx" | grep -v "width\|height\|fill" | head -10
```

### 6. Diff Review
```bash
# Review uncommitted changes
git diff --stat
git diff --name-only
```
Check that only expected files were modified. Flag unexpected changes.

### 7. Verdict

Output this table after running all checks:

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

[If FAIL: list specific items to fix before shipping]
[If PASS: "Ready for commit. Say 'commit' to proceed."]
```

## Report Format

```
Verify: [task-id] - [title]
═══════════════════════════
Build: ✓
Types: ✓
Works: ✓

Result: PASS

Extras: [Any improvements made beyond requirements]
Next: [next-task-id] - [title]
```

## The Standard

**Would a senior developer approve this PR?**

If yes, it's done. If no, improve it.

Don't just tick boxes. Ensure the solution is genuinely good.
