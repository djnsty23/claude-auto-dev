---
name: quality
description: Core principles - guides judgment on what "good" means
user-invocable: false
model: sonnet
---

# Quality Principles

Senior developer judgment. What makes code "good"?

## Core Standards

1. **Correct** - It works. Types pass, builds succeed, features function.
2. **Clear** - Easy to read. Names obvious, flow simple, matches patterns.
3. **Complete** - Handles reality. Errors, edge cases, all UI states.

## All UI States (REQUIRED)

Every component: `loading → error → empty → content`

```tsx
if (isLoading) return <Skeleton />;
if (error) return <ErrorState message={error.message} />;
if (!data?.length) return <EmptyState />;
return <Content data={data} />;
```

## Responsive Layout (REQUIRED)

Every page must work at 3 breakpoints: mobile (375px), tablet (768px), desktop (1280px+).

- **Sidebars**: Hidden or collapsible on mobile (`md:block hidden`)
- **Grids**: Stack to single column on mobile (`grid-cols-1 md:grid-cols-2 lg:grid-cols-3`)
- **Navigation**: Hamburger menu or bottom nav on mobile
- **Touch targets**: Minimum 44x44px on mobile
- **Text**: No horizontal overflow, no clipped content
- **Modals/Drawers**: Full-screen on mobile, centered on desktop

```tsx
// Sidebar pattern
<aside className="hidden md:block md:w-64">...</aside>
<main className="flex-1">...</main>

// Mobile menu toggle
const [open, setOpen] = useState(false);
<Button className="md:hidden" onClick={() => setOpen(!open)} />
```

## Type Safety

- No `any`
- No `@ts-ignore`
- Types are documentation

## Design System

- Semantic tokens only (`text-foreground`, not `text-gray-500`)
- Spacing scale (`p-4`, not `p-[15px]`)
- Reuse components

## The Standard

**Would you approve this PR?** If not, improve it.

## Token Efficiency

Be concise. Short responses = more runway.
- Don't repeat file contents
- Don't explain what you're about to do
- Just do it, report briefly
