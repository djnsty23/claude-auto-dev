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
never-entered function fires on the first newcomer, as on the other platforms.

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
