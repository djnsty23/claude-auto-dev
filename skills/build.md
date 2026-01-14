---
name: Autonomous Build Loop
description: Multi-agent autonomous development with learning loop, UX review, and AI-first defaults.
triggers:
  - build
  - continue
  - auto
  - status
  - adjust
  - brainstorm
  - generate
  - stop
  - reset
  - work on
  - skip
  - unskip
  - archive
  - ux review
  - learn
  - rollback
  - deps
  - tree
  - review
---

# Autonomous Development Loop

## On "status" - Show Progress (Enhanced Dashboard)

**Generate rich markdown output with emojis and ANSI colors:**

```markdown
# 🎯 Progress: X/Y (Z%)

## 🔥 Active (N)
SXX: [Title] (Agent-N, ❤️ Xm ago, N attempts)
[List all with heartbeat <10min, show ⚠️ if heartbeat >10min but <30min]

## ✅ Recent Completions (Last 3)
SXX: [Title] (Xm ago, N attempts, coverage X%)

## 📋 Next Up (Top 5 ready tasks)
SXX: [Title] (P0, ready)
SYY: [Title] (P1, blocked by SXX)

## 🧠 Learnings: X entries
LXXX: [Description] (applied X× ⭐ most used)
[Show top 3 by timesApplied]

## 🚫 Blocked (if any)
SXX: [Title] (waiting for: SYY, SZZ)

## 📊 Session Stats
Duration: Xh Ym | Completed: N | Doom loops: N | Pattern storms: N

## 🎯 Next Task
SXX: [Title] - [Brief description]
```

**Logic:**
1. Read prd.json
2. Calculate stats
3. Check heartbeats (flag if >10min as ⚠️)
4. Load learnings.json, sort by timesApplied
5. Identify blocked tasks (dependsOn not satisfied)
6. Generate formatted output
7. Also write to `.claude/dashboard.md` for persistence

## On "auto" - Full Autonomous Mode

**DO NOT ASK FOR CONFIRMATION. DO NOT STOP. Just keep going.**

### Phase 1: LOAD (Quick Context)
```
1. Check for .claude/handoff.md - read if exists (previous session notes)
2. Read .claude/context.json if exists (cached state)
3. Read prd.json
4. Skim progress.txt (last 20 lines for recent learnings)
5. Skim ~/.claude/patterns.txt (global patterns that apply everywhere)
6. Load learnings.json (structured error→solution pairs)
7. Initialize tracking:
   - errorCount = {}           // Track error types
   - fileAttempts = {}         // Track file edit attempts
   - taskAttempts = 0          // Attempts on current task
   - patternStormTracker = []  // Recent errors for storm detection
   - sessionStart = Date.now() // For session duration
   - heartbeatInterval = null  // Will be set when claiming task
```

### Phase 2: TASK SELECTION (with Auto-Discovery + Dependencies + Heartbeat)
```
1. Filter available tasks with multi-pass logic:

   Pass 1 - Availability:
   available = stories where passes=false AND NOT skipped

   Pass 2 - Claim status (with heartbeat check):
   available = available.filter(s =>
     s.claimedAt === null OR
     Date.now() - new Date(s.heartbeat || s.claimedAt) > 10 * 60 * 1000  // >10min
   )

   Pass 3 - Dependencies (NEW):
   available = available.filter(s =>
     (s.dependsOn || []).every(depId =>
       stories.find(d => d.id === depId)?.passes === true
     )
   )

2. IF available.length === 0 (queue empty):
   → Check if blocked tasks exist (all remaining have unmet dependencies)
   → If blocked: Report which tasks are blocking progress
   → Else: Trigger AUTO-DISCOVERY mode (see below)
   → After discovery, re-check available

3. Sort by priority (ascending), pick first
4. **IMMEDIATELY** claim in prd.json:
   - Set claimedAt = new Date().toISOString()
   - Set heartbeat = new Date().toISOString()
   - Save prd.json RIGHT NOW before any other work
   - Start background heartbeat updater (every 3 min)
```

**Heartbeat Logic (Background):**
```
Every 3 minutes during task work:
1. Read current prd.json
2. Find your claimed task
3. Update heartbeat = new Date().toISOString()
4. Save prd.json (quick atomic write)

This allows other agents to steal work if you hang/crash.
Heartbeat >10min = stealable (vs old 30min claim timeout)
```

