---
name: Autonomous Build Loop
description: Multi-agent autonomous development with interactive task management.
triggers:
  - build
  - continue
  - auto
  - status
  - adjust
  - brainstorm
  - stop
  - reset
  - work on
---

# Autonomous Development Loop

## On "status" - Show Progress
```
Read prd.json
Count: passes=true (complete), passes=false (remaining)
Show active claims (claimedAt < 30min, passes=false)
Report: "X of Y complete. Active: [list]. Next available: [title]"
```

## On "auto" - Full Autonomous Mode

**DO NOT ASK FOR CONFIRMATION. DO NOT STOP. Just keep going.**

```
1. Read prd.json
2. available = stories where passes=false AND (claimedAt is null OR >30min old)
3. Pick first available task
4. **IMMEDIATELY** claim in prd.json:
   - Set claimedAt = new Date().toISOString()
   - Save prd.json RIGHT NOW before any other work
   - This is how other agents know the task is taken
5. Implement task
6. Run: npm run build (or project's build command)
7. If passes: set passes=true, completedAt=today, save prd.json
8. Append to progress.txt
9. Goto step 1

STOP ONLY IF:
  - User interrupts
  - Build fails repeatedly (3+ times)
  - No available tasks remaining
```

**CRITICAL: prd.json is the coordination mechanism.**
- Write claims to prd.json BEFORE starting work
- Do NOT rely on internal TodoWrite for multi-agent coordination
- Other agents read prd.json to see what's claimed
- If you don't update prd.json, other agents will grab the same task

## On "continue" - Single Task Mode

Same as auto but:
- Only process ONE task
- Ask before continuing to next

## On "work on SXX" - Specific Task

1. Find story with matching ID (e.g., S42)
2. **IMMEDIATELY** update prd.json:
   - Set claimedAt = new Date().toISOString()
   - Save prd.json before doing anything else
3. Implement the task
4. Mark passes=true, completedAt=today, save prd.json
5. Ask what to do next

---

## On "brainstorm" - Generate New Stories

**Use AskUserQuestion. Keep it simple - one good question.**

### Step 1: One Adaptive Question
```
question: "What would you like to build next?"
options:
  - { label: "Fix bugs/issues", description: "Things that are broken or annoying" }
  - { label: "Add features", description: "New functionality" }
  - { label: "Improve UX", description: "Polish, speed, usability" }
  - { label: "Let me describe", description: "I'll type what I need" }
```

### Step 2: Based on Answer
- If "Fix bugs": Ask what's broken, generate 3-5 fix stories
- If "Add features": Ask what features, generate 3-5 feature stories
- If "Improve UX": Analyze current code, suggest 3-5 polish stories
- If "Let me describe": Parse their input, generate matching stories

### Step 3: Confirm Before Adding
```
question: "Generated X stories. Add them?"
options:
  - { label: "Add all", description: "Include everything" }
  - { label: "Show me first", description: "List them before adding" }
```

### Step 4: Add to prd.json
Report: "Added X stories. Say 'auto' to start."

---

## On "adjust" - Reprioritize Tasks

**Only runs when user explicitly says "adjust". Never auto-triggers.**

### Step 1: Group Remaining Tasks
```
Analyze remaining tasks (passes=false)
Group by theme/component
```

### Step 2: Present Options
```
question: "Which should I focus on?"
options:
  - { label: "[Group A] (X tasks)", description: "..." }
  - { label: "[Group B] (X tasks)", description: "..." }
  - { label: "All in order", description: "Keep current priorities" }
```

### Step 3: Reprioritize
Move selected group to top, renumber priorities.

---

## On "stop" - Before Closing Session

```
1. Read prd.json
2. Clear claimedAt on any incomplete tasks you were working on
3. Save prd.json
4. Delete tmpclaude-* files (Bash: rm tmpclaude-* or PowerShell: Remove-Item tmpclaude-*)
5. Report: "Stopped. Safe to close."
```

## On "reset" - After Crash

```
1. Read prd.json
2. Clear ALL claimedAt fields where passes=false
3. Save prd.json
4. Delete tmpclaude-* files
5. Report: "Reset all claims."
```

## On "build [goal]" - Quick Start

1. Parse the goal
2. Generate 5-10 stories
3. Show list, ask to confirm
4. Add to prd.json
5. Begin auto loop

---

## Task Schema

```json
{
  "id": "S1",
  "title": "Short title",
  "description": "What to build",
  "priority": 1,
  "passes": false,
  "claimedAt": null,
  "completedAt": null,
  "files": ["path/to/file.ts"],
  "acceptanceCriteria": ["Testable requirement"]
}
```

**Source of truth:** `passes: true/false`

---

## Command Summary

| Command | What Happens |
|---------|--------------|
| `auto` | Work through all tasks, don't stop |
| `continue` | One task, then ask |
| `work on S42` | Do specific task |
| `status` | Show progress |
| `brainstorm` | Generate new stories |
| `adjust` | Reprioritize remaining tasks |
| `build [goal]` | Generate tasks from description |
| `stop` | Clear claims, safe to close |
| `reset` | Clear all claims after crash |
