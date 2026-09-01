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
| C1 | No session idle with queued work | BUILD `check-idle-with-queue.js`: join each `fleet-heartbeat.js` row (age, cwd) to `<cwd>/QUEUE.md` open items. The heartbeat reader alone prints age, session and cwd and reads no queue (F4) | 0 sessions idle > 20 min while its queue is non-empty |
| C2 | No panel blocks a session | `fleet-status.js --pending` | 0 blocked > 10 min; reversible questions self-resolve (§2.3) |
| C3 | The fleet survives Brain death | kill the Brain process mid-window; re-run C1 | C1 still holds 30 min later |
| C4 | Standing conditional orders execute without re-prompt | a planted order ("when X is green, do Y") with X flipping during the window | Y happens within one wake interval, once, with the order's origin logged |
| C5 | No work lost | BUILD `commit-ledger.js`: the denominator is every commit ANNOUNCED in a transcript tool result during the window (`[<branch> <sha>] <subject>` lines under `~/.claude/projects`, each row carrying `cwd` and session); the numerator is those SHAs reachable from any remote ref or present in a bundle. Neither `git ls-remote` nor a bundle census can supply the denominator (F7) | every announced commit is on a remote or in a bundle |
| C6 | No duplicate work | BUILD a fourth signal in `fleet-overlap.js`: shared paths from `git diff --name-only <merge-base>..<tip>` per live branch pair in one repo. Today it scores branch, repo and title tokens only (F5). The story join is out of scope for this audit | 0 live pairs sharing 3 or more changed files |
| C7 | The coordinator writes nothing to a product repo | the same transcript ledger as C5, filtered to the Brain's session id and a `cwd` outside the harness repo. Git carries author and committer only, never the session (F8) | 0 commits in product repos from the Brain's session |
| C8 | Absence and completeness claims carry provenance | `check-claim-provenance.js --history N` over the window's commits, and `--check-message <file>` over each status file written in it. Both modes exist; there is no window mode and the checker detects absence and completeness claims only, never qualitative ones (F6) | 0 untagged absence/completeness claims |
| C9 | Cost stays inside the tripwire | `quota-tripwire.js --status` for the reading, `--once` for a single check. The bare form is the poll loop by design and must not be used as a probe (F1) | window spend under the configured ceiling; the tripwire fires BEFORE the wall, measured with a planted low ceiling |
| C10 | Output is mergeable | `git log --merges --since <window>` on each trunk; each merge commit body must carry the gate command with its result AND the line `VERDICT: CLEAN` with the adversary thread id. The round log is gitignored by design, so the merge commit is the tracked evidence (F9) | 100% of merges carry both; 0 merges on either alone |

C10 is the half nothing measures today. C1 to C9 are why the fleet stalls; C10
is why "it doesn't work well enough".

**Probe status, so P1 does not discover it the hard way.** EXISTS and prints
the number: C2, C3, C8, C9, C10. BUILD before P1 can score them: C1, C5, C6,
C7 (three small scripts and one new signal). Every probe in P1 runs under a
15 s timeout wrapper, and a probe that does not return is a finding, never a
stall (F1 to F3).

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

"Away" is a declared state, not an inference, and it needs a MECHANISM,
because two things already in the repo contradict the paragraph above as first
written (F10). `rule-options-protocol/SKILL.md` is always-on and tells every
worker to end each substantive turn with a panel; `brain-panels.js` denies
panels by writing `AskUserQuestion` into `permissions.deny`, so a worker
"raising the panel anyway" cannot happen while that deny stands. The plan
therefore replaces the deny, it does not layer on it:

- **State file:** `~/claude-memory/AWAY.md` carries an ISO until-time and the
  operator's words verbatim, written atomically (temp file, rename). Four
  states, each with a defined reading (F16): **active** (until-time in the
  future) means self-resolve; **expired**, **absent** and **malformed** all
  mean "the operator can be asked", and malformed is logged. Expiry needs no
  writer, so a dead Brain cannot strand anyone.
- **Enforcement point:** `panel-recommendation.js`, the PreToolUse hook that
  already parses every outgoing panel and knows its recommended option. Under
  an active AWAY it blocks the panel with exit 2 and returns the branch-2
  decision to the session in the block message: take the recommended option,
  append the branch label to `DECISIONS-<date>.md`, continue. Under any other
  state it behaves as today. The permissions deny in `brain-panels.js` is
  retired once this lands; `--extend` and expiry semantics move to the file.
