---
name: Code Quality Rules
description: Learned patterns from production - prevents recurring mistakes
triggers: [auto, build, review]
---

# Code Quality Rules

These rules are learned from production mistakes. Violation = failed task.

## Type Safety (Critical)

| Rule | Wrong | Right |
|------|-------|-------|
| Single source of truth | Define `User` in 3 files | Define in `types/user.ts`, import everywhere |
| Complete Records | `Record<Status, Color>` missing members | Include ALL union members, use exhaustive check |
| Supabase typing | `.insert(data)` untyped | `.insert(data as Database['table']['Insert'])` |
| Enum arithmetic | `"high" + 1` | `tierToNumber(tier) + 1` |
| Safe property access | `obj[key]` | `'key' in obj && typeof obj[key] === 'string'` |

## React Patterns (Critical)

| Rule | Wrong | Right |
|------|-------|-------|
| Nested interactives | `<button><button></button></button>` | `<button><div role="button"></div></button>` |
| Hooks in callbacks | `onClick={() => { useState() }}` | `const [x, setX] = useState()` at top |
| Conditional hooks | `if (x) { useEffect() }` | `useEffect(() => { if (x) {...} })` |

## Error Handling (Required)

```typescript
// ALWAYS detect auth errors
if (error?.error_type === 'reauth_required') {
  toast.error('Session expired. Please sign in again.');
  // Trigger re-auth flow
}

// ALWAYS catch storage quota
try {
  localStorage.setItem(key, value);
} catch (e) {
  if (e instanceof DOMException && e.name === 'QuotaExceededError') {
    toast.error('Storage full');
  }
}
```

## Component Architecture

| Pattern | Guideline |
|---------|-----------|
| File size | >300 lines = consider splitting |
| Props | Type all props with interface |
| State | Co-locate with consumer, lift only when shared |
| Effects | One concern per effect |
| Memoization | useMemo for expensive calcs, useCallback for stable refs |

## Design Tokens (Mandatory)

```tsx
// WRONG - hardcoded colors
<div className="text-red-500 bg-green-100">

// RIGHT - semantic tokens
<div className="text-destructive bg-success/10">
```

All colors via CSS variables: `hsl(var(--primary))`

## Query Keys (Required Pattern)

```typescript
// Use factory pattern for cache keys
export const queryKeys = {
  reports: {
    all: ['reports'] as const,
    detail: (id: string) => ['reports', id] as const,
    list: (filters: Filters) => ['reports', 'list', filters] as const,
  }
} as const;
```

## Mistake Logging Format

When errors occur, log to `.claude/mistakes.md`:

```markdown
## [Category]: [Brief Description]
**Date:** YYYY-MM-DD
**Task:** TASK-ID
**Error:** What went wrong
**Root Cause:** Why it happened
**Fix Applied:** How it was resolved
**Prevention:** Rule to add
```

Categories: `Type Safety`, `React Violation`, `API Integration`, `Performance`, `Accessibility`
