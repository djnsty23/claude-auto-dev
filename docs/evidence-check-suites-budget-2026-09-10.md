# Why `check:suites` blows a 15-minute child budget on an idle machine

`[measured 2026-09-10]` on a 14-core Apple Silicon box, node 24, in this clone,
against `9956ecd`.

Three `npm run check:suites` runs over five hours never completed cleanly, and the
data contradicted the advice CLAUDE.md and the project memory both gave about it.

| run | head | duration | ETIMEDOUT conflicts | 1-min load during |
|---|---|---|---|---|
| 1 | 5d4a3fe | 66 min, completed | 1 (`test-hook-execution-evidence` baseline) | 10–15 |
| 2 | 5d4a3fe | stopped at 83 min | 3 (`test-all.js` runner canary, `test-entrypoints` baseline, `test-fleet-stop-watch` baseline) | 8–11 |
| 3 | 1a8ea2e | stopped at 3h13m | 5 (`test-entrypoints` baseline, `test-fleet-overlap` ×3) | 4.97–7.3 |

The quietest run was five times the slowest with five times the conflicts. Both
documents said an exit-2 INDETERMINATE here is load — *"under load it is the sweep
working, not a red; re-run quiet, never raise the timeout"*. This file is why that
is wrong, and what replaced it.

## 1. The load explanation is dead from the code's own constants

Healthy cost of the suites that time out, measured through the sweep's own
invocation (`spawnSync`, `cwd` a detached worktree under tmpdir, `encoding: 'utf8'`,
a pipe, the same 900000 ms budget):

| suite | baseline, shared tree | baseline, sweep-identical worktree | baseline, via the sweep's exact `runSuite` | full stub cycle |
|---|---|---|---|---|
| `test-entrypoints.js` | 20 s | 20 s | 15.3 s | **66 s** (1 baseline + 5 stubs, all 5 correctly red) |
| `test-fleet-stop-watch.js` | — | — | 20.2 s | — |

A 900 s timeout on a 20 s suite requires a **45× blowup**. The largest slowdown
this project's own contention model will *admit* is `CONTENTION_MAX = 20`
(`tooling/spawn-budget.js`). 45 > 20, so no contention model in this repo can
explain these timeouts — before asking what the machine was doing.

And what it was doing does not reach 20 either. `contentionFactor()` against a
ramp of busy workers, interleaved, median of 3, on 14 cores:

| extra busy workers | `os.loadavg()[0]` | spin cost | measured factor | retry budget |
|---|---|---|---|---|
| 0 | 9.62 | 85 ms | **1.00** | base × 1.00 |
| 7 | 12.37 | 98 ms | **1.00** | base × 1.00 |
| 14 | 12.37 | 176 ms | 1.38 | base × 1.38 |
| 28 | 12.37 | 293 ms | 2.47 | base × 2.47 |

Two things fall out. `os.loadavg()` reads 12.37 at zero extra workers *and* at
28 — it is useless here, as `spawn-budget.js`'s own header already says. And the
factor is **1.00 until runnable threads exceed the core count**, so at the 1-min
loads all three runs ran at (4.97–15) the widening is inert.

**This is the inversion, and it is not that the quiet machine was unlucky.** At
factor 1.00, `widened = round(base × 1.00) = base`: the retry is granted exactly
the budget that just failed. What it still buys is *re-execution* — the
`slow-once` child in `test-spawn-budget.js` is rescued by a second attempt at any
budget — so the retry is not worthless. What it does not buy is head-room, at any
load this gate actually runs under. Every timeout therefore costs two full
budgets instead of one, on quiet and busy machines alike, and "re-run it on a
quiet machine" names the condition where the second budget is most certainly
spent for nothing. The advice cannot be followed to a conclusion because it is
pointed at the wrong variable.

## 2. The real defect: two budget regimes, and the inner one is larger

`check-suites-can-fail.js` gave each child 900000 ms. The suites grant themselves
budgets through `runBudgeted`, whose ceiling is `base + min(maxTimeout, base × 20)`
per call site. Summed per suite, against that 900000:

| suite | worst self-granted | vs the 15 min that kills it |
|---|---|---|
| `test-entrypoints.js` | **69.2 min** across distinct call sites; **73.5 min** in execution (its three-name `--help` loop runs one site three times) | EXCEEDS |
| `test-session-sweep.js` | 52 min | EXCEEDS |
| `test-coordinator-write-guard.js` | 47.3 min | EXCEEDS |
| `test-hook-execution-evidence.js` | 25 min | EXCEEDS |

Eight other budget-using suites fit. `test-entrypoints`'s `--json` call carries
`maxTimeout: Math.max(timeout, 900000)` — **numerically identical to the whole
outer budget** — so one widened retry can consume it alone.

The damage is not slowness. It is that **nobody gets to report**: the outer kill
lands mid-retry, so the suite never reaches `tally`/`exitCode` and never prints
the `INDETERMINATE` line `spawn-budget.js` exists to produce, while the sweep,
holding only `ETIMEDOUT`, records a conflict with no cause. Both timeout systems
are defeated — the one built to report indeterminacy is killed before it can, and
the one that kills learns nothing.

This predictor also settles the hypothesis test the brief set up. A crude count of
fleet/worktree references per suite fit the two fleet suites and was broken by
`test-entrypoints` (2 references, timed out in runs 2 *and* 3). The inner-ceiling
predictor fits exactly the two suites the count could not: `test-entrypoints`
(69.2 min) and `test-hook-execution-evidence` (25 min). The fleet suites use no
`runBudgeted` at all. **There are at least two populations among the nine observed
timeouts, and treating them as one phenomenon is what kept the diagnosis on load
for three runs.**

