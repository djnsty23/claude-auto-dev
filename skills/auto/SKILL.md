---
name: auto
description: Autonomous task execution with testing and security. Works through all tasks without stopping.
triggers:
  - auto
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, TaskCreate, TaskUpdate, TaskList
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

On start, create the flag file:
```bash
echo '{"started":"'$(date -Iseconds)'","sprint":"current"}' > .claude/auto-active
```
PowerShell: `@{started=(Get-Date -Format o)} | ConvertTo-Json > .claude/auto-active`

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
- Log decisions to `.claude/decisions.md`
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

## Pre-flight (Quick)

Before first task:
```bash
git status --short
npm run build 2>&1 | tail -5
```

Also check if prd.json needs archiving:
```bash
node -e "try{const s=require('fs').statSync('prd.json');if(s.size>50000)console.log('[Archive] prd.json is '+Math.round(s.size/1024)+'KB — run archive before starting')}catch{}"
```

Skip if takes >10 seconds.

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

### Execute Each Task

1. Read the task description
2. **Context Loading** — read 2-3 similar files to match existing patterns
3. Implement the solution
4. `npm run typecheck` — fix if fails
5. `npm run build` — fix if fails
6. Self-Verification (see below)
7. **Visual verification** — if the task touched UI (components, pages, styles, layouts), run audiq scan + screenshots. Do NOT skip this.
8. Update prd.json: `passes: true`
9. Start next task immediately

### Context Loading (before writing any code)

1. Read 2-3 existing files most similar to what you're building
2. Identify patterns: naming conventions, import style, error handling, state management
3. Match patterns — do not introduce new patterns when existing ones cover the use case

### Verification

| Task Type | Verification |
|-----------|--------------|
| UX/UI | audiq scan + screenshots (desktop + mobile) + console errors |
| Feature | Build passes + audiq scan if UI changed |
| API | Endpoint returns expected data + network check |
| Bug fix | Reproduce, verify fixed, no new errors |

For UI/API tasks, detect or start a dev server first:
```bash
# Check if already running
for port in 3000 3001 5173 8080; do curl -s http://localhost:$port > /dev/null 2>&1 && break; done
# If none found, start one in background
Bash({ command: "npm run dev", run_in_background: true })
# Wait for startup, then scan
```

Use audiq MCP (preferred):
```
mcp__audiq__scan_page({ url: "http://localhost:3000/[page]", profile: "quick" })
mcp__audiq__screenshot_page({ url: "http://localhost:3000/[page]", viewport: "desktop" })
mcp__audiq__screenshot_page({ url: "http://localhost:3000/[page]", viewport: "mobile" })
mcp__audiq__get_console_errors({ url: "http://localhost:3000/[page]" })
```

Analyze returned screenshots for: broken layout, missing content, visual regressions, design quality.
Fix console errors or visual issues before marking task complete.

If audiq MCP is not available, fall back to agent-browser:
```bash
agent-browser open http://localhost:3000/[page]
agent-browser snapshot -i
agent-browser errors
```

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

**3. Self-Review**
Run `git diff` and check:
- No `console.log` or `debugger` left in
- No hardcoded colors (use design tokens)
- All UI states handled (loading, empty, error)
- No `any` types introduced
- No commented-out code

**4. UI/API Change? Visual Verification**
If a dev server is running, scan the affected page with audiq:
```
mcp__audiq__scan_page({ url: "http://localhost:3000/[page]", profile: "quick" })
mcp__audiq__screenshot_page({ url: "http://localhost:3000/[page]", viewport: "desktop" })
mcp__audiq__screenshot_page({ url: "http://localhost:3000/[page]", viewport: "mobile" })
mcp__audiq__get_console_errors({ url: "http://localhost:3000/[page]" })
```
Check screenshots for: layout breaks, missing content, visual regressions, design quality.
If audiq is unavailable, use agent-browser as fallback.

