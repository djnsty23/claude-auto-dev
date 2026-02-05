---
name: code-quality
description: Learned patterns from production - loaded with auto/review/build
user-invocable: false
---

# Code Quality Rules

Patterns learned from production. Violation = failed task.

## Type Safety Patterns

| Rule | Wrong | Right |
|------|-------|-------|
| Single source | Define type in 3 files | Define once, import |
| Complete Records | Missing union members | Include ALL members |
| Supabase typing | Untyped `.insert()` | Cast to `Database['table']['Insert']` |
| Safe access | `obj[key]` | `'key' in obj && ...` |

## React Patterns

| Rule | Wrong | Right |
|------|-------|-------|
| Nested interactives | `<button><button>` | Use `role="button"` |
| Hooks in callbacks | `onClick={() => useState()}` | Hooks at top level |
| Conditional hooks | `if (x) useEffect()` | `useEffect(() => { if (x) })` |

## Error Handling

```typescript
// Auth errors
if (error?.error_type === 'reauth_required') {
  toast.error('Session expired');
}

// Storage quota
try {
  localStorage.setItem(key, value);
} catch (e) {
  if (e.name === 'QuotaExceededError') {
    toast.error('Storage full');
  }
}
```

## Query Keys

```typescript
export const queryKeys = {
  reports: {
    all: ['reports'] as const,
    detail: (id: string) => ['reports', id] as const,
  }
} as const;
```

## Mistake Logging

Log errors to `.claude/mistakes.md`:

```markdown
## [Category]: [Description]
**Task:** ID
**Error:** What
**Fix:** How
**Prevention:** Rule
```

Categories: `Type Safety`, `React`, `API`, `Performance`, `A11y`
