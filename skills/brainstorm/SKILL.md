---
name: brainstorm
description: Scan codebase, propose improvements, auto-create stories
aliases: ["what next", "whatnext", "what-next"]
allowed-tools: Bash, Read, Grep, Glob, Task, TaskCreate, TaskUpdate, TaskList, Write, Edit
model: opus
user-invocable: true
---

# Brainstorm / What Next

**Philosophy:** User doesn't know what to focus on. YOU scan, propose, and create stories.

## Why Proactive?

Users often don't know what they're missing. You have visibility into:
- Code patterns they can't see
- Technical debt they've forgotten
- Opportunities they haven't considered

## Execution

### Step 1: Parallel Scans (Run All at Once)

Launch these 4 scans in parallel using Task tool with `run_in_background: true`:

```typescript
// All 4 in a single message
Task({ subagent_type: "Explore", model: "haiku", run_in_background: true,
  prompt: "Find TODOs/FIXMEs in [PROJECT_PATH]. Report: count, file:line, content." })

Task({ subagent_type: "Explore", model: "haiku", run_in_background: true,
  prompt: "Find console.log statements in [PROJECT_PATH] (skip test files). Report: count, files." })

Task({ subagent_type: "Explore", model: "haiku", run_in_background: true,
  prompt: "Find hardcoded colors (text-white, bg-black, text-gray-*, bg-gray-*) in [PROJECT_PATH]. Report: count, files." })

Task({ subagent_type: "Explore", model: "haiku", run_in_background: true,
  prompt: "Find large files (>300 lines) and 'any' type usage in [PROJECT_PATH]. Report: file, lines, issues." })
```

### Step 2: Analyze Gaps

Compare findings to ideal state:
- 0 TODOs in production code
- 0 console.logs (use proper logging)
- 0 hardcoded colors (use design tokens)
- 0 `any` types (full type safety)
- No files >300 lines (split components)

### Step 3: Present Scenarios (Not Just Issues)

Don't just list problems. Present **concrete improvement scenarios** with impact:

```markdown
## Improvement Opportunities

### 1. Production Cleanup (High Impact, Low Effort)
**What:** Remove 530 console.log statements across 42 files
**Impact:** Cleaner logs, smaller bundle, more professional
**Effort:** ~30 min automated cleanup
**Files:** src/hooks/*.ts, src/components/*.tsx

### 2. Design System Compliance (Medium Impact, Medium Effort)
**What:** Replace 68 hardcoded colors with semantic tokens
**Impact:** Consistent theming, dark mode ready, maintainable
**Effort:** ~2 hours
**Files:** src/components/Dashboard.tsx (23), src/pages/*.tsx (45)

### 3. Type Safety Hardening (High Impact, High Effort)
**What:** Eliminate 12 `any` types with proper interfaces
**Impact:** Fewer runtime errors, better IDE support
**Effort:** ~3 hours
**Files:** src/types/*.ts, src/hooks/*.ts

### 4. Code Splitting (Medium Impact, Medium Effort)
**What:** Split 5 files >500 lines into focused modules
**Impact:** Easier testing, better maintainability
**Effort:** ~2 hours
**Files:** src/components/ReportBuilder.tsx (847 lines)
```

### Step 4: Auto-Create Stories

After presenting scenarios, **immediately create stories** for the top recommendation:

```typescript
// Auto-create stories for #1 recommendation
TaskCreate({
  subject: "Remove console.log from src/hooks/",
  description: "42 console.log statements in hooks. Remove all.",
  metadata: { type: "qa", priority: 2, category: "cleanup" }
})
```

Then ask:
```
Created 3 stories for Console Cleanup (top recommendation).

Want stories for other areas?
- "tokens" → Color token migration (68 items)
- "types" → Type safety fixes (12 items)
- "all" → Everything
- Or say "auto" to start working
```

## Rules

- **Auto-create stories for top recommendation** - Don't just list issues
- Present 3-5 scenarios, not 50 raw issues
- Include impact AND effort for each scenario
- Use parallel scans to minimize wait time
- If user says "all", create stories for everything

## Token Cost

- 4 parallel scans × ~5K tokens = ~20K tokens
- Time: 30-60 seconds (parallel execution)
- Much cheaper than reading entire codebase

## Example Output

```
Brainstorm Complete
═══════════════════

Scanned 247 files in 42 seconds.

Findings:
- 530 console.log statements
- 68 hardcoded colors
- 12 'any' types
- 5 files >500 lines

Created 3 stories for Console Cleanup (top recommendation).

Other areas available:
- "tokens" → Color token migration (68 items)
- "types" → Type safety fixes (12 items)
- "all" → Create stories for everything
- Or say "auto" to start working
```
