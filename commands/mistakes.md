---
description: View and analyze patterns in .claude/mistakes.md
---

# Mistakes Command

View error patterns from `.claude/mistakes.md` to learn from past failures.

## Usage

- `mistakes` - Show all mistakes with frequency analysis
- `mistakes recent` - Show last 10 mistakes
- `mistakes pattern [term]` - Filter by error pattern

## Process

1. Read `.claude/mistakes.md` (create if missing)
2. Parse entries (format: `## [DATE] TASK-ID: Error summary`)
3. Group by error pattern
4. Show frequency and suggestions

## Example Output

```
Mistake Patterns (23 total):

Pattern: "Property X does not exist on type Y" (8 occurrences)
→ Fix: Add interface property or use type guard
  Last seen: 2025-01-25 in AI-NLQ01, SUMM-AI01

Pattern: "Cannot find module" (5 occurrences)
→ Fix: Check import path, run npm install
  Last seen: 2025-01-24 in DATA01

Pattern: "as any usage" (4 occurrences)
→ Fix: Use proper type guards instead
  Last seen: 2025-01-23 in EXPORT01
```

## Mistake Entry Format

When logging mistakes (in auto mode), use:

```markdown
## [2025-01-25] TASK-ID: Brief error description

**Error:** Full error message (first 3 lines)
**File:** src/path/to/file.ts:123
**Pattern:** Category (type-error, import-error, runtime-error, etc.)
**Attempted:** What was tried
**Solution:** What fixed it (if fixed)
```

## Auto-Learning

Track recurring patterns to prevent future occurrences:
- 3+ same pattern → Add to brainstorm acceptance criteria
- Type errors → Suggest stricter interfaces
- Import errors → Check for missing dependencies
