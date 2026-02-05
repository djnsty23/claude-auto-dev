---
name: auto
description: Autonomous task execution with testing and security. Works through all tasks without stopping.
triggers:
  - auto
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, TaskCreate, TaskUpdate, TaskList
model: opus
user-invocable: true
disable-model-invocation: true
---

# Auto Mode

Fully autonomous development. Works through all tasks without stopping until complete.

## Current State
!`git status --short 2>/dev/null || echo "not a git repo"`
!`node -e "try{const p=require('./prd.json');const s=Object.values(p.stories||{});console.log('Sprint:',p.sprint,'| Pending:',s.filter(x=>!x.passes).length,'| Done:',s.filter(x=>x.passes===true).length)}catch{console.log('No prd.json')}" 2>/dev/null`

## Entry Flow

```
auto
  ├─ Activate: write .claude/auto-active
  ├─ Check prd.json exists?
  │   ├─ No → Bootstrap from context
  │   └─ Yes → Check pending tasks
  │             ├─ None pending → IDLE Detection
  │             └─ Has pending → Execute tasks
  │
  └─ Execute until done or interrupted
  └─ Deactivate: delete .claude/auto-active
```

## Auto-Active Flag (Continuous Execution)

**On start**, immediately create the flag file:
```bash
echo '{"started":"'$(date -Iseconds)'","sprint":"current"}' > .claude/auto-active
```
PowerShell: `@{started=(Get-Date -Format o)} | ConvertTo-Json > .claude/auto-active`

This flag tells the Stop hook to **block Claude from stopping**. Claude will keep working as long as this flag exists.

**On exit** (user says "done", or truly nothing left), delete the flag:
```bash
rm -f .claude/auto-active
```

Always delete the flag when auto mode ends. If you're about to ask the user what's next (IDLE Detection), keep the flag active so the conversation doesn't end.

## Autonomous Behavior

Don't ask "Should I continue?" or show summaries and wait. Don't output minimal responses.

Instead:
- Make autonomous decisions
- Log decisions to `.claude/decisions.md`
- Keep working until truly done
- The Stop hook prevents Claude from ending - trust it

## Bootstrap (No prd.json)

When prd.json doesn't exist:

1. Read CLAUDE.md, README.md, package.json for context
2. Generate 5-10 starter tasks based on project
3. Create prd.json with stories
4. **Continue immediately** - don't stop for approval

## Pre-flight (Quick)

Before first task:
```bash
git status --short          # Warn if dirty, continue anyway
npm run build 2>&1 | tail -5  # Fail if broken, fix first
```

Skip if takes >10 seconds.

## Task Execution

### Find Next Task

```javascript
// stories is an object { "S1-001": {...}, "S1-002": {...} }
const storyEntries = Object.entries(prd.stories);
const executable = storyEntries.filter(([id, s]) =>
  s.passes !== true &&
  (s.blockedBy || []).every(dep => prd.stories[dep]?.passes === true)
);
```

### Execute Each Task

1. Read the task description
2. **Context Loading** (see below) — REQUIRED before writing any code
3. Implement the solution
4. `npm run typecheck` - Fix if fails
5. `npm run build` - Fix if fails
6. Verify (see below)
7. **Run Self-Verification** (see below) — all checks must pass first
8. Update prd.json: `passes: true`
9. **IMMEDIATELY** start next task

### Context Loading (REQUIRED before implementation)

Before writing ANY code for a task:

1. **Read 2-3 existing files** that are most similar to what you're building
   - If adding a component: read an existing component in the same directory
   - If adding an API route: read an existing route
   - If modifying a file: read the FULL file first, not just the section
2. **Identify patterns**: Note naming conventions, import style, error handling patterns, state management approach
3. **Match patterns**: Your new code MUST follow the same patterns. Never introduce a new pattern when an existing one covers the use case.

This prevents: wrong imports, inconsistent naming, duplicate utilities, style mismatches.

### Verification

| Task Type | Verification |
|-----------|--------------|
| UX/UI | `agent-browser` visual check |
| Feature | Build passes |
| API | Endpoint returns expected data |
| Bug fix | Reproduce → verify fixed |

For UX tasks - browser check required:
```bash
agent-browser open http://localhost:3000/path
agent-browser snapshot -i  # Verify expected element
```

### Self-Verification (REQUIRED after each task)

Before marking ANY task as complete, run these checks:

