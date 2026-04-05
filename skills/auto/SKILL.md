---
name: auto
description: Autonomous task execution with testing and security. Works through all tasks without stopping.
triggers:
  - auto
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, TaskCreate, TaskUpdate, TaskList, Agent, SendMessage, mcp__audiq__scan_page, mcp__audiq__screenshot_page, mcp__audiq__get_console_errors, mcp__audiq__get_network_issues
model: opus
user-invocable: true
---

# Auto Mode

Fully autonomous development. Works through all tasks without stopping until complete.

## Current State
!`git status --short`
!`node -e "try{const p=require('./prd.json');const sp=p.sprints?p.sprints[p.sprints.length-1]:p;const s=Object.values(sp.stories||p.stories||{});const name=sp.id||sp.name||p.sprint||'unknown';const done=s.filter(x=>x.passes===true).length;const pend=s.filter(x=>x.passes===null||x.passes===false).length;console.log('Sprint:',name,'| Done:',done,'| Pending:',pend,'| Total:',s.length)}catch(e){console.log('No prd.json')}"`

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

On exit (user says "done", or nothing left), delete the flag:
```bash
rm -f .claude/auto-active
```

Delete the flag when auto mode ends. If asking the user what's next (IDLE Detection), keep the flag active.

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

Before first task, run these checks. Use simple commands that won't trigger security filters:

```bash
# 1. Git status
git status --short

# 2. Dependencies fresh?
# Compare timestamps — if package.json is newer than node_modules, run npm install
ls -lt package.json node_modules/.package-lock.json 2>/dev/null | head -1
```
If package.json is newer or node_modules is missing, run `npm install`.

```bash
# 3. Detect test runner — read package.json with Read tool, check for vitest/jest/playwright in devDependencies
# Use the detected runner for all test steps in this session

# 4. Build check
npm run build 2>&1 | tail -5

# 5. Branch check
git branch --show-current
```
If on main/master, create a feature branch before making changes.

```bash
# 6. Worktree cleanup
git worktree prune 2>/dev/null
```

Skip individual checks if they take >10 seconds. Use Read tool to inspect package.json instead of `node -e` one-liners.

## Task Execution

### Find Next Task

```javascript
// prd.json has two shapes:
// Flat:   { stories: { "S1-001": {...} }, sprint: "sprint-1" }
// Nested: { sprints: [{ id: "sprint-1", stories: { "S1-001": {...} } }] }
const sp = prd.sprints ? prd.sprints[prd.sprints.length - 1] : prd;
const stories = sp.stories || prd.stories || {};
const storyEntries = Object.entries(stories);
const executable = storyEntries.filter(([id, s]) =>
  s.passes !== true &&
  (s.blockedBy || []).every(dep => stories[dep]?.passes === true)
);
```

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
4. Implement the solution
5. `npm run typecheck` — fix if fails
6. `npm run build` — fix if fails
7. Self-Verification (see below)
8. **Visual verification** — if the task touched UI (components, pages, styles, layouts), run audiq scan + screenshots. Do not skip this.
9. **Progress output**: `[3/8] ✓ S6-003 | Next: S6-004`
10. Update prd.json: `passes: true`
11. Start next task immediately

### Context Loading (before writing any code)

1. Read 2-3 existing files most similar to what you're building
2. Identify patterns: naming conventions, import style, error handling, state management
3. Match patterns — do not introduce new patterns when existing ones cover the use case

### Verification

| Task Type | Verification |
|-----------|--------------|
| UX/UI (public pages) | audiq scan + screenshots (desktop + mobile) + console errors |
| UX/UI (admin/internal) | typecheck + build only (skip audiq — not worth the overhead) |
| Feature (UI) | Build passes + audiq scan if public UI changed + complete primary user flow once |
| Edge Function / API | Deploy + `curl` with real params + verify 200 + response shape matches expected |
| API Integration | Real request with real credentials + verify response contains expected data |
| Bug fix | Reproduce, verify fixed, no new errors |
| Refactor | Typecheck + build + existing tests pass + no behavior change |

**Integration test is mandatory for API/Edge Function tasks.** Typecheck alone does not catch wrong API keys, wrong function signatures, or wrong database tables. Make one real request before marking done.

