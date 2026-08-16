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

## Closing a task: the claim must be checkable, and it must be true

Marking `passes: true` writes a claim into a file other people and other
sessions act on. Two rules, both earned the hard way.

**1. Name the change, so a reader can falsify it.** "Fixed" is not a record.
`nudgetext moved below the authCheck call in coach.js` is — anyone can open the
file and disagree.

**2. Do not close a story until the change is somewhere a reader can reach it.**
Not "the fix is written", not "the fix is on my branch and I am about to push".
Committed and pushed, or the story stays open.

This exists because of a measured instance, not a hypothetical. Two P0 stories
were marked `passes: true`, titled `FIXED <date>`, with bodies reading
*"CONFIRMED live and FIXED"* — one of them verified genuinely well, by calling
the production endpoint unauthenticated and getting HTTP 200. Then:

| Where the fix was looked for | Result |
|---|---|
| the default branch | absent |
| the 25 most recently updated remote branches | absent |
| all 8 live worktrees, including uncommitted changes | absent |

An exploitable P0, verified live, recorded as closed, **fixed nowhere.** The
investigation had been excellent and the bookkeeping turned it into a lie — and
the next reader's rational move, seeing `passes: true`, is to skip it.

### There is no cheap detector for this. Two were measured and dropped.

Recorded so they are not rebuilt:

| Signal | Result |
|---|---|
| "no commit message references the story id" | **100% of done stories, in all three repos.** None of them put ids in commit messages, so this is the normal state, not a finding |
| "the story cites file paths that no longer exist" | 4 hits across 371 done stories — **0 real.** Three were path-prefix artifacts (`dashboard/page.tsx` for `src/app/dashboard/page.tsx`), one a file the story's own fix deliberately deleted |

What caught the real instance was reading the claim and checking the specific
fact it asserted. That is a review step, and it stays a review step. **Before
closing a story that claims a code change, open the file and confirm the change
is there.**

## What `auto` handles without being asked

Sprint transitions (archive done, carry deferred, bump number), deploys of
changed edge functions, the verification above, and a conventional commit every
three tasks.
