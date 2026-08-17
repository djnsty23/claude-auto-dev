---
name: standards
description: The conventions this project holds code to — UI state completeness, design tokens, type-safety boundaries, query-key shape, and the anti-patterns to flag on sight.
when_to_use: "Background knowledge, loaded automatically when writing or reviewing TypeScript/React code. Not user-invocable."
user-invocable: false
allowed-tools: Read, Grep, Glob
model: opus
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
---

# Code Standards

This skill is auto-loaded on every code file, so it stays short on purpose. It
holds only the **decisions this project made** — not general React or
accessibility advice, which you already have.

> **`.claude/project-rules.md` outranks this file.** If it exists, read it and
> follow it wherever the two disagree — it was measured from this codebase,
> while everything below is a shipped default. Run `/autodev-init` to generate
> it. Where a convention appears under "Undecided" there, do not flag either
> form in review.

Three bars, in order: **correct** (types pass, it works), **clear** (matches
surrounding patterns), **complete** (handles reality, not just the happy path).

## All UI states

Every component that fetches handles all four:

```tsx
if (isLoading) return <Skeleton />;
if (error)     return <ErrorState message={error.message} />;
if (!data?.length) return <EmptyState />;
return <Content data={data} />;
```

A component that renders only the success path is incomplete here even when it
compiles. This is the single most common review finding in this codebase.

## Type-safety boundaries

- No `any`. No `as unknown as Type` on data from a database, an API, or a user —
  validate the shape with Zod at the boundary instead.
- `fetch()` always checks `res.ok` and sits inside try/catch. A fire-and-forget
  fetch is a bug, not a style choice.

## Query keys

Centralised and `as const`, never inline string arrays:

```typescript
export const queryKeys = {
  reports: {
    all: ['reports'] as const,
    detail: (id: string) => ['reports', id] as const,
  }
} as const;
```

## Design system

Semantic tokens only (`text-foreground`, `bg-background`, `text-muted-foreground`)
and the spacing scale (`p-4`, never `p-[15px]`). Reuse components and add
variants rather than forking them. `rule-design-system` has the token
definitions and the one exception.

## Anti-patterns — flag these on sight

**Security and data safety**
- Fail-open auth. `if (!session) redirect` must be the default; `if (session) allow` is backwards.
- Any `/dashboard/*` or `/api/*` route not covered by the auth middleware.
- SSRF: user-supplied URLs fetched without validating against private IP ranges.

**Accessibility**
- `user-scalable=no` or `maximum-scale=1`.
- `outline-none` with no `focus-visible` replacement.
- `transition: all`.
- Hardcoded date and number formats — use `Intl.*`.

**Design**
- Hardcoded colors or arbitrary spacing values.

## Mistake logging

When a review or a fix catches something that should not have shipped, append it
to `.claude/mistakes.md` so the pattern is greppable next time:

```markdown
## [Category]: [Description]
**Task:** ID
**Error:** What
**Fix:** How
**Prevention:** Rule
```

Categories: `Type Safety`, `React`, `API`, `Performance`, `A11y`.

## Proving the run

**Observable:** violations by category, next to the number of files scanned.

```bash
rg -l "…" --glob "**/*.tsx" | wc -l    # the denominator, always reported
```

Zero violations across 4 files and zero across 400 are different results printed
the same way. State the denominator. When a category returns nothing, confirm the
pattern can match at all by running it against a file you know violates it —
otherwise a typo'd pattern reports a clean codebase.
