---
name: code-quality
description: Learned patterns from production including React/Next.js best practices. Auto-loaded with auto, review, and build.
user-invocable: false
allowed-tools: Read, Grep, Glob
model: sonnet
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

## React/Next.js Patterns

Based on [Vercel's React Best Practices](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices) (57 rules, 8 categories).

### Optimization Priority (In Order)

**Fix these first - they have the biggest impact:**

1. **Eliminate Waterfalls** - Parallel async operations
2. **Reduce Bundle Size** - Less JS = faster loads
3. **Server Performance** - Optimize data fetching
4. **Client Data Fetching** - Efficient state management
5. **Re-render Optimization** - Last priority (often premature)

> "If a request waterfall adds 600ms of waiting time, it doesn't matter how optimized your `useMemo` calls are."

### 1. Eliminate Waterfalls (CRITICAL)

```typescript
// Bad - sequential (600ms)
const user = await getUser(id);
const posts = await getPosts(id);

// Good - parallel (200ms)
const [user, posts] = await Promise.all([getUser(id), getPosts(id)]);
```

- Use `Promise.all()` for independent operations
- Use `React.cache()` for per-request deduplication
- Wrap slow components in `<Suspense>` for streaming
- Preload data at route level, not component level

### 2. Bundle Size (CRITICAL)

```typescript
// Bad - imports entire library
import { format } from 'date-fns';

// Good - direct import
import format from 'date-fns/format';
```

- Avoid barrel files (`index.ts` re-exports) - they prevent tree-shaking
- Dynamic import heavy components: `dynamic(() => import('./Chart'), { ssr: false })`
- Analyze with `@next/bundle-analyzer` or `npx source-map-explorer`
- Mark client-only code with `'use client'` as low as possible

### 3. Server Performance (HIGH)

- Server Components by default. Only `'use client'` when you need state/effects/handlers
- Use `React.cache()` to deduplicate identical server-side fetches
- Add `Cache-Control` headers for static data
- Avoid serializing large objects across server/client boundary

### 4. Client Data Fetching (MEDIUM)

- Deduplicate with SWR or React Query (not raw `useEffect` + `fetch`)
- Use optimistic updates for mutations
- Prefer uncontrolled inputs for forms (controlled inputs re-render per keystroke)
- Add `staleTime` to avoid refetching on every mount

### 5. Re-render Optimization (LOW - do last)

```typescript
// Bad - new object every render
<Child style={{ color: 'red' }} />

// Good - stable reference
const style = useMemo(() => ({ color: 'red' }), []);
<Child style={style} />
```

- Lift state up only as far as needed
- Use `useCallback` for handlers passed to memoized children
- Split context providers by update frequency
- Lazy state initialization: `useState(() => expensiveComputation())`

### 6. Rendering Performance

- Large lists (50+ items): virtualize with `virtua` or `content-visibility: auto`
- No layout reads in render (`getBoundingClientRect`, `offsetHeight`)
- Batch DOM reads/writes; avoid interleaving
- Use CSS for animations (`transform`/`opacity` only)

### 7. Component Architecture

```tsx
// Bad - boolean prop explosion
<Card isCompact isHighlighted hasBorder isClickable />

// Good - composition
<Card variant="compact">
  <Card.Highlight>Content</Card.Highlight>
</Card>
```

- Prefer composition over boolean props
- Create explicit variant components instead of boolean modes
- Use compound components with shared context for complex UI
- Eliminate `forwardRef` (React 19+), use `use()` instead of `useContext()`

### When Reviewing React Code

Check in this order:

1. **Sequential awaits that could be parallel?**
2. **Barrel imports or large unconditional imports?**
3. **Client code that could be server code?**
4. **Missing Suspense boundaries?**
5. **Expensive computations not memoized?**
6. **Re-renders from object/array identity issues?**
7. **Large lists without virtualization?**

### Quick Wins

| Pattern | Impact | Effort |
|---------|--------|--------|
| `Promise.all` for parallel fetches | High | Low |
| Direct imports (no barrel files) | High | Low |
| Server Components for data display | High | Medium |
| Dynamic imports for modals/charts | High | Medium |
| `<Suspense>` for streaming | High | Medium |
| Lazy `useState` initializers | Medium | Low |
| SWR/React Query over raw fetch | Medium | Medium |
| `useMemo` for expensive calculations | Low | Low |

### Reference

Full guide: [vercel-labs/agent-skills/react-best-practices](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices)
