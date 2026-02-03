---
name: react-patterns
description: React/Next.js best practices - prioritized optimization patterns
user-invocable: false
model: sonnet
---

# React Best Practices

Based on [Vercel's React Best Practices](https://vercel.com/blog/introducing-react-best-practices).

## Optimization Priority (In Order)

**Fix these first - they have the biggest impact:**

1. **Eliminate Waterfalls** - Parallel async operations
2. **Reduce Bundle Size** - Less JS = faster loads
3. **Server Performance** - Optimize data fetching
4. **Client Data Fetching** - Efficient state management
5. **Re-render Optimization** - Last priority (often premature)

> "If a request waterfall adds 600ms of waiting time, it doesn't matter how optimized your `useMemo` calls are."

## Critical Patterns

### 1. Parallelize Async Operations

❌ **Bad - Sequential:**
```typescript
const user = await getUser(id);
const posts = await getPosts(id);
const comments = await getComments(id);
// Total: 600ms (200ms + 200ms + 200ms)
```

✅ **Good - Parallel:**
```typescript
const [user, posts, comments] = await Promise.all([
  getUser(id),
  getPosts(id),
  getComments(id),
]);
// Total: 200ms (all run simultaneously)
```

### 2. Lazy State Initialization

❌ **Bad - Runs on every render:**
```typescript
const [data, setData] = useState(JSON.parse(localStorage.getItem('data')));
```

✅ **Good - Runs once:**
```typescript
const [data, setData] = useState(() => JSON.parse(localStorage.getItem('data')));
```

### 3. Loop Consolidation

❌ **Bad - Multiple passes:**
```typescript
const active = users.filter(u => u.active);
const names = active.map(u => u.name);
const sorted = names.sort();
```

✅ **Good - Single pass:**
```typescript
const sortedActiveNames = users
  .reduce((acc, u) => {
    if (u.active) acc.push(u.name);
    return acc;
  }, [])
  .sort();
```

### 4. Server Components First

Use Server Components by default. Only add `'use client'` when you need:
- `useState`, `useEffect`, `useContext`
- Browser APIs (localStorage, window)
- Event handlers (onClick, onChange)

### 5. Dynamic Imports for Heavy Components

```typescript
const HeavyChart = dynamic(() => import('./HeavyChart'), {
  loading: () => <ChartSkeleton />,
  ssr: false, // If it uses browser APIs
});
```

## When Reviewing React Code

Check in this order:

1. **Are there sequential awaits that could be parallel?**
2. **Are large components being imported unconditionally?**
3. **Is there client code that could be server code?**
4. **Are expensive computations memoized?**
5. **Are re-renders caused by object/array identity issues?**

## Quick Wins

| Pattern | Impact | Effort |
|---------|--------|--------|
| `Promise.all` for parallel fetches | High | Low |
| Lazy `useState` initializers | Medium | Low |
| Dynamic imports for modals/charts | High | Medium |
| Server Components for data display | High | Medium |
| `useMemo` for expensive calculations | Low | Low |

## Reference

Full guide with 40+ rules: [github.com/vercel/react-best-practices](https://github.com/vercel/react-best-practices)
