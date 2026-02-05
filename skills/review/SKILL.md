---
name: review
description: Code quality check with adaptive effort scaling. Includes security scanning.
triggers:
  - review
allowed-tools: Bash, Read, Grep, Glob
model: opus
user-invocable: true
---

# Review

Quick quality check on current/recent changes.

## Effort Levels

Scale your effort to the task. Don't over-review trivial changes, don't under-review critical ones.

| Task Type | Review Depth |
|-----------|--------------|
| Typo, one-liner | Does it work? Ship it. |
| Feature, component | Build + types + looks right |
| Architecture, refactor | All above + system impact + docs |

**More review:** Money, security, user data, unfamiliar code
**Less review:** Isolated changes, low risk, well-understood code

## Quick Check

After any change:
1. `npm run typecheck && npm run build` - must pass
2. Does it solve the problem? (not just technically correct)
3. Would I approve this PR?

If yes to all, move on.

## Execution (ALL 4 steps required)

1. **Check what changed**
```bash
git diff --name-only HEAD~3  # Last 3 commits
git diff --staged --name-only  # Staged changes
```

2. **Run quality checks**
```bash
npm run typecheck
npm run build
npm run lint  # If available
```

3. **Scan changed files for issues** (ALWAYS do this even if build passes)

For each changed file, check:
- `any` types or `@ts-ignore`
- console.log statements
- Hardcoded colors (text-white, bg-gray-*)
- Missing error handling
- TODO/FIXME comments

4. **Report** (output MUST include all sections below)

```
Review: [X files changed]
==========================

Build: Pass/Fail
Types: Pass/Fail
Lint: Pass/Fail (or N/A)

Issues Found:
- src/component.tsx:45 - console.log left in
- src/hook.ts:12 - Missing error handling

Suggestions:
- Consider extracting duplicate logic in X and Y
- Add loading state to Z component

Overall: Ready to commit / Needs fixes
```

## When to Use

- Before committing
- After implementing a feature
- When unsure about code quality
- Before creating a PR

## Quality Framework Reference

Apply principles from related skills when reviewing:

| Skill | Check For |
|-------|-----------|
| `quality` | Type safety, design tokens, all UI states handled |
| `code-quality` | React patterns, error handling, Supabase typing |
| `design` | Avoid AI slop (no purple gradients, no Inter/Roboto) |

**Design System Checks:**
- Hardcoded colors -> Suggest semantic tokens
- Inter/Roboto fonts -> Reference `design` alternatives
- Purple gradients -> Flag as "AI slop"

**Type Safety Checks:**
- `any` usage -> Check `code-quality` patterns
- Missing Zod -> Check `quality` validation rules

**React Checks:**
- Missing cleanup -> Check `react-patterns`
- Inline objects -> Check `code-quality` memo patterns

> For detailed verification workflow, use `verify` command.
