# A timed-out sweep can have slept through its budget

Measured on macOS with Node 24.19.0, investigating the local handoff candidate
`562f4d5edc52a051903c1920b15e7cfadcac0ad8`.

The ordinary test run passed 138/138 suite entries. The following mutation sweep
returned 25 timeout conflicts, some carrying a child's complete passing tally.
That combination does not prove a lingering child or a slow suite.

## The missing frame: host suspension

The failed gate took 35,961 seconds of wall time. `pmset -g log`, filtered to its
recorded start/end interval, contained 128 sleep/wake events and approximately
34,205 seconds of reported sleep intervals: 95.1% of the gate's elapsed time.
It began with clamshell sleep and continued through repeated brief dark wakes.
The source candidate remained at the same commit with a clean working tree.

A controlled process-suspension experiment reproduced both timeout shapes:

| State | Trials | Result |
| --- | --- | --- |
| Parent and child running normally | 3/3 | status 0, no error, child prints completion; 189–191 ms |
| Parent suspended while child completes | 3/3 | status 0 **and** ETIMEDOUT, child completion output retained; 1,442–1,450 ms |
| Parent and child suspended together | 3/3 | status null, SIGTERM, ETIMEDOUT; 1,438–1,450 ms |

The parent used the actual Node `spawnSync` with a 700 ms timeout. The child
wrote a readiness file and scheduled its completion output after 150 ms. An
external Python controller waited for readiness, sent SIGSTOP to either the
parent PID or its newly created process group, waited 1.4 seconds, and sent
SIGCONT. Controls used the same commands without suspension. No system sleep,
peer processes, or test verdict substitution was involved.

Separately, the real handoff, supervisor and private-name suites all completed
through the sweep's pipe invocation and through file output (6/6 runs), with the
same published deadline environment. They took approximately 10.9, 2.6 and 20.9
seconds respectively. This excludes an always-present hang in those samples;
it does not exclude an intermittent defect elsewhere.

**Limit:** the historical sweep did not log per-child start/end timestamps.
These measurements establish suspension during the run and reproduce its
otherwise puzzling result shape. They do not attribute each of the 25 timeouts
individually, or claim every future timeout is sleep-related.

## The two repairs are at different layers

For validation on macOS, an invocation scoped to the gate can inhibit idle sleep:

```sh
caffeinate -i npm run gate
```

This does not prevent lid-close sleep or explicit system sleep. Keep the host
awake for the measurement. Do not reinterpret ETIMEDOUT as success because the
child printed a passing tally, and do not increase budgets to hide suspension.
The existing indeterminate verdict remains correct.

An earlier, separate run was observed stalled in `git fetch` against the survey
test's placeholder Bitbucket origin. That fixture needs the URL for metadata
classification, not a live service. `test-auto-brain-survey.js` now allows only
file Git transport in its subject subprocess and disables Git prompts. Its
local bare remotes still execute real fetch/default-branch controls. This makes
the fixture independent of network Git transport without changing production
survey behavior or imposing a transport override on the rest of the gate.
