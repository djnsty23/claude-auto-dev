---
name: rule-ramifications
description: "The eight ways a change passes typecheck, build, and a clean console and is still wrong. Derived from 3,127 fix commits across three production repos. Load before implementing a feature and again before calling it done."
when_to_use: "Always-on background rules for implementing and finishing any feature. Not user-invocable."
user-invocable: false
allowed-tools: Read, Grep, Glob, Bash
---

# Ramifications

These are not general best practices. They are the eight failure classes that
actually shipped, measured across 3,127 `fix` commits in three production repos
(see [`docs/failure-evidence.md`](../../../../docs/failure-evidence.md)).

The thing they share is why QA keeps catching them and tooling does not:

> "this is invisible in a diff and cannot be caught by testing the component
> alone — the bug lives in WHO owns the mount"
> — *Project B, fix commit*

Typecheck passes. The build is green. The console is clean. The component
renders. It is still wrong. **A clean verification run is not evidence against
any of the eight below** — each one has to be checked deliberately.

## Before writing the code

Answer these in one or two lines each. If a question does not apply, say so and
move on — but do not skip reading it, because the ones that get skipped are the
ones in the list.

**1. Ordering and async (32–41% of all fixes — the single largest class)**
What must happen before this runs? What if the user acts before it finishes,
twice in a row, or navigates away mid-flight? Is anything awaited that could
resolve after the component is gone?

**2. Every state of the flow, not just the successful one**
Enumerate them explicitly: first run · empty · loading · partial · error ·
offline · logged out · returning user with old data · the second time. Most
"incomplete flow" fixes are one of these never having been considered at all.

**3. Who else reads or writes this state?**
Grep for the other call sites before you edit one. If the same number appears on
four surfaces, it must come from one derivation — four local calculations will
drift, and the drift is invisible until a user notices two screens disagreeing.

**4. What is the cache/memo key, and what dimension is missing from it?**
Per user? Per account? Per locale? Per date? A key missing a dimension is how
one user gets served another's data — that exact bug shipped as
*"a warm lambda served one admin's prefs to another."*

**5. What has to be cleaned up?**
Listeners, intervals, `requestAnimationFrame` loops, subscriptions, abort
controllers. Two mounts must not stack two loops.

**6. Units, references, and formats**
What unit is this in, against what reference, in whose locale and timezone? A
percentage needs a stated denominator — *"protein % showed 200%+ (EU 50g ref vs
180g target)"* is what happens when it does not.

**7. Which environment/project/key does this actually target?**
*"producthealth read the WRONG Supabase project"* typechecks perfectly.

**8. Is it reachable?**
A handler nested inside another handler's block never runs. A route with no
link, a branch whose condition is never true, a translation key nothing renders.
It compiles, it is dead.

## Before calling it done

Re-read the eight. For each, either state the check you ran or state that it
does not apply. **"Types pass and the console is clean" answers none of them.**

Then, specifically:

- **Grep for siblings.** Every other place that reads the state you changed —
  did they all get the change? Show the grep.
- **Run the flow twice.** A surprising share of these defects only appear on the
  second run, or with data already present from the first.
- **Check the empty and error states in the browser**, not in your head.
- **If you changed user-visible English, every locale is now stale.** Tools that
  fill *missing* keys will not catch it — the old translation is still there and
  still wrong.

## When you cannot check something

Say so plainly and name it as a risk in your report. An unverified claim
presented as verified is the reason these reached manual QA in the first place.

## The gate itself can be the thing that is wrong

Encoding a class as a gate moves the question rather than closing it: now the
gate can be wrong, and a wrong gate is worse than no gate, because it reports
PASS about the thing it stopped checking.

Three shapes, all observed in production repos:

1. **A comment satisfies it.** A guard tested with a regex over raw source, so
   the identifier appearing in *prose* counts. One repo had an owner-only
   exemption granted by a block comment describing a check deleted three months
   earlier, and a consent gate over Art. 9 health data satisfied by a comment
   twelve lines above the guard it had lost.
2. **Nothing runs it.** 60 gates in one file that no script and no CI job
   invoked. `scripts/find-orphan-checks.js` finds these.
3. **It was never seen to fail.** A gate nobody has watched fire is a hypothesis.

The fix for all three is the same discipline: **prove it fails.** Delete the
thing it guards, confirm the gate goes red naming the file and line, then restore
the file and verify it is byte-identical. If you cannot make it fail, you have
not written a gate.

## Making this mechanical

A checklist a human runs sometimes is not a gate. When the same class bites this
project twice, encode it as an executable check with `/preflight add` — and make a stale gate fail loudly, because:

> "THE OTHER 60 GATES, which nothing ran … it objected for eight days."
> — *Project A, `scripts/preflight.js`*

`/learn-from-fixes` reads this project's own history and tells you which of the
eight it actually hits, ranked, with the commits as evidence.
