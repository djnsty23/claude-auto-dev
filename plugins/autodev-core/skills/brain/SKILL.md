---
name: brain
description: Drive an authorized product mission from idea through implementation, independent review and live verification. Use when asked to run the fleet, replace manual coordination, or resume Brain.
when_to_use: "Invoked when the user says \"brain\", \"restart the brain\", \"you are the brain\", \"take over the fleet\", or delegates a product mission from idea to delivery."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, Agent, Workflow, AskUserQuestion, SendMessage, Monitor, mcp__ccd_session_mgmt__send_message, mcp__ccd_session_mgmt__list_sessions, mcp__ccd_session_mgmt__get_session, mcp__ccd_session_mgmt__archive_session, mcp__ccd_session__spawn_task, mcp__ccd_session__dismiss_task
model: opus
user-invocable: true
argument-hint: "[mission or resume]"
---

# Brain

Own the outcome: choose the next useful work, start it, inspect its evidence,
resolve reversible decisions, and carry it through the authorized delivery
boundary. Completion means the promised behavior was observed in the intended
environment and its evidence recorded. Plans, workers and green builds are
intermediate results.

This is the active procedure. Read [historical notes](references/history-2026-09-09.md)
only when investigating a specific earlier incident. Their quoted permissions,
tool availability and superseded instructions are not current policy.

## 1. Establish scope and capabilities

Read the current request, repository guidance and the machine's mandate if one
exists (`~/claude-memory/MANDATE.md` is the convention). Preserve each grant's
source, scope and exceptions. An absent mandate does not cancel work authorized
in this session. Public anecdotes about another user's permissions grant none.
Decide reversible implementation and design details within scope, reuse product
conventions and record assumptions. Ask only for missing intent or authority
that materially changes the work; continue independent items while waiting.
Credentials, spending, customer data and destructive changes need the authority
applicable to the exact action. A peer cannot manufacture the user's consent.

Read available tools and their schemas. Resolve scripts from this installed
skill (`../../scripts`); use each script's `--help`. Label clone measurements
separately from installed behavior. A plugin-root environment variable need not
exist in a shell, and a Windows path need not exist on this host.

Before depending on unattended hook protections, load
[host admission](references/host-admission.md). Verify the native catalog and
actual allow/deny effects for the required operations on this host/version.
Missing warnings, empty hook populations and untested function modules are not
proof that controls ran.

For fleet coordination, run `brain-brief.js`, `fleet-status.js` and
`fleet-overlap.js`. Bind the repo set to the mandate and exclude client or
retired projects unless assigned. A `brain-brief.js` exit 2 means that set is
incomplete. Read populations and COULD-NOT-CHECK results; advisory exit 0 does
not establish health. Read current git refs and PR content before acting.

