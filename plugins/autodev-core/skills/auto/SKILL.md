---
name: auto
description: Autonomous task execution with testing and security. Works through all tasks without stopping.
when_to_use: "Invoked when the user says \"auto\"."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, Agent, SendMessage, mcp__Claude_Browser__*
model: opus
user-invocable: true
---

# Auto Mode

> **Browser access.** Use the built-in browser tools. `mcp__Claude_Browser__*`
> covers navigation, DOM reads (`read_page`), screenshots and `resize_window`;
> reach for chrome-devtools `emulate` when a mobile *device* gate has to fire,
> which `resize_window` alone does not guarantee. The `browser` skill and the
> `agent-browser` steps were dropped in 8.79.0 — do not reach for that CLI here.
> (The binary itself is still installed for kb-factory's JS-rendered crawls;
> that is a separate consumer, not a fallback for page verification.)

Fully autonomous development. Works through all tasks without stopping until complete.

## Current State
!`git status --short`
Read `prd.json` with the shared `workPlan` selector below. Report `plan.summary`, including blocked setup and unrecognised states, across all sprints.

## Entry Flow

```
auto
  |-- Activate: write .claude/auto-active
  |-- Check prd.json exists?
  |   |-- No -> Bootstrap from context
  |   +-- Yes -> Check pending tasks
  |               |-- None pending -> IDLE Detection
  |               +-- Has pending -> Execute tasks
  |
  +-- Execute until done or interrupted
  +-- Deactivate: delete .claude/auto-active
```

## Auto-Active Flag (Continuous Execution)

On start, create the flag file using the **Write tool** (not Bash echo — avoids sensitive file permission prompt):
```
Write tool → .claude/auto-active
Content: {"started":"<current ISO timestamp>","sprint":"<current sprint>"}
```

This flag tells the Stop hook to block Claude from stopping. Claude keeps working as long as this flag exists.

On exit (user says "done", or nothing left), **do not `rm` the flag** — Bash ops on `.claude/` trigger a sensitive-file permission prompt even under bypass. Instead, simply stop working. The Stop hook owns the flag lifecycle:

- Stale flags (>2h old) are auto-cleaned
- Sprint-complete → hook runs IDLE detection once, then approves stop and removes the flag on the next attempt
- No prd.json → hook approves stop and removes the flag immediately

If the user explicitly says "deactivate auto" mid-sprint, use the **Write tool** to create `.claude/auto-exit` (empty file). The Stop hook treats that as an unconditional exit signal and cleans up both files.

## Autonomous Behavior

Do not ask "Should I continue?" or show summaries and wait.

Instead:
- Make autonomous decisions
- Keep working until truly done
- The Stop hook prevents Claude from ending — trust it

## Persist to prd.json

When findings, scan results, or ad-hoc issues are identified during execution, write them to prd.json as stories before fixing them. prd.json is the source of truth that survives session restarts and /compact.

## Lightweight Mode

If the user gives a direct instruction (e.g., "fix this button", "update that copy") rather than saying "auto":
- Skip prd.json and sprint creation entirely
- Just fix, verify, done
- Use prd.json only when there are 5+ tasks to track

## Bootstrap (No prd.json)

When prd.json does not exist:

1. Read CLAUDE.md, README.md, package.json for context
2. Generate 5-10 starter tasks based on project
3. Create prd.json with stories
4. Continue immediately — do not stop for approval

## Pre-flight (Smart)

Before the first task, read the repo's guidance, package manifest and lockfile to
identify its package manager and actual gate/build/test scripts. A generic npm
command is not a substitute for the repo's own checks.

```bash
git status --short
git branch --show-current
```

Use an isolated worktree for shared-repo changes. Install dependencies with the
detected manager's lockfile-preserving command when required; timestamps alone
do not establish that an installation matches the lockfile.

Run the detected checks directly and capture their actual exit codes and output.
Do not pipe a gate into `tail` or `head`, or suppress errors. A long check needs
time or a supervised background run; exceeding ten seconds is not a reason to
skip it. If a required script is absent, identify the appropriate project check
or report that verification is unavailable before declaring readiness.

## Task Execution

### Find Next Task

