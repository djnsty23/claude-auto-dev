# Harness audit plan, 2026-09-02

Written from the failure record, not from principles. Every stall class below
names the date, the probe, and what it printed. Product repos are anonymised
per this repo's public-name gate; the two repos the Brain owns outright are
named only in the private `MANDATE.md` the `brain` skill reads at boot.

The question the audit answers: **can this harness run an unattended window
without stalling, and is what it produces good enough to merge?** Today the
answer to the first half is no, measured five separate ways below, and nothing
in the repo currently measures the second half at all.

## 0. The record: what stalled, what worked

### Stalls, each measured

| # | Stall class | Evidence | Root cause as diagnosed at the time |
|---|---|---|---|
| S1 | **The watcher died with the Brain.** 4 of 5 sessions last logged within 13 min of each other, then 7h dark; 0 commits on 4 of 5 trunks | `[measured 2026-08-30 04:29]` Brain transcript: "the stop watch has no completion record and may have been running when the Claude Code process died" | The only thing feeding sessions their next item was a background task INSIDE the Brain session. Process exit took both. 13 panel denies then outlived the Brain, so sessions had no Brain and no panel |
| S2 | **Sessions drained one at a time and stopped.** Six stops spread over 33 min, each on a clean commit | `[measured 2026-08-30 06:11]` "STOPPED with no RESUMED after it"; memory `stop-without-resume-is-a-drained-session` | Briefed a TASK, not a QUEUE. Panels denied, so a finished session's only legal move was stop |
| S3 | **A conditional standing order was re-issued by the operator five times.** "if green and sol says clean, push and open the PR" at 20:33, 21:02, 21:32, 22:01, 06:00 | `[measured]` prompt extraction over 14 days of transcripts, 12 project dirs | The session treated a conditional instruction as a one-shot and waited for a human to re-fire it each round. The authorisation was durable; the holder was not |
| S4 | **Panel-blocked sessions read as dead, or block silently.** A dead-man's check reported a panel-blocked session dead across 10 checks; right now one session has sat 50 min on "main is red and PR #83 is the green fix. Merge it?" while `list_sessions` already shows that PR MERGED | `[measured 2026-09-02 01:06]` `fleet-status.js --pending --days 1`: 1 blocked, 39 transcripts scanned | Nothing resolves a reversible question when the operator is away. `isRunning` is not a boolean and the detector that IS correct (`fleet-status --pending`) was not the one being asked |
| S5 | **The coordinator became a writer on product repos.** Five PRs retargeted onto the wrong base; a branch merged into a base a briefed session was landing PRs into 40 s later; a pre-push guard that reported the base moved and pushed anyway (`;` not `&&`) | `[measured 2026-09-01]` `DECISIONS-2026-09-01.md`, 500 lines, section "I RETARGETED FIVE PRs THE WRONG WAY" | Told to run the fleet with no mechanism to start a session, the coordinator had two doors: ignore the repo or work it itself. It worked four |
| S6 | **Cross-vendor review over a desktop app.** ~15 click batches lost to focus, two stale clipboard re-pastes, "you pasted the same text last 5 times" | `[stated 2026-08-31 12:05]` operator; memory `codex-reach-gpt-over-mcp` | Transport, not model. Fixed: MCP channel measured and adopted |
| S7 | **Delegate timeouts lost or corrupted deliverables.** A 30 min MCP timeout aborted the CALL not the PROCESS; re-dispatch put two writers on one file; 415 lines lost; a 32 KB report destroyed by `git worktree remove` because reports are gitignored | `[measured 2026-08-31, 2026-09-01]` PRs #110, #114 | Untracked deliverable, written at the end, re-dispatched without a liveness check |
| S8 | **Confident wrong claims, none caught by the system.** Five in one session ("exactly 3 models", "Sol's edge is semantics", …) | `[measured 2026-08-31 18:52]` Brain's own table when asked "are we ready to go fully autonomous": "Not one was caught by the system" | Provenance is a prose rule. `check-claim-provenance.js` exists but is warn-only at 6.25% flag rate with mixed precision |
| S9 | **Merging archived the Brain.** Auto-archive-after-PR-merge keyed on any PR the session record was linked to, including one it merely merged | `[measured 2026-09-01]` `brain/SKILL.md` "Dispatch mechanics"; operator turned the setting off | A per-operator toggle nobody reads. Follow-ups captured AFTER the merge were lost with the session |
| S10 | **Skills never fire from a peer message.** Zero user-invocable `autodev-core` skills fired across peer transcripts since 2026-08-20; `audit` appears 3,199 times, every one inside a sentence | `[measured 2026-08-25]` memory `skills-need-a-bare-word` | Triggers are one bare word and nobody sends one alone |
| S11 | **Entry points that start a watcher when probed.** `watch-panels.js --help` and `fleet-stop-watch.js --help` do not return; `quota-tripwire.js --help` did not return in 40 s | `[measured 2026-09-02 01:06]` `timeout 8 node <script> --help` → exit 143 on both; F8 in PR #105 fixed the same class in `fleet-board.js` only | A script that runs when you look at it cannot be audited, and a coordinator that probes it hangs |
| S12 | **The private mirror is a concurrent-writer race.** A mandate edit to the kickoff file was clobbered by the sync between write and `git add` | `[measured 2026-09-01 07:55]` Brain transcript: the Brain found its edit gone from disk and from history, because the automated sync's commit touched that file | Every session pushes `~/claude-memory` on edit; two writers on one file with no lock |

