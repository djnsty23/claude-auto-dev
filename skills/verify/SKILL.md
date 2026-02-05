---
name: verify
description: Verifies work completeness with outcome-focused checks. Use after implementing features to ensure quality.
triggers:
  - verify
allowed-tools: Bash, Read, Grep, Glob, TaskUpdate, TaskList
model: sonnet
user-invocable: true
---

# Verify

Confirm the work is done well, not just done.

## Quick Verification

```bash
npm run typecheck && npm run build
```

If these fail, fix them first. No exceptions.

## What "Complete" Means

A task is complete when:

1. **It works.** Build passes, types check, feature functions.

2. **It solves the actual problem.** Not just the literal requirements, but the underlying need.

3. **It's production-ready.** Handles errors, edge cases, and real-world conditions.

## Beyond Acceptance Criteria

Acceptance criteria are the **minimum**. If you see opportunities to:
- Make the UX better
- Improve performance
- Add helpful error messages
- Fix related issues you discover

**Do it.** A capable developer doesn't stop at "meets requirements."

## For UI Tasks

Verify visually:
- Does it look right at desktop AND mobile (375px)?
- Do all states work? (loading, error, empty, content)
- Is sidebar hidden on mobile with a toggle/hamburger?
- Do grids stack to single column on mobile?
- No horizontal overflow or clipped content?

Use `agent-browser` for verification when helpful:
```bash
# Detect running dev server port
for port in 3000 3001 5173 8080; do
  curl -s http://localhost:$port > /dev/null && break
done

agent-browser open http://localhost:$port/path
agent-browser snapshot -i
```

## Marking Complete

**PASS:**
```
TaskUpdate({
  taskId: "[id]",
  status: "completed",
  metadata: { passes: true, verified: "build" }
})
```

**FAIL:**
- Report what's wrong
- Keep task in_progress
- Fix and re-verify

## Report Format

```
Verify: [task-id] - [title]
═══════════════════════════
Build: ✓
Types: ✓
Works: ✓

Result: PASS

Extras: [Any improvements made beyond requirements]
Next: [next-task-id] - [title]
```

## The Standard

**Would a senior developer approve this PR?**

If yes, it's done. If no, improve it.

Don't just tick boxes. Ensure the solution is genuinely good.