The planner is loaded from `CLAUDE_PLUGIN_ROOT`, which the host sets per loaded
plugin; the snippet throws if it is unset rather than requiring a path built
here. Use the shared planner below; do not copy its state or dependency
predicates into the skill. The planner reads every sprint, reports
missing/malformed/cyclic dependencies, and keeps blocked work visible.

```javascript
if (!process.env.CLAUDE_PLUGIN_ROOT) throw new Error('CLAUDE_PLUGIN_ROOT is required');
const { workPlan } = require(require('path').join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts', 'prd-states.js'));
const plan = workPlan(prd);
const stories = plan.stories;
const executable = plan.ready;
```

If `executable` is empty and `plan.complete` is false, the sprint is incomplete.
Read `plan.blocked` and `plan.invalid`; repair an incorrect dependency only from
evidence, or report the external blocker and keep its state. Missing ids, cycles,
unknown states, and zero stories must not be reported as completion. The Stop
hook gives one reconciliation turn, then permits a bounded stop while retaining
the unresolved reasons. It resumes blocking when dependency-ready work appears.

### Size-Gate Before Executing

Before starting a task, assess its scope:
- **Small** (1-3 files, clear fix) → execute directly
- **Medium** (3-5 files, clear approach) → execute with extra caution
- **Large** (5+ files, new feature, multiple integrations) → write a 3-sentence inline plan before coding:
  1. What changes
  2. What systems are affected
  3. What to verify after

  Then execute. Do not stop to ask — the inline plan is sufficient for auto mode.

### Execute Each Task

1. **Progress output**: `[3/8] Starting: S6-003 — Add loading states`
2. Read the task description
3. **Context Loading** — read 2-3 similar files to match existing patterns
4. **Apply Generation Constraints** (see below) — before writing code
5. Implement the solution
6. **Self-Critique** — re-read your diff before running checks (see below)
7. Run the project's type/static checks — fix if they fail
8. Run its detected build and required gate — fix failures before completion
9. Self-Verification (see below)
10. **Visual verification** — if the task touched UI, screenshot it at 390 and 414 through the browser tools. Do not skip this, and do not substitute reading the diff.
11. **Test generation** — if the task created an API route, auth logic, or data mutation, write at least one test (see below)
12. **Progress output**: `[3/8] ✓ S6-003 | Next: S6-004`
13. Update prd.json: `passes: true`
14. Start next task immediately

### Generation Constraints (apply before writing code)

Before writing code, load `references/generation-constraints.md` — it covers TypeScript strictness patterns, security/data-safety rules (fetch error handling, SSRF guards, env var enforcement), accessibility checklist (labels, focus rings, touch targets), design anti-slop rules, and the test-generation matrix for API/auth/data mutations. Each rule explains the failure mode it prevents, so you can judge when to bend it.

After writing code but before typecheck, re-read your diff against the 8-point self-critique checklist in the same reference file.

### Acceptance Criteria & Verify Tags

When creating stories in prd.json, each story can carry a `verify: []` array and an `acceptance: []` array. Load `references/verify-tags.md` for the tag definitions (`visual`, `a11y`, `design`, `security`, `auth`, `test`, `api`) and an example story.

If no `verify` field exists, auto infers from the task type (UI → visual+a11y+design, API → api+security, etc.).

Before marking a task done, verify each acceptance criterion. "Does it compile?" is not acceptance — "does it behave correctly?" is.

### Context Loading (before writing any code)

1. Read 2-3 existing files most similar to what you're building
2. Identify patterns: naming conventions, import style, error handling, state management
3. Match patterns — do not introduce new patterns when existing ones cover the use case
4. **For UI tasks:** Read globals.css (or tailwind config) + layout.tsx to understand the project's design system — fonts, colors, component patterns. Use the project's ACTUAL tokens, not stock defaults. Check if fonts are loaded via `next/font` or just declared in CSS.
5. **For library-specific code (third-party APIs, SDKs, framework features):** If Context7 tools are available (`mcp__plugin_context7_context7__*`), query them for version-pinned docs before writing code that touches the library. This prevents using deprecated APIs or patterns from old training data — even for well-known libraries like Next.js, React, and Supabase.
6. **Check for Doppler:** If `doppler.yaml` exists in the repo, secrets live in Doppler — prepend `doppler run --` when running `npm/pnpm/bun run dev|build|start|test` commands. If `doppler` CLI is missing, install first (see `doppler` skill). If not logged in, stop and guide user to `doppler login`.

