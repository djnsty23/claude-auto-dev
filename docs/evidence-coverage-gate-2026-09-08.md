# A coverage floor for the gate, costed three ways

`[measured 2026-09-08]` on this Mac (Node 24.19.0, 14 cores, with up to thirteen other
sessions running their own gates: **the load average is printed beside every timing**,
and only the runs marked quiet had one below 12). Tree: `main` at **b8eae1f** (VERSION
8.164.0). **Population: 88 plugin source files, 87 loaded by the suite, 774 named functions
in the 83 loaded files that declare any, 113 suites.**

## The question, and the sentence the answer has to carry

ECC's gate runs `c8 --check-coverage --lines 80 --functions 80 --branches 79
--statements 80` over its scripts and fails the run below it. This repo had
`npm run check:functions` (`tooling/find-untested-functions.js`, "functions never
entered") and it was **informational**: it exits 1 on every commit since it was
written, because the count has a floor above zero, so nothing in `npm run gate` or
CI ran it and the count could grow without anything going red. The 2026-09-07 ECC
comparison scored test rigor 7 here and named this as the one-line gap.

**This gate is a floor against regression, not a claim of quality. Coverage
measures execution; mutation measures verification. A function can be entered
every run while nothing asserts anything about it**, and this gate is green for
that function. `check:vacuity` is the tool that asks the other question. The gate's
own output says the same on every green run, so a reader of a CI log cannot mistake
it for more than it is.

## Three variants, measured

| | A: extend the V8 census (shipped) | B: `c8 --check-coverage` | C: nothing (before) |
|---|---|---|---|
| dependencies after | **0** (unchanged) | 55 packages, 9.6 MB of `node_modules`, a lockfile | 0 |
| what it reads | `NODE_V8_COVERAGE` dumps, which `find-untested-hooks.js` and this tool already read | the same V8 dumps, converted to Istanbul | nothing |
| population | 88 files under `plugins/`, named functions only; a file V8 never loaded is its own bucket | `--all --include plugins/**`: 789 functions including anonymous ones, plus 27,935 statements and 7,258 branches | – |
| HEAD scores today | **37 never-called of 774, 1 never-loaded of 88** (read one by one below) | functions 94.29 % (744/789), statements 89.04 %, lines 89.04 %, **branches 79.51 %** | the same numbers, unread |
| at ECC's thresholds | n/a (counts) | **green**, with 0.51 points of headroom on branches; 38 branches flipping turns it red | – |
| wall time of the check alone | **327 s** quiet (load 7.6 to 11.1); 876 s at load 111, where the suite was red | 566 s (load 26 to 68) | 0 |
| what it adds to `npm run gate` | one more suite run. Before: **1,570 s** for the six-step chain (load 68 falling to 2.8). After: the seven-step re-run ended INDETERMINATE at step 2 (check:suites hit ETIMEDOUT on the unmodified test-validate baseline, load 9 rising to 38, 4,426 s, 112 suites graded ok including the new one), so the last five steps were run one by one on the same commit: 15 s for four of them and **2,125 s** for check:coverage at load 34 to 26, against **327 s** for the same step quiet. Then, after the rebase onto f870b15 and on the worktree itself (validate green locally once #181 landed): the full seven-step chain **exited 0 in 2,352 s** at load 9 to 17, 119 of 119 suites, the new suite graded ok by the sweep, 117 of 117 entry points returned, coverage 39 against 39. Loaded, the added step alone can cost more than the old chain did quiet. (#198 and #210 then added check:agents-md and check:claude-md as the seventh and eighth steps, so this step is the ninth and last; the chain was not re-timed for two sub-second additions.) | the same order, plus the install | 0 |
| can it be red on the introducing commit | no: the ceilings are the numbers above | no today, and the branch margin is half a point | – |
| exit on what it prints | 2 when the suite is red (no verdict, failed suites named, a killed runner named as killed), 1 above a ceiling, 0 otherwise | 1 below a threshold | 1 always |

For scale, a plain `npm test` on the same tree: **858 s** at load 20 to 30, **328 s**
quiet (load 11.1 to 12.6). So the coverage instrumentation itself costs
nothing measurable; the cost is the second run of the suite. The `~20s` this tool's
header carried since it was written was never re-measured and is corrected in the
same commit.

**A shipped.** B was rejected on the dependency count: the 2026-09-07 comparison
scored "zero dependencies" 8/10 as a deliberate property, and B buys the same V8
data this repo already reads, for 55 packages. The measurement also overturned the
assumption this document started with, that c8 at ECC's thresholds would be red
here. It is green, by half a point on branches, which is the other reason not to
adopt it: a percentage threshold that happens to sit half a point under today's
number is a gate that goes red on an unrelated refactor and gets muted. C is the
state that let the count drift.

**Counts, not a percentage**, for the shipped variant. `--min-entered 95` was the
obvious spelling and was costed rather than adopted: 737 of 774 is 95.2 %, which
rounds DOWN to 95, and 5 % of 774 is 38, so a percentage floor admits one more
never-entered function than today before it fires and grows that allowance with
every function added. A count fires on the first newcomer. The never-loaded ceiling
is separate because a file no suite loads contributes nothing to the function
census, so it cannot move the first number.

## The floor, and what each entry in it is

`node tooling/find-untested-functions.js --json` on b8eae1f, suite green, quiet:

```
88 source file(s) in plugins/ · 87 executed · 1 NEVER LOADED · 4 ran but declare no named function
774 named function(s) IN THE LOADED FILES · 737 executed · 37 NEVER CALLED
```

The list was identical on the earlier loaded run (load 111, suite red), so the
count is stable under contention; only the verdict is not, which is why a red suite
is exit 2 and not a number. Reading the 37 rather than counting them
(rule-ab-testing, rule 3):

| bucket | count | entries | reading |
|---|---|---|---|
| long-running watchers a suite kills or runs one-shot | 7 | `watch-panels.js` loadSeen, saveSeen, scan · `fleet-board.js` deny, esc · `fleet-stop-watch.js` human · `quota-tripwire.js` tick | V8 writes coverage on normal exit only; a subject a suite kills leaves no dump, and a `--once` run never reaches the interval body. watch-panels and fleet-board carry 53 and 62 behavioural assertions (this tool's header, 2026-08-25). |
| the gh/git-shelling half of scripts whose suites stay offline | 11 | `check-branch-landed.js` gh · `check-pr-ready.js` checkPrReady, gh, render · `fleet-snapshot.js` repoFacts, sh, shJson, transcriptsFor, trunkOf · `workflow-liveness.js` ghJson, shortReason | Every suite drives the parsing half in-process or through `--selftest` and never spawns `gh` or `git fetch`. A coverage gap on the network path, not dead weight. |
| `--selftest` entry points no suite spawns | 3 | `check-doc-staleness.js`, `check-pr-ready.js`, `deploy-ledger.js` selftest | `npm run check:ledger` and friends run these by hand; their suites require the module instead. |
| CLI argument readers on scripts their suites drive in-process | 4 | `check-assignment.js` has · `check-doc-staleness.js` arg · `check-scheduled-verdicts.js` arg · `layout-probe.js` val | Same shape: the suite calls the exported function, so the `process.argv` reader is never entered. |
| branches no fixture takes | 8 | `auto-brain-survey.js` repoKey (no client names seeded) · `check-brain-role.js` defaultRoleFile (every case passes an explicit role file) · `check-rules-reachable.js` walk (no rules directory in the fixture) · `check-scheduled-verdicts.js` declarationBody · `steer-log.js` loadSessionIndex (the fallback stub, replaced by fleet's loader when present) · `memory-session-start.js` fence, stripUntrusted (no carried lines seeded) · `redact.mjs` `get size` (a getter nothing reads) | Live code, untested branches. Each is a test to write, not a function to delete. |
| runs somewhere other than node | 1 | `layout-probe.js` harvest | Stringified and evaluated inside the browser page; node never calls it. |
| exported, no caller in the tree | 1 | `prd-states.js` isDeferred | `grep -rn isDeferred plugins tooling` finds only its definition; `summarise()` covers the state. The one deletion candidate, and a public helper, so left. |
| platform-gated | 1 | `agent-browser-cleanup.js` removeWindowsAutostartRegistry | Dead on any non-Windows machine by design (header). |
| defence-in-depth | 1 | `user-prompt-image-scan.js` fail | Unreachable from outside every inner guard (header, with the attempt). |

Never loaded: `plugins/autodev-core/scripts/heal-sweep.workflow.js` (a workflow
script; `test-workflow-isolation.js` reads it as text and never requires it).

None of these is a defect this gate asks anyone to fix. They are the floor as
measured at b8eae1f. **The ceilings shipped are `FLOOR = { untested: 40,
neverLoaded: 1 }`**, re-measured at fcfb8fa for the reason the next section
gives, dated and carrying the commit they were measured at. Ratcheting them down is a decision for `docs/decisions.md`, taken with
a re-measured green run; it was deliberately not taken here, so the gate cannot be
red on the commit that introduces it.

## The floor moved under the PR, and the gate said so

`[measured 2026-09-08]` after rebasing onto `main` at **f870b15** (14 commits past
b8eae1f, among them #181, #189, #200 and release 8.165.0), `npm run check:coverage`
at the b8eae1f floor **exited 1**, quiet (load 3 to 8), 443 s:

```
91 source file(s) in plugins/ · 90 executed · 1 NEVER LOADED
816 named function(s) IN THE LOADED FILES · 777 executed · 39 NEVER CALLED
[coverage] 39 never-called function(s) vs ceiling 37
```

The two newcomers, read: `fleet-overlap.js` degrade() (#189; an error-path helper
called only when a git command fails, and no fixture makes one fail) and
`workflow-run-triage.js` projectsDir() (#200; the default-directory resolver, and
its suite always passes `--projects`). Both are the "branches no fixture takes"
bucket above, both are a test to write, and both landed on `main` in the hours
between the measurement and the rebase. **That is the gate rejecting a real
regression on the real corpus**, which no fixture proves and this run does: a
floor that had only ever been met met something it was designed to miss. The
floor shipped is 39 at f870b15 rather than the two functions being driven here,
because they belong to other sessions' merges and are follow-up tests, not
defects in this change. The same tree also answered the boundary question the fixture suite answers in miniature: `--max-untested 38` against the measured 39 **exited 1** (observed, 500 s at load 9 to 11), and `--gate` at 39 is the exit-0 run the gate and CI paragraphs below record. Red one below, green at, both on the real corpus.

**It happened a second time.** `[measured 2026-09-08]` after the rebase onto
`main` at **fcfb8fa** (#210, #196, #183 and others), the nine-step gate ran green
through step eight and **exited 1 at step nine**: `40 never-called function(s) vs
ceiling 39`, 3,331 s for the chain at load 9 to 33. The newcomer is
`production-signals.js` httpGetJson() (#196), the HTTP fetcher of a script whose
suite stays offline, the same bucket as the eleven gh/git helpers above. Three
measurements in one day, 37, 39, 40, each rejected at the previous floor: main
adds a never-entered plugin function roughly every ten merges, and this gate is
the first thing in the repo that says so at the moment it happens. The shipped
floor is 40 at fcfb8fa. Whoever merges next after adding one either drives it
from a suite or re-measures with a dated commit; both are one commit, and the
second is now a documented habit rather than a silent drift.

## Where this was measured, and why not on `main` bare

`main` at b8eae1f is red on this machine, and green in CI, for two reasons that
`5fa045b` on the open PR #181 explains and fixes: validate reads the local Claude
Code 2.1.233's silence as an unread hooks-module entry, and the layout gate's
84 KB `--json` report is truncated at the 64 KiB pipe buffer by `process.exit()`
on macOS. Both are about the machine, neither is about plugin functions, and the
fix adds no named function. So every number above was taken in a throwaway clone
of b8eae1f with 5fa045b cherry-picked, where the suite is green, and the gate's
exit-2 path ("the suite did not pass, so this measurement is not trustworthy") is
exactly what `npm run check:coverage` reports on `main` bare on this Mac until
#181 lands. That is the correct answer there: no verdict, with the failed suites
named.

The first push's CI run was the Ubuntu measurement at b8eae1f. The count is platform-sensitive
(Windows-gated code is entered on one runner and not the other), which is why the
step runs on `ubuntu-latest` only, beside the other Linux-only gates.
**CI, run 34209762305 on d303f89, `ubuntu-latest`:** `npm test` 114/114, check:suites green, and the coverage step printed `774 named function(s) · 737 executed · 37 NEVER CALLED` and `1 NEVER LOADED`, **37 vs ceiling 37, 1 vs ceiling 1**, exit 0, in 236 s (09:39:26 to 09:43:22 UTC) on a runner that is quiet by construction. The Ubuntu count is the Mac count, so the platform sensitivity is real but dormant today. `windows-latest` went red on exactly one line, in the new suite: an assertion matched the fixture path with forward slashes and the tool prints `path.relative()`, which is backslashes there. Fixed in the commit that carries this paragraph; nothing in the check itself differed on Windows.

## What the suite proves and what it does not

`tooling/test-check-coverage.js` drives the check as a subprocess against a fixture
tree it builds: one plugin file with two named functions, a runner that enters one
of them. It asserts, in about a second and a half: the fixture fails a ceiling of 0
with the function NAMED and the population printed; the same tree passes a ceiling
of 1; a runner entering both functions passes a ceiling of 0 (the control that the
dead function, not the fixture, is what flipped it); a file nothing loads trips the
other ceiling; a malformed ceiling is exit 2, distinct from a coverage failure, and
never starts the suite (a marker file the runner writes proves it); a red fixture
suite is exit 2 with the failed suite named; a runner killed by SIGKILL is exit 2
and named as killed, not as a failure; `--gate` prints a dated floor. With the check
stubbed to `module.exports = {}` the suite goes red with exit 1 (8 of 30 at the
time of the stub run), which is what `check:suites` grades.

**"Green on HEAD" is not in the suite**, for a structural reason: the check runs
`test-all.js` under coverage, `test-all.js` runs this suite, so a HEAD run inside
the suite recurses whenever the suite is itself under the check. It is asserted by
the `check:coverage` step of `npm run gate` and of CI instead, and the suite prints
a SKIP line saying so. `AUTODEV_COVERAGE_FULL=1` runs it by hand.

## What the review found, and what changed

The gate-step review (2026-09-08) approved the mechanism, 7 of 7 effective
mutations killed, and returned one defect worth fixing: **a runner printing
more than node's 1 MiB default `maxBuffer` was killed with SIGTERM and reported
as KILLED**, the same misreading of a non-verdict the exit-2 path exists to
stop. Reproduced here before fixing: the shipped check against a fixture runner
that prints 2 MiB and then its PASS line exited 2 with `runnerSignal: SIGTERM`.
The runner's output now goes to a file (no ceiling, and synchronous on every
platform, so the tail is never truncated either); the same fixture exits 0 with
`runnerOutputBytes: 2097167`, and the suite carries that case. The whole gate
prints 258 KB today, so nothing had hit the cliff; it was latent, which is the
kind a review is for.

The review's second point, that a green board on macOS and Windows says nothing
about this step because only `ubuntu-latest` runs it, is why every CI line in
this document names the Ubuntu job and its coverage step rather than the run.

**A second, independent review (2026-09-08, head 2c97678)** ran eight mutants
against the suite and killed all eight, each by the case predicted for it, then
found the defect this document's own second section describes: **an empty
census passed `--gate` green.** A `plugins/` directory with no source files,
and a runner that passes, scored `0 never-called vs ceiling 40` and printed the
clean-floor sentence, exit 0. The gate guarded the count RISING and nothing
else; a walker that silently stopped finding files would have reported a clean
floor forever. That is rule-gate-integrity §2 verbatim ("no output never
differs from no output; a scan needs a floor asserted separately from the
comparison"), and this document quoted the rule while the script broke it. Fixed
in the same shape as a red runner: a census that read zero plugin files, or saw
no named function in any loaded one, is **NO VERDICT, exit 2**, in both
renderers, with the population printed beside the refusal. The suite carries the
reviewer's exact probe (empty `plugins/`, passing runner: exit 2 under `--gate`,
under `--json`, and bare) with a control that the two-function fixture still
exits 0. The same commit moves every exit in the report section to
`process.exitCode`, the review's non-blocking note: the gate's own stdout was
2 KB, so the darwin pipe truncation was latent, and the fix is one wrapper.

## Known limits, stated so a green run is not read as more

- **Load.** Three suites here are load-sensitive. The check runs the whole suite
  again, so it doubles the gate's exposure to a flake, and a flake is exit 2 (no
  verdict), with the failed suites named, rather than a false red or a false green.
- **A killed runner.** A peer session's `pkill -9` across worktrees ended one census
  here 164 s into a 15-minute run with 24 of 88 files loaded. The check now says
  "KILLED by SIGKILL" for that case; before, it said "did not pass".
- **V8 writes coverage on normal exit only.** Seven entries in the floor are that
  limit, not dead code.
- **Named functions only.** Arrow functions bound to a `const` count when V8 names
  them from the binding; anonymous callbacks do not. c8's wider population (789) is
  why its percentage reads lower, not evidence of more dead code.
- **Execution, not verification.** Said three times in this document on purpose.
