# Task checks: context, verification by type, self-verification

Loaded from `auto` before the first task of a run.

## Context loading (before writing any code)

1. Read 2-3 existing files most similar to what you're building.
2. Identify patterns: naming conventions, import style, error handling, state management.
3. Match patterns. Do not introduce new patterns when existing ones cover the use case.
4. **For UI tasks:** read globals.css (or tailwind config) and layout.tsx to learn
   the project's design system: fonts, colours, component patterns. Use the
   project's ACTUAL tokens, not stock defaults. Check whether fonts are loaded via
   `next/font` or only declared in CSS.
5. **For library-specific code (third-party APIs, SDKs, framework features):** if
   Context7 tools are available (`mcp__plugin_context7_context7__*`), query them
   for version-pinned docs first. This prevents deprecated APIs and patterns from
   old training data, even for Next.js, React and Supabase.
6. **Check for Doppler:** if `doppler.yaml` exists, secrets live in Doppler.
   Prepend `doppler run --` to `npm/pnpm/bun run dev|build|start|test`. If the
   `doppler` CLI is missing, install it first (`doppler` skill). If not logged in,
   stop and guide the user to `doppler login`.

**Design context is not optional.** UI generated without reading the design
system produces stock shadcn that fails the AI slop checklist.

## Verification by task type

| Task Type | Verification |
|-----------|--------------|
| UX/UI (public pages) | `computer` screenshots (desktop + mobile) + `read_console_messages` |
| UX/UI (admin/internal) | Browser screenshots (desktop + mobile), console inspection, and complete the affected flow with the correct role |
| Feature (UI) | Build passes + visual check for every changed UI + complete the primary user flow once + **runtime flow check** when a criterion names what the user sees or gets |
| Edge Function / API | Exercise the local/preview endpoint with real parameters; verify expected response, authorization and side effects. Production deploy follows `ship` + **runtime flow check** when a criterion names what the user sees after the call |
| API Integration | Real request with real credentials + verify response contains expected data |
| Bug fix | Reproduce, verify fixed, no new errors + **runtime flow check** with `observedBefore` taken from the reproduction |
| Refactor | Typecheck + build + existing tests pass + no behavior change |
| Auth / billing / RLS | Write or verify a test for the security-critical path |

**All task types also require the Hardening Check (step 4c below).** It catches
logic bugs that typecheck and build miss.

**Integration test is mandatory for API/Edge Function tasks.** Typecheck alone
does not catch wrong API keys, wrong function signatures or wrong tables. Make
one real request before marking done.

**Ignore Preview-plugin visual reminders on non-UI edits.** Skip "verify in
browser" when the edit was server-only: API routes, middleware, `next.config.*`,
`*.test.*`, migrations, types-only files, server actions without JSX. Run visual
verification only when the edit touches a component, page, layout or CSS that
ships to the browser.

**Risk-shaped testing.** Prioritise tests on paths that handle money, access
control or user data over easy-to-test pure functions.

For UI/API tasks, detect or start a dev server first:

```bash
# Check if already running
for port in 3000 3001 5173 8080; do curl -s http://localhost:$port > /dev/null 2>&1 && break; done
# If none found, prefer preview_start with a .claude/launch.json entry: it
# supervises the server and exposes its output via preview_logs.
# Fall back to a detached Bash only when there is no launch.json entry:
Bash({ command: "npm run dev", run_in_background: true })
```

Analyse screenshots for broken layout, missing content, visual regressions,
design quality and dark mode. Fix console errors or visual issues before
marking the task complete.

## Self-verification (after each task)

1. **Type safety:** `npm run typecheck 2>/dev/null || npx tsc --noEmit 2>/dev/null`
2. **Tests:** `npm test -- --passWithNoTests --watchAll=false 2>/dev/null`
3. **Resource validation:** if the task added images, fonts or API URLs, run the
   URL check in [self-verification-checks.md](self-verification-checks.md). Broken
   URLs cause blank images and layout shifts in production.
4. **Self-review:** `git diff`: no `console.log`/`debugger`, no hardcoded colours,
   all UI states handled, no `any`, no commented-out code.
   - **4b. Sweeping change:** after a bulk find-and-replace, grep for the OLD
     pattern to confirm it is gone. Partial migrations cause subtle bugs.
   - **4c. Hardening check:** scan your own diff for the twelve patterns in
     [self-verification-checks.md](self-verification-checks.md), only those
     relevant to the files you changed, and fix before marking done.
5. **Design token compliance (UI tasks only):** run the two greps in
   [self-verification-checks.md](self-verification-checks.md) on changed `.tsx`
   and `.css` files. Fix stock colours or unloaded fonts in YOUR changes.
6. **Visual verification:** the browser screenshots above. Not optional for UI.
7. **Mark complete** only after all checks pass. UI files without visual
   verification go back to step 6.

## Error pattern recognition

Track error types across tasks. When the same pattern appears 3+ times, save it
to auto-memory with its fix recipe and apply the fix at once next time.
[error-patterns.md](error-patterns.md) lists the common ones.