**Design context is not optional.** Auto-generated UI without reading the design system produces stock shadcn that fails the AI slop checklist. Spend 30 seconds reading the design tokens before writing any component.

### Verification

| Task Type | Verification |
|-----------|--------------|
| UX/UI (public pages) | `computer` screenshots (desktop + mobile) + `read_console_messages` |
| UX/UI (admin/internal) | Browser screenshots (desktop + mobile), console inspection, and complete the affected flow with the correct role |
| Feature (UI) | Build passes + visual check for every changed UI + complete the primary user flow once + **runtime flow check** (below) when a criterion names what the user sees or gets |
| Edge Function / API | Exercise the local/preview endpoint with real parameters; verify expected response, authorization and side effects. Production deploy follows `ship` + **runtime flow check** when a criterion names what the user sees after the call |
| API Integration | Real request with real credentials + verify response contains expected data |
| Bug fix | Reproduce, verify fixed, no new errors + **runtime flow check** with `observedBefore` taken from the reproduction |
| Refactor | Typecheck + build + existing tests pass + no behavior change |
| Auth / billing / RLS | Write or verify a test for the security-critical path |

**All task types also require the Hardening Check (step 4c).** This catches logic bugs that typecheck and build miss.

**Integration test is mandatory for API/Edge Function tasks.** Typecheck alone does not catch wrong API keys, wrong function signatures, or wrong database tables. Make one real request before marking done.

**Ignore Preview-plugin visual reminders on non-UI edits.** Claude Code's Preview plugin and similar tools may suggest "verify in browser" on any file change. Skip the suggestion when the edit was purely server-only: API routes, middleware, `next.config.*`, `*.test.*`, migration files, types-only files, server actions without JSX. Only run visual verification when the edit touches a React/Vue/Svelte component, page, layout, or CSS that ships to the browser.

**Risk-shaped testing.** When adding tests, prioritize paths that handle money, access control, or user data over easy-to-test pure functions.

For UI/API tasks, detect or start a dev server first:
```bash
# Check if already running
for port in 3000 3001 5173 8080; do curl -s http://localhost:$port > /dev/null 2>&1 && break; done
# If none found, prefer preview_start with a .claude/launch.json entry — it
# supervises the server and exposes its output via preview_logs.
# Fall back to a detached Bash only when there is no launch.json entry:
Bash({ command: "npm run dev", run_in_background: true })
# Wait for startup, then verify
```

Drive the page with the built-in browser tools:

1. `navigate` to the page.
2. `read_page` — the accessibility tree, and the assertion surface. Cheaper and more
   reliable than a screenshot for text and structure.
3. `computer` `screenshot` for the desktop view.
4. `resize_window` `{preset: 'mobile'}`, reload, then screenshot again.
5. `read_console_messages` `{onlyErrors: true}`.

**Two viewports, not one.** Check 390px *and* 414px — a layout can survive one and
break the other. And `resize_window`'s mobile preset changes the viewport and the
user agent, which is enough for a CSS breakpoint but not proof that a load-time
*device* gate fired; when the code branches on device rather than width, use
chrome-devtools `emulate` and reload so those gates re-run.

**Assert the viewport you think you measured.** A resize tool can report success
while the page never changed, which turns "I verified the mobile layout" into a
desktop screenshot with a mobile label. Read `window.innerWidth` in the same call
that takes the measurement.

If the browser tools are unavailable, `WebFetch` verifies that a page loads at all —
say that is what you did, and do not describe it as visual verification.

Analyze screenshots for: broken layout, missing content, visual regressions, design quality, dark mode correctness.
Fix console errors or visual issues before marking task complete.

### Runtime flow check