### AUTO-DISCOVERY MODE (when queue empty)
```
Triggered automatically when no tasks available.

1. RUN UX REVIEW (silent):
   - Check for console errors in browser
   - Run through main user flows
   - Look for: off-screen elements, broken buttons, empty states
   - Generate UX-### stories for issues found

2. RUN CODE SCAN:
   - npm run build (check for warnings)
   - Look for TODO/FIXME comments
   - Check for unused exports
   - Generate FIX-### stories for issues found

3. CHECK LEARNINGS:
   - Review recent learnings.json entries
   - Any patterns that suggest missing features?
   - Generate S### stories for improvements

4. PRESENT FINDINGS:
   "Found X potential issues:
   - UX: [list]
   - Code: [list]
   - Improvements: [list]

   Add to queue? (yes/no/pick)"

5. IF user says yes:
   - Add stories to prd.json
   - Continue auto loop

6. IF user says no:
   - Report: "Queue empty. Say 'brainstorm' to add new features."
   - Exit auto mode
```

### Phase 3: PRE-TASK QUALITY CHECK
```
Before implementing, verify:
- [ ] Criteria are specific (no red flags: "test flow", "ensure works")
- [ ] Files mentioned in task exist (or will be created)
- [ ] Required env vars are documented
- [ ] No blockers noted in context.json

If confidence < 80%:
- Log concern to progress.txt
- Continue anyway (don't block on uncertainty)
```

### Phase 4: IMPLEMENT with LEARNING LOOP

#### 4a: Pre-Retry Consultation (CRITICAL)
```
BEFORE attempting any fix:
1. Extract error signature (key terms, error codes)
2. Search learnings.json for matching signature
3. Search progress.txt for similar issues
4. Search ~/.claude/patterns.txt for applicable patterns

If match found with confidence > 0.7:
   - Apply known solution FIRST
   - Log: "Applied learning [id]: [description]"
   - Increment learnings.json timesApplied

If no match:
   - Attempt novel solution
   - Track for potential new learning
```

#### 4b: Doom Loop & Pattern Storm Detection
```
While implementing:
- Track fileAttempts[path]++ on each edit
- Track errorCount[errorType]++ on each error
- Add to patternStormTracker: { signature, taskId, timestamp }

DOOM LOOP TRIGGERS (stop and ask user):
- Same file edited 5+ times without build passing
- Same error type appears 3+ times in CURRENT task
- Task attempted 3+ times without progress
- Build fails 3+ times consecutively

PATTERN STORM TRIGGERS (NEW - stop immediately):
- Same error signature appears in 3+ different stories within last hour
- Indicates systematic issue (broken import, missing config, bad env var)

Pattern Storm Check:
recentErrors = patternStormTracker.filter(e =>
  Date.now() - e.timestamp < 3600000  // Last hour
)
errorsBySignature = groupBy(recentErrors, 'signature')
stormDetected = Object.values(errorsBySignature).some(group =>
  group.length >= 3 && new Set(group.map(e => e.taskId)).size >= 3
)

On doom loop:
1. Log to progress.txt: "DOOM LOOP: [description]"
2. Create structured learning entry (even for failure)
3. Save current state to context.json
4. Ask user: "Stuck on [task]. Tried X times. Options: skip, different approach, or help?"

On pattern storm:
1. Log to progress.txt: "PATTERN STORM: [signature] across tasks [list]"
2. Identify common factor (import path, config file, env var)
3. Create high-priority fix story: "FIX-STORM: [root cause]"
4. Ask user: "Same error in 3+ tasks within 1hr. Root cause likely: [analysis].
   Options: fix globally now, skip affected tasks, or investigate manually?"
```

### Phase 5: VERIFICATION
```
1. Run: npm run build (or project's build command)
2. If build passes, run tests:
   - npm test (if test script exists)
   - Check for test failures
3. If both pass:
   - Set passes=true, completedAt=today in prd.json
   - Clear errorCount and fileAttempts for this task
   - Update .claude/context.json (every 5 tasks)
4. If fails:
   - Consult learnings before retrying (Phase 4a)
   - Increment taskAttempts
   - Check doom loop conditions
   - If not doom loop: try to fix and repeat

Note: If project has no test script, skip step 2.
```

