---
name: status
description: Show sprint progress
allowed-tools: Read, TaskList
model: haiku
user-invocable: true
---

# Status

Show current progress with minimal token usage.

## Process

1. Call `TaskList` to get all native tasks
2. Read `prd.json` header (first 20 lines) if exists
3. Display:

```
[projectName] | Sprint: [sprint]
═══════════════════════════════
Progress: [N]/[N] complete
In Progress: [N] | Ready: [N] | Blocked: [N]

Active:
  → [id] [subject] (in_progress)

Next:
  [id] [subject] (pending)
  [id] [subject] (pending)
```

## Rules
- Use TaskList for native tasks (primary)
- Read only prd.json header for context (not full file)
- Use haiku model for minimal cost
- If no prd.json, just show TaskList results
