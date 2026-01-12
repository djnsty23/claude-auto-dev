# Awareness Skill

## Purpose
Prevent doom loops, detect stuck states, and maintain self-awareness throughout development sessions.

## Core Principle
**Fresh context + pattern awareness = efficient development**

Each task starts with selective carry-over of what matters, avoiding accumulated confusion.

## Pre-Task Briefing

Before starting ANY task, generate a briefing:

```
Task Briefing: S42 "Add YouTube import API"
=============================================

Domain: backend.api
Estimated complexity: Medium
Time budget: 30 minutes

Relevant Patterns (from patterns.json):
✅ Apply: Zod-first API design (SP001)
✅ Apply: External API wrapper (SP008)
⚠️ Avoid: Direct external API in handler (FA002)

Known Issues (from context.json):
- YouTube API has quota limits
- CORS requires proxy through API route

Doom Loop Risks (from patterns.json):
⚠️ "Module not found" - verify import paths
⚠️ "Type mismatch" - check Zod schema matches API response

Checklist:
[ ] Create Zod schema first
[ ] Use server-side API call
[ ] Handle rate limiting
[ ] Add error responses

Ready to proceed.
```

## Doom Loop Detection

### What is a Doom Loop?
Repeating the same action expecting different results:
- Same error appearing 3+ times
- Same file edited repeatedly without progress
- Build failing with identical error

### Detection Algorithm
```javascript
function detectDoomLoop(action) {
  const recentActions = getLastNActions(5);

  // Same error pattern
  if (countMatching(recentActions, action.error) >= 3) {
    return { type: 'error_loop', signature: action.error };
  }

  // Same file edited without build success
  const fileEdits = recentActions.filter(a => a.type === 'edit' && a.file === action.file);
  if (fileEdits.length >= 3 && !anyBuildSuccess(recentActions)) {
    return { type: 'edit_loop', file: action.file };
  }

  // Same approach repeated
  const approaches = recentActions.filter(a => similarity(a.approach, action.approach) > 0.8);
  if (approaches.length >= 2 && !anySuccess(approaches)) {
    return { type: 'approach_loop', approach: action.approach };
  }

  return null;
}
```

### Intervention Triggers

When doom loop detected:

```
⚠️ DOOM LOOP DETECTED
======================
Type: Error loop
Signature: "Property 'videoId' does not exist on type"
Attempts: 3

Previous attempts:
1. Added videoId to interface → Same error
2. Changed import path → Same error
3. Regenerated types → Same error

STOP. Take a different approach.

Suggested actions:
1. Read the FULL error message and stack trace
2. Check if type file is being compiled
3. Verify import is from correct file
4. Consider: Is this the right interface?

Known resolution (from patterns.json):
"Type export issues often require explicit re-export in index.ts"

Do you want me to:
A) Try the known resolution
B) Step back and re-analyze
C) Ask for help
```

## Stuck State Detection

### Signs of Being Stuck
1. **Time exceeded** - Task taking >2x estimated time
2. **No progress** - No successful builds in last 10 minutes
3. **Circular edits** - Editing same files back and forth
4. **Confidence drop** - Multiple uncertain decisions

### Response Protocol
```
⚠️ STUCK STATE DETECTED
========================
Duration: 45 minutes (budget: 20 min)
Progress: 30% (estimated)
Last success: 25 minutes ago

Assessment:
- YouTube API response structure unclear
- Multiple type mismatches
- Approach may be fundamentally wrong

Options:
1. PIVOT - Try alternative approach
2. RESEARCH - Read YouTube API docs
3. DECOMPOSE - Break into smaller tasks
4. ESCALATE - Ask user for guidance

Recommendation: RESEARCH
"We're guessing at the API response shape. Let's fetch actual response first."
```

## Post-Task Learning

After EVERY task completion:

```javascript
function postTaskLearning(task, result) {
  const learning = {
    taskId: task.id,
    success: result.success,
    duration: result.duration,
    approach: summarizeApproach(task),
    blockers: identifyBlockers(task),
    insights: extractInsights(task)
  };

  // Update patterns.json
  if (result.success) {
    addSuccessfulPattern(learning);
  } else {
    addFailedApproach(learning);
  }

  // Update metrics.json
  updateMetrics(learning);

  // Log to progress.txt
  appendToProgress(learning);

  return learning;
}
```

