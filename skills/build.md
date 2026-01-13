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
---

# Autonomous Development Loop

## On "status" - Show Progress
```
Read prd.json
Count: passes=true (complete), passes=false (remaining)
Show active claims (claimedAt < 30min, passes=false)
Flag stale tasks (claimedAt > 7 days ago, passes=false) with ⚠️
Show recent learnings count from learnings.json
Report: "X of Y complete. Active: [list]. Stale: [list]. Learnings: Z. Next: [title]"
```

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
   - errorCount = {}     // Track error types
   - fileAttempts = {}   // Track file edit attempts
   - taskAttempts = 0    // Attempts on current task
```

### Phase 2: TASK SELECTION (with Auto-Discovery)
```
1. available = stories where passes=false AND (claimedAt is null OR >30min old)

2. IF available.length === 0 (queue empty):
   → Trigger AUTO-DISCOVERY mode (see below)
   → After discovery, re-check available

3. Pick first available by priority
4. **IMMEDIATELY** claim in prd.json:
   - Set claimedAt = new Date().toISOString()
   - Save prd.json RIGHT NOW before any other work
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

### Phase 3: PRE-TASK CONFIDENCE CHECK
```
Before implementing, verify:
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

#### 4b: Doom Loop Detection
```
While implementing:
- Track fileAttempts[path]++ on each edit
- Track errorCount[errorType]++ on each error

DOOM LOOP TRIGGERS (stop and ask user):
- Same file edited 5+ times without build passing
- Same error type appears 3+ times
- Task attempted 3+ times without progress
- Build fails 3+ times consecutively

On doom loop:
1. Log to progress.txt: "DOOM LOOP: [description]"
2. Create structured learning entry (even for failure)
3. Save current state to context.json
4. Ask user: "Stuck on [task]. Tried X times. Options: skip, different approach, or help?"
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

## File Schemas

### prd.json Task Schema
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
  "acceptanceCriteria": ["Testable requirement"],
  "attempts": []  // Optional: track retry history
}
```

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

## Command Summary

| Command | What Happens |
|---------|--------------|
| `auto` | Work through tasks; auto-discover when queue empty |
| `continue` | One task, then ask |
| `work on S42` | Do specific task |
| `status` | Show progress + learnings count |
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
