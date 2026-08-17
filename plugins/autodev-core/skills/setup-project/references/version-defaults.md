# Version Defaults (updated 2026-08-17)

Safe choices for greenfield projects. Pin with caret ranges.

**How these were set.** Each row was checked against the npm registry on the date
above, not against memory. Where a major had turned over, the deciding evidence was
the age of the new major and whether the previous one is still being patched — a
previous major that stopped receiving releases means the ecosystem has moved and
staying put is the risk. `next` + `react` + `typescript` were additionally proven by
scaffolding an app on these exact pins and running `tsc --noEmit` and `next build`
to completion under `strict`, `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. Re-check with `npm run check:versions`.

| Package | Version | Risk |
|---------|---------|------|
| next | ^16.3 | Stable. v16 shipped 2025-10, ~10 months seasoned; 15.x still patched but is now the trailing line |
| react / react-dom | ^19.2 | Mature |
| typescript | ^7.0 | **Verified, not assumed** — typechecks a Next 16 app clean under the strict flags above. v7 is young (Jul 2026), so if a project hits a compiler regression, ^6.0 is the fallback |
| tailwindcss | ^4.3 | Stable v4, uses `@theme` not a config file |
| @biomejs/biome | ^2.5 | Stable. Exclude CSS (Tailwind v4) |
| @supabase/supabase-js | ^2.112 | Mature v2 |
| @supabase/ssr | ^0.12 | Pre-1.0 but stable API |
| zod | ^4.4 | v4 has been out since Jul 2025 and v3 stopped getting releases the day after — v3 is the risk now, not v4 |
| shadcn CLI | ^4.18 | Requires Tailwind v4 |
| pnpm | 11.x | Set in `packageManager`. v10 is still patched, so 10.x is a safe fallback on a machine that has not upgraded |
| vitest | ^4.1 | Stable |
| @playwright/test | ^1.62 | Stable v1 |
| stripe (Node) | ^22.5 | v22 since Apr 2026; v21 has had no release since |
| lucide-react | ^1.31 | Stable |
| @trigger.dev/sdk | ^4.5 | Stable v4 |
| drizzle-orm | ^0.45 | Pre-1.0, pin exact minor |
| @sentry/nextjs | ^10.70 | Stable v10 |
| posthog-js | ^1.417 | Stable v1 |
| ai (AI SDK) | ^7.0 | v7 since Jun 2026, **but v6 is still actively patched** — unlike the other majors here, this is a live dual track. Prefer v7 for greenfield; do not rush an existing v6 app across |
| @ai-sdk/react | ^4.0 | Versioned on its own line, not in step with `ai` — check both before pinning |

## Why this file rots silently

Every "too fresh" note is a judgment with an expiry date, and nothing about a stale
one looks wrong on the page. The April 2026 edition of this table called TS 6 too
fresh and pinned ^5.8; by August that pin was two majors behind, and no grep, lint
or test could see it — the file was internally consistent and entirely wrong.

That is what `tooling/check-version-drift.js` exists for. It is the only detector
here that reads something outside the repo, because staleness of this kind is not
visible from inside it.
