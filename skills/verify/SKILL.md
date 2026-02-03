---
name: verify
description: Verify work is complete - outcome-focused, encourages going beyond minimum
allowed-tools: Bash, Read, Grep, Glob, TaskUpdate, TaskList
model: sonnet
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
- Does it look right?
- Do all states work? (loading, error, empty, content)
- Is it responsive?

Use `agent-browser` for verification when helpful:
```bash
agent-browser open http://localhost:3000/path
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
