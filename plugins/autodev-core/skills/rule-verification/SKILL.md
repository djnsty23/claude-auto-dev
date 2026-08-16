---
name: rule-verification
description: "What counts as done for each kind of change: the required verification per task type, and the six cross-cutting checks that apply to every task. Load before marking any task complete."
when_to_use: "Always-on background rules for finishing work. Not user-invocable."
user-invocable: false
allowed-tools: Read, Grep, Glob, Bash
---

# Verification Rules

A task is not done because the code was written. It is done when the check for
its type has passed.

> **The checks below catch crashes. They do not catch the common case.** Across
> 3,127 fix commits in three production repos, runtime crashes were a small
> minority; the bulk was code that ran fine and was wrong — a handler nested
> where it never fires, four surfaces disagreeing about one number, a cache key
> missing the account dimension, a locale holding a translation of the previous
> sentence. Work `rule-ramifications` before claiming any of these passed.
> Evidence: [`docs/failure-evidence.md`](../../../../docs/failure-evidence.md).

## Scope boundary

- **audit** owns: security, a11y, performance, type safety, `console.log`,
  hardcoded colors, missing states, test gaps.
- **brainstorm** owns: new features, dead code removal, file splitting, unused
  deps, competitor research, UX flow ideas.

No overlap. If brainstorm turns up a bug, note it and suggest `audit`.

## Verification by task type

| Task | Required before done |
|------|----------------------|
| Edge Function / API | curl with real params, verify 200 + response shape |
| UI (public) | Browser check: page reads correctly and the console is clean |
| UI (admin) | typecheck + build only |
| Refactor | typecheck + build + existing tests pass |
| Bulk change | grep for the old pattern to confirm full elimination |
| Auth / Billing / RLS | tests + manual verification of deny-by-default behavior |

For the UI rows, use whichever browser driver the `browser` skill selects — the
built-in tools when available, the `agent-browser` CLI otherwise.

## Cross-cutting verification (all task types)

These six apply to every task regardless of type:

1. **No unsafe casts** — `as unknown as Type` on external data must be validated with Zod.
2. **No fire-and-forget fetch** — every `fetch()` checks `res.ok` and has try/catch.
3. **Fail-closed auth** — protected routes deny by default, not allow by default.
4. **Design tokens** — no hardcoded colors; semantic tokens only, with the gradient-surface exception.
5. **Form a11y** — labels on inputs, correct `type`/`inputmode`, don't block paste.
6. **Error handling** — no empty catch blocks, no missing error states, no unhandled promise rejections.

## What `auto` handles without being asked

Sprint transitions (archive done, carry deferred, bump number), deploys of
changed edge functions, the verification above, and a conventional commit every
three tasks.