### Progress Entry Format
```
[2024-01-15 10:30] COMPLETED: S42 "Add YouTube import API"
Duration: 22 min | Approach: Zod-first + proxy pattern
Blockers: Initial CORS issue (solved with API route proxy)
Learning: YouTube API returns nested data structure
New pattern: SP009 "YouTube API response parsing"
```

## Confidence Scoring

Track confidence level throughout task:

```javascript
const confidenceIndicators = {
  high: [
    "Using known pattern",
    "Similar task completed before",
    "Clear documentation available"
  ],
  medium: [
    "New but similar to known work",
    "Some uncertainty in approach",
    "Partial documentation"
  ],
  low: [
    "Completely new domain",
    "Conflicting information",
    "No clear examples"
  ]
};

function assessConfidence(task) {
  let score = 50; // Base confidence

  // Boost for pattern match
  if (hasMatchingPattern(task)) score += 20;

  // Boost for similar completed task
  if (hasSimilarSuccess(task)) score += 15;

  // Reduce for doom loop history
  if (hasDoomLoopHistory(task.domain)) score -= 20;

  // Reduce for new domain
  if (isNewDomain(task)) score -= 15;

  return Math.max(0, Math.min(100, score));
}
```

### Confidence-Based Behavior
```
Confidence > 80%: Proceed autonomously
Confidence 50-80%: Proceed with checkpoints
Confidence < 50%: Research first or ask user
```

## Time Boxing

Enforce time limits to prevent runaway tasks:

```javascript
const timeLimits = {
  simple: 15,      // minutes
  medium: 30,
  complex: 60,
  investigation: 20
};

function checkTimeBox(task, elapsed) {
  const limit = timeLimits[task.complexity];

  if (elapsed > limit * 0.8) {
    warn(`⏱️ 80% of time budget used (${elapsed}/${limit} min)`);
  }

  if (elapsed > limit) {
    alert(`⏱️ TIME LIMIT REACHED

Task: ${task.title}
Elapsed: ${elapsed} min
Limit: ${limit} min

Options:
1. Request extension (explain why)
2. Complete partial work
3. Mark as blocked and move on`);
  }
}
```

## Fresh Context Strategy

### What to Carry Forward
```javascript
const carryForward = {
  always: [
    "Active task context",
    "Relevant patterns",
    "Recent errors (last 3)",
    "Current file state"
  ],
  sometimes: [
    "Related task history",
    "Domain context (if same domain)"
  ],
  never: [
    "Unrelated task details",
    "Old error messages",
    "Abandoned approaches"
  ]
};
```

### Context Reset Points
```javascript
const resetPoints = [
  "New task started",
  "Domain switch (backend → frontend)",
  "After doom loop resolution",
  "After 5 consecutive successes"
];
```

## Self-Check Prompts

Questions to ask before major actions:

```
Before editing a file:
- Have I read the current state?
- Do I understand the surrounding code?
- Is this the right file?

Before running a command:
- What do I expect to happen?
- What could go wrong?
- Have I tried this exact command before?

Before claiming task complete:
- Did I test the change?
- Does the build pass?
- Have I addressed all criteria?

When stuck:
- What assumption might be wrong?
- Have I read the actual error message?
- Is there a simpler approach?
```

## Integration with Build System

### Pre-Task Hook
```javascript
// Called before each task in build.md
async function preTaskAwareness(task) {
  const briefing = generateBriefing(task);
  const confidence = assessConfidence(task);
  const patterns = findRelevantPatterns(task);

  return {
    briefing,
    confidence,
    patterns,
    timeLimit: getTimeLimit(task),
    doomLoopRisks: getDoomLoopRisks(task.domain)
  };
}
```

### During-Task Monitoring
```javascript
// Called after each significant action
async function monitorProgress(action, context) {
  // Check for doom loop
  const doomLoop = detectDoomLoop(action);
  if (doomLoop) {
    return handleDoomLoop(doomLoop);
  }

  // Check time
  checkTimeBox(context.task, context.elapsed);

  // Update confidence
  updateConfidence(action);
}
```

### Post-Task Hook
```javascript
// Called after task completion
async function postTaskAwareness(task, result) {
  // Extract learnings
  const learning = postTaskLearning(task, result);

  // Update all systems
  await updatePatterns(learning);
  await updateMetrics(learning);
  await updateContext(learning);

  // Decide on context carry-forward
  return prepareNextTaskContext(task, result);
}
```

## Commands

| Command | Action |
|---------|--------|
| `status` | Show current awareness state |
| `briefing` | Generate pre-task briefing |
| `stuck` | Trigger stuck state protocol |
| `reset` | Fresh context for next task |
