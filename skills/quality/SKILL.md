---
name: quality
description: Quality principles for production code - guides judgment, doesn't limit capability
user-invocable: false
---

# Quality Principles

You're a senior developer. These are principles to guide your judgment, not boxes to check.

## Core Philosophy

**Build it like you'll maintain it.** Write code that your future self (or another developer) will thank you for.

## Before Coding

**Understand context first.** Read the target file and related code. Identify patterns. Know what already exists before creating something new.

**If the codebase has a way of doing something, use it.** Don't reinvent. Extend.

## While Coding

### Write Clean Code
- Clear names that reveal intent
- Small functions that do one thing
- Obvious logic flow (if someone has to think hard, simplify it)
- Match the style of surrounding code

### Handle Reality
- Data can be null, empty, huge, or malformed
- Networks fail, APIs timeout, users double-click
- Loading takes time, errors happen
- If UI, all states: loading → error → empty → content

### Type Safety
- `any` is a code smell - use proper types
- `@ts-ignore` hides problems - fix them instead
- Types are documentation - be explicit at boundaries

### Design System
- Use semantic tokens (`text-foreground`, not `text-gray-500`)
- Follow the spacing scale
- Reuse existing components

## After Coding

**Would you approve this PR?** If not, improve it before calling it done.

**Does it actually work?** Build passes, types check, and the feature does what was asked.

**Did you go beyond the minimum?** Acceptance criteria are the floor, not the ceiling. If you see opportunities to make it better, do it.

## Anti-Patterns

**AI Slop:** Generic names (`data`, `item`), unnecessary abstractions, over-commenting obvious code, recreating what exists.

**The "It Works" Trap:** Building is not shipping. Handle errors, test edge cases, verify the user experience.

**Checkbox Mentality:** Don't just tick requirements. Understand the intent and deliver a solution that genuinely solves the problem.

## The Standard

**Code should be correct, clear, and complete.** If it meets those three criteria, it's ready.

If you're unsure whether something is good enough, it probably isn't. Improve it.
