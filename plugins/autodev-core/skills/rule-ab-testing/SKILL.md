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

This is not process for its own sake. Across two working sessions, measurement
overturned the recommendation **sixteen** times — and four of those were
proposals to build a detector that, once built and run, found nothing true:

| Claim | What measuring found |
|---|---|
| "Write a cross-surface parity gate" | Already existed |
| "Write an i18n drift gate" | Already existed, and shelled out to the fixer so the two could not diverge — better than the proposal |
| "Uncleared intervals are a bug" | 3 hits, all guarded by an idempotence check |
| "Listeners leak on re-render" | 3 hits, all idempotent `el.onclick =` assignment |
| "Interactive divs lack keyboard paths" | 66 hits, precision destroyed by variable-name reuse; the tight version found 0 |
| "16 stale references in CLAUDE.md" | 1 was real; the rest were prose, patterns, shorthand, and deliberate history |
| "prd.json is 0 days stale" | mtime lies; by last commit, one repo was 4 days and 59 commits behind |
| "Age prd.json from the last `passes` change instead" | **Returned the identical answer in all 3 repos.** A single incremental story-close resets it exactly as a bulk edit does. Dropped — and the *per-story* age it was standing in for turned out to be the real signal (4d/0d/1d file-level vs 61d/15d/1d median pending story) |
| "None of the 60 commits maps to a story" | 58 of 60. The 2 exceptions were named in my own document two sections earlier |
| "The backlog is 38 days / 809 commits stale" | Hand-counted against a threshold I invented (commits changing ≥2 `passes` lines). No mechanical definition reproduces it |
| "Slice the story's text block to compare revisions" | The last story in the object has no trailing comma, so its slice ran to EOF — every story read as edited the day a story was appended after it. Under-reported one repo by 2 stale stories and 4 days of median age |
| "Widen the unmerged-branch check beyond `prd.json`" | Scoped to prd.json: **2 carriers / 224 branches, both real.** Unscoped at ≤45 days: ~30 branches across 4 repos, mostly one-commit debris. The scope *was* the precision |
| "Compare carrier branches to HEAD" | Sitting on any feature branch makes `origin/main` report as a carrier. The base has to be the *default branch*, or the answer depends on where the reader is standing |
| "Detect a done-story with no commit referencing its id" | **100% of done stories in all three repos.** None of them put ids in commit messages |
| "Detect a done-story citing files that no longer exist" | 4 hits across 371 done stories, **0 real** — three path-prefix artifacts, one file the story's own fix deleted |
| "That P0 is marked done and the fix exists nowhere" | **The fix had shipped two minutes earlier.** I searched for two shapes it might take; the real one was a third, and better. A zero needs reading exactly as much as a count does |

Most of the later ones came from **implementing the recommendation and running
it** — including errors in claims already written down and shared, a bug in one
of the fixes itself, and a detector whose base of comparison depended on which
branch the reader happened to have checked out. None would have surfaced from
more careful reasoning.

Every one of those would have shipped noise, and a detector that cries wolf is
one people learn to skip — after which the ones that were right get skipped too.

**Some classes are real and still not detectable.** Two of those rows were
attempts to mechanise "a story says done but is not". Both were precise and both
found nothing true, so the class went into `rule-verification` as a review step
rather than becoming a third guess. **"No detector fits" is a legitimate
conclusion, and cheaper than a checker nobody trusts.**

**And the last row is the one to read twice.** The failure those two detectors
were built to catch turned out not to have happened: the fix had shipped two
minutes before I declared it missing. I had searched for two shapes it might
take and the real one was a third. The detectors were sound; the *premise* was
not, and no amount of measuring a detector checks the story that motivated it.

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
5. **A result of zero is a result — and it needs reading, like any other.**
   "The gate finds nothing" is worth saying; it usually means the class is
   already handled, which is the cheapest possible fix. But a zero from a search
   is a claim about your *search*, not about the world. Before reporting that
   something is absent, write down what you would accept as evidence that it is
   present; if that list has two entries, expect a false negative. **Search for
   the effect, not for the fix you had in mind.** One "it exists nowhere" here
   was three searches for two shapes, while the real implementation took a
   third — and better — form that had shipped two minutes earlier.
6. **Prefer the boring variant when it ties.** An existing rule with a baseline
   beats a bespoke checker you will have to debug.
7. **Run the fix you recommended before you call it shipped.** Several of the
   sixteen reversals above were invisible until the recommendation was executable
   and executed — including one where the proposal changed nothing at all, and
   one where the implementation had a bug that silently under-reported. A
   recommendation you have only reasoned about is still a hypothesis.
8. **Re-derive the numbers you already published if the tool that produced them
   changes.** Fixing the comparison shifted a shipped figure from "12 of 15
   stale, median 60d" to "14 of 15, median 61d". Numbers outlive the session
   that produced them, so a tool fix means the old output needs correcting, not
   just the tool.

## When you cannot measure

Say so explicitly, state which way you are guessing, and make the guess cheap to
reverse. An unmeasured claim presented with the confidence of a measured one is
the failure this rule exists to prevent.