### Phase 6: LEARN (Automatic Pattern Extraction)
```
AFTER each task (success or failure):

1. Append to progress.txt:
   - What was done
   - Any gotchas discovered
   - Files changed

2. If error took 2+ attempts to fix:
   a. Create entry in learnings.json:
      {
        "id": "L###",
        "type": "fix|pattern|gotcha|workaround",
        "errorSignature": "regex pattern matching the error",
        "description": "What went wrong",
        "solution": "How to fix it",
        "confidence": 0.7,
        "stories": ["S##"],
        "files": ["affected/files.ts"],
        "created": "ISO date",
        "timesApplied": 0
      }
   b. If pattern is universal (applies to any project):
      - Also append to ~/.claude/patterns.txt
      - Format: [Category] Pattern: explanation

3. Goto Phase 2 (next task)
```

### STOP CONDITIONS
```
- User interrupts
- Doom loop triggered
- No available tasks remaining
- Context limit approaching (proactively save and notify)
```

**CRITICAL: prd.json is the coordination mechanism.**
- Write claims to prd.json BEFORE starting work
- Do NOT rely on internal TodoWrite for multi-agent coordination
- Other agents read prd.json to see what's claimed
- If you don't update prd.json, other agents will grab the same task

---

## On "continue" - Single Task Mode

Same as auto but:
- Only process ONE task
- Ask before continuing to next

## On "work on SXX" - Specific Task

1. Find story with matching ID (e.g., S42)
2. **IMMEDIATELY** update prd.json:
   - Set claimedAt = new Date().toISOString()
   - Save prd.json before doing anything else
3. Run PRE-TASK CONFIDENCE CHECK
4. Implement the task (with learning loop + doom loop detection)
5. Mark passes=true, completedAt=today, save prd.json
6. Ask what to do next

---

## On "ux review" - Manual UX Testing Phase

**Automated tests catch code bugs. UX review catches human friction.**

### Step 1: Identify Testable Flows
```
Read prd.json, find completed UI stories
List main user flows:
- [ ] Auth flow (signup, login, logout)
- [ ] Main creation flow (wizard steps)
- [ ] Settings/preferences
- [ ] Admin panel (if exists)
```

### Step 2: UX Review Checklist
```
For each flow, check:

VISIBILITY
- [ ] All interactive elements visible on screen (no off-screen buttons)
- [ ] Popups/modals within viewport bounds
- [ ] Loading states visible
- [ ] Error messages visible and helpful

PERSISTENCE
- [ ] Dismissed dialogs stay dismissed (localStorage fallback)
- [ ] Form state survives refresh
- [ ] User preferences persist

NAVIGATION
- [ ] Can always go back
- [ ] Action buttons at END of content (not middle)
- [ ] Clear what clicking a button does
- [ ] No dead ends

EMPTY STATES
- [ ] "0 items" has helpful message
- [ ] Clear CTAs when list is empty
- [ ] Skip option when data unavailable

BUTTON LABELS
- [ ] Labels describe action outcome, not technical process
- [ ] "Continue to Preview" not "Generate Preview"
- [ ] No ambiguous buttons

AI-FIRST DEFAULTS (Andy's Preference)
- [ ] AI pre-selects optimal values
- [ ] User tweaks, not builds from scratch
- [ ] Sensible defaults everywhere
```

### Step 3: Test with Playwright MCP
```
For critical flows:
1. Launch browser: mcp__playwright__browser_navigate
2. Walk through flow step by step
3. Take snapshots: mcp__playwright__browser_snapshot
4. Document any friction found
```

### Step 4: Log UX Issues
```
Create UX stories in prd.json for issues found:
{
  "id": "UX-###",
  "title": "Fix: [issue description]",
  "type": "ux-fix",
  "priority": 0,  // High priority
  "passes": false
}
```

---

## On "brainstorm" or "generate" - Generate New Stories

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
- If "Improve UX": Run UX review checklist, suggest fixes
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

## On "learn [description]" - Manual Learning Entry

```
1. Parse the learning from user description
2. Create entry in learnings.json:
   {
     "id": "L###",
     "type": "manual",
     "errorSignature": "[extracted pattern]",
     "description": "[what user said]",
     "solution": "[extracted solution]",
     "confidence": 1.0,  // User-provided = high confidence
     "stories": [],
     "created": "ISO date",
     "timesApplied": 0
   }
3. If global, also add to ~/.claude/patterns.txt
4. Report: "Learning captured. ID: L###"
```

---

## On "stop" - Before Closing Session

**ENHANCED: Generate handoff + save learnings**