A screenshot cannot tell a handler that ran from one nested where it never
runs; both produce one green picture. `[measured 2026-08-16]` that is the
common first-pass failure, 112 incomplete flows against 20 crashes in one
repo (`docs/failure-evidence.md`). So when a story's acceptance criterion
names something the user **sees or gets** — a row appears, a total matches
on both surfaces that show it, a request leaves with the right shape — the
story closes on an **assertion about state**, not on a picture. The `flow`
verify tag (`references/verify-tags.md`) marks it; infer it from the
criteria when the tag is absent.

1. Start or find the dev server exactly as above.
2. Drive the **primary flow the criterion describes** with the browser tools:
   `navigate`, `find`, `form_input`, `computer`. For a bug fix, drive it
   first on the pre-fix tree and record what you read as `observedBefore`.
3. Read the outcome back, never eyeball it: `read_page` or `find` for a DOM
   count or text, `read_network_requests` for a request and its shape,
   `read_console_messages` for a log line or the error count, `javascript_tool`
   for a value the page holds. Use a **fresh tab** per check: the console
   buffer accumulates across navigations, and a tab left open across edits
   logs Fast Refresh errors that a fresh load does not reproduce. Read the
   error count once **before** the flow and record it as
   `consoleErrorsBaseline`; two dev trees here carried errors on every load.
   **While the Browser pane is hidden, `computer` clicks and key presses do
   not reach the page** (`[measured 2026-09-08]` a keydown listener saw
   nothing; `document.visibilityState` was `hidden`), while `navigate`,
   `find`, `form_input` and `javascript_tool` work. Front the tab with
   `tabs_select`, or dispatch the event from `javascript_tool`, and prove the
   input arrived before reading the outcome, or the red you report is about
   the probe.
4. Write `.claude/evidence/<story>/flow.json` — `node
   ${CLAUDE_PLUGIN_ROOT}/scripts/flow-evidence.js --template` prints the
   shape — with the steps, the assertion (`subject`, `claim`, `expected`),
   the `observed` value, screenshot paths, console error count, timestamp,
   and `commit`: the 40-character sha `git rev-parse HEAD` prints when the
   flow is driven, the tree the dev server was serving. The template fills it
   from the cwd; confirm it is still HEAD if you committed between driving and
   writing. Screenshot paths are **relative to the repository root**
   (`.claude/evidence/<story>/after.png`), not to the record's directory.
5. `node ${CLAUDE_PLUGIN_ROOT}/scripts/flow-evidence.js .claude/evidence/<story>/flow.json`.
   Exit 0 is PASS. Exit 1 is the product failing its own criterion: fix,
   re-drive, re-run. Exit 2 is the **record** being refused — no assertion,
   a "looked fine" claim, a `visual` subject, no observed value, or a
   `commit` that is missing, malformed, or not reachable from HEAD (the
   record was measured on another revision; `--at <sha>` verifies against a
   different commit) — and a refused record does not close a story. Commit the
   record with the change, as `prove` does with its captures: its `commit`
   is then the parent of the commit that carries it, which is what the
   ancestry rule expects.

**What it reaches, honestly.** `[measured 2026-09-08]` over 30 first-pass
fixes in a live repo, 4 were catchable by driving the primary flow with a state
assertion, 3 more only with specific data (a rate-limited account, a particular
prompt), 23 not at all — copy, contrast, cron, admin-only routes, server-side
counts. Replayed against the parent of three of those four fixes, the check
went red on every parent and green on every fix. It costs about 50 s and
three to five tool calls per story on a dev server the visual check already
needs. Cheap insurance on the 4, not a gate on the 30
(`docs/evidence-flow-verification-2026-09-08.md`).

**The Stop hook does not enforce this, on purpose.** `stop-auto-check.js`
blocks the end of a turn while pending stories remain; a block on a missing
flow record would hold every turn in a repo with no dev server, no browser
tools, or a criterion that names nothing user-visible. Enforcement is here, in
the verification step, and the validator is what makes the record checkable.

### Self-Verification (after each task)

Before marking any task as complete:

**1. Type Safety**
```bash
npm run typecheck 2>/dev/null || npx tsc --noEmit 2>/dev/null
```

**2. Tests**
```bash
npm test -- --passWithNoTests --watchAll=false 2>/dev/null
```

