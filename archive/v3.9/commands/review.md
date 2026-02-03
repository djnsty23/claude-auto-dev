---
description: Comprehensive code quality and type safety audit
---

# Review Mode

Run a comprehensive audit of the codebase to catch issues before they accumulate.

## What to Check

### 1. Type Safety (CRITICAL)
```bash
npm run typecheck 2>&1 | head -100
```

Look for:
- `as any` usage (should be 0)
- Implicit `any` types
- Missing type annotations
- Type mismatches between interfaces

### 2. Build Health
```bash
npm run build 2>&1
```

Verify:
- No compilation errors
- No unused exports warnings
- Bundle size reasonable

### 3. Code Quality Scan

Search for anti-patterns:
```
- console.log (should use proper logging)
- TODO/FIXME comments (should be in prd.json)
- Hardcoded values (should be constants)
- Duplicate code blocks
```

### 4. Type Consistency Audit

Check for conflicting type definitions:
```typescript
// BAD: Multiple DateRange definitions
// src/types/reports.ts: { from: Date; to: Date }
// src/types/data-globe.ts: { from: string; to: string }

// GOOD: Single source of truth
// src/types/common.ts exports DateRange
```

### 5. Interface Property Audit

For each major interface, verify:
- All properties used in code actually exist in interface
- Optional properties marked with `?`
- No `as unknown as` type casts

## Output Format

Generate a report like:

```markdown
# Code Review Report

## Type Safety: ✅/❌
- [ ] No `as any` usage
- [ ] All functions have return types
- [ ] Interfaces match runtime data

## Build Health: ✅/❌
- [ ] Build passes
- [ ] No warnings
- [ ] Bundle size < X MB

## Issues Found:
1. [CRITICAL] File:line - Description
2. [WARNING] File:line - Description
3. [INFO] File:line - Description

## Recommendations:
1. Create src/types/common.ts for shared types
2. Add type guards in src/lib/type-guards.ts
3. Run typecheck in CI pipeline
```

## Auto-Fix Mode

If issues are found, offer to fix them:

```
Found 5 type issues. Fix now? (y/n)
```

If yes:
1. Fix each issue
2. Re-run typecheck
3. Commit with message: "fix: Resolve type safety issues from review"
