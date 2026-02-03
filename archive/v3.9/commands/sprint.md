---
description: Run a timed development sprint with automatic phase cycling
argument-hint: "[HOURS|MILESTONE] [--cycles N]"
---

# Sprint Mode

Run a structured development sprint with automatic phase rotation.

## First: Configure Status Line

Before starting sprint, ensure context monitoring is active:
```
/status line
```
This shows model, context %, and tokens in real-time. Essential for long sprints.

## Usage

```bash
sprint 3h              # Run for 3 hours
sprint 2h --cycles 2   # Run 2 full cycles within 2 hours
sprint "all P1 done"   # Run until milestone reached
sprint until-green     # Run until build + typecheck pass
```

## Sprint Cycle Phases

Each cycle runs these phases in order:

| Phase | Duration | Actions |
|-------|----------|---------|
| 1. brainstorm | 5% | Generate/update tasks if prd.json empty |
| 2. auto | 70% | Build all unblocked tasks (parallel agents) |
| 3. review | 10% | Run typecheck, check for `as any`, validate types |
| 4. polish | 5% | Strip console.logs, optimize imports, format |
| 5. security | 5% | Run `npm audit`, check for exposed secrets |
| 6. docs | 5% | Update CHANGELOG, commit message summaries |

## CRITICAL: No Stopping

Same rules as auto mode:
- ❌ NEVER use `AskUserQuestion` - make decisions autonomously
- ❌ NEVER wait for input between phases
- ✅ Log decisions to `.claude/sprint-log.md`
- ✅ Continue to next phase even if current has issues

## State File

Create `.claude/sprint.local.md`:

```yaml
---
started_at: "2025-01-25T10:00:00Z"
end_condition: "3h"  # or milestone text
current_phase: "auto"
cycle: 1
max_cycles: 0  # 0 = unlimited until time/milestone
phases_completed: ["brainstorm"]
tasks_completed: 5
---
```

## Time Management

Check remaining time before each phase:
```bash
STARTED=$(grep started_at .claude/sprint.local.md | cut -d'"' -f2)
ELAPSED=$(($(date +%s) - $(date -d "$STARTED" +%s)))
LIMIT_SECONDS=$((3 * 3600))  # 3h example
REMAINING=$((LIMIT_SECONDS - ELAPSED))
```

If `REMAINING < 600` (10 min), skip to docs phase and wrap up.

## Milestone Detection

For milestone-based sprints like `"all P1 done"`:
```javascript
const prd = require('./prd.json');
const p1Incomplete = prd.stories.filter(s => s.priority === 1 && s.passes !== true);
if (p1Incomplete.length === 0) {
  // Milestone reached - complete sprint
}
```

## Phase Execution (AUTOMATIC)

**DO NOT just document phases - EXECUTE them using Skill tool:**

### Phase 1: Brainstorm (5%)
```
IF prd.json has no pending tasks:
  Skill({ skill: "brainstorm" })
ELSE:
  Skip - tasks already exist
```

### Phase 2: Auto (70%)
```
Skill({ skill: "auto" })
// This runs until all unblocked tasks complete
// Uses parallel builder agents (up to 5)
```

### Phase 3: Review (10%)
```
Skill({ skill: "review" })
// Runs typecheck, checks for `as any`, validates types
// Logs issues to .claude/mistakes.md
```

### Phase 4: Polish (5%)
```
Bash: npm run build -- --mode production  # Strip console.logs
Bash: npx eslint --fix src/               # Fix lint issues
Grep: Check bundle size warnings
```

### Phase 5: Security (5%)
```
Bash: npm audit --audit-level=high
Grep: Search for hardcoded secrets (password=, apiKey=, token=)
IF Supabase project:
  mcp__supabase__get_advisors(project_id, type: "security")
```

### Phase 6: Docs (5%)
```
Update CHANGELOG.md with completed task summaries
Git commit: "feat: Sprint cycle N complete"
```

## Phase Loop Implementation

```javascript
// Sprint controller logic
async function runSprintCycle(cycleNumber) {
  updateState({ current_phase: "brainstorm", cycle: cycleNumber });

  // Phase 1: Brainstorm (skip if tasks exist)
  const prd = JSON.parse(fs.readFileSync('prd.json'));
  const pending = prd.stories.filter(s => s.passes !== true);
  if (pending.length === 0) {
    await invokeSkill("brainstorm");
  }

  // Phase 2: Auto (main work)
  updateState({ current_phase: "auto" });
  await invokeSkill("auto");

  // Phase 3: Review
  updateState({ current_phase: "review" });
  await invokeSkill("review");

  // Phase 4: Polish
  updateState({ current_phase: "polish" });
  await runBash("npm run build -- --mode production");
  await runBash("npx eslint --fix src/ 2>/dev/null || true");

  // Phase 5: Security
  updateState({ current_phase: "security" });
  await runBash("npm audit --audit-level=high 2>/dev/null || true");

  // Phase 6: Docs
  updateState({ current_phase: "docs" });
  await updateChangelog();
  await gitCommit(`feat: Sprint cycle ${cycleNumber} complete`);

  // Check if should continue
  if (!checkEndCondition()) {
    return runSprintCycle(cycleNumber + 1);
  }
}
```

## End of Sprint

When time/milestone reached:
1. Complete current task (don't abandon mid-work)
2. Run final commit
3. Generate sprint summary:

```
Sprint Complete!

Duration: 2h 47m
Cycles: 2 full + partial
Tasks completed: 23
Commits: 8
Issues found & fixed: 12
  - 5 type errors
  - 3 security warnings
  - 4 polish items

Next suggested: [remaining high-priority tasks]
```

## Handoff Integration

At sprint end, auto-generate handoff:
```bash
/handoff --sprint
```