**5. Mark Complete**
Only after all checks pass. If any check fails, fix it first.

A task that changed UI files (.tsx, .css, layout, page) without visual verification is NOT complete — go back to step 4.

## Parallel Execution (Optional)

For independent tasks, launch multiple agents with worktree isolation to avoid file conflicts:
```
Agent({ subagent_type: "general-purpose", prompt: "...", run_in_background: true, isolation: "worktree" })
```

Use `SendMessage({ to: agentId })` to continue a previously spawned agent (do not pass a resume parameter).

### File Ownership (required for parallel agents)

Assign each agent exclusive files to prevent merge conflicts:
- Specify in the prompt: "You own src/components/Feature.tsx and src/lib/feature-utils.ts. Do not modify any other files."
- **Shared files** (globals.css, shared types, index files) must NOT be assigned to parallel agents — handle them in a single coordinating step after agents complete.
- If an agent needs a shared type, it should create a local type and let the coordinator merge it.

### Worktree Agents Must Commit

When using `isolation: "worktree"`, agents MUST commit their work before finishing:
```
"Before you finish, run: git add -A && git commit -m 'feat: [description]'. Uncommitted changes in worktrees are lost on cleanup."
```

## Smart Retry

On failure:
1. **Auto-fix first** — Most failures are trivial (missing import, type mismatch, wrong path). Read the error, fix it inline, re-run the check. This does not count as a retry.
2. If auto-fix doesn't resolve it, log to `.claude/mistakes.md`
3. Retry 1: Different approach
4. Retry 2: Simplest possible implementation
5. Still fails: set `passes: false`, continue to next task

Do not retry a third time. Do not spend more than 10 minutes on retries for a single task.

## Commit Cadence

- Commit every 3 completed tasks
- Or after major milestones
- Use conventional commits: `feat|fix|refactor`

## Save Project Knowledge

When solving hard problems (debugging, retries, unexpected errors), save reusable lessons:
- **Patterns discovered** — "This project uses X pattern for Y" → save to auto-memory
- **Environment quirks** — "Port 5173 is Vite, not 3000" → save to auto-memory
- **Common fix recipes** — "RLS errors need auth.uid() not custom function" → save to auto-memory

This builds project context that helps future sessions. Use Claude's built-in auto-memory — just describe what you learned and it persists.

## Token Management

With 1M context, token pressure is rarely an issue. Only suggest `/compact` if context usage is visibly high (e.g., after 10+ completed tasks or large file reads).

Be concise but don't sacrifice clarity for brevity.

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
2. Output completion summary for current sprint
3. Assess context to decide next action:

### Decision Matrix

| Signal | Action |
|--------|--------|
| Sprint had 5+ tasks | Run `simplify` to catch duplication from parallel work |
| Dev server running + UI changes made | Run `scan` to catch visual/QA regressions |
| Last scan scored <70 on any category | Create stories from scan findings |
| TODOs/FIXMEs in code | Brainstorm (auto mode creates stories) |
| Console.logs left in | Quick cleanup sprint |
| No tests exist | Suggest test sprint |
| Build warnings | Fix warnings sprint |
| Clean codebase | Ask user (see below) |

### Auto-Continue (Obvious Work)

If brainstorm scan finds 3+ actionable improvements, auto-create next sprint and continue:
```
Sprint [N] complete (8/8 tasks).
Scanning codebase... found 5 improvements.
Creating Sprint [N+1] and continuing.
```

Limit: 1 auto-generated sprint per session. After that, ask the user.

### Ask User (No Obvious Work or Limit Reached)

```
Sprint [N] complete (8/8 tasks).

What's next? (Recommended: ship)
1. ship - Deploy current work
2. simplify - Check for duplication and over-abstraction
3. audit - Deep quality check
4. brainstorm - Find more improvements
5. Done for now
```

Present these options to the user and wait for their response. Pick recommendation based on context.

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
