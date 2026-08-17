---
name: fix
description: Debug and fix a broken build, a runtime error, or a visual bug, closing the loop with a real verification rather than a passing typecheck.
when_to_use: "Invoked when the user says \"fix\", \"debug\", \"it's broken\", \"this errors\", or reports something behaving unexpectedly."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task
model: opus
user-invocable: true
argument-hint: "[build|types|file path|description]"
---

# Fix

**For anything beyond a one-line cause, run Claude Code's built-in debugger:**

```
/debug
```

It does root-cause analysis properly — reproduce, isolate, form and test a
hypothesis — and it is better at that than a checklist. Reach for it whenever
the cause is not immediately obvious from the error text.

This skill adds the two things it does not know: how *this* project reproduces a
bug, and what counts as fixed here.

## Reproduce

| Symptom | Reproduce with |
|---------|----------------|
| Build error | `npm run build 2>&1` (or the project's package manager) |
| Type error | `npm run typecheck 2>&1` |
| Runtime error | Start the dev server, then drive the app and read the console — see the `browser` skill for which driver to use |
| UI bug | Same, plus a screenshot at desktop and mobile widths |

For anything in the browser, read the console **before** reading the code. An
error message costs one tool call and usually names the file.

## Fix

Change the cause, not the symptom. Specifically, in this codebase:

- A `?.` that makes a crash go away is a symptom fix. Ask why the value was
  absent — a missing loading state is the usual answer, and `rule-design-system`
  plus the UI-states convention say that state must be handled explicitly.
- An `as unknown as Type` on external data is never the fix. Validate with Zod.
- If the same class of bug appears in more than one place, grep for the pattern
  and fix them together, then grep again to prove none remain.

## Verify

A fix is not done because it compiles. Per `rule-verification`:

- **API / edge function** — curl it with real params, check status and response shape.
- **UI** — reload it in the browser, confirm the behavior, confirm the console is clean.
- **Bulk change** — grep for the old pattern and show zero remaining.
- **Anything auth, billing, or RLS** — verify the deny path, not just the allow path.

Then say what you verified and how. "Fixed" with no evidence is not a report.

## Stop and ask when

- The fix needs an architectural change.
- More than one valid approach exists with a real trade-off.
- The fix could plausibly break something else that has no test.
- The root cause is still unclear after three attempts. Say what you ruled out —
  that is genuinely useful even without a fix.

## Feeding the learning loop

Set the story's `resolution` to `[PATTERN]: [SPECIFIC FIX]` — `null-check:
added optional chaining at line 45`. That string is the raw material
`mine-fixes.js` ranks into `.claude/project-rules.md`, which `review` and
`audit` then check on every future change. A blank resolution costs nothing
today and loses the pattern permanently.

**Threshold — write a note beyond the resolution only when the first hypothesis
was wrong.** A fix that went where you expected teaches nothing. A fix whose
cause was somewhere else entirely is the one worth a sentence, because the wrong
first guess is what will repeat.
