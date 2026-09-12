# The four collapses `test-suite-verdict-summary.js` now plants on itself

`[measured 2026-09-11]` 21:0x UTC (local 2026-09-12 00:0x EEST), node 24.19.0,
macOS, against `c05cba0` plus this change.

## The gap this closes, stated exactly

PR #239 split `check-suites-can-fail.js`'s summary line by CAUSE, so that a
sweep which could not MEASURE a suite stopped being reported as a suite with no
derivable subject. Three artifacts came out of it:

* `tooling/suite-verdict-summary.js` — the policy.
* `tooling/test-suite-verdict-summary.js` — assertions that the policy HOLDS.
* a live sweep receipt, kept outside this repo, showing all three causes
  rendering in one real summary line.

None of those three answers the question a reader of a green suite actually
has. `check:suites` proves this suite can fail AT ALL — it plants one canary
and requires a red. The assertions prove the split is correct TODAY. Neither
proves the suite would NOTICE the split being undone. **A suite can be green,
canary-verified, and blind to the one regression it was written for**, and the
mutants that proved otherwise when the split landed were scratch copies that
did not survive the session.

## Provenance — these are not those mutants

The original four were not preserved and are not recoverable. The four below
are a reconstruction from the module's own design: four things
`suite-verdict-summary.js` states in prose that it must not do. Each is now
planted in a scratch copy of the subject and **watched going red**, in the
suite itself, on every `npm test`.

Presenting a reconstruction as the original would be the worse artifact.

## The four, and what killed each

Run: `node tooling/test-suite-verdict-summary.js` → **41 passed, 0 failed**,
0.81 s wall (0.15 s before the harness; five extra child runs).

| # | mutant | the collapse it restores | assertions that must go red |
|---|---|---|---|
| 1 | `renderCauses` returns `CAUSE.NO_SUBJECT.say(family)` | the measured incident itself: one clause for the whole unverified family, under the derivation wording | *names the real deficiency with its own count*; *never attributes the 3 sweep failures to a missing subject* |
| 2 | `RUN_INCOMPLETE.say` → `` `${n} indeterminate` `` | the reassuring short phrase the module's own comment forbids, because it reads as a verdict to exactly the reader this exists for | *says in words that they are not a finding about the suite*; *the sweep-failure wording says it is re-runnable* |
| 3 | `counts[UNCATEGORISED.key]++` → `counts[CAUSE.NO_SUBJECT.key]++` | a row whose producer set no cause joins the derivation bucket instead of surfacing — how a sixth producer added tomorrow becomes invisible | *an UNCHECKED row with no cause is counted apart*; *does not inflate the derivation count* |
| 4 | `UNVERIFIED_FAMILY` gains `VACUOUS`, `RED` | verdicts ABOUT a suite counted as things the sweep could not measure | *VACUOUS/RED stay out of the family*; *the unverified FAMILY is the 4 without a verdict* |

Each mutant is asserted twice: that it turns the suite RED **and** that the
reds include the assertions written for it. A mutant killed by an unrelated red
is a canary firing for the wrong reason, and is reported as a miss.

## The control, and the proof the control has teeth

The unmutated subject is run first, in the same scratch directory, and must be
GREEN. Without that, a harness whose scratch copy is broken reports four kills
while catching nothing.

That is not a hypothetical. **Measured:** removing the line that carries
`check-suites-can-fail.js` into the scratch directory — one file the static
half reads as text — produced:

```
FAIL  CONTROL: the unmutated subject is GREEN in the same scratch copy
40 passed, 1 failed
```

All eight mutant assertions still PASSED in that run. Every mutant "died" of
the missing file, not of its own collapse. The control is the only line that
noticed, and it is why the control is not optional.

## Anchor drift is a harness defect, not a kill

Each mutant's source anchor must match the subject **exactly once**. A refactor
that moves the anchor makes the harness report *"matched 0 time(s) — the
subject was refactored; re-point this mutant"* and go red, rather than silently
testing nothing. A mutation harness that quietly stops mutating is the same
class of failure as the summary line it grades.

## Why it runs by default rather than behind a flag

A `--mutants` flag is a mode nobody invokes. The harness spawns children of
this suite with `AUTODEV_SVS_MUTANT_CHILD=1` set, and skips itself when that is
present, so recursion is impossible and the cost is five extra child runs —
0.66 s measured. That is affordable on every `npm test`, and a control that
runs is worth more than a thorough one that does not.
