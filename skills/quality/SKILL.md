---
name: quality
description: Quality standards reference (not user-invocable)
user-invocable: false
---

# Quality Standards

These standards apply to ALL work done by this system.

## Task Metadata Schema

All stories created by audit/brainstorm/sprint MUST use this metadata:
```
metadata: {
  sid: "[PREFIX]-[NNN]",     // e.g. TSF-001
  sprint: "[sprint-name]",   // e.g. sprint-1
  epic: "[epic name]",       // e.g. Type Safety Fixes
  priority: [1-3],           // 1=critical, 2=important, 3=nice
  category: "[category]",    // auth|ui|perf|security|qa|infra
  type: "[type]",            // feature|fix|qa|security|polish
  passes: null,              // null → true/false after verify
  verified: null             // null → "build"|"test"|"browser"
}
```

## Non-Negotiable
1. `npm run typecheck` MUST pass before any task is marked complete
2. `npm run build` MUST pass before any task is marked complete
3. No `as any` - use proper types, generics, or `unknown` with type guards
4. No `@ts-ignore` or `@ts-expect-error`
5. No `console.log` in production code (use proper logging)
6. No hardcoded secrets, API keys, or credentials
7. All user inputs validated with Zod at system boundaries
8. Supabase tables MUST have RLS policies

## Code Style
- TypeScript strict mode
- Functional React components with hooks
- Tailwind CSS with semantic tokens (not inline colors)
- Handle all UI states: loading, error, empty, success
- Error boundaries around feature areas
- Proper error messages (not generic "Something went wrong")

## Testing
- If modifying a function, verify it works (build + typecheck minimum)
- If adding a feature, it should be testable
- If fixing a bug, the fix should prevent regression
- Browser test critical user flows when touching UI

## Do It Right
- Read existing code before changing it
- Follow existing patterns in the codebase
- One concern per commit
- Don't over-engineer, but don't cut corners
- If unsure, investigate first rather than guessing
