# Known-Safe Framework Patterns — Do Not Flag

These are patterns audit agents have historically misidentified as bugs. Include this list under a "SKIP — NOT A BUG" section in every audit agent prompt.

## shadcn / Radix / Base UI

- `<label><input /></label>` — implicit label nesting. Accessible. Same for `<Label htmlFor>`.
- `<label><Checkbox /> Text</label>` — shadcn's canonical pattern, not a violation.

## React 19 + Next.js App Router

- `'use server'` files without top-level `await` — async boundary is per-function, the file-level marker is fine.
- `<form action={serverAction}>` — doesn't need `onSubmit`. The action prop IS the handler.
- `next/image` without explicit `width`/`height` — valid when `fill` prop is set or the image has a `position: relative` parent.

## Supabase

- `auth.uid() = user_id` in RLS `USING` clause — correct pattern, not a bug.

## Style / Design tokens

- `text-[#1a1a1a]` arbitrary Tailwind value — only flag as hardcoded if a matching token exists. On gradient/brand surfaces, literal hex is acceptable.

## Logging

- `console.error` — acceptable in production. Flag only `console.log`, `console.debug`, `console.warn` leftovers.

## Type assertions

- `as const` — not an unsafe cast. Flag only `as any` and `as unknown as`.

## Test scaffolding

- `.test.*` and `.spec.*` files — skip strict type and a11y checks. Minimal markup, `any`, and `!` are acceptable for tests.

## Type declarations

- `.d.ts` files — skip all checks except unused declarations.

## Post-processing rule

If an agent flags one of these patterns, drop the finding during aggregation before writing to prd.json. Don't argue with the agent, just filter.