**3. Resource Validation**
If the task added external resources (images, fonts, API URLs), validate them:
```bash
# Check image/asset URLs are reachable
grep -rn 'https://.*\.(png|jpg|svg|webp|woff2)' src/ --include="*.tsx" --include="*.ts" | while read line; do
  url=$(echo "$line" | grep -oP 'https://[^\s"'\'']+'); curl -s -o /dev/null -w "%{http_code} $url\n" "$url"
done
```
Fix broken URLs before committing — they cause blank images and layout shifts in production.

**4. Self-Review**
Run `git diff` and check: no `console.log`/`debugger`, no hardcoded colors, all UI states handled, no `any` types, no commented-out code.

**4b. Sweeping Change Verification**
If the task involved a bulk find-and-replace (e.g., renaming, migrating values, swapping imports), grep for the OLD pattern to confirm it's fully eliminated. Partial migrations cause subtle bugs (e.g., USD→EUR migration that missed one pricing page).

**4c. Hardening Check (per-task audit-lite)**
Review the diff for these patterns in the files you just changed. Fix before marking done:

| Pattern | What to Check | Fix |
|---------|--------------|-----|
| **Fail-open auth** | `if (secret && ...)` skips auth when env var is unset | Fail-closed: return 401 if env var missing |
| **Unsafe casts** | `as unknown as`, `as any`, double assertions | Create a validator (Zod or manual), parse instead of cast |
| **Fire-and-forget fetch** | `fetch()` without try/catch or `.ok` check | Wrap in try/catch, check `res.ok`, revert optimistic state on failure |
| **Missing form labels** | `<input placeholder="...">` without `<label>` or `aria-label` | Add `<label>` or `aria-label` to every input |
| **Missing autocomplete** | Login/signup inputs without `autoComplete` | Add `autoComplete="email"`, `autoComplete="current-password"`, etc. |
| **User-supplied URLs** | Server-side `fetch(userUrl)` without validation | Validate URL, resolve DNS, block private IP ranges |
| **Env var fallbacks** | `process.env.X \|\| 'localhost'` or `\|\| ''` | Throw if missing in production, only fallback in dev |
| **RLS policy logic** | New table or RLS change | Verify policy restricts to `auth.uid()` for user data |
| **Missing focus styles** | Raw `<button>` without `focus-visible:ring-*` | Add `focus-visible:ring-2 focus-visible:ring-ring` |
| **Stock UI** | Fonts declared but not loaded, text-only nav, generic empty states | Load fonts via next/font, add icons, add visual personality |
| **Dark mode** | Colors that don't use theme tokens, cards same color as background | Use semantic tokens, add elevation distinction |
| **Chart colors** | `hsl(var(--x))` when var already contains `hsl(...)` | Use raw HSL values or remove outer `hsl()` wrapper |

Only check patterns relevant to the files you changed — this is a 30-second scan of your own diff, not a full audit.

**5. Design Token Compliance (UI tasks only)**
If the task changed `.tsx` or `.css` files, verify the output uses the project's actual tokens:
```bash
# Check for stock shadcn / hardcoded colors in changed files
git diff --name-only | xargs grep -n "text-white\|bg-black\|text-gray-\|bg-gray-\|#[0-9a-fA-F]\{6\}" 2>/dev/null | grep -v "gradient\|from-\|to-\|via-" | head -10
# Check fonts are loaded, not just declared
grep -rn "fontFamily\|font-family" src/ --include="*.css" --include="*.tsx" | grep -v "next/font\|@font-face\|tailwind" | head -5
```
If stock colors or unloaded fonts found in YOUR changes, fix before proceeding.

**6. UI/API Change? Visual Verification**
Run the browser-tool screenshots from the Verification section above. Not optional for UI tasks.

**7. Mark Complete**
Only after all checks pass. UI files (.tsx, .css, layout, page) without visual verification → go back to step 6.

## Smart Retry

On failure:
1. **Auto-fix first** — Most failures are trivial (missing import, type mismatch, wrong path). Read the error, fix it inline, re-run the check. This does not count as a retry.
2. Retry 1: Different approach
4. Retry 2: Simplest possible implementation
5. Still fails: set `passes: false`, continue to next task
6. If failure is due to missing external setup (API keys, services, infrastructure): set `passes: "needs-setup"` with `blockedReason` explaining what's needed. This distinguishes "can't do yet" from "tried and failed."