```
1. Read prd.json
2. Clear claimedAt on any incomplete tasks you were working on
3. Save prd.json
4. Generate .claude/handoff.md:
   ---
   # Session Handoff
   Date: [ISO timestamp]

   ## What Was Done
   - [List of completed tasks this session]

   ## In Progress (if any)
   - [Task ID]: [What was started, what's left]

   ## Blocked/Issues
   - [Any problems encountered]

   ## Learnings This Session
   - [Count] new entries in learnings.json
   - Key patterns: [list]

   ## Next Steps
   - [Recommended next task]
   - [Any context needed]

   ## Quick Stats
   - Tasks completed: X
   - Current phase: Y
   - Overall progress: Z%
   ---
5. Update .claude/context.json with final state
6. Ensure learnings.json is saved
7. Delete tmpclaude-* files (PowerShell: Remove-Item tmpclaude-*)
8. Report: "Session saved. Handoff ready. X learnings captured. Safe to close."
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

## On "review" - Code Review & Quality Check

**Comprehensive review of recent changes or specific areas.**

### Automatic Actions
```
1. CHECK BUILD
   npm run build
   Report any TypeScript/compilation errors

2. CHECK GIT STATUS
   git status
   git diff --stat HEAD~3
   List uncommitted changes and recent commits

3. RUN LINTER (if configured)
   npm run lint (if exists)
   Report issues by severity

4. SECURITY SCAN
   - Check for hardcoded secrets (.env patterns in code)
   - Check for console.log with sensitive data
   - Verify no API keys in committed files

5. CODE QUALITY CHECKS
   - Find TODO/FIXME comments
   - Check for any `as any` TypeScript casts
   - Identify large functions (>50 lines)
   - Find duplicate code patterns

6. DEPENDENCY CHECK
   - Outdated packages (npm outdated)
   - Security vulnerabilities (npm audit)
```

### Generate Report
```markdown
# 📋 Code Review Report

## ✅ Build Status
[Pass/Fail with details]

## 🔒 Security
[Any issues found or "No issues"]

## 📝 Code Quality
- TODOs: X found
- Type safety issues: X
- Large functions: X

## 📦 Dependencies
- Outdated: X packages
- Vulnerabilities: X (Y critical)

## 💡 Recommendations
1. [Actionable improvement]
2. [Actionable improvement]

## 🎯 Quick Wins
[Easy fixes that improve quality]
```

### Create Stories (Optional)
```
If issues found:
question: "Found X issues. Create fix stories?"
options:
  - { label: "Yes, create stories", description: "Add to prd.json" }
  - { label: "No, just report", description: "Informational only" }
```

---

## File Schemas

### prd.json Task Schema (Updated)
```json
{
  "id": "S1",
  "title": "Short title",
  "description": "What to build",
  "priority": 1,
  "passes": false,
  "claimedAt": null,
  "heartbeat": null,                    // NEW: Updated every 3min during work
  "completedAt": null,
  "dependsOn": [],                      // NEW: Array of story IDs that must complete first
  "blockedBy": [],                      // Auto-computed: stories blocking this one
  "files": ["path/to/file.ts"],
  "acceptanceCriteria": ["Testable requirement"],
  "attempts": [],                       // Optional: track retry history
  "criteriaScore": null                 // Optional: 1/attempts = effectiveness
}
```

**New Fields:**
- `heartbeat`: Timestamp of last activity (updated every 3min). If >10min old, task is stealable.
- `dependsOn`: Array of story IDs (e.g., ["S40", "S41"]). Task won't be picked until all dependencies pass.
- `blockedBy`: Auto-computed from dependsOn. Shows what's blocking this task (for dashboard).

### learnings.json Schema
```json
{
  "version": "1.0",
  "learnings": [
    {
      "id": "L001",
      "type": "fix",
      "errorSignature": "Export .* doesn't exist in target module",
      "description": "Import name doesn't match actual export",
      "solution": "Check actual exports with Read tool, use correct name",
      "confidence": 0.9,
      "stories": ["S107"],
      "files": ["src/lib/supabase/server.ts"],
      "created": "2026-01-12",
      "timesApplied": 3
    }
  ]
}
```

**Source of truth:** `passes: true/false`

---

## On "skip SXX" - Skip Blocked Task

```
1. Find story with matching ID
2. Add to story: skippedAt = new Date().toISOString(), skipReason = "[reason]"
3. Clear claimedAt if set
4. Save prd.json
5. Report: "Skipped [title]. Reason: [reason]. Say 'unskip SXX' to restore."
```

## On "unskip SXX" - Restore Skipped Task

```
1. Find story with matching ID
2. Remove skippedAt and skipReason
3. Save prd.json
4. Report: "Restored [title]. It's back in the queue."
```

## On "archive" - Clean Completed Phases

```
1. Read prd.json
2. Find phases where all stories have passes=true
3. Move those stories to prd-archive.json (create if needed)
4. Remove archived stories from prd.json
5. Keep phase metadata in prd.json (for reference)
6. Report: "Archived X stories from phases [list]. prd.json is now lighter."
```

---

## On "rollback SXX" - Undo Task Changes

**Git-based time machine for undoing task work:**

```
1. Find task with matching ID
2. Search git log for commit before task started:
   git log --all --grep="Before SXX" --format="%H %s" -1

