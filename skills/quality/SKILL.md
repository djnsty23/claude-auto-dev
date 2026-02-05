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

## Frontend Engineering (REQUIRED)

Apply these rules to all web UI code:

### Accessibility
- `<button>` for actions, `<a>`/`<Link>` for navigation (never `<div onClick>`)
- Icon-only buttons need `aria-label`
- Form controls need `<label>` or `aria-label`
- Images need `alt` (or `alt=""` if decorative)
- Interactive elements need `onKeyDown`/`onKeyUp` handlers

### Focus & Interaction
- Visible focus: `focus-visible:ring-*` (never `outline-none` without replacement)
- Hover states on all interactive elements
- `touch-action: manipulation` on touch targets

### Forms
- Correct `type` and `inputmode` on inputs
- `autocomplete` on form fields
- Never block paste
- Errors inline next to fields; focus first error on submit
- Disable spellcheck on emails, codes, usernames

### Animation
- Honor `prefers-reduced-motion`
- Only animate `transform`/`opacity` (compositor-friendly)
- Never `transition: all` - list properties explicitly
- Animations must be interruptible

### Hydration Safety (Next.js/RSC)
- Inputs with `value` need `onChange` (or use `defaultValue`)
- Guard date/time rendering against hydration mismatch
- Server Components by default; `'use client'` only for state/effects/handlers

### Images & Performance
- `<img>` needs explicit `width` and `height` (prevents CLS)
- Below-fold: `loading="lazy"`; above-fold: `priority` or `fetchpriority="high"`
- Large lists (50+): virtualize with `virtua` or `content-visibility: auto`

### Anti-Patterns (Always Flag)
- `user-scalable=no` or `maximum-scale=1`
- `transition: all`
- `outline-none` without focus-visible replacement
- `<div>`/`<span>` with click handlers (should be `<button>`)
- Images without dimensions
- Form inputs without labels
- Hardcoded date/number formats (use `Intl.*`)

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
