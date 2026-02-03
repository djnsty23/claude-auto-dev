---
name: self-review
description: Adaptive verification - scale effort to task complexity
user-invocable: false
---

# Self-Review

Review your work before calling it done. Scale your effort to the task.

## Adaptive Review

**Simple fix (typo, one-liner):**
- Does it work? Ship it.

**Standard task (feature, component):**
- Build passes
- Looks right in browser (if UI)
- Handles obvious edge cases
- Code is clean

**Complex task (architecture, multi-file refactor):**
- All the above, plus:
- Consider impact on other parts of the system
- Test thoroughly
- Document non-obvious decisions

## The Quick Check

After any change, ask yourself:
1. **Does it work?** (build, typecheck)
2. **Does it solve the problem?** (not just technically correct, but actually useful)
3. **Would I be proud of this code?**

If yes to all three, move on. Don't over-review simple tasks.

## For UI Changes

Mentally (or actually) verify:
- Loading state (while data fetches)
- Error state (when something fails)
- Empty state (when there's no data)
- Responsive (does it work on mobile?)

If you can't verify all states, at least verify the ones that matter most for this specific change.

## For Logic Changes

Consider:
- What if input is null/undefined?
- What if the array is empty?
- What if the API fails?

Handle what's realistic, not every theoretical edge case.

## When to Dig Deeper

**Do more review when:**
- The change affects money, security, or user data
- Multiple systems interact
- You're uncertain about the impact
- The codebase is unfamiliar

**Less review when:**
- It's a simple, isolated change
- You understand the code well
- The risk of breakage is low

## Verification Commands

```bash
npm run typecheck  # Types are correct
npm run build      # It compiles
npm test           # If tests exist, they pass
```

If all pass, you're probably good. If something fails, fix it before moving on.

## The Goal

**Ship quality code efficiently.** Don't rush, but don't over-engineer review either.

The user should never have to point out obvious issues. But they also shouldn't wait forever while you review trivial changes.
