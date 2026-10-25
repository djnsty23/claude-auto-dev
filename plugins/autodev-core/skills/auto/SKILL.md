---
name: auto
description: Autonomous task execution with testing and security. Works through all tasks without stopping.
when_to_use: "Invoked when the user says \"auto\", \"iterate\", \"converge\", \"sprint\", \"progress\", \"archive\" or \"compact prd\", and the moment a tool error names a human decision rather than a fault."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebSearch, Agent, SendMessage, mcp__Claude_Browser__*
model: opus
user-invocable: true
---

# Auto Mode

Fully autonomous development. Works through all tasks without stopping until complete.

> **Browser access.** Use `mcp__Claude_Browser__*`; reach for chrome-devtools
> `emulate` when a mobile *device* gate has to fire. The `agent-browser` CLI is
> not a fallback for page verification.

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
  +-- Deactivate: the Stop hook removes the flag
```

On start, write `.claude/auto-active` with the **Write tool**, never Bash. The
Stop hook blocks stopping while it exists and owns its whole lifecycle: never
`rm` it. To end mid-sprint on "deactivate auto", Write an empty
`.claude/auto-exit`. Load [references/auto-active-flag.md](references/auto-active-flag.md)
for the content, the per-session rename and the cleanup cases.

Do not ask "Should I continue?" or show summaries and wait. Make autonomous
decisions and keep working until truly done; the Stop hook prevents ending.

When findings, scan results or ad-hoc issues come up, write them to prd.json as
stories before fixing them. prd.json is the source of truth that survives
restarts and /compact.

**Lightweight mode.** A direct instruction ("fix this button") rather than
"auto" skips prd.json and sprints: fix, verify, done. Use prd.json only for 5+
tasks. **Bootstrap**, with no prd.json: read CLAUDE.md, README.md and
package.json, generate 5-10 starter tasks into a new prd.json, and continue
without stopping for approval.

## Pre-flight (Smart)

Before the first task, read the repo's guidance, package manifest and lockfile to
identify its package manager and actual gate/build/test scripts. A generic npm
command is not a substitute for the repo's own checks.

Work in an isolated worktree at `<repo>/.claude/worktrees/<name>` for shared-repo
changes, and install with the lockfile-preserving command. Run the checks
directly with their real exit codes: never pipe a gate into `tail` or `head`,
never skip a long one. A missing script means find the right check or report
verification unavailable.

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

**Size-gate.** Small (1-3 files) and medium (3-5) tasks execute directly. A large
one (5+ files, a new feature, several integrations) first gets a 3-sentence
inline plan: what changes, what systems are affected, what to verify. Then
execute without stopping to ask.

### Execute Each Task

Load [references/task-checks.md](references/task-checks.md) before the first task:
it holds context loading, the verification table by task type, the dev-server
start and the self-verification steps.

1. **Progress output**: `[3/8] Starting: S6-003 — Add loading states`
2. Read the task, then read 2-3 similar files and match their patterns. For UI,
   read the project's design tokens first; for a library, its version-pinned docs.
3. Load `references/generation-constraints.md` before writing code, and re-read
   your diff against its self-critique checklist before typecheck.
4. Implement, then run the project's type/static checks, build and required gate.
5. Self-verify per `references/task-checks.md`, the hardening check in
   [references/self-verification-checks.md](references/self-verification-checks.md) included.
6. **Visual verification**: if the task touched UI, screenshot it at 390 and 414
   through the browser tools, per [references/browser-verification.md](references/browser-verification.md).
   Do not skip this or substitute reading the diff.
7. **Test generation**: an API route, auth logic or data mutation gets at least one test.
8. **Progress output**: `[3/8] ✓ S6-003 | Next: S6-004`, set `passes: true`, start the next task.

### Acceptance Criteria & Verify Tags

Stories carry `verify: []` and `acceptance: []`; `references/verify-tags.md` defines
the tags, and without one, infer from the task type. Load core's
`references/requirements.md` when reading acceptance or spec revisions: explicit
acceptance wins, and a fresh worker's brief carries the frozen requirements.
"Does it compile?" is not acceptance; "does it behave correctly?" is.

**Runtime flow check.** When a criterion names something the user **sees or
gets** (a row appears, a total matches, a request leaves with the right shape),
the story closes on an **assertion about state**, not a screenshot. Load
[references/runtime-flow-check.md](references/runtime-flow-check.md).

## Smart Retry

On failure:
1. **Auto-fix first.** Most failures are trivial: read the error, fix it inline,
   re-run. This does not count as a retry.
2. Retry 1: a different approach. Retry 2: the simplest possible implementation.
3. Still failing: set `passes: false` and continue to the next task. No third
   retry, and no more than 10 minutes of retries on one task.
4. Missing external setup (an API key, a service, a console, a decision only a
   person can take) is not a retry case: it is a handback, below, in this turn.

An error pattern seen 3+ times goes to auto-memory with its fix recipe
(`references/task-checks.md`, `references/error-patterns.md`).

## Handback: a story blocked on a person

The moment a story is blocked on a person (an error names a choice, a permission,
a credential, a console nobody has opened, a decision of taste, a client), do
these three things in the SAME turn, before touching anything else:

1. **Mark the story, with the handback as the reason.** Never hand-edit the JSON:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/prd-mark-needs-setup.js" S1-004 "Needs a Stripe account: https://dashboard.stripe.com/register (about 5 minutes), then STRIPE_SECRET_KEY in Doppler app/prd. Done when 'doppler secrets get STRIPE_SECRET_KEY --plain | wc -c' prints more than 1."
   ```

   `passes` becomes `"needs-setup"` with `blockedReason` and `blockedAt`. It
   refuses an unknown id, a `true` or `deferred` story and an empty reason, and a
   repeated call is a no-op.