Do not retry a third time. Do not spend more than 10 minutes on retries for a single task.

### Error Pattern Recognition

Track error types across tasks. When the same error pattern appears 3+ times:
1. Save it to auto-memory as a known pattern with its fix recipe
2. On future occurrences, apply the fix immediately without the auto-fix→retry cycle

Common patterns to recognize:
| Error Pattern | Instant Fix |
|--------------|-------------|
| `exactOptionalPropertyTypes` error | Add `\| undefined` to optional prop types: `foo?: string \| undefined` |
| `Cannot find module './X'` | Check file exists, fix path or create file |
| `Type 'X' is not assignable to type 'Y'` | Check the type definition, add union or cast |
| `Property 'X' does not exist on type 'Y'` | Add to interface or use optional chaining |
| `RLS policy violation` | Check auth.uid() in policy, verify user is authenticated |
| `CORS error` | Check API route headers or middleware config |
| `as unknown as` cast | Create a validator function, parse instead of assert |
| Unhandled fetch in component | Wrap in try/catch, check res.ok, add error feedback |
| `<input>` without label | Add `<label htmlFor>` or `aria-label` prop |
| Env var `\|\| ''` fallback | Throw if missing, fallback only with NODE_ENV check |
| Middleware blocks new route | Add to PUBLIC_PREFIXES or route matcher |
| Font declared but not loaded | Add `next/font` import in layout.tsx |
| `hsl(var(--x))` double-wrap | Remove outer `hsl()` when CSS var already contains it |
| Stock shadcn tokens | Read project's globals.css, use actual brand colors |

## Commit Cadence

- Commit every 3 completed tasks
- Or after major milestones
- Feature branch for team projects; main is fine for solo (see commit skill)
- Use conventional commits: `feat|fix|refactor`

## Save Project Knowledge (Continuous Learning)

After solving hard problems (debugging, retries, unexpected errors), save reusable lessons to auto-memory:

| What to Save | Example |
|-------------|---------|
| **Environment quirks** | "This project uses Vite on port 5173, not CRA on 3000" |
| **Error fix recipes** | "RLS 'permission denied' → check auth.uid() in policy, not custom function" |
| **Architecture patterns** | "API routes follow /api/v1/[resource]/route.ts pattern" |
| **Build gotchas** | "Must run `npm run generate` before build (Prisma client)" |
| **Test setup** | "Tests need `TEST_DB_URL` env var, seed with `npm run seed:test`" |
| **Deploy requirements** | "Vercel needs `ANALYZE=true` for bundle analysis" |

Also save after these events:
- **Same error 3+ times across tasks** → save as known pattern with fix recipe
- **Unexpected project structure** → save the actual structure for next session
- **Workarounds discovered** → save so next session doesn't rediscover them

This builds per-project context that compounds across sessions.

## Token Management

With 1M context, compaction is almost never needed. Do NOT suggest `/compact` unless you are certain context usage exceeds 70%. A full sprint (10+ tasks) typically uses only 15-20% of 1M context.

Be concise but don't sacrifice clarity for brevity.

## Deployment (After Commit)

Run the [ship workflow](../ship/SKILL.md) before any deployment, or any push or
merge that triggers production. Its current eligibility, exact-commit gate,
ledger and undo requirements apply here too. Existing user authorization
persists; check what it covers instead of asking again. Resolve or escalate
ineligible changes under that policy before a production mutation.

Identify the commit currently deployed from the live platform, then inspect the
entire undeployed range. Set `deployed_commit` to that verified SHA first:

```bash
git diff --name-only "$deployed_commit" HEAD
```

Include shared function imports, migrations and configuration, not only entry
files or the latest commit. If deployed identity cannot be established, report
the unresolved baseline and resolve it before choosing deployment scope. Read
the project's deploy configuration; do not infer production settings or relax
authentication from an example command.

After an authorized deployment, verify the live version and affected behavior
with the expected role, response data and side effects, and record the evidence
in the deploy ledger. A successful HTTP status alone does not establish that the
feature works or that the intended commit is running.

