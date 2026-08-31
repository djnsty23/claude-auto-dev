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

## Bounding the rounds, and why a round cap is not the bound

The obvious control is a round cap. It does not hold: the first production
run of this loop was capped at 5 and ran to 24, because every round raised a
**real** blocker in the previous round's fix. Nobody was padding. The
adversary was asked whether it had softened under pressure and answered that
it had rejected "clean" through four consecutive rounds and reached it on a
full outcome truth table. A cap you would be wrong to enforce is not a bound.

What actually converges the loop is narrowing what each round may reopen:

- **Freeze the acceptance contract after the audit round.** The tests define
  done. A blocker that does not map to a frozen test is a new audit, and it
  waits for the next loop rather than extending this one.
- **Watch for the round that stops being about findings.** Rounds 1–11 of
  that run fixed the subject and produced a design change that deleted 151
  lines of guard code. Rounds 20–24 were five rounds around one
  exit-classification decision. Same rigour, a fraction of the value — that
  transition is the signal to freeze, not the round number.
- **Run the targeted check during iteration and the complete gate at
  convergence.** Fourteen full 85-suite gate runs were safe and mostly
  wasted; the affected suite answers a micro-fix in seconds.
- **A human reads the delta every round** — raised, fixed, refuted — and
  decides whether another round buys anything. That judgement is cheap
  outside the loop and re-bills a full context inside it.

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

## Delivery is part of the loop, and it fails silently

When the channel to the adversary is a UI rather than an API, a send can fail
in a way that looks like success. In that first run two messages were stale
re-pastes from a clipboard whose delivery had been interrupted, and the
adversary answered both with "this is the same commit already reviewed" —
costing two full review cycles and reading, from the builder's side, like a
stubborn reviewer.

- **After any failed or ambiguous send, look before retrying.** A retry that
  cannot see the thread will re-send whatever is staged.
- **Clear the input, then verify it holds the intended text, then submit.**
- **Put the commit SHA in every message.** It is what let the adversary catch
  the duplicates immediately rather than reviewing stale work.

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

Worked example — the first production run, an 8-finding audit of a plugin
repo's own gates, merged as one squashed PR:

| | |
|---|---|
| Rounds to clean | 24 (capped at 5; see the bounding section) |
| Original findings | 8, every one a gate that could return a false verdict |
| Defects in the adversary's own tests | 2, found by mutation-testing them |
| Full gate runs | 14, all green at the commit reviewed |
| Rounds that changed the design | 11 — the shared-tree mutation engine was replaced by a private worktree, net −151 lines |
| Rounds spent on one decision | 5 (20–24), all real, all narrow |

The builder believed the work was done after round 1. What the following 23
rounds bought was not polish: they replaced three successive restore
strategies that each lost a concurrent writer's edit, deleted an entire
lock/nonce/announce protocol in favour of isolation, and established that an
infrastructure failure must never be scoreable as test evidence. Two of them
found defects in the acceptance tests themselves.

The honest cost line beside that: the last five rounds circled a single exit
code, and the loop kept its rigour long after it had stopped buying much.
