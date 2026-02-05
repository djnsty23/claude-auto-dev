---
name: review
description: Code quality check - manual trigger for current changes
allowed-tools: Bash, Read, Grep, Glob
model: opus
user-invocable: true
---

# Review

Quick quality check on current/recent changes.

## Execution

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

3. **Scan changed files for issues**

For each changed file, check:
- `any` types or `@ts-ignore`
- console.log statements
- Hardcoded colors (text-white, bg-gray-*)
- Missing error handling
- TODO/FIXME comments

4. **Report**

```
Review: [X files changed]
═══════════════════════

Build: ✓ Pass
Types: ✓ Pass
Lint: ✓ Pass (or N/A)

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

## Auto-Trigger

Consider running `review` automatically:
- After `verify` marks task complete
- Before `deploy`

## Quality Framework Reference

Apply principles from related skills when reviewing:

| Skill | Check For |
|-------|-----------|
| `quality` | Type safety, design tokens, all UI states handled |
| `code-quality` | React patterns, error handling, Supabase typing |
| `design` | Avoid AI slop (no purple gradients, no Inter/Roboto) |
| `self-review` | Scale effort to change complexity |

**Design System Checks:**
- Hardcoded colors → Suggest semantic tokens
- Inter/Roboto fonts → Reference `design` alternatives
- Purple gradients → Flag as "AI slop"

**Type Safety Checks:**
- `any` usage → Check `code-quality` patterns
- Missing Zod → Check `quality` validation rules

**React Checks:**
- Missing cleanup → Check `react-patterns`
- Inline objects → Check `code-quality` memo patterns