2. **Write the handback into the chat** in the shape [references/handback.md](references/handback.md)
   gives: numbered atomic steps, the exact URL or settings path, what done looks
   like, how long it takes, what you will do when they confirm.
3. **Move to the next ready story.** The selector skips `needs-setup` and
   anything `blockedBy` it; the Stop hook does not count it as remaining work.

When the operator says it is done, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/prd-mark-needs-setup.js" S1-004 --clear`,
then verify the observable in its `acceptance` before closing it. A
`type: "setup"` story closes `true` once that observable holds, not when the
person says "done": the verification catches a key pasted into the wrong
environment.

Load [references/handback.md](references/handback.md) the moment an error names a choice, an account, a credential or a console only the user can act on, before retrying it: it holds the handback shape and the stop conditions.

Load [references/handback-rationale.md](references/handback-rationale.md) when the script or the same-turn rule is questioned: it holds the measured evidence behind both.

## Commits, learning and context

Commit every 3 tasks or at a milestone (`feat|fix|refactor`, commit skill for
branches). Save the lesson from a hard problem
([references/project-knowledge.md](references/project-knowledge.md)). Do not
suggest `/compact` below 70% context.

## Deployment (After Commit)

Run the [ship workflow](../ship/SKILL.md) before any deployment, or any push or
merge that triggers production: its exact-commit gate, live baseline, ledger and
undo apply here. Scope is the whole range from the SHA the platform serves to
HEAD (`git diff --name-only "$deployed_commit" HEAD`), shared imports,
migrations and configuration included. Existing authorization persists; check
what it covers instead of asking again. An HTTP 200 alone proves nothing.

## Completion

When `plan.complete` holds (a nonempty population of only `true` and `deferred`
stories), print the completion summary in `references/sprint-transition.md`. A
`needs-setup` story keeps the sprint incomplete, but its "Blocked on you" line,
printed from `prd-mark-needs-setup.js --list`, goes in whatever you report when
the run stops.

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

## Sprints and convergence

Load [references/sprint.md](references/sprint.md) when asked to create, advance or close a sprint in prd.json.

Load [references/iterate.md](references/iterate.md) when asked to iterate or converge: the brainstorm, fix and re-scan loop, its scope and its exit condition.

Load [references/progress.md](references/progress.md) when asked for progress: sprint and story counts, and what is blocked on the user.

Load [references/archive-prd.md](references/archive-prd.md) when prd.json grows too large or asked to archive or compact it: the split, the keep list and the durability checks.
