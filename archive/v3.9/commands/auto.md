---
description: Self-bootstrapping autonomous development - handles all scenarios
---

# Auto Mode v2

Single command for fully autonomous development. Handles cold start, task execution, and completion.

## Entry Point Flow

```
auto
  ├─ Check Ralph Loop active?
  │   └─ No → Suggest: /ralph-loop auto --completion-promise 'All tasks complete'
  │
  ├─ Check prd.json exists?
  │   ├─ No → Bootstrap (see below)
  │   └─ Yes → Check pending tasks
  │             ├─ None pending → All done! (output promise if in Ralph)
  │             └─ Has pending → Execute tasks
  │
  └─ Execute until done or interrupted
```

## Ralph Loop Detection

Check if in Ralph Loop and get completion promise:
```bash
node -e "
const fs=require('fs');
const f='.claude/ralph-loop.local.md';
if(!fs.existsSync(f)){console.log('NOT_RALPH');process.exit()}
const c=fs.readFileSync(f,'utf8');
if(!c.includes('active: true')){console.log('NOT_RALPH');process.exit()}
const m=c.match(/completion_promise:\\s*[\"']?([^\"'\\n]+)/);
const promise=m?m[1].trim():'All tasks complete';
console.log('IN_RALPH|'+promise);
"
```

Output format: `IN_RALPH|<promise_text>` or `NOT_RALPH`

**If NOT in Ralph Loop:**
- Work normally but Claude will stop after results
- Suggest: "For non-stop execution, run: `/ralph-loop auto --completion-promise 'All tasks complete'`"

**If IN Ralph Loop:**
- Work continuously
- **CRITICAL:** When all tasks complete, output the EXACT promise text from config:
  ```
  <promise>EXACT_PROMISE_TEXT_FROM_CONFIG</promise>
  ```
- Do NOT use a generic "All tasks complete" - use the ACTUAL text from ralph-loop.local.md

## Bootstrap (No prd.json)

When prd.json doesn't exist:

1. **Check for project context:**
   - Read CLAUDE.md, README.md, package.json
   - Understand what the project is

2. **Generate initial tasks:**
   - Based on project context, create 5-10 starter tasks
   - OR if no context, create setup tasks (init, config, first feature)

3. **Create prd.json:**
   ```json
   {
     "projectName": "From package.json or folder name",
     "version": "0.1.0",
     "stories": [/* generated tasks */]
   }
   ```

4. **Continue to execution** - Don't stop, start working immediately

## CRITICAL: NEVER STOP

**FORBIDDEN:**
- ❌ NEVER use `AskUserQuestion` - make decisions yourself
- ❌ NEVER ask "Should I continue?"
- ❌ NEVER show summaries and wait
- ❌ NEVER say "Let me know..."

**REQUIRED:**
- ✅ Make autonomous decisions
- ✅ Log decisions to `.claude/decisions.md`
- ✅ Keep working until truly done

## Pre-flight (Quick)

Before first task:
```bash
git status --short          # Warn if dirty, continue anyway
npm run build 2>&1 | tail -5  # Fail if broken
```

Skip if takes >10 seconds. Don't block on pre-flight.

## Task Execution

### Mode Selection

| Task Type | Mode | Verification |
|-----------|------|--------------|
| `ux`, `bugfix` | Sequential | Browser test |
| `feature` (new) | Parallel | Build + Browser |
| `ai`, `integration` | Parallel | Data test |
| `performance` | Sequential | Metrics |

### Parallel Execution

Launch up to 5 builder agents in ONE message:
```
Task({ subagent_type: "builder", prompt: "...", run_in_background: true })
Task({ subagent_type: "builder", prompt: "...", run_in_background: true })
// ... up to 5
```

### After Each Task

1. `npm run typecheck` - Fix if fails
2. `npm run build` - Fix if fails
3. **Verify** (see below)
4. Update prd.json: `passes: true`, `verified: "browser"|"test"`
5. Commit every 3 tasks
6. **IMMEDIATELY** start next task

## Auto-Verification

**For UX tasks - REQUIRED browser check:**
```bash
# Navigate to affected page
agent-browser navigate http://localhost:5173/path

# Check for expected element from acceptance criteria
agent-browser snapshot -q "expected text or element"
```

If element NOT found → `passes: false`, retry with fix.
If element found → `verified: "browser"`

**For other tasks:**
- Feature: Build passes + page loads → `verified: "build"`
- API: Endpoint returns expected data → `verified: "test"`
- AI: Mock data renders correctly → `verified: "browser"`

## Dependency Resolution

```javascript
// Find executable tasks
const executable = stories.filter(s =>
  s.passes !== true &&
  (s.blockedBy || []).every(dep =>
    stories.find(d => d.id === dep)?.passes === true
  )
);
```

Skip blocked tasks, work on unblocked ones.

## Completion

**When all tasks done:**

1. Check: `stories.every(s => s.passes === true)`

2. If in Ralph Loop:
   - Read the EXACT completion_promise from `.claude/ralph-loop.local.md`
   - Output: `<promise>EXACT_PROMISE_TEXT</promise>`
   - Example: if promise is "All sprint 4 tasks complete, leaving no detail out..." then output:
     ```
     <promise>All sprint 4 tasks complete, leaving no detail out...</promise>
     ```
   - **SEMANTIC MATCHING:** If tasks evolved (Sprint 4 → Sprint 6), the promise is still TRUE
     because the INTENT was "finish all tasks" - which IS complete

3. If NOT in Ralph, output:
   ```
   All 23 tasks complete. Run `status` to see results.
   ```

## IDLE DETECTION (Critical for Token Efficiency)

**If you find yourself with no tasks to work on:**

1. First check: Are ALL stories `passes: true`?
   - YES → Output the completion promise immediately
   - NO → Find blocked tasks and resolve blockers

2. **NEVER output minimal responses** like `.`, `—`, `•`, `Idle.`, `Ready.`
   - These burn tokens without progress
   - If you have nothing to do, the work IS done

3. **If all tasks complete + in Ralph Loop:**
   ```bash
   # Read promise and output it
   node -e "const c=require('fs').readFileSync('.claude/ralph-loop.local.md','utf8'); const m=c.match(/completion_promise:\\s*[\"']?([^\"'\\n]+)/); console.log('<promise>'+(m?m[1].trim():'All tasks complete')+'</promise>')"
   ```

4. **Trust semantic completion:** If all prd.json tasks pass, the promise is TRUE regardless
   of how sprint numbers evolved during execution

## Smart Retry

On failure:
1. Log to `.claude/mistakes.md`
2. Retry 1: Different approach
3. Retry 2: Simplest implementation
4. Still fails → `passes: false`, continue to next

## Code Quality Rules

**From production mistakes - ALWAYS follow:**

1. **Types:** Single source of truth, complete Records, Supabase typing
2. **React:** No nested buttons, hooks at top level only
3. **API:** Surface auth errors with toast

## Screenshots

Save to `.claude/screenshots/`, never project root.

## Quick Reference

| Situation | Action |
|-----------|--------|
| No prd.json | Bootstrap from context |
| All done + Ralph | Read exact promise from config, output `<promise>TEXT</promise>` |
| All done + no Ralph | Output status summary |
| Build broken | Fix first |
| Task fails | Retry 2x, then skip |
| UX task | Browser verify required |
| Not in Ralph | Suggest starting it |
| **IDLE (no tasks)** | **Output promise immediately - DO NOT loop with dots** |
| Sprint numbers changed | Promise still TRUE if all tasks pass (semantic match) |
