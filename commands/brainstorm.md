---
description: Generate new tasks from description or project context
---

# Brainstorm

Generate tasks from a description OR automatically from project context.

## Two Modes

### Interactive Mode (default)
When user says "brainstorm":
1. Ask: "What do you want to build?"
2. Generate 5-15 stories based on answer

### Auto Mode (called from auto)
When called programmatically with no user input:
1. **Read project context:**
   - CLAUDE.md - project-specific instructions
   - README.md - project description
   - package.json - name, description, scripts
   - Existing src/ structure

2. **Infer what to build:**
   - If TODO comments exist → tasks from TODOs
   - If package.json has description → features from description
   - If CLAUDE.md has goals → tasks from goals
   - Fallback → generic setup tasks

3. **Generate without asking** - Don't stop for confirmation in auto mode

## Process

1. Gather context (ask OR read files)
2. Generate 5-15 stories based on context
3. Identify dependencies between tasks
4. Add to `prd.json` with `passes: null`, `verified: null`
5. Use `TaskCreate` for each task (enables Claude Code visibility)
6. **If called from auto** → return control, don't stop

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
  "acceptanceCriteria": ["Requirement 1", "TypeScript types pass", "No `as any` usage"]
}
```

## Type Safety Rules (ALWAYS INCLUDE)

Every task's `acceptanceCriteria` MUST include:
- "TypeScript types pass (`npm run typecheck`)"
- "No `as any` or `as unknown` type casts"
- "All new interfaces in `src/types/`"

For tasks that create new interfaces:
- "Interface matches actual runtime data"
- "Type guards added for external data"
- "Optional properties marked with `?`"

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
