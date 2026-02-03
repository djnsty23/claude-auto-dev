---
name: quality
description: Production-quality code standards - auto-applied to all work
user-invocable: false
---

# Quality-First Development

These standards are NON-NEGOTIABLE. Every piece of code must meet them.

## Before Writing ANY Code

### 1. Read First (Mandatory)
- [ ] Read the TARGET file completely
- [ ] Read 2-3 RELATED files in same directory
- [ ] Identify existing PATTERNS (naming, structure, style)
- [ ] Check for existing UTILITIES that do what you need

### 2. Plan the Change
- [ ] State WHAT you're changing in one sentence
- [ ] State WHY (ties to user request)
- [ ] State HOW it fits existing patterns

**If you can't answer these, you haven't read enough.**

## Code Requirements

### Structure
- Functions: <50 lines, single responsibility
- Components: <200 lines, split if larger
- Files: <400 lines, extract modules if larger
- No deeply nested code (max 3 levels)

### Reusability
- Extract repeated logic (3+ occurrences) to utils/hooks
- Use composition over prop drilling
- Create variants, not duplicates
- Generic types over repeated interfaces

### Type Safety
- NO `any` - use `unknown` with type guards
- NO `@ts-ignore` or `@ts-expect-error`
- Explicit return types on exported functions
- Zod schemas at system boundaries

### Design System
- Semantic tokens ONLY: `text-foreground`, `bg-background`
- NO hardcoded colors: `text-white`, `bg-gray-500`
- Spacing from scale: `p-4`, `gap-6`, not `p-[13px]`
- Check tailwind.config.ts before adding values

### UI States (ALL Required)
```tsx
// Every data-fetching component needs:
if (isLoading) return <Skeleton />
if (error) return <ErrorState message={error.message} />
if (!data || data.length === 0) return <EmptyState />
return <ActualContent data={data} />
```

### Error Handling
- Specific messages: "Failed to save user" not "Error"
- Error boundaries around feature areas
- Graceful degradation, not crashes
- Log errors with context (file, function, params)

## After Writing Code

### Self-Review Checklist
- [ ] Re-read your changes - do they make sense?
- [ ] Would a new developer understand this?
- [ ] Did you introduce any hardcoded values?
- [ ] Are all edge cases handled?
- [ ] Does it match the style of surrounding code?

### Verification Steps
1. `npm run typecheck` - MUST pass
2. `npm run build` - MUST pass
3. For UI: Describe what it looks like in different states
4. List 3 ways this could break (then prevent them)

### Red Flags (Fix Before Continuing)
- Inline styles or hardcoded colors
- Copy-pasted code blocks (extract to function)
- Missing loading/error/empty states
- Functions doing multiple things
- Magic numbers or strings without constants
- TODO comments without TaskCreate

## Anti-Patterns to Avoid

### AI Slop Indicators
- Generic variable names: `data`, `item`, `thing`
- Unnecessary abstractions for one-time use
- Over-commented obvious code
- Recreating what already exists in codebase
- Ignoring existing component library

### The "Works" Trap
Just because it builds doesn't mean it's done:
- Does it handle errors gracefully?
- Does it work on mobile?
- Does it work with empty data?
- Does it work with lots of data?
- Does it work when network is slow?

## Quality Gates

Before marking ANY task complete:

1. **Build Gate**: `npm run typecheck && npm run build`
2. **Pattern Gate**: Matches existing codebase style
3. **State Gate**: All UI states handled
4. **Review Gate**: Self-reviewed and would approve your own PR

**If any gate fails, the task is NOT complete.**
