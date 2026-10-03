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
When any story is `needs-setup`, print `Blocked on you: N (ids)` as its own line, from `prd-mark-needs-setup.js --list` (see **Handback**); never select those stories.

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

The hooks rename it at once to `.claude/auto-active.<session id>`, so it holds only THIS session. A peer session in the same directory is never held by it, and a peer's `auto-exit` never ends it. Do not look for the plain name afterwards: it is gone by design.

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

Use an isolated worktree at `<repo>/.claude/worktrees/<name>`, never beside the
repo, for shared-repo changes. Install dependencies with the
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
// A story whose blockedBy names a needs-setup story is in plan.blocked, not
// plan.ready, so a dependent of "create the Supabase project" waits for the
// person rather than failing against the missing key every run.
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

Load core's `references/requirements.md` when reading acceptance or spec revisions.
Use its canonical requirements reader; explicit acceptance overrides diagnostic
notes. Reconcile stale `specRefs` before starting or completing affected work,
and carry the frozen requirement snapshot into a fresh worker's brief.

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

Load [references/browser-verification.md](references/browser-verification.md) whenever the task touched UI: it holds the five browser steps, the two-viewport rule and the viewport assertion.

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

Load [references/runtime-flow-check.md](references/runtime-flow-check.md) for the five steps, the `flow-evidence.js` exit codes, what the check reaches and why the Stop hook does not enforce it.

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
Run the URL check in [references/self-verification-checks.md](references/self-verification-checks.md).
Fix broken URLs before committing — they cause blank images and layout shifts in production.

**4. Self-Review**
Run `git diff` and check: no `console.log`/`debugger`, no hardcoded colors, all UI states handled, no `any` types, no commented-out code.

**4b. Sweeping Change Verification**
If the task involved a bulk find-and-replace (e.g., renaming, migrating values, swapping imports), grep for the OLD pattern to confirm it's fully eliminated. Partial migrations cause subtle bugs (e.g., USD→EUR migration that missed one pricing page).

**4c. Hardening Check (per-task audit-lite)**
Review the diff for these patterns in the files you just changed. Fix before marking done:

Load [references/self-verification-checks.md](references/self-verification-checks.md) for the twelve patterns: what to check and the fix for each.

Only check patterns relevant to the files you changed — this is a 30-second scan of your own diff, not a full audit.

**5. Design Token Compliance (UI tasks only)**
If the task changed `.tsx` or `.css` files, verify the output uses the project's actual tokens:
Run the two greps in [references/self-verification-checks.md](references/self-verification-checks.md) on your changed files.
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
6. If the failure is missing external setup (an API key, a service, a console, a decision only a person can take): this is not a retry case at all — it is a handback. Do the three steps under **Handback** below, in this turn. That marks the story `needs-setup` through the script, which distinguishes "can't do yet" from "tried and failed."

Do not retry a third time. Do not spend more than 10 minutes on retries for a single task.

### Error Pattern Recognition

Track error types across tasks. When the same error pattern appears 3+ times:
1. Save it to auto-memory as a known pattern with its fix recipe
2. On future occurrences, apply the fix immediately without the auto-fix→retry cycle

Load [references/error-patterns.md](references/error-patterns.md) for the common error patterns and their instant fixes.

## Handback: a story blocked on a person

The moment `wizard` fires for a story — an error names a choice, a permission,
a credential, a console nobody has opened, a decision of taste, a client — do
these three things in the SAME turn, before touching anything else:

1. **Mark the story, with the handback as the reason.** Never hand-edit the
   JSON for this:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/prd-mark-needs-setup.js" S1-004 "Needs a Stripe account: https://dashboard.stripe.com/register (about 5 minutes), then STRIPE_SECRET_KEY in Doppler app/prd. Done when 'doppler secrets get STRIPE_SECRET_KEY --plain | wc -c' prints more than 1."
   ```

   `passes` becomes `"needs-setup"`, `blockedReason` carries the text,
   `blockedAt` the date, and `acceptance` and `notes` are untouched.
   It refuses an unknown id, a `true` story, a `deferred` story and an empty
   reason, and a second identical call is a no-op — so calling it from a loop
   is safe.

2. **Write the handback into the chat** in the shape `wizard` gives: numbered
   atomic steps, the exact URL or settings path, what done looks like, how long
   it takes, what you will do when they confirm.

3. **Move to the next ready story.** The selector above skips `needs-setup`
   and anything `blockedBy` it; the Stop hook does not count it as remaining
   work; `status` prints it under "Blocked on you". Nothing retries it.

**When the operator says it is done:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/prd-mark-needs-setup.js" S1-004 --clear
```

`passes` returns to `null` and the story is yours again: verify the observable
in its `acceptance` (the key resolves, the env var lists, the page renders), then
close it as usual. A `type: "setup"` story from `spec` closes `true` once that
observable holds, and its dependents become ready then — not when the person
says "done", because the agent verifying is the half that catches a key pasted
into the wrong environment.

Load [references/handback-rationale.md](references/handback-rationale.md) when the script or the same-turn rule is questioned: it holds the measured evidence behind both.

## Commit Cadence

- Commit every 3 completed tasks
- Or after major milestones
- Feature branch for team projects; main is fine for solo (see commit skill)
- Use conventional commits: `feat|fix|refactor`

## Save Project Knowledge (Continuous Learning)

After solving hard problems (debugging, retries, unexpected errors), save reusable lessons to auto-memory. Load [references/project-knowledge.md](references/project-knowledge.md) for what to save and which events trigger a save.

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

When `plan.complete` holds (a nonempty population of only `true` and `deferred`
stories), print the summary below. A `needs-setup` story keeps the sprint
incomplete — see IDLE Detection — but still gets its "Blocked on you" line in
whatever you report when the run stops:

```
All [N] tasks complete.

Summary:
- [X] features implemented
- [X] bugs fixed
- [X] improvements made

Blocked on you: [K] ([ids]) — one line each: what it waits for, since when.
(Omit the line when K is 0. Print it from `prd-mark-needs-setup.js --list`,
 which reads blockedReason and blockedAt, rather than from memory.)

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

Load [references/sprint-transition.md](references/sprint-transition.md) at step 2: it holds the build gate, the archive and bump steps, the honest close criteria, the decision matrix, the auto-continue limit and the ask-user prompt.

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
