---
name: adversarial-loop
description: "Run a cross-vendor tests-first review loop: an adversary model authors failing acceptance tests, the building agent fixes against them, and bounded review rounds end on an exact verdict token. Use for changes where a wrong fix is expensive — gates, harnesses, security paths, anything that grades other code."
when_to_use: "Invoked for high-stakes fixes and audits: the user says \"adversarial loop\", \"tests-first review\", or asks a second model to audit a change before merge."
allowed-tools: Bash, Read, Grep, Glob, Task
user-invocable: true
argument-hint: "[audit|round <n>|verdict]"
---

# Adversarial loop

Two agents with asymmetric roles and separate contexts, tests before fixes —
a second vendor is one way to get that separation, not a requirement (see
the tool-posture section). The building agent never grades its own work, and
the adversary never merges its own opinion — the merge condition is a green gate plus an exact verdict token.

This exists because diff review after the code is written cannot catch the
worst class: a suite that passes without asserting anything. A reviewer reading
a diff sees a plausible test. Only a test that was **watched failing on the
defect** is evidence. So the adversary's first deliverable is failing tests,
not comments.

## Roles

- **Adversary** (a different vendor's model): audits the subject, writes
  acceptance tests that FAIL on current code, and reviews each fix round. It
  never edits the fix branch and never runs the gate.
- **Builder** (this session): confirms each finding against the real code
  before starting, implements, runs the complete gate, and owns the evidence.
  It never edits the test branch.
- Two branches: `<topic>/test-acceptance` (adversary's commits) and
  `<topic>/fix` (builder's commits, which merges the test branch in).

### Route by what each side is actually good at

`[measured 2026-08-31]` over one 24-round audit of a repo's own gates. The
adversary's eight opening findings were all real, all in gates the builder had
written, and all in code that an 85-suite gate passed green. Every one was the
same class: **a check that reports success while proving nothing.**

So the split is not "a second opinion". It is:

| Give the adversary | Keep with the builder |
|---|---|
| What an exit code MEANS | Whether the code works and ships |
| What a gate actually PROVES | Running the gate, producing the evidence |
| Restore and concurrency semantics under a racing writer | Implementation and style |
| Which outcomes are indeterminate rather than red | Anything needing the working tree |

The builder ships past contract defects precisely because its own tests encode
its own assumptions. That is the gap the adversary fills, and it is narrow: the
adversary cannot run your gates, cannot see your tree, and will keep producing
ever-narrower findings well past the point of value.

### The adversary needs TOOLS, or you are buying assertions

`[measured 2026-08-31]` The routing table above was first written crediting the
*vendor* for those eight findings. A controlled test the next day does not
support that reading, and the correction is the more useful half.

Same prompt, same unreviewed 214-line authorization gate, neither model having
seen it. The cross-vendor adversary returned 11 findings; an in-house subagent
on the builder's own model returned 10; about 8 were the same defects. The
in-house one additionally caught a **live** false pass the other missed, and
prefixed every finding with "Measured" — it had actually executed the predicate
and run the target's selftest against an empty root. The cross-vendor reviewer
reasoned statically and asserted.

The confound was the operator's: the subagent was given Bash and Read; the
cross-vendor reviewer was given a read-only sandbox. One could verify
empirically and did. **That is tool posture, not vendor judgment**, and it
plausibly explains the entire apparent gap.

So the likely source of the original eight findings is this skill's PROTOCOL
rather than the second vendor: an adversary required to write tests that FAIL
on the defect produces empirical evidence by construction.

Three rules follow, and they outrank the routing table above:

- **Grant the adversary enough tools to prove a finding** — write access to a
  scratch area, and the ability to run the thing. An adversary that can only
  read will hand you plausible reasoning, and plausible reasoning is exactly
  what a false-verdict defect survives.
- **Require demonstration, not assertion.** "Measured: <command> printed <x>"
  in every finding. A finding without a reproduction is a hypothesis, and it
  costs a builder round to discover which.
- **A cross-vendor adversary is optional; the posture is not.** Run this loop
  with an in-house subagent on a separate context first. Reach for a second
  vendor when you want independence from your own model's blind spots, not
  because you expect it to see more.

And when comparing two reviewers: **an A/B is void unless their tool grants
match.** Check that before believing any comparison, including the one above.

## Reach the adversary over MCP, not a desktop app

`[measured 2026-08-31]` The same audit was driven by computer-use into a
desktop app, and the transport — not the model — produced most of the waste:
roughly fifteen click batches lost to focus changes, two stale clipboard
re-pastes that burned two entire review cycles, and several stalls waiting for
a human to unlock the machine.

An MCP server removes that failure class outright. Measured against the same
vendor's CLI on identical prompts:

| | MCP | CLI |
|---|---|---|
| Latency | 8,245 ms median | 8,993 ms median — a tie, ~8s is inference |
| Server startup | 207 ms, paid once | full process per call |
| Input tokens per call | 22,800 | 29,343 (−22% for MCP) |
| Multi-turn | returns a thread id; replies continue it | a thread another writer holds refuses resume |
| Concurrency | two calls in flight returned at +7.3s and +7.9s, not 2x | one process per call |
| Output | structured JSON | stdout to scrape |

Two operational notes that cost real time to learn:

- **The CLI appends piped stdin to the prompt.** Spawning it with an open stdin
  pipe blocks forever waiting for EOF. Close stdin explicitly.
- **Put the commit SHA in every message.** It is what catches a duplicate or
  stale send immediately, instead of spending a review round on already-reviewed
  work.

Pick the reviewing model deliberately and verify what RAN, not what was asked:
a per-call model override is honoured, but read it back from the vendor's own
session log before trusting it.

## One thread for the whole loop, not one per round

`[measured 2026-08-31]` Every fresh call to the reviewer re-pays its entire
preamble: 22,800 input tokens over MCP, 29,343 over the CLI, before it has read
a single line of your diff. A 24-round audit run as 24 fresh calls pays that
24 times and gives the reviewer amnesia between rounds.

The reviewer keeps context only when you reply INTO its thread:

```
round 1   mcp__codex__codex        { prompt: <audit brief>, cwd, sandbox, model }
          -> { threadId, content }          <- record this threadId
round 2+  mcp__codex__codex-reply  { threadId, prompt: <round N brief> }
```

Verified: a reply into an existing thread recalled the reviewer's own previous
answer. A fresh `codex` call returns a NEW threadId every time and remembers
nothing, and the CLI's `exec` is fresh per invocation as well.

**What this changes about how a round reads.** With a live thread you no longer
restate what the reviewer already knows, so a round brief shrinks to the delta:

- the commit range for THIS round, `<prev-tip>..<new-tip>`
- what you changed per blocker, one clause each
- the gate result, with the command that produced it
- the exact verdict token you want back

Keep the SHA in every message even so. The thread gives the reviewer memory; it
does not tell you whether your send landed, and a duplicate send is the failure
that costs a whole round.

**Record the threadId in the round log** (the row shape is defined once, under
"Measure every run"). It is the only handle that lets a later session resume the
same review, and it is cheap to lose.

**When to start a NEW thread instead.** A thread carries the reviewer's earlier
conclusions, which is the point, and also its earlier mistakes. Start fresh
when the subject changes, when the acceptance contract is re-frozen, or when
you deliberately want a second opinion uncontaminated by round 1. An
independent second read is worth more from a new thread than from the one that
already agreed with you.

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
   <test-tip>..<fix-tip>`) as a REPLY into the loop's existing thread, not a
   fresh call, and answers with either new blockers or the exact
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

### Make the decay observable: a round log

"Watch for the round that stops being about findings" is a judgement, and a
judgement made inside a long loop is made by the party least able to make it.
Record it instead.

**Use the round log the "Measure every run" section already defines** — the
same file, the same row per round. Do not start a second one: two logs with
different schemas means one of them is wrong and nothing reports which. Add one
column to it:

```
| round | range | threadId | raised | new defect | regression | unresolved | new scope | tests added | verdict |
```

That log lives under `.claude/reports/`, which this repo **gitignores on
purpose** so an audit's raw output cannot be staged. It is durable enough for
the loop because it is appended every round, not written at the end. Do not
describe it as committed, and do not move it in order to commit it.

**Findings-per-round is the wrong metric and repeat-subject is not the fix.**
The naive count points the wrong way: rounds 20 to 24 of the run above raised
five real findings, so the rate looked healthy while the loop circled one
exit-classification decision.

An earlier version of this section said to count distinct subjects and stop
after two consecutive rounds on already-seen ones. **The worked example above
falsifies that rule** — those five rounds sit on one subject and all five were
real, so the rule stops at round 21 and loses three acknowledged defects.
"Subject" also has no stable granularity, so a caller can make the same
sequence converge or not by calling it one subsystem or five clauses.

**What decays is the DISPOSITION of what arrives.** Give every finding a stable
id and classify it as exactly one of:

| disposition | meaning |
|---|---|
| `new defect` | a fault not previously raised |
| `regression in fix` | the previous round's fix broke something |
| `same unresolved decision` | the same question, argued again |
| `new scope` | does not map to a frozen acceptance test |

Only the last two are churn. A round of `regression in fix` is the loop working
exactly as intended, however familiar the subject looks.

**This decides when to stop ATTACKING. It does not decide when to merge.** The
merge invariant is unchanged and stated three times elsewhere in this file: the
loop ends on the exact verdict token, and neither the token nor a green gate is
sufficient alone. A decayed yield means stop spending rounds and go get that
verdict on what is fixed — never land without it.

The stop rule, computed by the caller from the log:

- **Two consecutive rounds producing only `same unresolved decision` and
  `new scope`** means the loop has converged on argument rather than defects.
  Freeze the contract, then close the loop the normal way. A single
  `new defect` or `regression in fix` in either round resets this.
- **The same id disposed `same unresolved decision` three times** is a decision,
  not a defect. Take it out of the loop and decide it directly; it will not
  converge by being attacked again.
- **A repeated subject is a prompt to look, never evidence on its own.** It
  tells you to read the dispositions; it does not tell you the loop is done.
- **New scope is a separate loop, always.** A finding that does not map to a
  frozen acceptance test is the next audit's input. Logging it in the `new
  scope` column is how it survives without extending this run.

**The caller computes this, never the adversary.** An adversary asked to
declare itself done does not: measured across two workflows, one told to output
a dry verdict when the work was sound produced zero dry passes and ran to its
agent cap. A model asked to find findings finds findings. The log is read from
outside the loop, where the judgement costs one cheap read instead of re-billing
a full context inside it.

The log is also the only artifact that survives the run. A loop whose history
lives in one session's chat cannot be audited, cannot be resumed by anyone else,
and cannot tell a later reader whether round 20 was rigour or churn.

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

## A timeout aborts the call, not the process

A timeout ends your handle on the adversary. **It may or may not end the
adversary**, and you cannot tell which from the error.

Both outcomes are observed. One dispatch kept working for about ten minutes
after the caller had recorded it as failed, rewriting its deliverable four
times. A second, on the same machine the same day, died with its transport: its
session log froze at the moment of injection and never grew. Treat "still
running" as the case to rule out, not as the rule — the cost is asymmetric,
because acting on a dead delegate wastes a re-dispatch while acting on a live
one corrupts a file.

**So the first move after a timeout is a liveness check, not a decision.** Look
for the process, and check whether the delegate's session log is still growing.
Log SIZE is not the signal: a log can be large purely from the context injected
at start, which is what fooled the caller in the second case.

The rest follows once you know which case you are in:

- **Do not re-dispatch on a timeout.** A second dispatch puts two writers on one
  deliverable. That is not a race you lose loudly — one file vanished mid-rewrite
  and was later found 415 lines shorter under an append that looked clean.
- **Find out whether it is still running before concluding anything.** An empty
  result is a claim about the handover, never about the work.
- **The tell is `git show --numstat`, not the tool output.** Nothing in a tool
  result announces that a file got smaller. A deliverable that shrank and a
  deliverable that was edited look identical until you count lines.
- **Give the deliverable a recovery path, and pick the one its location
  allows.** An untracked file has none, so an overwrite is total loss rather
  than a diff. If the deliverable is repo content, commit it to the working
  branch as it grows — that is a local commit, and pushing still needs the
  usual say-so. If it is an audit report, it belongs under `.claude/reports/`,
  which this repo gitignores deliberately so raw audit output cannot be staged;
  there the recovery path is appending every round plus the delegate's own
  session log, not a commit. Do not relocate a report in order to commit it.
- **Last resort: the adversary's own session log on disk holds the bytes
  verbatim.** That is what recovery came from when the untracked file was gone.
  It is a backstop, not a plan — committing is the plan.

**Instruct the adversary to write incrementally.** Append findings to a file as
it goes rather than composing one answer at the end, and prefer a format that
survives truncation — one finding per block, never a single JSON object, which
parses as nothing when cut anywhere. A run that times out then still leaves
output, and a partial deliverable beats an empty one every time.

**Keep from the dispatch whatever tends to stall it.** In the run this was
measured on, browser work was the stalling half and was also the half the caller
could do directly. Removing it and re-dispatching narrowed produced a complete
plan on the next attempt. Split a brief along "what can hang" rather than along
what is conceptually tidy.

## Measure every run

Append one row per round to `.claude/reports/adversarial-loop-<topic>.md` in
the repo under audit, and total it when the loop closes:

```
| round | range | threadId | raised | confirmed | refuted | tests added | verdict |
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
