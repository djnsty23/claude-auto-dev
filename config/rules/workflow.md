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
| UI (public) | agent-browser snapshot + console errors check |
| UI (admin) | typecheck + build only |
| Refactor | typecheck + build + existing tests pass |
| Bulk change | grep for old pattern to confirm full elimination |
| Auth / Billing / RLS | tests + manual verification of deny-by-default behavior |

## Cross-Cutting Verification (All Task Types)

These 6 patterns apply to every task, regardless of type:

1. **No unsafe casts** — `as unknown as Type` on external data must be validated with Zod
2. **No fire-and-forget fetch** — every `fetch()` checks `res.ok` and has try/catch
3. **Fail-closed auth** — protected routes deny by default, not allow by default
4. **Design tokens** — no hardcoded colors (semantic tokens only, exception for gradient surfaces)
5. **Form a11y** — labels on inputs, correct type/inputmode, don't block paste
6. **Error handling** — empty catch blocks, missing error states, unhandled promise rejections