3. If found:
   - Show changes that will be lost: git diff [commit] HEAD
   - Ask confirmation: "Rollback to before SXX? This will discard: [file list]"
   - If yes: git reset --hard [commit]
   - Update prd.json: clear claimedAt, completedAt, set passes=false
   - Report: "Rolled back to before SXX. Task reopened."

4. If not found:
   - Report: "No rollback point found for SXX. Use 'git log' to find manual restore point."
```

**Auto-commit before each task (add to Phase 2 after claiming):**
```
After claiming task in prd.json:
1. git add -A
2. git commit -m "WIP: Before SXX - [title]" --no-verify
3. Continue with implementation

This creates restore points without manual intervention.
```

---

## On "deps" or "tree" - Show Dependency Tree

**ASCII visualization of task dependencies:**

```
1. Read prd.json
2. Build dependency graph from dependsOn fields
3. Generate tree starting from roots (tasks with no dependencies)

Example output:

📦 Dependency Tree

S40: Database schema ✅
  ├─ S41: Auth endpoints ✅
  │   ├─ S43: Login UI ⏳ (you are here, 5m ago)
  │   └─ S45: Signup UI 📋 (ready)
  └─ S42: User model ✅
      ├─ S46: Profile page 🚫 (blocked, depends on S43)
      └─ S47: Settings 📋 (ready)

S50: Payments 📋 (ready)
  └─ S51: Checkout 🚫 (blocked by S50)

S60: Analytics ⚠️ (claimed 15m ago, no heartbeat)

Legend:
✅ Complete | ⏳ In progress | 📋 Ready | 🚫 Blocked | ⚠️ Stale claim
```

**Algorithm:**
- Group by root (tasks with no dependencies)
- Use DFS to traverse dependents
- Show status emoji based on passes/claimedAt/heartbeat/dependsOn
- Indent children with tree characters (├─ └─)

---

## Command Summary

| Command | What Happens |
|---------|--------------|
| `auto` | Work through tasks; auto-discover when queue empty |
| `continue` | One task, then ask |
| `work on S42` | Do specific task |
| `status` | Enhanced dashboard with heartbeats, dependencies, learnings |
| `deps` / `tree` | Show ASCII dependency tree with status emojis |
| `rollback S42` | Undo task changes via git, reopen task |
| `brainstorm` | Generate new stories |
| `generate` | Same as brainstorm - create new stories |
| `adjust` | Reprioritize remaining tasks |
| `build [goal]` | Generate tasks from description |
| `ux review` | Manual UX testing checklist |
| `learn [desc]` | Manually add a learning |
| `skip S42` | Skip blocked task with reason |
| `unskip S42` | Restore skipped task |
| `archive` | Move completed phases to prd-archive.json |
| `stop` | Save handoff + learnings, safe to close |
| `reset` | Clear all claims after crash |

---

## Andy's Design Principles (Always Apply)

### AI-First Defaults
```
When building UI that collects user input:
1. AI should pre-analyze and suggest optimal values
2. Pre-fill all fields with AI recommendations
3. User tweaks, not builds from scratch
4. "Generate" happens automatically, user reviews result

