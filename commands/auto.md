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

Before starting, check for active sessions using cross-platform approach:

```javascript
// Use Node.js for cross-platform compatibility
const fs = require('fs');
const lockFile = '.claude-lock';

function checkLock() {
  if (fs.existsSync(lockFile)) {
    const stat = fs.statSync(lockFile);
    const ageSeconds = (Date.now() - stat.mtimeMs) / 1000;
    if (ageSeconds < 60) {
      console.log('Another session is active. Use "reset" to force unlock.');
      return false;
    }
  }
  // Create/update lock
  fs.writeFileSync(lockFile, JSON.stringify({
    timestamp: Date.now(),
    pid: process.pid,
    hostname: require('os').hostname()
  }));
  return true;
}
```

**Or use inline check:**
```bash
# Check if lock exists and is recent (works on both platforms via Node)
node -e "const fs=require('fs'); if(fs.existsSync('.claude-lock') && (Date.now()-fs.statSync('.claude-lock').mtimeMs)<60000) { console.log('LOCKED'); process.exit(1); }"
```

Update lock every 30 seconds while running. Delete on completion with:
```bash
node -e "require('fs').unlinkSync('.claude-lock')" 2>/dev/null || true
```

## Pre-flight Check

Before launching agents, verify:
1. `git status` - warn if uncommitted changes (but continue)
2. `npm run build` - ensure project builds before starting
3. No merge conflicts in current branch

## Execution Modes

### Sequential Mode (Default for UX/bugfix)
When tasks touch the SAME files or need visual verification:
- Work on ONE task at a time
- Verify with browser/build after each
- Best for: UX tasks, bugfixes, refactors

### Parallel Mode (For independent features)
When tasks create NEW files or touch DIFFERENT areas:
- Launch up to 5 parallel `builder` agents via Task tool
- All in a SINGLE message block
- Best for: New pages, new hooks, new components

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
5. **IMMEDIATELY** launch next batch - DO NOT:
   - ❌ Print summary tables
   - ❌ Show "Sprint Summary" or progress reports
   - ❌ Wait for acknowledgment
   - ❌ Say "Let me know if you want to continue"
6. Just silently continue to next task

## CONTINUATION IS MANDATORY

After EVERY commit, you MUST:
```
1. Check prd.json for remaining tasks (passes === null)
2. If tasks remain → start next task IMMEDIATELY
3. If no tasks remain → say "All tasks complete" and stop
```

**NEVER** end with a summary and wait. The loop is:
`task → verify → commit → next task → verify → commit → ...`

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

**Common type issues to avoid (from production mistakes):**
- Never use `as any` - use proper type guards
- Check for `undefined` before accessing properties
- Ensure interface properties match actual data
- Use `typeof` and `in` guards for unknown types

## Learned Code Quality Rules

**From recurring mistakes - ALWAYS follow:**

### Type Safety (5 recurring patterns)
1. **Single source of truth** - NEVER define same type in multiple files
2. **Complete Record types** - `Record<UnionType, Value>` MUST include ALL union members
3. **Supabase typing** - Always type-assert: `.insert({...} as Database[...]['Insert'])`
4. **String→number conversion** - Convert enums before arithmetic: `tierToNumber(tier)`
5. **Safe property access** - Guard with `'key' in obj && typeof obj.key === 'x'`

### React/Component Rules (2 recurring patterns)
1. **No nested interactives** - NEVER nest `<button>` inside `<button>` → Use `<div role="button">`
2. **Hooks at top level** - NEVER call hooks inside callbacks → Extract to component level

### API Integration (1 pattern)
1. **Surface auth errors** - Detect `reauth_required` and show toast, don't fail silently

### Decision Logging
When making autonomous decisions, log to `.claude/decisions.md` with:
```markdown
## [Component/Feature Name]
**Decision:** What you decided
**Rationale:** Why this approach (not just what)
**Trade-offs:** What was considered but rejected
**Impact:** Files/features affected
```

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

## Task Type Routing

| Task Type | Mode | Reason |
|-----------|------|--------|
| `bugfix` | Sequential | May need debugging, affects existing code |
| `ux` | Sequential | Needs visual verification, touches shared components |
| `feature` (new page) | Parallel | Creates new files, independent |
| `feature` (modify) | Sequential | Touches existing code |
| `ai` | Parallel | Usually new hooks/components |
| `integration` | Parallel | New API connections |
| `performance` | Sequential | Affects shared code paths |
| `tech-debt` | Sequential | Refactoring existing code |

## Stop Conditions

- No more pending tasks (all `passes: true`)
- All remaining tasks blocked by incomplete dependencies
- User explicitly interrupts (Ctrl+C or "stop")

## For TRUE Non-Stop Mode

**Why Claude stops:** Claude Code has natural stopping points after showing results. Our instructions can't override this - it's a platform limitation.

**Solution: Ralph Loop integration**

Ralph Loop uses the Stop hook to inject the prompt back, creating a real loop:

```
/ralph-loop auto --completion-promise 'All prd.json tasks complete'
```

This prevents ANY exit until the promise is true. The loop:
1. Runs auto mode
2. When Claude tries to stop, Ralph intercepts
3. Feeds "auto" back as input
4. Continues until all tasks have `passes: true`

**Alternative: Manual continuation**

If Ralph Loop isn't available, user says `continue` when it stops. The session will see remaining tasks and continue.

**Note:** With Ralph Loop, there's NO manual stop - it runs until completion or max iterations.

## Screenshots

Save to `.claude/screenshots/`, never project root.

## Task Visibility

Use TaskUpdate for Claude Code UI:
- Starting: `TaskUpdate({ taskId: "X", status: "in_progress" })`
- Done: `TaskUpdate({ taskId: "X", status: "completed" })`
