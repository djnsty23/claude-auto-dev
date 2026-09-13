# A coverage floor per platform

`[measured 2026-09-13]` on Windows 11 (32 logical cores, Node from `C:\Program Files\nodejs`,
three peer `check:suites` sweeps running, CPU 20 to 35 %). Tree: `main` at **b9d0d56**.

## What was reported, and what reproduced

A peer session ran `npm run gate` for PR #252, which adds one markdown file. Step 10,
`check:coverage`, exited 1: `94 never-called function(s) vs ceiling 40`. A markdown
diff cannot move function coverage, so the red had to come from the base.

It reproduced exactly, in a detached worktree of b9d0d56 with nothing else of this
session's running:

```
104 source file(s) in plugins/ · 103 executed · 1 NEVER LOADED
1060 named function(s) IN THE LOADED FILES · 966 executed · 94 NEVER CALLED
suitePassed: true · failedSuites: [] · runnerSignal: null
```

ubuntu-latest CI on the same commit (run 34673906530) printed
`1063 named function(s) · 1026 executed · 37 NEVER CALLED` and
`37 never-called function(s) vs ceiling 40`, exit 0. **main is green on Linux and red on
Windows, with a green suite on both.**

## The three candidate causes, tested

| candidate | test | result |
|---|---|---|
| C1 a real regression on main | bisect on Windows across f908146, the first-parent merge that brought in mission-store, -dispatch, -deliver and -supervisor (2026-09-11), with each commit's own checker | **crossed at f908146, on platform-gated code.** c05cba0 (just before): 35. f908146: 93, suite green, and the 58 added are exactly the 57 mission functions plus validateSnapshot, with none removed. b9d0d56: 94, adding `fleet-redispatch.js` selftest (#218, 2026-09-12), which no suite enters on any platform. The c05cba0 run had one red suite, test-watch-panels, the timing defect #248 fixed, so its 35 is informational (exit 2). |
| C2 a measurement artifact (a killed or timed-out suite writes no coverage) | the runner exit and every suite state; the count and the list across independent runs at different load | **refuted.** The checker exits 2 when any suite fails or is indeterminate, and it exited 1. `failedSuites` is empty and `runnerSignal` is null. The peer's run and this one agree on all three numbers (1060, 966, 94). A second run here, with the unmodified tool and two other censuses running beside it (00:24 to 00:43 UTC), listed **the same 94 entries, zero added and zero removed**. More load moved nothing. |
| C3 the floor is stale | where and when the floor was measured | **the floor was never a Windows number.** 40 was measured on macOS at fcfb8fa on 2026-09-08. CI runs this step on ubuntu-latest only, and its own comment says why: "the count is platform-sensitive". `npm run gate` runs it on every host against that one number. |

## The 94, read by cause

Every never-called function was traced to the processes that loaded its file, from the
V8 dumps of the run above.