Example: Video import → AI analyzes → pre-selects clips, style, music mood
User sees optimized result, can adjust if wanted.
```

### UX Patterns
```
- Action buttons at END of content, never middle
- Button labels = outcome ("Continue to Preview"), not process ("Generate")
- Empty states have helpful message + CTA
- Dismissed dialogs persist (localStorage fallback)
- All elements visible on screen
- No dead ends - always a way forward
```

### Technical Patterns
```
- TypeScript strict, no `any` (use typed helpers)
- Relative paths, not absolute
- Environment vars for all secrets
- Build must pass before marking complete
- Console errors = bugs to fix
```

---

## Security Rules

**NEVER hardcode API keys or secrets in code.**

When implementing features that need API keys:
1. Use `process.env.API_KEY_NAME` - never literal values
2. Add the var name to `.env.example` (without value)
3. Tell user to set it via system env vars or .env.local

```typescript
// GOOD
const apiKey = process.env.OPENAI_API_KEY;

// BAD - never do this
const apiKey = "sk-abc123...";
```

Environment variable storage:
- System env vars for global keys (GOOGLE_CLIENT_ID, etc.)
- .env.local for project-specific URLs only
- Never commit .env files to git

## Story Creation Guidelines

### Acceptance Criteria Count (Dynamic)
```
Match criteria count to story complexity:

| Type | Criteria | Example |
|------|----------|---------|
| Bug fix | 2-3 | "Error gone, no regression, build passes" |
| Small feature | 3-4 | "UI renders, API works, state persists, tests pass" |
| Medium feature | 4-5 | Standard |
| Complex feature | 5-7 | Multiple integrations, edge cases |
| Infrastructure | 2-3 | "Config works, deploys, no downtime" |

DON'T pad with filler criteria. Each must be testable.
```

### Criteria Quality Checklist
```
Each criterion should be:
- [ ] Testable (can verify pass/fail)
- [ ] Specific (not vague like "works well")
- [ ] Independent (doesn't duplicate another)
- [ ] Necessary (removing it would miss something)

BAD: "Good UX" (not testable)
GOOD: "Button visible without scrolling" (testable)
```

## Criteria Effectiveness Tracking

### Track Attempts Per Story
```json
{
  "id": "S140",
  "attempts": [
    { "at": "2026-01-13T10:00:00Z", "error": "Still showing 2 toasts", "fix": "..." },
    { "at": "2026-01-13T10:15:00Z", "error": null }  // Success
  ],
  "criteriaScore": 0.5  // 1/attempts = effectiveness
}
```

### Auto-Adjustment Rules
```
After completing a story:

IF attempts > 2:
  - Flag criteria as "weak"
  - Analyze which criterion was vague
  - Add learning: "Criterion '[text]' was too vague, needed: [specific version]"

IF attempts == 1:
  - Flag criteria as "strong"
  - Use as template for similar stories

Over time, build pattern:
  - Vague phrases to avoid: "test X flow", "ensure works", "fix issue"
  - Strong phrases to use: "X returns Y", "clicking Z shows exactly 1 toast"
```

### Criteria Quality Auto-Check
```
Before starting a story, scan criteria for red flags:

RED FLAGS (vague):
- "Test the X flow"
- "Ensure X works"
- "Fix the issue"
- "Improve X"
- "Handle errors"

If >50% criteria have red flags:
  - Suggest rewrites before implementing
  - Example: "Test clip flow" → "Clicking Analyze shows 1 toast, clips appear in <2s"
```

## Auto-QA After Implementation

### Trigger Automatically
```
After marking any story as complete:

1. RUN BUILD CHECK (always):
   npm run build
   - If fails: reopen story, fix errors, don't mark complete until passes
   
2. RUN RELATED TESTS (if test files exist):
   - Check for: tests/**/*.spec.ts matching modified files
   - Run: npx playwright test [matched-files]
   - If fails: add failing tests to learnings, attempt fix
   
3. QUICK SMOKE TEST (if UI changed):
   - List affected routes from story files
   - Suggest: "Run smoke test on /dashboard/create?" (y/n)
   
4. UPDATE STORY:
   - Add "qaPass": true/false to story
   - Add "qaNotes": ["build passed", "2 tests passed"] 
```

### Skip Conditions
```
Skip auto-QA if:
- Story is type: "docs" or "refactor" (no functional change)
- User says "skip qa" or "quick mode"
- Previous 3 stories all passed QA (confidence boost)
```

### QA Failure Recovery
```
If QA fails after implementation:
1. DON'T mark story complete
2. Analyze error, search learnings.json
3. Apply fix
4. Re-run QA
5. Max 3 attempts, then ask user
```