For UI/API tasks, detect or start a dev server first:
```bash
# Check if already running
for port in 3000 3001 5173 8080; do curl -s http://localhost:$port > /dev/null 2>&1 && break; done
# If none found, start one in background
Bash({ command: "npm run dev", run_in_background: true })
# Wait for startup, then scan
```

Use audiq MCP if available (check if `mcp__audiq__scan_page` is in your tool list):
```
mcp__audiq__scan_page({ url: "http://localhost:3000/[page]", profile: "quick" })
mcp__audiq__screenshot_page({ url: "http://localhost:3000/[page]", viewport: "desktop" })
mcp__audiq__screenshot_page({ url: "http://localhost:3000/[page]", viewport: "mobile" })
mcp__audiq__get_console_errors({ url: "http://localhost:3000/[page]" })
```

If audiq MCP is not connected, fall back to `WebFetch` for basic page load verification, or skip visual verification and note it in the completion summary.

Analyze returned screenshots for: broken layout, missing content, visual regressions, design quality.
Fix console errors or visual issues before marking task complete.

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

**5. UI/API Change? Visual Verification**
Run the audiq scan from the Verification section above. Not optional for UI tasks.

**6. Mark Complete**
Only after all checks pass. UI files (.tsx, .css, layout, page) without visual verification → go back to step 5.

## Smart Retry

On failure:
1. **Auto-fix first** — Most failures are trivial (missing import, type mismatch, wrong path). Read the error, fix it inline, re-run the check. This does not count as a retry.
2. Retry 1: Different approach
4. Retry 2: Simplest possible implementation
5. Still fails: set `passes: false`, continue to next task

Do not retry a third time. Do not spend more than 10 minutes on retries for a single task.

### Error Pattern Recognition

Track error types across tasks. When the same error pattern appears 3+ times:
1. Save it to auto-memory as a known pattern with its fix recipe
2. On future occurrences, apply the fix immediately without the auto-fix→retry cycle

Common patterns to recognize:
| Error Pattern | Instant Fix |
|--------------|-------------|
| `Cannot find module './X'` | Check file exists, fix path or create file |
| `Type 'X' is not assignable to type 'Y'` | Check the type definition, add union or cast |
| `Property 'X' does not exist on type 'Y'` | Add to interface or use optional chaining |
| `RLS policy violation` | Check auth.uid() in policy, verify user is authenticated |
| `CORS error` | Check API route headers or middleware config |

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

## Auto-Deploy (After Commit)

After committing completed tasks, check if changed files need deployment:

```bash
# Check what changed since last deploy/commit
git diff --name-only HEAD~1
```

| Changed Files | Deploy Action |
|--------------|---------------|
| `supabase/functions/*/index.ts` | Deploy changed edge functions (read deploy command from project CLAUDE.md) |
| `supabase/migrations/*.sql` | Run `supabase db push` or apply migration |
| `src/**` (Vercel/Next.js) | Push to trigger Vercel auto-deploy |

For edge functions, read project-specific deploy config from CLAUDE.md (e.g., path to supabase binary, project ref, flags like `--no-verify-jwt`). If no config found, skip auto-deploy and note it in completion summary.

After deploy, verify the deployment succeeded (check endpoint responds with 200).

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
1. Are all stories `passes: true`?
   - No: find blocked tasks and resolve blockers
   - Yes: continue to step 2
2. **Auto-transition sprint** (see below)
3. Output completion summary
4. Assess context to decide next action

### Auto Sprint Transition

When all pending tasks are done, auto handles the sprint lifecycle — never ask the user to do this manually:

```
1. Log summary to .claude/sprint-history.md:
   "Sprint [N]: [done]/[total] tasks | [date] | [one-line summary of work]"

2. Archive completed stories:
   - Copy current prd.json to .claude/archives/prd-archive-sprint-[N].json
   - Remove stories with passes: true from prd.json
   - Keep stories with passes: null, false, or "deferred"

3. If new work exists (audit findings, brainstorm stories, deferred tasks):
   - Bump sprint number in prd.json
   - Continue executing immediately

4. If no work remains:
   - Ask user (see below)
```

### Decision Matrix

| Signal | Action |
|--------|--------|
| Deferred tasks from previous sprint | Carry forward, start working |
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

```
Sprint [N] complete ([done]/[total] tasks).

What's next?
1. audit - Deep quality scan (finds bugs + violations)
2. brainstorm - Feature ideas + dead code scan
3. Done for now
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
