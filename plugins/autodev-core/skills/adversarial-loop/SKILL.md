---
name: adversarial-loop
description: "Run a cross-vendor tests-first review loop: an adversary model authors failing acceptance tests, the building agent fixes against them, and bounded review rounds end on an exact verdict token. Use for changes where a wrong fix is expensive — gates, harnesses, security paths, anything that grades other code."
when_to_use: "Invoked for high-stakes fixes and audits: the user says \"adversarial loop\", \"tests-first review\", or asks a second model to audit a change before merge."
allowed-tools: Bash, Read, Grep, Glob, Task
user-invocable: true
argument-hint: "[audit|round <n>|verdict]"
---

# Adversarial loop

Two agents from different vendors, asymmetric roles, tests before fixes. The
building agent never grades its own work, and the adversary never merges its
own opinion — the merge condition is a green gate plus an exact verdict token.

This exists because diff review after the code is written cannot catch the
worst class: a suite that passes without asserting anything. A reviewer reading
a diff sees a plausible test. Only a test that was **watched failing on the
defect** is evidence. So the adversary's first deliverable is failing tests,
not comments.

## Roles

- **Adversary** (a different vendor's model, in its own session or harness):
  audits the subject, writes acceptance tests that FAIL on current code, and
  reviews each fix round. It never edits the fix branch.
- **Builder** (this session or a subagent): validates the adversary's tests,
  implements fixes, runs the complete gate. It never edits the test branch.
- Two branches: `<topic>/test-acceptance` (adversary's commits) and
  `<topic>/fix` (builder's commits, which merges the test branch in).

## The loop

1. **Audit round.** The adversary reads the subject and returns numbered
   findings (F1, F2, …). The builder confirms or refutes each against the real
   code before any work starts — an audit finding is a claim, not a work item.
2. **Tests first.** For each confirmed finding the adversary commits a test
   that fails on current code. The builder runs each new test and checks it
   fails **for the stated reason** — a test failing on a typo validates
   nothing. A test that passes on current code goes back: it does not encode
   the defect.
3. **Fix.** The builder implements on the fix branch until the acceptance
   tests pass, then runs the repo's complete gate.
4. **Review round.** The adversary gets the commit range (`git diff
   <test-tip>..<fix-tip>`), and replies with either new blockers or the exact
   token `VERDICT: CLEAN`. Nothing else counts as approval — prose verdicts
   get misread, so the token is agreed up front and matched exactly.
5. **Loop or land.** Blockers go back to step 2 or 3. On the token AND a green
   gate, merge. Neither alone is sufficient.

**Bound the rounds.** Cap at 5. A loop told to run "until quiet" does not
converge: a model asked for findings finds findings. Every round ends with a
human-readable delta (what was raised, what was fixed, what was refuted), and a
human decides whether another round buys anything.

## Verify the adversary's tests too

The adversary's tests are gates, and a gate's first run is a measurement.
Mutation-test them: stub the subject, confirm the suite goes red; restore,
confirm green. In the first production run of this loop, mutation testing found
two defects in the adversary's own tests (a canary that emitted no usable
coverage, and a prepend that broke the target's shebang). The adversary fixed
its own tests when shown the evidence — that exchange is the loop working, not
the loop failing.

Two sweep rules that bite here:

- A mutation sweep needs the repo to itself. Never run the gate, a diff, or a
  restore while one is in flight — a killed sweep leaves stub prepends in
  suite files that read exactly like someone else's broken commit. Check
  running processes before blaming the diff.
- Restoration is part of the gate. A sweep that dies mid-run must leave the
  tree recoverable (`git status` clean after its own recovery), and its exit
  code must distinguish clean / findings / could-not-restore.

## Cross-vendor handover limits

- **Structured payloads truncate.** One harness cut every structured reply at
  a hard 2048-character cap, severed mid-token, five out of five attempts —
  each retry burning a full generation. Keep schema string fields short and
  push detail into repo files; the repo is the channel that does not truncate.
- **Before re-running a failed expensive agent, read its transcript for
  rejected tool inputs.** A payload pinned at exactly the cap means the work
  is finished and only the handover failed; recover it instead of paying for
  the run twice.
- **The repo is the only shared memory.** Findings, test contracts, and round
  logs live in committed files, never in one session's chat. The other vendor
  cannot read your context window.

## Measure every run

Append one row per round to `.claude/reports/adversarial-loop-<topic>.md` in
the repo under audit, and total it when the loop closes:

```
| round | raised | confirmed | refuted | tests added | fix commits | verdict |
```

Close with: rounds to clean, defects caught after the builder first believed
it was done, and defects found in the adversary's own tests. That last number
is the honest one — if it is always zero, nobody is mutation-testing the
tests, and the loop has degraded into review theatre.

Worked example (first production run, an 8-finding harness audit): 5 rounds to
clean. The builder believed the work was done after round 1; rounds 2–5 raised
12 further blockers, all confirmed against the real code, including two in the
adversary's own acceptance tests. Every round after "done" paid for itself.
