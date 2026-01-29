---
name: brainstorm
description: Proactively propose improvements without asking - you scan, you propose
allowed-tools: Bash, Read, Grep, Glob, Task, TaskCreate, TaskUpdate, TaskList, Write, Edit
model: sonnet
---

# Brainstorm (Proactive Mode)

**Philosophy:** YOU propose ideas, user doesn't ask. Scan the codebase proactively and present concrete improvement scenarios.

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

### Step 4: Offer Story Creation

```
Which would you like to tackle?
1. "cleanup" → Create stories for console.log removal
2. "tokens" → Create stories for color token migration
3. "types" → Create stories for type safety
4. "split" → Create stories for code splitting
5. Number(s) → Create stories for specific items
```

## Rules

- **Never ask "what do you want?"** - You propose based on scan results
- Present 3-5 scenarios, not 50 raw issues
- Include impact AND effort for each scenario
- Offer to create stories for selected improvements
- Use parallel scans to minimize wait time

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
- 6 TODO comments

Top Recommendations:
1. Console Cleanup (530 items) - High impact, quick win
2. Token Migration (68 colors) - Medium effort, enables dark mode
3. Type Hardening (12 anys) - Prevents runtime errors

Say a number (1-3), "all", or describe what interests you.
```
