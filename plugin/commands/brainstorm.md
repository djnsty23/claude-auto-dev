---
description: Generate new tasks from your description
---

# Brainstorm

Generate tasks from a description.

## Process

1. Ask: "What do you want to build?"
2. Generate 3-10 stories based on answer
3. Show list, confirm before adding
4. Add to `prd.json` with `passes: null`

## Story Schema

```json
{
  "id": "S1",
  "title": "Short title",
  "description": "What to build",
  "priority": 1,
  "passes": null,
  "files": ["src/file.ts"],
  "acceptanceCriteria": ["Requirement 1"]
}
```
