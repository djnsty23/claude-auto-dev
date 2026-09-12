# Stubbing fewer candidates, and what the run-count headline hides

`[measured 2026-09-10]` on a 14-core Apple Silicon box, node 24, in this clone.
Companion to `docs/evidence-check-suites-budget-2026-09-10.md`.

## The cost, and why the obvious fix is refused

`check-suites-can-fail.js` stubs every derived candidate of every suite in turn,
which on this tree is **348 suite process runs for 124 graded subjects**. Candidates
are derived from PATH LITERALS, and a literal is not evidence of use:
`test-fleet-overlap.js` derives 12, of which **7** — `tooling/validate.js`,
`tooling/test-pre-tool-filter.js`, `tooling/test-rendered-layout-gate.js`,
`tooling/find-untested-hooks.js`, `tooling/spawn-budget.js`,
`tooling/test-quota-tripwire.js` and
`plugins/autodev-core/scripts/rendered-layout-gate.js` — are entries in its
`PLUGIN_SEED` and `SUITES` arrays, names it writes into throwaway git repos and
never reads. Its real subject sat **ninth of eleven**.

Dropping the spurious ones is what `check-suites-can-fail.js`'s own header argues
against at length, and it is right: every way of telling a subject from a mention
is a guess about a FILE, and a wrong guess DROPS a real subject — turning a
verified suite into an unverified one, or an `ok` into a VACUOUS accusation. The
asymmetry used instead:

> A heuristic that **orders** candidates cannot produce a wrong verdict, only a
> slower run. A heuristic that **selects** candidates can.

So the candidate set is untouched. It is ranked, and the traversal stops at the
first candidate that reddens the suite — sound because the property is "this suite
CAN fail" and one killed subject establishes it. A genuinely VACUOUS suite still
pays for every candidate, because proving a negative costs all of them.

## Run counts, from the real kill sets

A verbose sweep over `6e988997` reported which candidates actually redden each
suite; "does stubbing X redden S" is deterministic, so that kill set is the
measurement and each policy is a different traversal of it.

| policy | runs | |
|---|---|---|
| A  stub every candidate (before) | **348** | |
| B  stop at the first killer, derivation order | **254** | 27.0% fewer |
| C  stop at the first killer, evidence-ranked | **246** | 29.3% fewer — shipped |

C averages **2.03 runs/suite** against a floor of 2.00 for any such policy.

**Ranking contributes 8 of the 102 runs saved. Early exit contributes 94.** The
cleverer half is the smaller half, and the table says so:

| suite | candidates | A | B | C |
|---|---|---|---|---|
| `test-hooks-profile.js` | 19 | 20 | 2 | 2 |
| `test-fleet-overlap.js` | 11 | 12 | **9** | **2** |
| `test-argv-injection.js` | 8 | 9 | 2 | 2 |
| `test-prd-container-class.js` | 6 | 7 | 2 | 2 |

`test-fleet-overlap` is the only row where ranking is what does the work, and it
is the row the measurement started from. Everywhere else the first derived
candidate already killed the suite.

## WHAT THE HEADLINE HIDES, and it matters more than the headline

**29.3% fewer runs is not 29.3% less time, and on the suite that dominated this
sweep the change saves nothing at all.**

The verbose baseline took **3h26m**, and **45 minutes of it — 21.9% — was three
`ETIMEDOUT` kills inside one suite**, `test-validate.js`, at 900 s each. Its only
killing candidate is `plugins/autodev-core/hooks/stop-auto-check.js`, which sits
**fourth of four**, behind the three that time out. Ranking puts
`tooling/validate.js` first because it is the suite's namesake — and that is one of
the three that times out. Measured, both orders:

```
derivation order        ranked order (shipped)
1. tooling/validate.js                 TIMED OUT   1. tooling/validate.js                 TIMED OUT
2. tooling/find-untested-hooks.js      TIMED OUT   2. tooling/find-untested-hooks.js      TIMED OUT
3. .../post-tool-typecheck.js          TIMED OUT   3. .../post-tool-typecheck.js          TIMED OUT
4. .../stop-auto-check.js   <- only killer         4. .../stop-auto-check.js   <- only killer
=> 5 runs, 45 min of timeout              => 5 runs, 45 min of timeout
```