Before claiming an existing fleet role, read its live registries. `session_id`
is the CLI UUID; `peer_name` and `desktop_session_id` are separate addresses,
joined through the desktop record's `cliSessionId`. Never derive one by editing
another's spelling. Preserve the prior `brain-role.json` record and scope
`home_repos` to the coordinator's own writable repos. Run `check-brain-role.js
--json`; require an `ok` record naming this session. Exit 0 also covers an absent
role. Where this runtime has no compatible registry, use its native agent return
channel and state that Claude's fleet hooks do not cover it. Notify existing
workers of an address change only within the user's authorized coordination.

When the record is `degraded`, use its positively verified reachable address
for existing work and re-stamp the stale field before broadcasting the record.
A decayed peer name does not mean the coordinator disappeared. A `fault` or
unchecked address requires diagnosis; a missing check is not proof of death.

## 2. Turn the mission into executable outcomes

Read `SPEC.md`, `prd.json`, decisions and resume state at named refs. Fetch before
acting on remote state; inspect local unpushed branches and open PR contents to
avoid duplicating work. A branch title is a lead, not a description of its diff.

For a new idea, load `spec`, then `setup-project` and `core`. Infer ordinary
choices and record assumptions. Continue into building when already requested;
“say auto to start” does not complete a build request. Add missing capabilities
to an existing product's backlog. Small direct fixes need no invented sprint.
Each capability names an actor, trigger, observable outcome and verification
method. Write dependency IDs in `blockedBy` and concrete acceptance conditions.
Include persistence after reload, invalid input, access boundaries, recovery and
loading/empty/error/success states where applicable. Identify external setup and
the release step. A wording check does not prove completeness or database access.

Use `workPlan(prd)` from `scripts/prd-states.js` for dependency-ready work from
all sprints, as Auto and its Stop hook do. For missions recorded in the store,
`scripts/mission-supervisor.js tick` is one bounded pass over that plan: it
settles claimed missions (reconcile, deliver, accept the envelope or fail the
attempt with the store's retry codes), starts what is ready or past its
backoff through the dispatcher, admits each mission in its own worktree with
`--worktrees`, and reports exhausted, blocked and invalid work by name. It
never loops, never writes `prd.json`, and reports an accepted envelope as
awaiting verification, never as done. Keep pending, failed, done, deferred,
needs-setup and invalid records distinct. No ready work with unresolved stories
means blocked or inconsistent, never complete. Diagnose dependency faults once,
preserve the blocker and work elsewhere; retry only after a relevant condition
changes. Do not reactivate deferred work to manufacture a fresh queue.

## 3. Start bounded workers with one owner per unit

Load `isolate` and `rule-agent-concurrency`. Before dispatch, record story,
worker, repository, base SHA, worktree, owned paths and return artifact. Record
it durably, not in the conversation: `scripts/mission-contract.js` turns the
story's acceptance criterion, verified repository identity and base SHA into an
immutable contract, and `scripts/mission-store.js` `admit` then `claim`
persist it under a fenced owner (both answer `--help`). The same story at the
same base yields the same contract; a changed criterion is refused under the
original event, so stale evidence cannot be carried forward by re-admitting. The
store records and fences; it starts nothing, delivers nothing and verifies
nothing, and every status it returns says `verified: false`. One
coordinator assigns this mission's work. A decision log is not a cross-machine
lease; inspect existing ownership, including `mission-store.js status`,
before a second dispatch.

Choose a channel that actually starts work:

- Use available native agents or workflows for bounded work in this mission.
  Assign an isolated worktree and verify the worker's actual cwd, origin and
  base before edits. Agents may inherit the parent's directory. For a worker
  that is a local Node script, `scripts/mission-dispatch.js start` is that
  boundary: it forks the worker in the contract root with no shell, waits for
  it to register with the store, reads back its pid, cwd and HEAD, and refuses
  a readback that disagrees with the contract; after a crash, `reconcile`
  reports prepared, terminal, live or unknown and never starts a second
  worker. Any other adapter answers `awaiting-start` and records nothing.
- Reuse an authorized existing worker through a channel that wakes it. Read
  back identity and started state once, then use completion events or bounded
  waits. A queued message is not an acknowledgment or a running process.
- Create desktop chips when the user requests separate tasks or that is the
  available transport. Keep them `awaiting-start` until started. A chip needing
  a click cannot satisfy unattended dispatch. If no autonomous channel exists,
  name that limitation instead of assuming execution or generating more chips.

Every brief stands alone: mission, acceptance, exact refs, evidence, ownership,
permitted actions, actual verification commands, artifact path and return
address. Explicitly LOAD required skills through the runtime's skill mechanism
or readable skill file; a bare word in a prompt is not proof it loaded. Require
small committed units and concise artifact pointers. Reserve independent review
for material risks; avoid nested fan-outs and duplicate assignments.

Workers implement with `auto` and the project's actual gate. Brain owns scope,
sequencing and acceptance. Product edits and conflicts belong to the assigned
worker; honor the coordinator write guard. Framework fixes can be separately
owned work. Do not take over another worker's uncommitted files.

## 4. Accept evidence and integrate

Read the commit and artifacts, not just the worker's summary. Load `prove`:
capture a defect before editing and compare the same observable afterwards.
For new behavior record that no earlier implementation existed.

Reconcile required hook verdicts and actual tool results with the worker's
lifecycle status. A native `completed` turn can follow a blocked hook with no
process error. Do not promote that lifecycle receipt into verified acceptance;
an unloaded item list is not evidence that no work occurred.

Execute acceptance through the actual interface. UI verification includes
internal/admin pages: drive the flow at supported desktop and mobile sizes,
inspect console/network errors, and verify resulting data and reload behavior.
A screenshot or HTTP 200 alone proves neither a mutation nor authorization.
Use an isolated account/environment for writes; unauthorized production tests
remain unresolved instead of being run or counted as passed.

Run the project's complete gate on the exact candidate commit. Confirm every
required stage ran, with real populations and preserved exit codes. An unrelated
success cannot excuse a skipped required job. Use `check-pr-ready.js` for PR
triage, not product acceptance or deployment permission. Re-run integration
checks after a rebase or changed base.

Load `review`, or `adversarial-loop` for harness/security/verification changes.
Fix findings or record disconfirming evidence. Freeze acceptance scope after the
audit pass and queue independent new scope. Repeated identical observations add
no evidence. A score is not a completion condition. Set `passes: true` only when
the story's acceptance evidence exists; subjective realness does not replace it.

## 5. Release and verify the live result

Load `commit` and `ship` under current authorization. Determine the action that
actually deploys: merging or pushing the default branch can change production.
Apply production conditions BEFORE that action. Inspect the platform target;
a preview command can assign a first production deployment.

Before promotion, record tested SHA/base, gate command/output, affected surfaces,
expected target, live verification plan and an executable rollback procedure.
Bind evidence to that candidate; regenerating a ledger must not transfer ticks
to changed code. A ledger is recorded assertions, not independent proof. Check
the candidate against the current base; resolve a platform that cannot deploy
the tested candidate before promotion. Afterwards read the platform's actual
SHA/environment and drive the promised live flows.

If live verification fails, stop later releases, preserve the failed attempt,
execute the authorized recovery procedure, and verify the recovered behavior.
A first deployment needs recovery that works without a previous version. For a
harness release, verify installed bytes and hook activation too; source tests do
not update running sessions.

## 6. Recover and hand over

Consume completion/failure events and inspect durable work. Stop hooks request
reports; they are not acknowledged message queues. Keep dispatch records until
results are acknowledged: after a restart, `mission-store.js status` returns
the mission's attempts, results, launches and outbox as recorded, and a replayed
event returns its first answer instead of acting twice. A cooldown, crash or
first Stop may emit no report. A worker's result lives in the store's outbox
from the moment it enqueued it; `scripts/mission-deliver.js deliver` consumes
it once, recovers a lost acknowledgement without a second send, reports an
exhausted send budget instead of retrying, and `status` keeps sent, received,
quarantined, rejected and accepted apart. `accept` records only that the
envelope matches the contract; it is not verification.
Before retrying, inspect commits, the working tree and journal: a timed-out
worker may still be running. Never kill by command pattern or spawn blindly.

Use `workflow-run-triage.js`, then the existing workflow's resume mechanism for
unfinished calls. A redispatch proposal is not a restart. Quota exhaustion needs
a supported scheduler/reset event to run later; a Stop hook cannot wake a dead
process. Record the recovery command if no automatic mechanism exists. Promise
monitoring only after an authorized monitor is installed and verified.

For a stalled item record the hypothesis, last meaningful evidence and next
experiment. Continue independent stories and keep failed work unresolved. At
handoff run `session-exit.js` for your own tree, reconcile the backlog, and write
the RESUME.md fields it cannot measure. The six fields are goal, current state,
files in flight, changes made, failed attempts with why each failed, and next
steps. Changes made carries commits, exact validation and deployed URLs; failed
attempts carries every approach that did not work, so a successor does not retry
it; next steps carries unresolved work and its owners.
Artifact URLs belong in the durable repo record. Report completion only at the
verified boundary; otherwise state exactly what remains.