## Completion

When all stories have `passes === true`:

```
All [N] tasks complete.

Summary:
- [X] features implemented
- [X] bugs fixed
- [X] improvements made

Run `progress` to see full results.
```

## IDLE Detection (Smart Next Action)

If no tasks to work on:
1. Re-read the shared plan. Does `plan.complete` hold?
   - No: name `plan.blocked` and `plan.invalid`, repair a demonstrated graph
     error, or report the blocker. `needs-setup` remains incomplete; a bounded
     stop preserves it and is never a completed sprint.
   - Yes: continue to step 2. Only done/deferred stories remain, with a nonempty
     population and no unknown states.
2. **Auto-transition sprint** (see below)
3. Output completion summary
4. Assess context to decide next action

### Auto Sprint Transition

When all pending tasks are done, auto handles the sprint lifecycle — but verifies the work first and surfaces a summary before bumping.

```
1. BUILD GATE — run the real deploy-target build before anything else:
   npm run build  (or pnpm/yarn/bun equivalent)
   If it fails, do NOT archive or bump. Create a prd.json story for each
   error and continue working. Sprint can only close on a clean build.

2. Log summary to .claude/sprint-history.md:
   "Sprint [N]: [done]/[total] tasks | [date] | [one-line summary of work]"

3. Archive completed stories:
   - Copy current prd.json to .claude/archives/prd-archive-sprint-[N].json
   - Remove stories with passes: true from prd.json
   - Keep stories with passes: null, false, "deferred", or "needs-setup"
     (needs-setup was missing here, so archiving DELETED work that was waiting
      on the operator — losing the record of what he still owed)

4. Decide whether to bump — show a one-line honesty summary first:

   Sprint [N] closed: [done]/[total] tasks.
   Average realness: [avg]%  (see realness field in core schema)
   Build: passed in [T]s
   Carried forward: [M] deferred, [K] new findings
   Bumping to Sprint [N+1]. Say "stop" to pause.

   Then proceed — no confirmation needed, but the user has a clean
   window to interrupt. This beats silent bumps AND beats blocking
   prompts that break autonomous execution.

5. If no new work exists, skip the bump and go to "Ask User" below.
```

**Honest close criteria:** A sprint doesn't close just because every story has `passes: true`. It closes when (a) build passes on deploy target, (b) the summary accurately reflects what shipped, and (c) realness scores are filled in honestly.

### Decision Matrix

| Signal | Action |
|--------|--------|
| Deferred tasks from previous sprint | Preserve the decision; reactivate only when the mandate explicitly changes |
| Audit/brainstorm created new stories | Bump sprint, continue |
| Dev server running + UI changes made | Run visual scan, fix issues found |
| TODOs/FIXMEs in changed files | Create stories, fix them |
| Build warnings | Fix directly (no story needed) |
| Clean codebase, no work | Ask user (see below) |

### Auto-Continue (Obvious Work)

When new work exists after sprint transition, continue immediately:
```
Sprint [N] complete ([done]/[total] tasks).
Archived completed stories. [M] tasks carried forward.
Continuing as Sprint [N+1].
```

Limit: 2 auto-continued sprints per session. After that, ask the user.

### Ask User (No Obvious Work or Limit Reached)

If the sprint had 5+ tasks, suggest simplify first:
```
Sprint [N] complete ([done]/[total] tasks).

Recommended: run `simplify` to catch duplicate code from this sprint.

What's next?
1. simplify - Review for duplicate code and over-abstraction
2. audit - Deep quality scan (finds bugs + violations)
3. brainstorm - Feature ideas + dead code scan
4. Done for now
```

Keep `.claude/auto-active` flag while asking. Only delete it if user picks "Done for now".

## Quick Reference

| Situation | Action |
|-----------|--------|
| No prd.json | Bootstrap from context |
| All done + issues found | Brainstorm (auto-creates stories) |
| All done + clean code | Ask user for next action |
| All done + already auto-sprinted | Ask user (limit reached) |
| Build broken | Fix first |
| Task fails | Retry 2x, then skip |
| UX task | Browser verify |
| Blocked task | Skip, work on unblocked |
| < 5 tasks, no sprint | Work directly |