Identical. **Zero improvement on 22% of the wall clock.** Any claim that this
change makes the sweep faster in proportion to its run-count saving would be
false, and the timing of these two runs cannot be compared anyway: the baseline
ran alongside my own test runs and I moved its source HEAD mid-run (see below).

## What the #237 instrumentation found, and the correction it forces

This is the first sweep since `lastWords` landed, and it is the first time an
`ETIMEDOUT` here has named anything:

```
[CONFLICT] test-validate.js (with tooling/validate.js stubbed) did not run (ETIMEDOUT)
           — last output: "PASS  validate is green on a clean tree"
```
…three times, once per timed-out candidate. So the intermittent 45x blowup that
`docs/evidence-check-suites-budget-2026-09-10.md` left open is **located to one
suite**, reproducibly within a sweep, where before it was somewhere among 124.

**And then the evidence undercuts its own obvious reading, which is worth more
than the reading.** "Last output: the first assertion" looks like "it hung right
after assertion 1". It is not, and `test-validate.js` cannot hang there: it
COLLECTS its results and prints all 29 lines at the end, in a loop with nothing
blocking in it. Two facts about that file explain the single line instead:

1. **It ends `process.exit(fail > 0 ? 1 : 0)` immediately after writing to
   stdout** — the macOS truncation this repo documents in CLAUDE.md: node's
   `process.stdout` is ASYNCHRONOUS when it is a pipe on darwin, and
   `process.exit()` does not drain a pending write. So what the sweep captured is
   whatever had flushed, not where the suite was.
2. **None of its three `spawnSync` calls carries a `timeout`**, and it is not among
   the suites wired to `spawn-budget.js`. The word "timeout" appears in it once, in
   a comment. So a block in any of them is unbounded and can only be ended by the
   sweep's outer kill, which is exactly the shape observed.

So the honest conclusion is narrower than it first looked: the hang is in
`test-validate.js`, and **the truncation has to be fixed before the captured
evidence can be trusted to say where.** Unbounded spawns and a truncating exit are
both defects on their own terms, and both are already named hazards in this repo.
Reproducing the suite in isolation did not hang it — 68.4 s clean, 49.2 s with
`validate.js` stubbed — so it is intermittent and needs the sweep to provoke it.

Not fixed here. It is a different change to a different file, and bundling it
would put two unrelated claims in one review.

## My own error, recorded because the sweep caught it

```
[CONFLICT] the SOURCE tree's HEAD advanced during this run: 6e988997 -> 274cfb7e
```
I committed while the sweep was running, so it exited 2 and said its verdicts
describe a tree I am no longer standing in. The verdicts were still usable — they
are about `6e988997`, which is what I wanted — but the run is INDETERMINATE and
CLAUDE.md says plainly not to touch the tree while it runs. This is the second
time in one session; the first was editing tracked files mid-`npm test` and
reddening `tree-inert`.

## Verification

- Verdict equivalence against the previous exhaustive traversal over **all 363
  outcome patterns** for 1-5 candidates, with the old traversal written out as the
  reference implementation rather than paraphrased. 738 of 1641 runs unnecessary in
  that population.
- `deriveSubjects` **byte-identical at 125/125 suites**, same members and same
  order, compared against `origin/main`'s function evaluated side by side — with a
  control confirming the comparison detects a perturbation (45 differ when the
  order is reversed).
- Ranking is a permutation for all 46 real suites with 2+ candidates (153
  candidates), and ranks the namesake first for all 25 that have one.
- Canaried: stubbing `tooling/subject-evidence.js` reddens its suite; restoring it
  returns exit 0. An assertion that PASSED against the stub — an empty module has
  no CLI, so `--selftest` exits 0 having run nothing — was strengthened to require
  output as well as a status.
