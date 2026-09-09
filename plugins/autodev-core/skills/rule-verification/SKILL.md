---
name: rule-verification
description: "What counts as done for each kind of change: the required verification per task type, and the cross-cutting checks that apply to every task. Load before marking any task complete."
when_to_use: "Before claiming a change is done — pick the verification its task type actually requires."
user-invocable: false
allowed-tools: Read, Grep, Glob, Bash
paths:
  - "**/prd.json"
---

# Verification Rules

A task is not done because the code was written. It is done when the check for
its type has passed.

> **Type/build checks alone miss behavior that runs but is wrong.** Across
> 3,127 fix commits in three production repos, runtime crashes were a small
> minority; the bulk was code that ran fine and was wrong — a handler nested
> where it never fires, four surfaces disagreeing about one number, a cache key
> missing the account dimension, a locale holding a translation of the previous
> sentence. Work `rule-ramifications` before claiming any of these passed.
> Evidence: [`docs/failure-evidence.md`](../../../../docs/failure-evidence.md).

## Scope boundary

- **audit** owns: security, a11y, performance, type safety, unsafe/noisy logging,
  hardcoded colors, missing states, test gaps.
- **brainstorm** owns: new features, dead code removal, file splitting, unused
  deps, competitor research, UX flow ideas.

Route confirmed bugs into the audit/fix process and feature proposals into
brainstorm. A bug discovered during ideation still gets preserved and fixed
when that work is already authorized; no extra command is required for routing.

## Verification by task type

| Task | Required before done |
|------|----------------------|
| Edge Function / API | Execute the affected operation with representative inputs; assert expected status, response and side effects, including relevant rejection paths |
| UI (public or admin) | Drive the affected flow in a browser with the intended role/data; verify loading, empty, error and success behavior where relevant, including persistence after reload for mutations. When a criterion names what the user sees or gets, drive that flow and assert on **state**, recorded through `scripts/flow-evidence.js` (`auto`, "Runtime flow check"). `[measured 2026-09-08]` on three first-pass defects a screenshot had passed, the state assertion went red on the parent of each fix and green on the fix, 3 of 3; over 30 such fixes it reaches about 4, so it is not a substitute for `rule-ramifications` |
| CLI / hook / worker | Drive the real entry point as a subprocess/event; assert stdout, stderr, exit/result and side effects for success and relevant failure inputs |
| Refactor | Existing tests and applicable type/build checks; verify affected callers still reach equivalent behavior |
| Bulk change | Enumerate affected consumers and search for remnants; verify the changed behavior on representative consumers |
| Auth / Billing / RLS | Allowed and denied cases across relevant roles/accounts; verify resulting state, retries/idempotency where relevant and no unintended charge/data access |

Use the available browser driver with its actual schema. If a check is
unavailable, report it as a gap and continue independent checks; typecheck
cannot substitute for an admin flow. UI-only steps do not apply to a CLI-only
project; state why a check is not applicable rather than inventing a page.

For every required check, retain the command/flow, cwd, tested revision/tree,
environment/build, time, outcome and artifact. Inspect the assertion and failure
reason, not just the summary count. Missing, skipped, stale or unexecuted checks
are not passes; identify the required set from the task and actual gate. Local
verification, deployment and live verification are separate claims. For live
acceptance, identify the deployed revision and repeat the relevant user flow
under the existing authorization. A Stop hook allowing a turn to end proves
none of those outcomes.

For agent hosts, test native dispatch as well as the hook script. Enumerate
expected hooks and inspect warnings/trust; an empty catalog may have exit 0.
Reconcile required hook verdicts with actual operation effects: a blocked hook
can still produce a completed turn and a successful process exit. Preserve
unloaded history as unknown rather than interpreting an empty item array as no
work. See [host admission](../brain/references/host-admission.md).

## Cross-cutting verification (all task types)

Apply these where the task touches the relevant boundary; record meaningful
exceptions rather than manufacturing unrelated work:

1. **Validate external data** — unsafe casts do not validate; use the project’s runtime validator at the relevant boundary.
2. **Handle request failure** — verify HTTP-status and rejected-promise handling at the effective boundary, including any intentional best-effort path.
3. **Fail-closed auth** — protected routes deny by default, not allow by default.
4. **Design tokens** — no hardcoded colors; semantic tokens only, with the gradient-surface exception.
5. **Form a11y** — labels on inputs, correct `type`/`inputmode`, don't block paste.
6. **Error handling** — verify recovery/reporting and no unhandled rejections. Deliberately silent hooks or best-effort cleanup can be valid; prove the expected failure/exit contract.
7. **Something must REACH it** — name what routes a user or caller to the thing
   you built, and check that path exists. Not "the page renders" — *what links to
   it?* Not "the helper is correct" — *do its callers call it?*

