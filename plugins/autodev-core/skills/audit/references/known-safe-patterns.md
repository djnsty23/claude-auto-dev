# Framework Counterexamples — Verify the Preconditions

These patterns have been misidentified as bugs. Use them to challenge a
syntactic finding, then inspect the actual framework/version and behavior. They
do not exempt a file, API or route from a different demonstrated defect.

## shadcn / Radix / Base UI

- A label wrapping a labelable native input can supply its accessible name.
  `htmlFor` must resolve to the correct control ID.
- For wrapped framework checkboxes, inspect the rendered semantics and effective
  accessible name; a React component called `Checkbox` alone proves neither.

## React 19 + Next.js App Router

- `'use server'` files without top-level `await` — async boundary is per-function, the file-level marker is fine.
- `<form action={serverAction}>` — doesn't need `onSubmit`. The action prop IS the handler.
- `next/image` can omit explicit dimensions with `fill` or dimensions inferred
  from a static import. A relatively positioned parent alone is insufficient.
  Check the installed version’s [Image contract](https://nextjs.org/docs/app/api-reference/components/image)
  and measured layout; CSS-reserved dimensions can also prevent ordinary image CLS.

## Supabase

- `auth.uid() = user_id` can be a valid ownership predicate. Verify the column,
  roles, operation, grants, other permissive policies and `WITH CHECK` behavior.
  That expression alone is not proof of private-row protection.

## Style / Design tokens

- `text-[#1a1a1a]` arbitrary Tailwind value — only flag as hardcoded if a matching token exists. On gradient/brand surfaces, literal hex is acceptable.

## Logging

- CLI results, structured hook protocol output and intentional diagnostics may
  use any console method. Flag demonstrated secret leakage, broken output
  contracts or unnecessary noise, not the method name. `console.error` can leak
  secrets too; nonblocking hooks may intentionally emit nothing.

## Type assertions

- `as const` is not an unsafe runtime validation bypass. For `as any` or double
  casts, inspect provenance and the effective validation boundary; show the
  reachable bad input rather than treating every occurrence as a defect.

## Test scaffolding

- Minimal test markup and casts can be intentional scaffolding. Do not flag
  fixture-only accessibility omissions as product bugs. Still inspect useful
  assertions, wrong fixtures, runtime errors and falsely passing test paths.

## Type declarations

- Declaration files describe contracts rather than runtime implementations.
  Review incorrect public types or conflicting declarations; avoid applying
  runtime-only checks to them.

## Post-processing rule

Dismiss a finding only when its claimed defect is refuted by verified safe
preconditions or a passing behavioral control. Record the reason and scope.
Retain distinct reproducible failures even when the same file contains one of
these patterns; do not use a substring whitelist as the verdict.
