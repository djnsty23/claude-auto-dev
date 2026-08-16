---
name: rule-ab-testing
description: "Every proposal gets measured against the current approach and at least one variant before it is adopted, and the measurement is reported. Load before recommending a change, writing a detector, or claiming something is cheap, fast, or better."
when_to_use: "Always-on. Applies to any recommendation, gate, detector, or performance claim. Not user-invocable."
user-invocable: false
allowed-tools: Bash, Read, Grep, Glob
---

# Measure it against something

A proposal is not a finding. Before recommending a change, measure it against
**what happens today** and against **at least one alternative**, then report the
numbers alongside the recommendation.

This is not process for its own sake. In one working session, measurement
overturned the recommendation seven times:

| Claim | What measuring found |
|---|---|
| "Write a cross-surface parity gate" | Already existed |
| "Write an i18n drift gate" | Already existed, and shelled out to the fixer so the two could not diverge — better than the proposal |
| "Uncleared intervals are a bug" | 3 hits, all guarded by an idempotence check |
| "Listeners leak on re-render" | 3 hits, all idempotent `el.onclick =` assignment |
| "Interactive divs lack keyboard paths" | 66 hits, precision destroyed by variable-name reuse; the tight version found 0 |
| "16 stale references in CLAUDE.md" | 1 was real; the rest were prose, patterns, shorthand, and deliberate history |
| "prd.json is 0 days stale" | mtime lies; by last commit, one repo was 4 days and 59 commits behind |

Every one of those would have shipped noise, and a detector that cries wolf is
one people learn to skip — after which the ones that were right get skipped too.

## What a measurement looks like

Three columns, minimum: the current behaviour, the proposal, and one variant.

```
variant                     per prompt   context when 5 files waiting
A  no hook (baseline)             0ms    0 tokens
B  notify-only, subprocess       56ms    ~248 tokens
C  notify-only, in-process       30ms    ~248 tokens   <- shipped
D  auto-inject every arrival     30ms    ~5,500 tokens
```

That table decided two things at once: spawning a subprocess doubled a cost paid
on every turn, and auto-injecting cost 22x for images the user may not have
meant. Neither was obvious from reasoning about it.

## Rules

1. **Baseline first.** "Faster" and "cheaper" are meaningless without the number
   they improve on. Measure the current state before you change it.
2. **At least one alternative.** Comparing a proposal only to doing nothing hides
   the case where a simpler variant wins — a config line usually beats a custom
   detector.
3. **Read every finding before reporting a count.** A detector's output is a
   hypothesis. Nine of the classes above were false positives that a count alone
   would have presented as work.
4. **Report the measurement, not just the conclusion.** The reader needs to be
   able to disagree with your interpretation.
5. **A result of zero is a result.** "The gate finds nothing" is worth saying;
   it means the class is already handled, and that is the cheapest possible fix.
6. **Prefer the boring variant when it ties.** An existing rule with a baseline
   beats a bespoke checker you will have to debug.

## When you cannot measure

Say so explicitly, state which way you are guessing, and make the guess cheap to
reverse. An unmeasured claim presented with the confidence of a measured one is
the failure this rule exists to prevent.
