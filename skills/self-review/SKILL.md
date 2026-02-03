---
name: self-review
description: Multi-pass verification before completing any task - auto-applied
user-invocable: false
---

# Self-Review Protocol

Every task requires MULTIPLE verification passes before completion.

## The Three-Pass Rule

### Pass 1: Implementation
- Write the code
- Get it working (builds, no errors)
- Basic functionality verified

### Pass 2: Quality Review
Re-read your changes and check:
- [ ] Matches existing code style?
- [ ] No hardcoded values?
- [ ] All states handled (loading/error/empty)?
- [ ] No copy-paste code?
- [ ] Meaningful variable names?
- [ ] Would you approve this PR?

### Pass 3: Edge Case Audit
For each change, ask:
- What if the input is null/undefined?
- What if the array is empty?
- What if the API fails?
- What if the user double-clicks?
- What if the data is huge?
- What if the network is slow?

**Fix issues found in Pass 2 & 3 before proceeding.**

## Verification Commands

Always run before marking complete:

```bash
# TypeScript check
npm run typecheck

# Build check
npm run build

# If tests exist
npm test

# Check for common issues
grep -r "console.log" src/ --include="*.ts" --include="*.tsx" | grep -v test
grep -r "any" src/ --include="*.ts" --include="*.tsx" | head -10
```

## UI Verification

For any UI change, verify:

### Visual Checklist
- [ ] Looks correct at mobile width (320px)
- [ ] Looks correct at tablet width (768px)
- [ ] Looks correct at desktop width (1280px)
- [ ] Loading state displays correctly
- [ ] Error state displays correctly
- [ ] Empty state displays correctly
- [ ] Hover/focus states work
- [ ] No layout shift on state change

### Accessibility Check
- [ ] Color contrast sufficient?
- [ ] Keyboard navigable?
- [ ] Screen reader friendly?
- [ ] Touch targets large enough?

## Code Verification

### Before Each Edit
- Did I read the file first?
- Do I understand what this code does?
- Will my change break anything else?

### After Each Edit
- Does the change do what I intended?
- Did I introduce any regressions?
- Is the code cleaner than before (or at least not worse)?

## Common Bugs to Check

### React
- [ ] Missing dependency in useEffect array
- [ ] State update on unmounted component
- [ ] Key prop missing in lists
- [ ] Event handler not memoized (if needed)

### TypeScript
- [ ] Optional chaining where needed (`?.`)
- [ ] Null checks before accessing properties
- [ ] Proper error type narrowing

### API/Data
- [ ] Loading state while fetching
- [ ] Error handling on failure
- [ ] Empty state when no data
- [ ] Stale data handled (refetch/invalidate)

## The "Ship It" Checklist

Before saying a task is complete:

1. **Builds?** `npm run build` passes
2. **Types?** `npm run typecheck` passes
3. **Tests?** Existing tests still pass
4. **Visual?** UI looks correct in all states
5. **Edge cases?** Handled null, empty, error
6. **Code quality?** Would approve your own PR
7. **Documentation?** Complex logic has comments

## When to Ask for Help

If after 3 attempts you can't:
- Fix a failing build
- Understand existing code
- Make tests pass
- Get the UI right

**Stop and ask the user** rather than:
- Deleting "broken" code
- Adding workarounds
- Commenting out errors
- Using `any` or `@ts-ignore`

## Summary

```
Write → Review → Test → Fix → Review → Ship

NOT:

Write → Ship → User complains → Fix → Ship → User complains...
```

The goal is: **User never has to point out obvious issues.**
