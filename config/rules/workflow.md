# Workflow Rules

## Primary Commands
- **auto** — executes tasks, deploys, tests, transitions sprints automatically
- **audit** — finds bugs, violations, quality issues. Creates fix stories.
- **brainstorm** — feature ideas, architecture improvements, dead code. No bugs.
- **Natural language** — overrides/interrupts anything with specific instructions

## Scope Boundary
- Audit owns: security, a11y, performance, type safety, console.log, hardcoded colors, missing states, test gaps
- Brainstorm owns: new features, dead code removal, file splitting, unused deps, competitor research, UX flow ideas
- No overlap. If brainstorm finds a bug, note it and suggest `audit`.

## Auto Handles Everything Else
- Sprint transitions (archive done, carry deferred, bump number)
- Deploys (detect changed edge functions, auto-deploy)
- Testing (typecheck, build, integration test for APIs, visual scan for UI)
- Commits (every 3 tasks, conventional format)

## Verification by Task Type
| Task | Required Before Done |
|------|---------------------|
| Edge Function / API | curl with real params, verify 200 + response shape |
| UI (public) | audiq scan + screenshots + console errors |
| UI (admin) | typecheck + build only |
| Refactor | typecheck + build + existing tests pass |
| Bulk change | grep for old pattern to confirm full elimination |
