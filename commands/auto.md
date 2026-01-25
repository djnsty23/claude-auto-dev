---
description: Work through all tasks in prd.json automatically with maximum parallelism
---

# Auto Mode

Work through ALL pending tasks using MAXIMUM parallelism. Launch up to 5 parallel builder agents.

## CRITICAL: NEVER STOP

**FORBIDDEN ACTIONS - DO NOT DO THESE:**
- ❌ NEVER use `AskUserQuestion` tool - make decisions yourself
- ❌ NEVER ask "Should I continue?" or "Which option?"
- ❌ NEVER wait for user input between tasks
- ❌ NEVER stop to show progress - just keep working

**REQUIRED BEHAVIOR:**
- ✅ Make autonomous decisions using reasonable defaults
- ✅ If unsure between options, pick the simpler/safer one
- ✅ If a task is ambiguous, interpret it reasonably and proceed
- ✅ Log decisions to `.claude/decisions.md` instead of asking

## Session Lock (Prevent Conflicts)

Before starting, check for active sessions:
```bash
# Check lock file
if [ -f ".claude-lock" ]; then
  LOCK_AGE=$(($(date +%s) - $(stat -c %Y .claude-lock 2>/dev/null || echo 0)))
  if [ $LOCK_AGE -lt 60 ]; then
    echo "Another session is active. Use 'reset' to force unlock."
    exit 1
  fi
fi
# Create lock with PID and timestamp
echo "$(date +%s):$$:$(hostname)" > .claude-lock
```

Update lock every 30 seconds while running. Delete on completion.

## Pre-flight Check

Before launching agents, verify:
1. `git status` - warn if uncommitted changes (but continue)
2. `npm run build` - ensure project builds before starting
3. No merge conflicts in current branch

## Maximum Parallelism

1. Read `prd.json`, find ALL tasks where `passes !== true` AND `blockedBy` are complete
2. Launch up to 5 parallel `builder` agents via Task tool in a SINGLE message
3. When agents complete, immediately launch next batch
4. Continue until no tasks remain

## Parallel Launch Example

```
// Launch 5 agents in ONE message block:
Task({ subagent_type: "builder", description: "Build AI11", prompt: "...", run_in_background: true })
Task({ subagent_type: "builder", description: "Build AI12", prompt: "...", run_in_background: true })
Task({ subagent_type: "builder", description: "Build AI13", prompt: "...", run_in_background: true })
Task({ subagent_type: "builder", description: "Build RPT01", prompt: "...", run_in_background: true })
Task({ subagent_type: "builder", description: "Build RPT02", prompt: "...", run_in_background: true })
```

## Dependency Resolution

- Check `blockedBy` array - skip tasks whose deps aren't `passes: true`
- Tasks WITHOUT blockedBy or with all deps complete → can run in parallel
- Re-check after each batch completes for newly unblocked tasks

## After Each Batch Completes

1. Run `npm run typecheck` (if available) - **FAIL task if types don't pass**
2. Run `npm run build` - **FAIL task if build doesn't pass**
3. Mark completed tasks in prd.json (`passes: true`)
4. Git commit the changes
5. **IMMEDIATELY** launch next batch of unblocked tasks
6. NO confirmation prompts - just keep going

## Type Safety Requirements

**Every agent MUST verify type safety before marking a task complete:**

```bash
# Run these checks (in order):
npm run typecheck 2>&1 | head -50  # Check for TS errors
npm run build 2>&1 | tail -10      # Verify build passes
```

**If typecheck fails:**
1. Fix the type errors immediately
2. Do NOT mark task as complete until types pass
3. Log the error pattern to `.claude/mistakes.md`

**Common type issues to avoid:**
- Never use `as any` - use proper type guards
- Check for `undefined` before accessing properties
- Ensure interface properties match actual data
- Use `typeof` and `in` guards for unknown types

## Smart Retry (On Failure)

When a task fails:
1. Log error to `.claude/mistakes.md` with pattern
2. Retry with modified approach (max 2 retries):
   - Retry 1: "Previous attempt failed with [error]. Try a different approach."
   - Retry 2: "Two approaches failed. Use simplest possible implementation."
3. If still fails, mark `passes: false` with error summary and continue to next task

## Batch Commits

Instead of committing after every task:
1. Commit after every 3 completed tasks OR
2. Commit before switching to a different file domain OR
3. Commit on explicit `stop` command

Use commit message: `feat: Complete [TASK-IDs] - [brief summary]`

## Stop Conditions

- No more pending tasks (all `passes: true`)
- All remaining tasks blocked by incomplete dependencies
- User explicitly interrupts (Ctrl+C or "stop")

## For TRUE Non-Stop Mode

Use Ralph Loop integration:
```
/ralph-loop auto --completion-promise 'All prd.json tasks complete'
```

This prevents ANY exit until all tasks are done.

## Screenshots

Save to `.claude/screenshots/`, never project root.

## Task Visibility

Use TaskUpdate for Claude Code UI:
- Starting: `TaskUpdate({ taskId: "X", status: "in_progress" })`
- Done: `TaskUpdate({ taskId: "X", status: "completed" })`
