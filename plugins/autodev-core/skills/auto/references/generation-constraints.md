# Generation Constraints

Apply these before writing code, not after. They exist because each one has been an audit finding enough times to be worth enforcing up-front.

## TypeScript strictness

In strict projects with `exactOptionalPropertyTypes`, write optional props as `foo?: string | undefined`, not just `foo?: string`. Saves a retry cycle every time the compiler complains about the missing `| undefined` on assignment.

## Security & data safety

Each of these prevents a specific failure mode you've shipped before:

- **Every `fetch()` in a component has try/catch and `res.ok` check.** Missing it turns network errors into silent undefined renders.
- **Every user-supplied URL in server code is validated before fetch.** Missing it is SSRF (e.g., `http://169.254.169.254` metadata endpoint exfiltration).
- **Every `process.env.X` for security vars throws if undefined — no localhost fallbacks.** A missing env var on prod should break the build, not silently fall back.
- **No `as unknown as` casts** — validate with Zod or a type guard. That cast is the #1 vector for shape-mismatch runtime crashes on API/DB data.
- **In webhook/cron routes, use `createServiceClient()`, not `createClient()`.** The user-scoped client won't have permission to write as the service account.
- **Every new API route gets added to middleware route matcher / PUBLIC_PREFIXES if public.** Otherwise the route defaults to authenticated-only and returns 401 for anonymous users.

## Accessibility

Each of these maps to a WCAG AA failure:

- **Every `<input>` has an associated `<label>` or `aria-label`.** Without it, screen readers announce "edit text" with no context.
- **Every `<select>` has an `aria-label`.** Same failure mode.
- **Every icon-only `<button>` has an `aria-label`.** Screen readers announce "button" with no purpose.
- **Every `<button>` has `focus-visible:ring-*` styles.** Keyboard users can't see where they are otherwise.
- **Every form has `autoComplete` on email/password fields.** Password managers + browser auto-fill need it.
- **Every async operation shows loading, error, and empty states.** Missing any one is a blank screen for real users on slow networks.
- **Every animation has a `motion-reduce` alternative.** Users with vestibular disorders get sick from motion otherwise.
- **Every touch target is minimum 44px.** Smaller targets fail Apple HIG + Material Design minimums.

## Design (anti-slop)

Stock shadcn with no project-specific tokens reads as AI-generated. The fix:

- **Read the project's globals.css or tailwind config before writing UI.** Use its actual tokens — `bg-primary`, `text-muted-foreground`, whatever — not stock shadcn defaults.
- **Fonts load via `next/font` (or framework equivalent).** Just declaring `font-family` in CSS triggers FOUT and the wrong font weights.
- **Chart/graph colors: use raw HSL values from tokens, not `hsl(var(--x))` when the variable already contains `hsl(...)`.** You end up with invalid `hsl(hsl(...))`.
- **Cards need visible elevation/distinction from background in both light and dark mode.** Otherwise cards vanish in dark mode.
- **Navigation needs icons alongside text labels.** Text-only nav reads as stock template.
- **OAuth/social buttons need provider icons (GitHub octocat, Google G), not plain text.** Users scan for the logo.
- **Empty states need engaging visuals — illustration or icon + descriptive text, not just "No data yet".**
- **Landing pages need a visual hook above the fold (demo, screenshot, animation), not just text + subtitle.**
- **Use the project's brand/accent color for emphasis, not stock primary.** If the project has a brand color, use it.

## Test generation (for API / auth / data mutations)

When auto creates an API route, auth logic, hook, or data mutation, also write a test. Keep tests minimal (1-3 assertions each). Prioritize risky paths over easy-to-test pure functions.

| Created | Write test for |
|---------|---------------|
| API route | Happy path (200 + response shape) + missing auth (401) |
| Auth logic | Valid login + expired token + missing credentials |
| Hook | Initial state + success path + error path |
| Data mutation | Success + validation error + unauthorized |
| RLS policy | Authorized read + unauthorized read blocked |

## Self-critique (re-read diff before checks)

After writing code, before running typecheck, re-read the diff and answer these eight questions:

1. Does every input have a label?
2. Does every fetch handle errors?
3. Does every async operation show a loading state?
4. Could any user-supplied value reach a dangerous sink (SQL, HTML, URL fetch)?
5. Are there any `as unknown as` casts that should be runtime-validated?
6. Would this work in dark mode? (Are colors from theme tokens, not hardcoded?)
7. Is every interactive element keyboard-accessible?
8. Does the UI have visual personality, or is it stock shadcn? (Check: distinctive colors, loaded fonts, icons in nav, non-generic empty states)

Fix issues found before running typecheck. This catches the easy stuff before the tooling does.