| bucket | count | entries | why it is never entered on win32 |
|---|---|---|---|
| mission runtime | 57 | `mission-store.js` 24, `mission-dispatch.js` 17, `mission-supervisor.js` 9, `mission-deliver.js` 7 | `mission-store.js:100` refuses with `runtime-unavailable` when `process.getuid` is missing. The mission suites check the same thing and run one case on win32. Run alone here: mission-store skips 22 POSIX+SQLite cases, mission-runtime 20, mission-dispatch 13, mission-hardening 10, mission-write-boundaries 5, mission-runtime-crashes 4. |
| reached only through the mission runtime | 1 | `prd-requirements.js` validateSnapshot | Its only caller in the tree is `mission-store.js:87`. |
| POSIX process table | 3 | `agent-browser-cleanup.js` kill, readOneProcess, readProcessTable | The `ps` branch (#217, 2026-09-08). The suite's decoy cases are inside `if (process.platform !== 'win32')`. |
| the same kind as the Linux floor | 33 | selftest and CLI argument readers, the gh/git/HTTP half of offline suites, watcher bodies, untaken fixture branches, `redact.mjs` get size, `prd-states.js` isDeferred, `user-prompt-image-scan.js` fail | The buckets `docs/evidence-coverage-gate-2026-09-08.md` reads one by one. |

61 of the 94 cannot run on win32 by design. None of the 57 mission functions is
untested: on a POSIX host their suites run the cases this host skips. Linux's 37 includes
`removeWindowsAutostartRegistry`, which is the same shape pointed the other way.

## What changed

`find-untested-functions.js --gate` now reads `FLOORS[process.platform]`. A platform
with no entry is **NO VERDICT (exit 2) before the suite runs**, the same class as a red
runner. It is never 1, because nothing exceeded a floor, and never 0, because nothing was
graded. The verdict line names the platform (`linux floor measured ...`), and the failure
text says which platform the count was measured on. `--platform P` grades against
another platform's floor, so the suite can reach the refusal from any host. The override
is printed in every verdict.

`darwin` and `linux` keep 40 at fcfb8fa. `linux` shares the macOS number because
ubuntu-latest scored the Mac's 37 at b8eae1f (run 34209762305) and 37 at b9d0d56.

**The win32 floor is a separate commit, and it is Andy's decision.** Without it, step 10
on this machine is exit 2 with the reason printed, rather than an exit 1 that blames the
change under test. With it, step 10 grades Windows at the number measured here, and a new
never-entered function fires on the first newcomer, as on the other platforms. Andy
delegated that decision to a second session; its reading is the last section below.

## What the suite proves

`tooling/test-check-coverage.js` goes from 37 to 43 assertions on win32 and moves every existing `--gate`
case to `--platform linux`, so they grade the census rather than the host. A platform
with no floor exits 2 naming it and does not start the runner (marker file). Both ceilings
given explicitly still grade on that platform. A missing or malformed `--platform` exits 2
without running. With no `--platform`, the verdict or the refusal names `process.platform`.

Two planted defects, each in a scratch copy of the tool and suite:

| planted defect | result |
|---|---|
| `const platform = 'linux'` (host and flag ignored) | exit 1, 40/43: the unmeasured-platform refusal, its runner marker, and the host-platform case |
| `FLOORS[platform] \|\| FLOORS.linux` (fall back instead of refusing) | exit 1, 41/43: the refusal and its runner marker |

The host-platform case cannot kill the first mutant on a Linux host, where `'linux'` is
the right answer. The Windows and macOS CI jobs run the suite, and the second mutant is
killed on every host.

## The win32 floor, and why the mission runtime is not in it

`[measured 2026-09-13]` a second session on the same Windows machine, on top of 84e0a75,
with 160 or more node processes from peer sweeps running.

**Main was checked first.** `find-untested-functions.js --gate --json` in a clean detached
worktree of b9d0d56 counted the same 94 (1060 named, 966 executed), with the same per-file
breakdown: mission-store 24, mission-dispatch 17, mission-supervisor 9, mission-deliver 7,
fleet-snapshot 5, and a tail of 1 to 3. Its verdict was exit 2, not 1:
`test-hook-execution-evidence` hit ETIMEDOUT under the load of two censuses at once. The
count is the reproduction. The quiet exit 1 is the one in the first section.

### Three variants

| | V1: a win32 count floor over everything | V2: refused-by-design files apart, floor over the rest (shipped) | V3: one floor raised for every host |
|---|---|---|---|
| win32 ceiling | 93 | 36, plus 57 printed apart | 94 |
| a new mission function on win32 | exit 1, so a floor re-measure on every mission PR | printed in the refused count; linux grades it | nothing |
| a new never-entered function elsewhere on win32 | exit 1 | exit 1 | nothing for 54 more |
| slack given to linux and darwin | none | none | 54 |

V3 raises the linux ceiling to fit a platform linux does not run, so it was dropped. V1 is
honest, but it costs a re-measure on each mission story still queued: 57 functions arrived
in four stories over three days (B05 to B08). V2 keeps V1's first-newcomer rule for
everything except four whole files whose refusal is one checkable precondition.

### What V2 does

`REFUSED_BY_DESIGN.win32` names `mission-deliver.js`, `mission-dispatch.js`,
`mission-store.js` and `mission-supervisor.js`, with the precondition
`process.getuid is not a function`. It applies only when this repo is the measured tree,
the platform graded is the host's, and the precondition holds on the host. Never-called
functions in those files stay in `untested` and in the `NEVER CALLED` headline. Only the
comparison subtracts them, and the verdict line prints `(+57 refused by design, not graded)`.

A listing is stale, and NO VERDICT (exit 2), when a listed file does not exist, was never
loaded, or has no never-called function on the run. The last condition fires the day the
store learns to run on Windows.

The four POSIX-gated single functions in other files stay in the graded 36:
`prd-requirements.js` validateSnapshot, and `agent-browser-cleanup.js` kill,
readOneProcess, readProcessTable. They do not grow with a runtime under construction.

### The census

On the branch, explicit ceilings of 999 so the run could not refuse: 104 source files, 1061
named functions, 968 executed, 93 never called (the fleet-redispatch selftest is now
driven), 57 refused by design (7, 17, 24, 9), **36 graded**, 1 never loaded
(`heal-sweep.workflow.js`), no stale listing. That run's suite was also red, for two causes
that are not about the census: the same ETIMEDOUT, and `tree-inert`. The second was this
session. The PostToolUse typecheck hook writes `.claude/.typecheck-pending` into the
worktree on any Write, including a Write to the scratchpad, so drafting outside the tree
during a run still changes `git status`. The 36 match, entry for entry, the list the first
section read at b9d0d56 minus the selftest. `FLOORS.win32` is 36 at 84e0a75, and the gate
run on the committed tree is the green measurement.

### Planted defects

Each in a scratch copy of the checker, against the suite (53 assertions on win32):

| planted defect | result |
|---|---|
| `const graded = dead` (exclusion ignored) | exit 1, 49/53: the refused case, its printed population, its JSON, the second-file case |
| `const graded = []` (exclusion hides everything) | exit 1, 45/53: every pre-existing ceiling case |
| `const staleRefused = []` (no stale guard) | exit 1, 50/53: all three stale listings |
| stale guard without `neverCalled === 0` | exit 1, 52/53: the all-entered listing |
