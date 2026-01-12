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

**DO NOT ASK FOR CONFIRMATION. Just keep going.**

```
1. Read prd.json
2. available = stories where passes=false AND (claimedAt is null OR >30min old)
3. active_count = count stories where passes=false AND claimedAt <30min old
4. offset = random(0,2) if active_count=0, else active_count
5. task = available[offset] (or last available if offset too high)
6. Claim: set claimedAt = now(), save prd.json IMMEDIATELY
7. Verify: re-read prd.json, confirm claimedAt is still yours
   - If overwritten by another agent: goto step 1
8. Implement task
9. Run: npm run build (or project's build command)
10. If passes: set passes=true, completedAt=today, save prd.json
11. Append to progress.txt
12. After every 5 tasks: trigger "adjust" wizard
13. Goto step 1

STOP ONLY IF:
  - User interrupts
  - Build fails repeatedly (3+ times)
  - No available tasks remaining
```

## On "continue" - Single Task Mode

Same as auto but:
- Only process ONE task
- Ask before continuing to next
- Skip offset calculation (just pick first available)

---

## On "brainstorm" - Discovery Questionnaire

**Interactive session to uncover new stories. Use AskUserQuestion for each step.**

### Step 1: Understand Current State
```
Read prd.json and progress.txt
Summarize: "You have X complete, Y remaining tasks."
```

### Step 2: Ask Discovery Questions (use AskUserQuestion)

**Question 1: Pain Points**
```
question: "What's frustrating you most about the current app?"
options:
  - { label: "UX issues", description: "Confusing flows, slow interactions" }
  - { label: "Missing features", description: "Things you wish existed" }
  - { label: "Bugs/stability", description: "Things that break or don't work" }
  - { label: "Performance", description: "Speed, loading times" }
```

**Question 2: User Needs**
```
question: "Who uses this and what do they need most?"
options:
  - { label: "New users", description: "Onboarding, discoverability" }
  - { label: "Power users", description: "Advanced features, shortcuts" }
  - { label: "Admins", description: "Management, analytics, controls" }
  - { label: "All of the above", description: "General improvements" }
```

**Question 3: Scope**
```
question: "How big should these new features be?"
options:
  - { label: "Quick wins", description: "Small fixes, polish (1-2 hours each)" }
  - { label: "Medium features", description: "New functionality (half day each)" }
  - { label: "Big features", description: "Major additions (full day+)" }
  - { label: "Mix", description: "Variety of sizes" }
```

**Question 4: Open Input**
```
question: "Describe any specific features or improvements you have in mind:"
(Allow free text input - user types custom ideas)
```

### Step 3: Generate Stories
```
Based on answers, generate 5-15 new stories
Group them by feature area
Each story has: id, title, description, priority, files (guessed), acceptanceCriteria
```

### Step 4: Review Generated Stories (use AskUserQuestion)
```
question: "I've drafted X stories. Which should we add?"
options:
  - { label: "Add all", description: "Include everything I suggested" }
  - { label: "Let me pick", description: "Show me the list to select from" }
  - { label: "Refine first", description: "Discuss before adding" }
```

### Step 5: Add to prd.json
```
Add selected stories with incremental IDs
Report: "Added X new stories. Run 'auto' to start building."
```

---

## On "adjust" - Interactive Feature Selection Wizard

**ALWAYS use AskUserQuestion tool for this wizard.**

### Step 1: Show Current State
```
Read prd.json and progress.txt
Summarize: "Completed X tasks. Recent: [last 3 titles]"
```

### Step 2: Group Remaining Tasks by Feature Area
```
Analyze remaining tasks (passes=false)
Group by common theme/component/feature
Example groupings:
  - "UI Polish" (3 tasks): animations, responsive fixes, dark mode
  - "API Integration" (4 tasks): YouTube import, batch processing, webhooks
  - "Testing" (2 tasks): E2E tests, unit tests
```

### Step 3: Present Options via AskUserQuestion
```
question: "Which feature set should I work on next?"
options:
  - { label: "UI Polish (3 tasks)", description: "Animations, responsive, dark mode" }
  - { label: "API Integration (4 tasks)", description: "YouTube, batch, webhooks" }
  - { label: "Testing (2 tasks)", description: "E2E and unit tests" }
  - { label: "All remaining", description: "Work through everything in order" }
```

### Step 4: Reprioritize Based on Selection
```
If user picks a feature group:
  - Move those tasks to top priority
  - Renumber priorities in prd.json
  - Report: "Reprioritized. Starting with [group name]."

If user picks "All remaining":
  - Keep current order
  - Continue with auto

If user provides custom input:
  - Parse their request
  - Either reprioritize existing tasks OR generate new tasks
  - Confirm understanding before proceeding
```

### When to Auto-Trigger This Wizard
- After every 5 completed tasks (rhythm check)
- When a task seems unclear or out of scope
- When build fails and you're unsure of the fix
- When you notice conflicting requirements
- When the next task doesn't logically follow

**Phrase it as:** "I've completed 5 tasks. Let me check in on priorities."

---

## On "stop" - Clear Claims and Exit Safely

```
1. Read prd.json
2. For stories where passes=false AND claimedAt is recent:
   - Set claimedAt = null
3. Save prd.json
4. Report: "Stopped. Released X claims. Safe to close."
```

## On "reset" - Clear ALL Claims (After Crash)

```
1. Read prd.json
2. For ALL stories where passes=false:
   - Set claimedAt = null
3. Save prd.json
4. Report: "Reset all claims. Ready for fresh start."
```

## On "build [goal]" - Auto-Generate Tasks

1. Analyze the goal
2. Break into feature groups (each group = 3-5 related tasks)
3. **Present feature groups via adjust wizard**
4. Let user pick which to start with
5. Add selected tasks to prd.json
6. Begin auto loop

---

## Task Schema (prd.json)

```json
{
  "id": "S1",
  "title": "Short title",
  "description": "What to build",
  "priority": 1,
  "passes": false,
  "claimedAt": null,
  "completedAt": null,
  "group": "UI Polish",
  "files": ["path/to/file.ts"],
  "acceptanceCriteria": ["Testable requirement"]
}
```

**Key fields:**
- `passes`: true/false - the source of truth
- `claimedAt`: ISO timestamp or null - for multi-agent coordination
- `group`: Optional feature group for wizard categorization

---

## Parallel Agents

```bash
claude "auto"   # Each agent auto-coordinates via offset algorithm
claude "auto"
claude "auto"
```

Each agent will independently trigger "adjust" after 5 tasks.
User only needs to respond to one wizard at a time.

---

## Command Summary

| Command | Purpose |
|---------|---------|
| `auto` | Work through all tasks without stopping |
| `continue` | One task, then ask before next |
| `status` | Show progress summary |
| `brainstorm` | Discovery questionnaire → generate new stories |
| `adjust` | Pick which feature set to work on next |
| `build [goal]` | Generate tasks from a goal description |
| `stop` | Clear your claims before closing |
| `reset` | Clear all claims after crash |
