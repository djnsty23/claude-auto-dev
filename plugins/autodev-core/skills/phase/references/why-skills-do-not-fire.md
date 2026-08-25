# Why 41 of 45 skills never fire, and why the two obvious fixes are both wrong

`[measured 2026-08-25]` Investigated properly across 565 transcripts. Both
intuitive remedies were attempted and both were stopped by evidence. Recording
that so neither gets re-attempted on the same reasoning.

## What is established

**The skill listing is recorded in transcripts, and descriptions are selectively
dropped from it.** Direct proof, one listing, verbatim:

```
- autodev-core:rule-design-system
- autodev-core:rule-diagnosis: Diagnosis is the load-bearing step, not the fix. A wrong fix costs...
```

Bare names, and one described skill, in the same list in the same session.

**Survival is a stable per-skill property.** Counting transcripts containing each
skill's bare name against those containing a distinctive phrase from its
description:

| skill | name appears | description appears | survival |
|---|---|---|---|
| rule-diagnosis | 517 | 506 | 98% |
| rule-thumb-first | 536 | 322 | 60% |
| auto-brain | 44 | 17 | 39% |
| brain | 537 | 67 | 12% |
| heal | 81 | 5 | 6% |
| spec | 518 | 14 | 2.7% |
| audit | 536 | 13 | 2.4% |
| review | 536 | 13 | 2.4% |
| a11y | 536 | 9 | 1.7% |

**Survival predicts MODEL invocation and nothing else.** In the same window, the
only skill the model chose was `rule-diagnosis` (98%), and the only auto-load
that fired was `rule-thumb-first` (60%). Everything at 6% or below: zero model
invocations.

**Invocation does not buy survival.** `brain` fired 17 times at 12% survival and
`audit` 11 times at 2.4%. So causation runs description to model-reach, not the
reverse, which rules out the obvious confound.

## What the mechanism is NOT

Each of these was tested and eliminated:

- **not invocation count.** Inverted, as above
- **not frontmatter shape.** `brain`, `a11y`, `audit` and `review` declare an
  identical field set and only `brain` survives
- **not recency.** Eleven skills were modified the same day as the four
  survivors and do not survive
- **not description length.** The longest (`rule-local-first`, 337 chars) does
  not survive; the second longest does
- **not the memory database.** It holds exactly ONE row containing the phrase,
  written that morning from a command's stdout. One row cannot produce 506
  transcripts across seven days
- **not repo-file contamination.** `a11y`'s phrase appears in MORE repo files
  (README, CHANGELOG, docs/commands.md) and still scores 9 against 506

So the selection rule is opaque from outside this process.

## Why the two obvious fixes are both wrong

**Cutting the dead skills is circular.** The criterion "never fired, no paths
glob, no real references" yields 28 candidates, and the list includes `auto` at
518 lines, plus `commit`, `preflight`, `ship`, `test` and `brainstorm`. Those are
the primary command vocabulary. A skill's description is dropped, so the model
cannot choose it, so it never fires, so it looks dead, so it gets cut. Every step
follows from the last and the conclusion is the opposite of correct.

**Trimming descriptions to fit more of them is a guess.** It is the fix that
would follow IF survival were driven by total description budget. Nothing above
supports that, and length specifically points the other way. Editing 51 files to
influence an unidentified mechanism is the same error as prescribing a fix for an
unverified cause.

## What actually works, and it is already in use

**User-typed invocation needs no description at all.** `audit` is the proof: 2.4%
survival, 11 invocations, every one of them typed. `brain` likewise at 12% and 17.

So the reliable channel is a person typing a name they remember, and the leverage
is not more skills or shorter ones. It is fewer names worth remembering. That is
what this skill was written to be, and it is also why this skill cannot rescue
itself: it entered a listing that already drops 47 of 51 descriptions, so the
model will not reach for it either.

## What would settle the mechanism

Only something with visibility this process does not have: the harness deciding
what to include. From outside, the remaining honest options are to observe
whether survival changes after a deliberate single-variable edit to one skill, or
to accept the channel as it is and optimise the typed one.

If you try the single-variable test, change ONE property of ONE skill, wait for
fresh sessions, and re-run the measurement. Changing several at once cannot
attribute the result, and that is how this question stays open for another month.