## 3. The evidence was in hand at all nine timeouts and thrown away nine times

`[measured]` a `spawnSync` child killed on timeout returns with `stdout` and
`stderr` **populated** — everything it wrote before the `SIGTERM`:

```
{ error: "ETIMEDOUT", signal: "SIGTERM", status: null,
  stdout: "line A: the suite got this far\nline B: still going\n",
  stderr: "stderr: and this\n" }
```

`completed()` had all of it and printed the error code alone, on all three of its
paths. Every suite here prints its assertions as it goes, so the last lines name
what was in flight. Five hours of runs located nothing because the one cheap thing
was not done; a timeout is going to cost its budget regardless, so it may as well
be spent on evidence.

## 4. Ruled out, so nobody spends a session on them again

- **`spawnSync`'s timeout not bounding wall time when a grandchild holds the inherited stdout pipe.** A/B on exactly that variable, 3000 ms budget: `stdio:'ignore'` → 3002 ms, `stdio:'inherit'` (pipe held) → **3001 ms**. Refuted; the timeout is honoured, so a 900 s `ETIMEDOUT` means 900 s of real work.
- **The sweep's worktree being under tmpdir.** Same suite, sweep-identical detached worktree: 20 s, 12/12 pass.
- **The pipe / `maxBuffer` path.** `runSuite` sets no `maxBuffer`, but these suites emit 585 and 50 bytes; a `maxBuffer` breach is `ENOBUFS`, not `ETIMEDOUT`.
- **Contention on the shared `.git`.** `check-entrypoints` probes every script inside a scratch copy that excludes `.git`, with no parent repo above it, so there is no shared ref or index to block on.
- **tmpdir size.** 198,120 entries; `readdirSync(os.tmpdir())` costs **149 ms**.

## 5. Two cost findings that are not the timeouts

**350 suite process runs for 123 suites**, because each derived subject costs a
full extra run. Derivation reads path literals, so *fixture data becomes a
subject*: `test-fleet-overlap.js` derives 12, of which 7 (`tooling/validate.js`,
`tooling/test-pre-tool-filter.js`, `tooling/test-rendered-layout-gate.js`,
`tooling/find-untested-hooks.js`, `tooling/spawn-budget.js`,
`tooling/test-quota-tripwire.js`,
`plugins/autodev-core/scripts/rendered-layout-gate.js`) are seed filenames in its
`PLUGIN_SEED`/`SUITES` arrays, used to create files inside throwaway git repos.
The suite never reads the repo's real copies. Each spurious subject buys one more
run of the heaviest fixture-building suite in the tree, and each earns an `ok` row
for breaking a file the suite does not use — the "verdict about the wrong file"
`check-suites-can-fail.js`'s own header warns about. `test-hooks-profile.js`
derives 20 subjects, so 21 runs. **Not fixed here:** narrowing derivation means
guessing, which that header argues against at length, and it is a change to what
the gate *claims*, not to what it costs per claim. It wants its own measurement.

**198,120 entries of suite fixture debris in tmpdir** — 32,135 `telem*`, 11,375
`brain-panels*`, 3,842 `sbr-state*`, 3,553 `cdn-tx*`, and so on: suites that
`mkdtemp` and never clean up. Harmless at this size (149 ms to enumerate) and
recorded because it is monotone in time and nothing reports it.

## 6. What was not established

**The proximate cause of the ≥45× blowup itself.** No timeout was reproduced in
this session, at loads 7–12, across the shared tree, a sweep-identical worktree,
the sweep's exact `runSuite`, and a full stub cycle. It is intermittent and this
session did not catch it. §2 explains why a single inner timeout *guarantees* the
outer kill and an unexplained exit 2, and §3 is what will name the cause the next
time one fires — which is the honest state of it, and the reason the fix is
diagnostic as well as structural.

## The changes

1. **`spawn-budget.js` learns about the parent's deadline.** A parent that will
   kill this process publishes the moment, in epoch ms, as
   `AUTODEV_SPAWN_BUDGET_DEADLINE`; every budget granted below is clamped to what
   remains, so an inner budget can no longer outlive the outer one and the suite
   reaches its own tally. A blown deadline clamps to a 1000 ms floor rather than
   to zero — a child that never ran, reported as a child that did not finish,
   would be a different lie. **Absent the variable nothing changes**, which is the
   whole compatibility story for every file that calls in here.
2. **`check-suites-can-fail.js` publishes its budget** instead of only enforcing
   it, minus a 30 s margin — the room a suite needs to print why it could not
   measure.
3. **`completed()` reports the child's last words** on all three of its paths.
4. **The budget was not raised.** It is still 900000 ms, and the comment above it
   now records that the 20 s measurements make a bigger number the wrong lever.

Canaried by mutation, each mutant killed: removing the clamp → 4 reds, one
reading `spent=60002ms ETIMEDOUT` where the fix gives ~1.2 s (the defect and the
fix in one line); ignoring the clamp on the first attempt → 2 reds; dropping
`lastWords`' tail → 1 red. Assertions in `spawn-budget.js --selftest` (42, both
deadline directions and a blown deadline) and in `test-spawn-budget.js` (29,
including an out-of-process parent-publishes-deadline case and a control proving
the same call waits out its own budget with no deadline published).