Cost context for all of it: `[measured]` `quota-burn.js --days 7` prints a
list-price equivalent of **$21,159 in the current weekly window**, 91% on the
Opus main-thread model, from 238 transcripts. The binding constraint on any
unattended plan is the weekly usage ceiling, not concurrency. Workflow runs lost
42 of 280 agents (15%) and the dominant loss cause was the quota wall
(`docs/evidence-workflow-runs.md`).

### What worked, so the audit tests these rather than rebuilding them

- **The adversarial loop protocol.** 8 real false-verdict defects in gates an
  85-suite gate passed green, all found by an adversary REQUIRED to write a
  test that fails on the defect (PR #105). The edge was the posture, not the
  vendor (`adversary-edge-was-tool-posture`).
- **Spec-driven delegation.** A brief with a payload contract ran 17/17 with
  one steer; taste-driven work took eleven messages (`agent-quality.md` 10k-i).
- **Bundle before archive.** `git bundle create` preserved unpushed work from
  four worktrees before a crash cleanup, with nobody's authorisation needed.
- **The no-panel decision log.** 500 lines on 2026-09-01, branch-labelled,
  including the withdrawn retarget. The log is what made S5 reversible.
- **Draft-PR batching** as structure rather than discipline (`brain/SKILL.md`).
- **`fleet-status --pending`** detects panel-blocking directly and is correct.
- **Mutation-tested gates**, and `check:suites` refusing to count an
  unverifiable suite as verified (PR #90).

## 1. The acceptance contract: what "works unattended" means

Frozen before any audit lane starts, so a lane cannot move the goalposts.
Each criterion names the probe that scores it. A criterion with no probe is
not in the contract.

| # | Criterion for an N-hour away window | Probe | Threshold |
|---|---|---|---|
| C1 | No session idle with queued work | `fleet-heartbeat.js` age vs the repo's queue file having open items | 0 sessions idle > 20 min while its queue is non-empty |
| C2 | No panel blocks a session | `fleet-status.js --pending` | 0 blocked > 10 min; reversible questions self-resolve (§2.3) |
| C3 | The fleet survives Brain death | kill the Brain process mid-window; re-run C1 | C1 still holds 30 min later |
| C4 | Standing conditional orders execute without re-prompt | a planted order ("when X is green, do Y") with X flipping during the window | Y happens within one wake interval, once, with the order's origin logged |
| C5 | No work lost | `git ls-remote --heads` + bundle census before and after | every commit made during the window is on a remote or in a bundle |
| C6 | No duplicate work | `fleet-overlap.js` + `gh pr list --state all` | 0 pairs of branches touching the same files for the same story |
| C7 | The coordinator writes nothing to a product repo | commit author + cwd census over the window | 0 commits in product repos from the Brain's session |
| C8 | Every state claim in a report carries provenance | `check-claim-provenance.js` over the window's reports and commit bodies | 0 untagged absence/completeness claims |
| C9 | Cost stays inside the tripwire | `quota-tripwire.js` | window spend under the configured ceiling; the tripwire fires BEFORE the wall, measured with a planted low ceiling |
| C10 | Output is mergeable | each landed unit has a green gate run named by command AND an adversary `VERDICT: CLEAN` token in the round log | 100% of merges carry both; 0 merges on either alone |

C10 is the half nothing measures today. C1 to C9 are why the fleet stalls; C10
is why "it doesn't work well enough".

## 2. Roles and channels while the operator is away

### 2.1 Roles

| Role | Who | May | May not |
|---|---|---|---|
| **Brain** | one session, on Opus, in an autodev worktree | dispatch, verify, merge autodev PRs, write autodev code, spawn chips, log decisions | commit in any product repo; relay authorisation; poll |
| **Adversary** | Codex `gpt-5.6-sol` over MCP, `sandbox: workspace-write`, `approval-policy: never`, one thread per loop | read, run probes, write failing tests on the test branch, write its report incrementally under `.claude/reports/` | edit the fix branch; run the merge; be asked to coordinate |
| **Workers** | one session per repo tier, each holding its own queue | take the next queue item when idle; self-resolve reversible panels; commit before reporting; send one idle message | spawn chips; push without a standing order; cross-repo work |
| **Operator** | Andy, by phone | read the status file; answer branch-3 items whenever; say push | be required for anything reversible |

**This planning session runs on Fable on the main thread.** The operator's own
model rule says never do that for execution: a main-thread turn re-reads ~534k
tokens and Fable doubles the input term. So the plan is written here and the
audit is EXECUTED from a fresh Opus Brain session booted with `/brain`, which
reads `MANDATE.md`, the latest `DECISIONS-*.md`, and this file.

### 2.2 Channels: files, never chat

| Thing | Where | Why there |
|---|---|---|
| This plan and its revisions | `docs/harness-audit-plan.md`, committed | repo is the only channel a cold Codex run and a fresh Brain share |
| Adversary round log | `.claude/reports/harness-audit-rounds.md`, appended every round, one schema (the one `adversarial-loop` "Measure every run" defines) | gitignored on purpose; durable by append, and the delegate's own session log is the backstop |
| Decisions taken without a panel | `~/claude-memory/DECISIONS-<date>.md`, branch-labelled | the operator audits branch 2 and moves the boundary |
| Per-repo work queue | `<repo>/PUBLISH-QUEUE.md` for publish items; `<repo>/QUEUE.md` for work items, one tier deep | survives session death; a worker reads it itself |
| Standing orders | `~/claude-memory/STANDING-ORDERS.md`, one line per order: the operator's words verbatim, the date, the condition, the action, who holds it | S3: durable authorisation needs a durable holder |
| Status for the operator | `~/claude-memory/STATUS-<date>.md`, rewritten at each milestone and sent with `SendUserFile` | a phone cannot open a repo path; a markdown link outside cwd is dead (`outside-cwd-paths-need-sendfile`) |

Mirror writes go through **write-then-commit in one command**, never write,
then `git add` later (S12). A lock file is not available; atomicity is.

### 2.3 Decisions with nobody to ask: the three branches, applied to workers

The `brain` skill's no-panel mode is written for the Brain. S2 and S4 show it
has to apply to WORKERS too, because a worker under panel-deny with a question
has exactly one legal move today, and it is stop.

1. **Covered by a standing rule or standing order** → act, log, continue.
2. **Reversible and not covered** → take the recommended option, log it with
   the branch label, continue. `[measured 2026-08-29]` 8 of 11 panel answers
   were the recommended option; the 3 that diverged all chose MORE forward
   action. `[measured 2026-08-26]` over 1,389 answered panels the only class
   rejected at a high rate is a recommended PAUSE (43% vs 9%). So "take the
   recommendation" errs toward stopping, never toward damage.
3. **Irreducible** (money, production rows, deletes of unmeasured shared state,
   taste on a daily surface) → write it to the queue as blocked, send the
   four-part idle message, **and take the next queue item**. Blocked on one
   item is not idle.

"Away" is a declared state, not an inference: the Brain writes
`~/claude-memory/AWAY.md` with an until-time from the operator's own words
("i'm going outside", "keep them going, i'll be back in a bit"), and removes
it on his next direct message. Workers read it before choosing branch 2 vs a
panel. The panel-deny window (`brain-panels.js`) is subordinate to it: a deny
that outlives the Brain must not strand a worker (S1), so a worker whose panel
is denied AND `AWAY.md` is absent raises the panel anyway.

### 2.4 Liveness without a Brain

The feeder must not live inside any session (S1). Two mechanisms, both already
partly present, and the audit tests which actually holds:

- **Worker-side:** each worker holds its queue and its next item. A worker
  with a standing conditional order re-checks it on its own `ScheduleWakeup`
  cadence (`/loop`), never by waiting for a message. Finishing item N starts
  item N+1 with nobody in the loop.
- **Machine-side:** `install-fleet-notify-task.ps1` registers a Windows task.
  The stop-without-resume detector runs THERE, keyed per session on the last
  transition, and toasts the operator's phone via `fleet-notify.js` when a
  session with a non-empty queue has been silent 20 min. It does not message
  sessions; it cannot. It makes the absence visible.

The Brain's job on return is to read the transitions, not to poll.

## 3. Audit lanes

Each lane is one adversarial loop: the adversary audits the subject and
returns numbered findings; the Brain confirms or refutes each against the real
code; confirmed findings get a failing test on `harness-audit/<lane>/test-acceptance`;
the fix lands on `harness-audit/<lane>/fix`; the round ends on `VERDICT: CLEAN`
plus a green `npm run gate`. Findings are classified by disposition every
round (`new defect`, `regression in fix`, `same unresolved decision`,
`new scope`); two consecutive rounds of the last two freeze the lane.

Every probe below prints its population and runs a known-positive first. A
probe that returns empty is a claim about the probe.

### L1: Liveness and the feeder (S1, S2)

- Subject: `fleet-heartbeat.js`, `fleet-stop-watch.js`, `inbox-watch.js`,
  `watch-panels.js`, `session-sweep.js`, `install-fleet-notify-task.ps1`,
  `brain/SKILL.md` "Dispatch mechanics", `auto-brain/SKILL.md` steps 5 to 7.
- Question: which of these runs OUTSIDE a session, and what happens to each
  when the Brain's process exits?
- Probe: start the watcher chain, kill the Brain process, read heartbeats and
  the notify log 30 min later.
- Acceptance test: a worker session with a 3-item `QUEUE.md` and no inbound
  message drains all 3 (C1), and a stop-without-resume fires a notification
  within 20 min (C3).

### L2: Queues and standing orders (S3)

- Subject: `check-queue-drained.js`, `check-queue-freshness.js`,
  `check-assignment.js`, the `QUEUE.md` / `PUBLISH-QUEUE.md` conventions,
  `check-push-authorisation.js`.
- Question: can a conditional order given once be held and executed once,
  and does the push-authorisation gate recognise a recorded standing order as
  the operator saying push in that turn, or does it refuse it?
- Probe: plant an order whose condition flips during the window; count
  executions and the log line.
- Acceptance test: C4 holds; a second wake after execution does NOT re-fire;
  an order with no operator words verbatim is refused by the gate.

### L3: The decision layer (S4)

- Subject: `brain-panels.js`, `panel-recommendation.js`,
  `check-recommendation-quality.js`, `fleet-status.js --pending`, the
  no-panel section of `brain/SKILL.md`, and the worker-side branches in §2.3
  which exist nowhere yet.
- Question: when a panel is denied and the operator is away, does a worker
  self-resolve a reversible question, and does it log it?
- Probe: a deny window, `AWAY.md` present, a planted reversible question in a
  worker; then the same with `AWAY.md` absent.
- Acceptance test: C2. The 50-minute panel in S4 is the first live case: its
  question is already moot (the PR merged), so the correct resolution is
  "re-read state, dismiss", and the test asserts a moot panel is detected as
  moot, never answered.

### L4: The adversarial loop itself (S6, S7)

- Subject: `adversarial-loop/SKILL.md`, `docs/codex-channels.md`,
  `reap-orphan-waiters.js`, `usage-both.js`, `AGENTS.md`.
- Question: does the loop find a planted false-verdict defect, prove it with a
  test that fails, survive a timeout without a second writer, and stay under
  the 2048-character structured-reply cap?
- Probe: copy one gate to a scratch subject, plant the exact F1 defect from
  PR #105 (verdict printed, exit 0), run one round with `sandbox:
  workspace-write`; separately kill the MCP call mid-run and follow the
  liveness procedure.
- Acceptance test: the finding arrives prefixed "Measured:" with the command;
  the test fails for the stated reason on the planted code; `git show
  --numstat` on the report shows no shrink across the timeout; cost per round
  is written to the round log from `usage-both.js`, both sides.

### L5: Gate integrity and inert entry points (S8, S11)

- Subject: every script under `tooling/` and `plugins/autodev-core/scripts/`
  that has a `--help` or `--selftest`; `check-claim-provenance.js`;
  `check-population-reporting.js`; `check:suites`; `check:vacuity` on the
  five coordination scripts (`brain-brief`, `fleet-status`,
  `check-queue-drained`, `brain-panels`, `auto-brain-survey`).
- Probe: `timeout 10 node <script> --help` over the whole population, print
  the population and the non-returners (S11 already names three).
- Acceptance test: a new `check:entrypoints` gate that fails on any script
  whose `--help` does not exit 0 within 10 s, mutation-tested by planting a
  `setInterval` before the help branch; claim-provenance precision measured on
  the last 100 commit bodies and promoted to blocking only if false positives
  are under 5% on that sample.

### L6: Safety rails for an unattended window (S5, S9, S12)

- Subject: the coordinator-write ban (exists as prose only), bundle-before-
  archive (`sessions` skill), `sessionend-secret-scan`, `quota-tripwire.js`,
  the mirror sync (`sync-claude-memory.ps1`), auto-archive-after-merge.
- Probe: a PreToolUse hook that refuses `git commit`/`git push` when the
  session holds the Brain role file AND cwd is outside the harness repo;
  planted in a scratch session and mutation-tested by removing the role file.
  Quota tripwire tested with a planted ceiling below current spend. Mirror
  write tested with two concurrent writers on one file.
- Acceptance test: C5, C7, C9; the archive setting's state is READ by the
  boot sequence and printed, never assumed.

### L7: Skill reachability (S10)

- Subject: `analyze-skill-invocations.js`, `check-skill-triggers.js`,
  `check-skill-tool-declarations.js`, the `when_to_use` lines of `auto`,
  `audit`, `heal`, `status`.
- Probe: send the bare word `status` to a scratch session and read its
  transcript for the skill load; send the same word inside a sentence as the
  control.
- Acceptance test: the dispatch templates in `brain` and `auto-brain` carry
  the bare-word form for any skill they mean to invoke, gated by
  `check-skill-triggers.js`. No new skill is written (memory: a 41st skill in
  a library where 38 never fire is the same failure with a new name).

## 4. Sequence, and the budget it is held to

| Phase | What | Who | Bound |
|---|---|---|---|
| P0 | Freeze §1 as `docs/harness-acceptance-contract.md`; Codex reviews THIS plan; plan v2 | this session, Codex 1 round | tonight, 1 Codex thread |
| P1 | Baseline census: run every probe in §1 against the last 7 days and print the table with populations. No fixes | fresh Opus Brain | 1 h, 0 Codex rounds |
| P2 | Lanes L1, L2, L3 in that order (they are the stall root), then L5, L6, L4, L7 | Brain + Codex, one thread per lane | ≤ 4 rounds per lane; freeze on two churn rounds; targeted suite during iteration, full gate at convergence |
| P3 | Rehearsal: a 4 h window with the operator present but silent, on the two mandated repos only, with §2 fully in force; score §1 | Brain, workers, machine task | 1 window; every failed criterion returns to its lane |
| P4 | A real away window; same scoring; only then declare unattended | operator names the window | none |

Bounds that are measured rather than chosen: `[measured]` the first
production adversarial loop ran 24 rounds against a cap of 5, so the freeze is
on disposition decay, not on a count. `[measured]` a session's second half
costs 1.44x its first for identical work, so each lane runs in a fresh Brain
context past ~300k tokens, with `RESUME.md` written by `session-exit.js`.

Concurrency: **one lane at a time.** Parallel lanes fix the same watcher twice
in different words (`fleet-brief.md` "six agents, sequential by default"), and
`check:suites` needs the tree to itself.

Cost ceiling for the whole audit: proposed at **10% of the weekly window**,
read off `quota-tripwire.js` at P1 and written into the contract; the Brain
stops dispatching at 8% and reports. Codex draws plan quota, not dollars, and
Pro rate-limits mid-week, so L4 runs early in the week.

## 5. What this plan refuses to do

- **No new coordination role, no "codex brain".** Coordination output was
  measured at null by two independent peers; Codex cannot see peer sessions
  and would assert claims about state it cannot read. Codex audits and
  attacks. It does not dispatch.
- **No new user-invocable skill.** See L7.
- **No revived cloud routines.** All 18 scheduled tasks are disabled or
  retired (`list_scheduled_tasks`, 2026-09-02); their descriptions say why.
  The machine-side task in §2.4 is a notifier, not an agent.
- **No pushes from this plan.** Commits stay local; a push needs the operator's
  word in that turn or a standing order that carries it verbatim.
- **No product-repo writes from the Brain**, ever, including "just this once
  to unblock". S5 is what that costs.
- **No parallel lanes, no round cap as the bound, no relayed authorisation.**

## 6. Queued for the operator: non-blocking

Answered whenever; nothing in P0 to P2 waits on them.

- Q1 Is 10% of the weekly window the right ceiling for the audit?
- Q2 Should a standing order recorded verbatim count as "push authorised in
  that turn" (L2 acceptance depends on it; the alternative is that every
  conditional merge waits for you, which is S3 forever)?
- Q3 Auto-archive-after-merge: leave off for Brain sessions permanently, or
  gate the Brain on reading it?
- Q4 The rehearsal window (P3): which 4 hours, and are the two mandated repos
  the right subjects?
