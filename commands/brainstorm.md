---
description: Generate new tasks from your description
---

# Brainstorm

Generate tasks from a description.

## Process

1. Ask: "What do you want to build?"
2. Generate 5-15 stories based on answer
3. Identify dependencies between tasks
4. Show list with dependencies, confirm before adding
5. Add to `prd.json` with `passes: null`
6. Use `TaskCreate` for each task (enables Claude Code visibility)

## Story Schema

```json
{
  "id": "S1",
  "title": "Short title",
  "description": "What to build",
  "priority": 1,
  "passes": null,
  "blockedBy": [],
  "files": ["src/file.ts"],
  "acceptanceCriteria": ["Requirement 1"]
}
```

## Dependencies

- `blockedBy: ["S1", "S2"]` - This task waits for S1 and S2 to complete
- Tasks with empty `blockedBy` can run first or in parallel
- Use dependencies for: DB schema before API, API before UI, setup before features

## TaskCreate Integration

After adding to prd.json, also create in Claude's task system:

```
TaskCreate({
  subject: story.title,
  description: story.description,
  activeForm: "Working on " + story.title
})
```

Then use `TaskUpdate` to set `blockedBy` relationships.