**1. Type Safety**
```bash
npm run typecheck 2>/dev/null || npx tsc --noEmit 2>/dev/null
```
If errors: fix them before proceeding. Never skip.

**2. Tests**
```bash
npm test -- --passWithNoTests --watchAll=false 2>/dev/null
```
If tests fail: fix them. If no test runner: skip.

**3. Self-Review**
Run `git diff` and check your own changes for:
- [ ] No `console.log` or `debugger` left in
- [ ] No hardcoded colors (use design tokens)
- [ ] All UI states handled (loading, empty, error)
- [ ] No `any` types introduced
- [ ] No commented-out code

**4. UI Change? Visual Check**
If the task modified UI components:
- Describe what the user should see
- Note any interactive states (hover, focus, click)
- Flag if responsive behavior needs manual check

**5. Mark Complete**
Only after ALL checks pass, mark the task as done. If ANY check fails, fix it first.

## Parallel Execution (Optional)

For independent tasks, launch multiple agents:
```
Task({ subagent_type: "general-purpose", prompt: "...", run_in_background: true })
Task({ subagent_type: "general-purpose", prompt: "...", run_in_background: true })
```

## Smart Retry

On failure (MAXIMUM 2 retries, then move on):
1. Log to `.claude/mistakes.md`
2. Retry 1: Different approach
3. Retry 2: Simplest possible implementation
4. Still fails → set `passes: false`, ALWAYS continue to next task

Do NOT retry a third time. Do NOT spend more than 10 minutes on retries for a single task.

## Commit Cadence

- Commit every 3 completed tasks
- Or after major milestones
- Use conventional commits: `feat|fix|refactor`

## Auto-Checkpoint (Token Protection)

**After every 3 completed tasks**, save checkpoint and recommend /compact:

```
if (completedThisSession % 3 === 0) {
  Write checkpoint to .claude/checkpoint.md

  Output:
  "💾 Checkpoint saved. Run /compact to reclaim ~40% tokens.
   Use /clear only at major transitions (~70% but wipes context)."
}
```

**Be concise.** Long responses burn tokens. Short responses = more runway.

## Completion

When all stories have `passes === true`:

```
All [N] tasks complete.

Summary:
- [X] features implemented
- [X] bugs fixed
- [X] improvements made

Run `status` to see full results.
```

## IDLE Detection (Smart Next Action)

If no tasks to work on:
1. Check: Are ALL stories `passes: true`?
   - NO → Find blocked tasks and resolve blockers
   - YES → Continue to step 2
2. Output completion summary for current sprint
3. **Assess context** to decide next action:

### Decision Matrix

| Signal | Action |
|--------|--------|
| TODOs/FIXMEs in code | Brainstorm → create sprint → continue |
| Console.logs left in | Quick cleanup sprint → continue |
| No tests exist | Suggest test sprint |
| Build warnings | Fix warnings sprint |
| Clean codebase, no issues | Ask user (see below) |

### Auto-Continue (Obvious Work)

If brainstorm scan finds **3+ actionable improvements**, auto-create next sprint and continue:
```
Sprint [N] complete (8/8 tasks).

Scanning codebase... found 5 improvements.
Creating Sprint [N+1] and continuing.
```

**Limit: 1 auto-generated sprint per session.** After completing an auto-generated sprint, always ask.

### Ask User (No Obvious Work or Limit Reached)

When the codebase is clean OR you've already auto-generated 1 sprint:
```
Sprint [N] complete (8/8 tasks).

What's next? (Recommended: ship)
1. ship - Deploy current work
2. audit - Deep quality check
3. brainstorm - Find more improvements
4. Done for now
```

Use `AskUserQuestion` with these options. Pick the recommended option based on context:
- Just finished features → recommend `ship`
- Been a while since audit → recommend `audit`
- Early in project → recommend `brainstorm`

**Keep `.claude/auto-active` flag while asking.** Only delete it if user picks "Done for now".
If user picks ship/audit/brainstorm → execute that flow, then loop back to IDLE Detection.

## Quick Reference

| Situation | Action |
|-----------|--------|
| No prd.json | Bootstrap from context |
| All done + issues found | Auto-brainstorm → new sprint |
| All done + clean code | Ask user for next action |
| All done + already auto-sprinted | Ask user (limit reached) |
| Build broken | Fix first |
| Task fails | Retry 2x, then skip |
| UX task | Browser verify required |
| Blocked task | Skip, work on unblocked |
