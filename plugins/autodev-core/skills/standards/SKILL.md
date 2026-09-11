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

This skill is auto-loaded on the JavaScript and TypeScript paths above, so it stays short on purpose. It
holds only the **decisions this project made** — not general React or
accessibility advice, which you already have.

> **Current user instructions and repository guidance still apply.**
> `.claude/project-rules.md` overrides the shipped defaults in this file. If it exists, read it and
> follow it wherever the two disagree — it was measured from this codebase,
> while everything below is a shipped default. Run `/autodev-init` to generate
> it. Where a convention appears under "Undecided" there, do not flag either
> form in review.

Three bars, in order: **correct** (types pass, it works), **clear** (matches
surrounding patterns), **complete** (handles reality, not just the happy path).

## All UI states

Every user-facing fetch has loading, error, empty and content behavior at the
appropriate component or shared boundary. For list data, for example:

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
  validate the shape with the project’s runtime validator (for example Zod).
- Handle HTTP failure (`res.ok` or the API’s explicit status contract) and
  rejected promises at a named boundary. A shared handler or deliberately
  best-effort telemetry path can be valid; prove its failure behavior rather
  than requiring a local try/catch at every call.

## Query keys

Centralised and `as const`, never inline string arrays:

```typescript
export const queryKeys = {
  reports: {
    all: (accountId: string) => ['reports', accountId] as const,
    detail: (accountId: string, id: string) => ['reports', accountId, id] as const,
  }
} as const;
```

For account-scoped data, test account switching/invalidation as well as key
shape. Public global data need not carry an account key. Keys do not replace
server-side authorization.

## Design system

Semantic tokens only (`text-foreground`, `bg-background`, `text-muted-foreground`)
and the spacing scale (`p-4`, never `p-[15px]`). Reuse components and add
variants rather than forking them. `rule-design-system` has the token
definitions and the one exception.

## Anti-patterns — flag these on sight

**Security and data safety**
- Protected operations without effective deny-by-default authorization. A
  positive `if (session)` guard is valid when its remaining paths deny access.
- Protected routes reachable without the intended auth/role checks. Public APIs
  and signed webhooks have different contracts; middleware presence alone
  proves neither authorization nor a defect.
- SSRF: user-supplied URLs fetched without validating against private IP ranges.

**Accessibility**
- `user-scalable=no` or `maximum-scale=1`.
- `outline-none` with no `focus-visible` replacement.
- Motion that ignores the relevant reduced-motion setting or disrupts use;
  `transition: all` alone is not an accessibility violation.
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

Enumerate the files in scope separately from matches, using `rg --files` with
the relevant globs and exclusions. Then run the detector on that population and
record matching files/locations. `rg -l PATTERN` counts matching files, not
scanned files; exit 1 means no matches and exit 2 means the search failed.

Zero violations across 4 files and zero across 400 are different results printed
the same way. State the denominator. When a category returns nothing, confirm the
pattern can match at all by running it against a file you know violates it —
otherwise a typo'd pattern reports a clean codebase.