- **Irreducible questions** (branch 3) are written to the queue as blocked
  by the session itself before it moves on; the hook cannot judge
  reversibility, so the session's brief names the branch-3 classes verbatim.

### 2.4 Liveness without a Brain

The feeder must not live inside any session (S1). Two mechanisms, both already
partly present, and the audit tests which actually holds:

- **Worker-side:** each worker holds its queue and its next item. A worker
  with a standing conditional order re-checks it on its own `ScheduleWakeup`
  cadence (`/loop`), never by waiting for a message. Finishing item N starts
  item N+1 with nobody in the loop.
- **Machine-side: the pieces exist and are not joined, and the host is not
  even registered here.** `[measured 2026-09-02]` by the adversary:
  `schtasks /Query /TN AutodevFleetNotify` prints "cannot find the path
  specified", so `install-fleet-notify-task.ps1` has never been run on this
  machine (F12). When it is, the task runs `fleet-notify.js` every 2 min,
  which toasts the DESKTOP once per newly panel-blocked session; it has no
  phone transport, and this plan makes no phone claim (F11).
  `fleet-stop-watch.js` emits STOPPED and RESUMED but keeps its state in
  memory on purpose, so `--once` from a task baselines every session and can
  never see a transition (F12). The build for this lane is therefore one
  persisted, queue-aware join: `--state <file>` on the stop watch, the
  stop-without-resume rule (STOPPED, no RESUMED after it, queue non-empty,
  silent 20 min) evaluated across runs, and the toast reused from the notifier.
- **Visibility is not liveness (F13).** Nothing outside a session can message
  a session, wake one, or reclaim its queue item. So after a Brain or worker
  dies, the machine side can only make the absence visible; the RECOVERY half
  is one of two things, and choosing is the operator's call (Q5): a worker's
  own `ScheduleWakeup` cadence, which survives Brain death but not its own;
  or the supervisor task launching a headless `claude -p` run against the
  repo's queue file, which is spend while nobody is watching. Until Q5 is
  answered, C3 is scored as "work is visible and resumable", not "continues".

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

### L0: Inert entry points (S11), done first because every other lane probes scripts

- Subject: every `plugins/*/scripts/*.js`, `plugins/*/hooks/*.js` and
  `tooling/*.js` except suites.
- `[measured 2026-09-02]` `tooling/check-entrypoints.js` probes each with
  `--help` under a 10 s budget against a scratch copy of the tree under a
  scratch HOME, so a script that ignores the flag and mutates cannot touch the
  source. First run: 90 probed, 5 hung (`watch-panels`, `fleet-stop-watch`,
  `quota-tripwire`, `find-untested-functions`, `find-untested-hooks`). All
  five fixed; the suite `tooling/test-entrypoints.js` asserts the corpus stays
  at zero, and the selftest plants a `setInterval` and a self-writing script
  to prove the classifier and the isolation.
- Remaining: mutation-verify the suite under `check:suites`; land as a PR.

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
- `[measured 2026-09-02]` the idle timeout bit this plan's own review: the
  resumed `codex-reply` ran 31 minutes, the harness aborted the call at 1800 s
  of silence ("sent no response or progress for 1800s"), and the reply was
  lost while the file survived because it was written incrementally. The
  error names the remedy: a per-server `timeout` in the MCP settings, or
  `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`. Setting it is a persistent config
  change and is the first item of the L4 bootstrap, with the operator's yes.
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
| P2 | L0 is done. Order per F14, validating the instrument before using it: **L4 bootstrap (one round: transport, idle timeout, report preservation) → L5 remainder → L7 (30 min, bare-word dispatch only) → L6 rails → L2 → L3 → L1**. L1 is the integration lane and runs last. C1 is built inside L1; C5 to C8 are deferred to week 2 | Brain + Codex, one thread per lane | ≤ 4 rounds per lane; freeze on two churn rounds; targeted suite during iteration, full gate at convergence |
| P3 | Rehearsal: a 2 h window, operator present but silent, on ONE synthetic three-item queue in a scratch repo, with a forced Brain death mid-window; score C1 to C4, C9, C10 | Brain, one worker, machine task | 1 window; every failed criterion returns to its lane |
| P4 | Week 2: C5 to C8 built and scored, the mandated repos brought in, a real away window; only then declare unattended | operator names the window | none |

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
- **No product repo in week 1.** The rehearsal runs on a synthetic queue in a
  scratch repo; the mandated repos enter in week 2 after C1 to C4 hold there.

