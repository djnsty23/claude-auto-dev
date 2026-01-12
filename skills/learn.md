# Learning System Skill

## Purpose
Track successful patterns, failed approaches, and insights in `patterns.json` for continuous improvement.

## Commands

| Command | Action |
|---------|--------|
| `learn` | Analyze recent work and extract patterns |
| `what works` | Show successful patterns |
| `what fails` | Show failed approaches to avoid |
| `patterns` | Full patterns report |

## File: patterns.json
Located at project root, contains learned patterns and insights.

## Learning Workflow

When user says "learn":

### 1. Analyze Recent Sessions
```
Review progress.txt for:
- Tasks completed successfully
- Tasks that required rework
- Build failures and fixes
- Test failures and fixes
```

### 2. Extract Successful Patterns
```javascript
// What approach worked?
{
  "pattern": "API route with Zod validation",
  "context": "Creating new API endpoint",
  "steps": [
    "Define Zod schema first",
    "Validate request body",
    "Return typed response"
  ],
  "evidence": "S42, S45, S48 all succeeded with this approach",
  "reusable": true
}
```

### 3. Document Failed Approaches
```javascript
// What didn't work?
{
  "approach": "Direct database call in component",
  "context": "Fetching data in React component",
  "problem": "Causes hydration mismatch in SSR",
  "solution": "Use server action or API route instead",
  "evidence": "S31 failed 3 times before switching"
}
```

### 4. Detect Doom Loops
```javascript
// Pattern: Same error repeating
{
  "type": "doom_loop",
  "signature": "TypeScript error TS2339",
  "attempts": 5,
  "rootCause": "Missing type export",
  "resolution": "Add explicit export to types/index.ts",
  "prevention": "Always check type exports after adding new types"
}
```

### 5. Update patterns.json
```json
{
  "lastAnalyzed": "2024-01-15T10:30:00Z",
  "successfulPatterns": [
    {
      "id": "SP001",
      "name": "Zod-first API design",
      "domain": "backend.api",
      "steps": ["Define schema", "Validate input", "Type response"],
      "successRate": 0.95,
      "usageCount": 12
    }
  ],
  "failedApproaches": [
    {
      "id": "FA001",
      "name": "Direct DB in components",
      "domain": "frontend.components",
      "problem": "SSR hydration mismatch",
      "alternative": "Use server actions"
    }
  ],
  "doomLoops": [
    {
      "id": "DL001",
      "signature": "Property does not exist on type",
      "frequency": 3,
      "resolution": "Check type exports and imports"
    }
  ],
  "insights": {
    "whatWorks": [
      "Test first catches issues early",
      "Small PRs get faster reviews"
    ],
    "whatFails": [
      "Large refactors without tests",
      "Skipping type definitions"
    ],
    "timeEstimates": {
      "newApiEndpoint": "15-30 min",
      "newComponent": "20-45 min",
      "bugFix": "10-60 min (varies)"
    }
  }
}
```

## What Works Query

When user says "what works":

```
Successful Patterns
===================

Backend:
1. Zod-first API design (95% success, 12 uses)
   → Define schema → Validate → Type response

2. RLS policies with service role (100% success, 8 uses)
   → Use service role for admin ops
   → User role for client-side

Frontend:
1. React Query + Zod (90% success, 15 uses)
   → Define query key → Fetch → Validate response

2. Error boundary pattern (100% success, 6 uses)
   → Wrap feature in boundary → Custom fallback

Testing:
1. Happy path first (95% success)
   → Test main flow → Then edge cases → Then errors
```

## What Fails Query

When user says "what fails":

```
Approaches to Avoid
===================

❌ Direct database calls in React components
   Problem: SSR hydration mismatch
   Instead: Use server actions or API routes

❌ Inline styles for theming
   Problem: Inconsistent across components
   Instead: Use Tailwind design tokens

❌ Large refactors without tests
   Problem: Breaks multiple features
   Instead: Incremental changes with tests

Recent Doom Loops:
1. "Property does not exist" (3 occurrences)
   → Check type exports first

2. "Module not found" (2 occurrences)
   → Verify import paths match file structure
```

## Automatic Learning Triggers

Learn automatically after:
1. **Task completion** - Extract what worked
2. **Task failure** - Document what didn't work
3. **Build fixed** - Note the fix pattern
4. **Test suite passes** - Capture test patterns
5. **Every 5 tasks** - Comprehensive analysis

## Pattern Matching for New Tasks

Before starting a new task, check patterns.json:

```javascript
function findRelevantPatterns(task) {
  const domain = identifyDomain(task);  // backend.api, frontend.components, etc.

  return {
    recommended: patterns.successfulPatterns.filter(p => p.domain === domain),
    avoid: patterns.failedApproaches.filter(p => p.domain === domain),
    doomLoopRisk: patterns.doomLoops.filter(p => p.domain === domain)
  };
}
```

## Integration with Build System

### Pre-Task Pattern Loading
```
Starting task: "Add YouTube import API"

Relevant patterns found:
✅ Use: Zod-first API design (SP001)
✅ Use: API key auth pattern (SP003)
⚠️ Avoid: Direct external API call in handler (FA002)
   → Use server action wrapper instead

Proceed with these patterns in mind.
```

### Post-Task Learning
```
Task completed: S42 "Add YouTube import API"

Learning extraction:
- Approach used: Zod-first + server action wrapper
- Result: Success on first try
- New pattern detected: External API wrapper pattern
- Adding to successfulPatterns...

Pattern SP008 created: "External API wrapper"
```

## Code Pattern Analysis

### Preferred Patterns
```javascript
codePatterns: {
  preferred: [
    {
      name: "Error handling",
      pattern: "try/catch with typed errors",
      example: "catch (e) { if (e instanceof AppError) ... }"
    },
    {
      name: "Component structure",
      pattern: "Props interface → Component → Export",
      example: "interface Props { ... }\nexport function Component({ ... }: Props)"
    }
  ]
}
```

### Avoided Patterns
```javascript
codePatterns: {
  avoided: [
    {
      name: "any type",
      reason: "Defeats TypeScript benefits",
      alternative: "Use unknown and narrow"
    },
    {
      name: "Nested ternaries",
      reason: "Hard to read and maintain",
      alternative: "Use if/else or switch"
    }
  ]
}
```

## Test Pattern Tracking

### Effective Tests
```javascript
testPatterns: {
  effective: [
    {
      name: "Network mock pattern",
      setup: "Mock fetch before test",
      assertion: "Verify request params and response handling"
    }
  ]
}
```

### Flaky Tests
```javascript
testPatterns: {
  flaky: [
    {
      name: "Animation timing tests",
      issue: "Varies by system speed",
      mitigation: "Use waitFor with timeout"
    }
  ]
}
```

## Example Learning Session

```
User: "learn"

Claude: Analyzing recent activity...

Reviewed: 8 tasks, 3 sessions, 45 commits

New Patterns Discovered:
✅ YouTube API caching pattern (SP009)
   - Cache responses for 15 minutes
   - Reduces API quota usage by 60%

✅ Form validation feedback (SP010)
   - Show errors inline as user types
   - Clear on valid input

Failed Approaches Logged:
❌ Direct YouTube API in component (FA004)
   - Caused CORS issues
   - Solution: Proxy through API route

Doom Loop Detected:
⚠️ "Invalid hook call" - 4 attempts
   - Root cause: Conditional hook usage
   - Added to awareness checklist

Updated patterns.json with 2 new patterns, 1 failed approach, 1 doom loop.

Recommendations:
- Consider documenting the caching pattern in project README
- Add ESLint rule for conditional hooks
```