### The reachability check, because one day produced four instances

The artifact getting built while its wiring doesn't is the most repeated failure
class on record here, and every instance passed its own verification:

- a pricing page shipped reachable only through the sitemap — Google could find
  it, a person browsing the site could not. "The page renders" was true.
- a copy guard was wired into one writer of a field that had three; the unguarded
  two kept emitting exactly what the guard strips. "The guard works" was true.
- a data-loss fix landed in the shared library while the skill that performs the
  operation kept its hand-rolled version. The library's tests passed.
- a gate sat unlanded on a branch for eleven days. Its suite was green the whole
  time, on a base 39 suites behind.

The shared shape: **verification asked "is the artifact correct?" when the
failing question was "does anything reach it?"** A page nothing links to, a
helper nothing calls, a guard only one of N writers passes through, a fix on a
branch nothing merged — each is indistinguishable from *not built* for everyone
except its author.

So before `passes: true`, answer in one sentence: *by what path does a user,
caller, or runner arrive at this change?* If the sentence names an entry point —
a nav link, a call site, a merged ref, a registered hook — check that it exists.
If the sentence cannot be written, the task is not done; it is half of a task
whose other half is the wiring.

For enumerable surfaces, enumerate: a guard's writers, a token's consumers, a
nav's pages. "The N sites are covered" requires stating N and how it was counted
— by a mechanical rule, not recall. One repo's count went from two writers to
three the day a rule replaced memory, and the third was on the most public path.

## Closing a task: the claim must be checkable, and it must be true

Marking `passes: true` writes a claim into a file other people and other
sessions act on. Two rules, both earned the hard way.

**1. Name the change, so a reader can falsify it.** "Fixed" is not a record.
`nudgetext moved below the authCheck call in coach.js` is — anyone can open the
file and disagree.

**2. Do not close a story until the change is somewhere a reader can reach it.**
Name the committed revision and evidence at the task’s agreed completion
boundary. A locally scoped task can close with a reachable local commit; a task
requiring merge/deployment/live verification stays open until those criteria
are met. Follow the current authorization and `rule-local-first` for publishing.
Do not infer permission to push from this rule or ask again for permission
already granted.

Both rules are sound. **The story originally told here to justify them was not,
and correcting it is the more useful lesson.**

I reported that two P0 stories were marked `passes: true` while the fix existed
nowhere — not on the default branch, not on 25 remote branches, not in 8 live
worktrees. Stated forcefully, twice, including in a handoff document.

**It was false.** The fixes had landed, in a commit two minutes before my own
duplicate. `passes: true` was accurate the whole time.

### How a confident false negative gets manufactured

I searched for two shapes I expected the fix to take:

```
"is the handler now below authCheck?"        → no
grep sanitis|sanitiz|generic.*fallback|strip.*PII   → no hits
∴ "the fix exists nowhere"
```

The real implementation was a third shape neither pattern matched: split the
copy into `text` (personal, rides in the encrypted push) and `pubText` (generic,
written to the public file). Better than either thing I looked for — the one I
eventually recommended myself, already shipped.

**An absence search is only as good as its enumeration of what would count as
presence.** Two misses became "nowhere". The rule:

> Before reporting that something is missing, write down what you would accept
> as evidence that it exists. A list of expected implementation shapes can
> miss a different correct fix, regardless of its length. Search for the
> *effect* — is the leak closed? — not
> for the fix you had in mind.

The same discipline this framework already applies to counts (*read every
finding before reporting it*) applies to zeroes. **A zero is a finding too, and
it needs the same reading.**

### On the rules themselves

They still hold, on their own merits rather than on that anecdote. A story that
says "fixed" without naming the change cannot be checked by the next reader, and
one closed without reachable evidence at its agreed boundary cannot support
its completion claim. Neither needs a scandal to justify it.

### There is no cheap detector for this. Two were measured and dropped.

Recorded so they are not rebuilt:

| Signal | Result |
|---|---|
| "no commit message references the story id" | **100% of done stories, in all three repos.** None of them put ids in commit messages, so this is the normal state, not a finding |
| "the story cites file paths that no longer exist" | 4 hits across 371 done stories — **0 real.** Three were path-prefix artifacts (`dashboard/page.tsx` for `src/app/dashboard/page.tsx`), one a file the story's own fix deliberately deleted |

**Before closing a story that claims a code change, open the file and confirm the
change is there** — and before claiming someone else's story is *falsely*
closed, do the same, harder.

## What `auto` handles without being asked

Load `auto` for its current entry/exit, state-transition and execution
protocol; load `ship` for the authorized release boundary. This verification
rule does not independently authorize deployment, reactivate deferred work or
specify a competing commit/sprint cadence.
