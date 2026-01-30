---
name: Brainstorm
description: Proactively analyze codebase and present improvement opportunities
triggers:
  - brainstorm
  - ideas
  - what's next
  - suggestions
---

# Brainstorm Command

**Philosophy:** YOU propose ideas based on what you observe. User doesn't need to know what's possible - that's your job.

## Execution Flow

```
1. Quick codebase scan (parallel):
   - Grep for TODO/FIXME/HACK comments
   - Check package.json for outdated patterns
   - Scan for console.log/debugger statements
   - Look at recent git commits for patterns
   - Check bundle size / performance opportunities

2. Analyze current state:
   - Read prd.json header for sprint context
   - Identify gaps between completed and ideal state
   - Check for unused exports, dead code

3. Generate 3-5 concrete proposals with scenarios
```

## Output Format

Present ideas as **scenarios**, not questions:

```markdown
## 🧠 Brainstorm Results

Based on scanning the codebase, here are actionable improvements:

### 1. [Category] Title
**Scenario:** [Describe the user experience problem or technical debt]
**Solution:** [Concrete implementation approach]
**Impact:** [High/Medium/Low] - [Why it matters]
**Effort:** [1-3 stories] - [What's involved]
**Files:** [Key files to modify]

### 2. ...
```

## Categories to Check

| Category | What to Scan | Example Finding |
|----------|--------------|-----------------|
| **Performance** | Bundle size, lazy loading gaps, N+1 queries | "Dashboard loads 3 charts sequentially - could parallelize" |
| **UX Polish** | Empty states, loading skeletons, error messages | "Settings page has no loading state during save" |
| **Tech Debt** | TODOs, deprecated APIs, duplicated code | "3 components duplicate the same date formatting logic" |
| **Security** | Exposed keys, missing validation, RLS gaps | "API endpoint doesn't validate user ownership" |
| **Accessibility** | Missing labels, keyboard nav, contrast | "Modal can't be closed with Escape key" |
| **Testing** | Uncovered critical paths, flaky tests | "Auth flow has 0% test coverage" |
| **DX** | Slow builds, confusing patterns, missing docs | "No TypeScript types for API responses" |

## Example Output

```markdown
## 🧠 Brainstorm Results

### 1. Performance: Parallelize Dashboard Chart Loading
**Scenario:** User opens dashboard, sees charts load one-by-one over 8 seconds. Feels sluggish.
**Solution:** Use `Promise.all` in useReportPreloader, increase concurrency from 2→5
**Impact:** High - Dashboard loads 3x faster, better first impression
**Effort:** 1 story - Modify useReportPreloader.ts lines 45-60
**Files:** src/hooks/useReportPreloader.ts

### 2. UX: Add Optimistic Updates to Favorites
**Scenario:** User clicks favorite star, waits 500ms for server response before UI updates.
**Solution:** Update local state immediately, rollback on error
**Impact:** Medium - App feels instant and responsive
**Effort:** 1 story - Add optimistic mutation to useFavorites
**Files:** src/hooks/useFavorites.ts, src/components/FavoriteButton.tsx

### 3. Tech Debt: Consolidate Date Formatting
**Scenario:** 5 different date format functions across codebase, inconsistent output
**Solution:** Create single `formatDate(date, format)` in lib/date-utils.ts, migrate usages
**Impact:** Low - Cleaner code, consistent UX
**Effort:** 2 stories - Create util + migrate 12 files
**Files:** src/lib/date-utils.ts, multiple components

---
**Want me to create stories for any of these?** Just say the number(s).
```

## Implementation

When user says "brainstorm":

1. **DO NOT ask "what do you want to brainstorm?"**
2. Run parallel scans (Grep for patterns, Read key files)
3. Analyze findings
4. Present 3-5 concrete scenarios
5. Offer to create stories for selected ideas

## Quick Scans (Run in Parallel)

```bash
# TODOs and FIXMEs
grep -r "TODO\|FIXME\|HACK\|XXX" src/ --include="*.ts" --include="*.tsx"

# Console statements (potential debug leftovers)
grep -r "console\.\(log\|warn\|error\)" src/ --include="*.ts" --include="*.tsx"

# Deprecated patterns
grep -r "componentWillMount\|componentWillReceiveProps\|findDOMNode" src/

# Hardcoded values
grep -r "localhost\|127\.0\.0\.1\|TODO" src/ --include="*.ts"

# Large files (complexity indicator)
find src/ -name "*.tsx" -size +500c | head -10
```