## 6. Queued for the operator

**Q2 blocks the contract freeze (F15). The rest are answered whenever.**

- Q2 **[blocking C4 and L2]** Does a standing order, recorded verbatim from
  your own words with the date, count as "push authorised in that turn" for
  the session that holds it? `brain/SKILL.md:915` says a push needs your yes
  in the turn, and whether a durable order satisfies that is your authority,
  not an audit detail. If no, S3 stays by design and C4 is dropped from the
  contract; if yes, L2 builds the holder and the push-authorisation gate learns
  the recorded form.
- Q1 Is 10% of the weekly window the right ceiling for the audit?
- Q3 Auto-archive-after-merge: leave off for Brain sessions permanently, or
  gate the Brain on reading it?
- Q4 The rehearsal window (P3): which 2 hours? Week 1 rehearses on a
  synthetic three-item queue in a scratch repo, not on the mandated repos.
- Q5 The recovery half of liveness (F13): may the supervisor task launch a
  headless `claude -p` run to reclaim a queue item when a worker is dead, or
  is in-session `ScheduleWakeup` the only mechanism you want spending while
  you are away?

## 7. Revision log

**v2, 2026-09-02, after the adversary's first nine findings** (thread
`01a05f07`, `gpt-5.6-sol`, workspace-write, 64 tool calls, every finding
measured; the call was interrupted by the operator after F9, so the conflict
check on 2.3, the overlap check on 2.4 and the one-week cut list are pending
in the same thread).

| Finding | Disposition | What changed |
|---|---|---|
| F1 to F3 | ORDER, accepted | L0 added and executed first; P1 wraps every probe in a timeout; C9 names `--status` and `--once` |
| F4 | WRONG, accepted | C1 marked BUILD with the join it needs |
| F5 | UNMEASURABLE, accepted | C6 marked BUILD, story join dropped to `new scope` |
| F6 | UNMEASURABLE, accepted | C8 narrowed to what the checker detects and to its two real modes |
| F7 | UNMEASURABLE, accepted | C5 gets a denominator: commits announced in transcripts |
| F8 | UNMEASURABLE, accepted | C7 uses the transcript ledger, which carries session and cwd |
| F9 | UNMEASURABLE, accepted | C10 reads merge-commit bodies, the tracked evidence |

All nine share one shape: probes were named by the question, not by what the
script prints. The correction is the one `rules/agent-quality.md` 5e already
states: an artifact is authoritative only about the layer it encodes.

**v3, 2026-09-02, after the resumed thread returned F10 to F16 and closed
with `REVIEW: COMPLETE`** (16 findings: WRONG 4, MISSING 2, UNMEASURABLE 5,
ORDER 5, OVERBUILT 0; adversary's severity order F1, F13, F10, F14, F15, F4,
F12, F16, F9, F7, F8, F5, F6, F2, F3, F11).

| Finding | Disposition | What changed |
|---|---|---|
| F10 | WRONG, accepted | 2.3 rewritten around a mechanism: the AWAY state is enforced by the existing panel hook, and the `permissions.deny` mechanism in `brain-panels.js` is retired rather than layered on |
| F11 | WRONG, accepted | "phone" removed; the toast is desktop-only |
| F12 | WRONG, accepted | the notifier task is not registered here; the stop watch keeps no state; L1's build is the persisted, queue-aware join |
| F13 | MISSING, accepted | visibility and recovery split; recovery is Q5, the operator's call, and C3 is scored honestly until then |
| F14 | ORDER, accepted | P2 runs L4 bootstrap first and L1 last |
| F15 | ORDER, accepted | Q2 now blocks the contract freeze |
| F16 | MISSING, accepted | AWAY has four states, atomic writes and expiry that needs no writer |
| one-week cut | accepted with one change | L7 kept as a 30-minute bare-word dispatch check inside week 1 rather than cut, because L2's briefs depend on it |

One new measurement from running the review itself: the 1800 s MCP idle
timeout, recorded under L4.
