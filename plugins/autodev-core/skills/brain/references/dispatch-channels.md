# Dispatch channels and queued briefs

Loaded from `brain` step 3 before starting any worker: how each channel starts
work, what an unattended session cannot do, and what a queued brief carries.

## Contents

- Channels that actually start work
- What an unattended worker cannot do
- A queued task must be able to finish whole

## Channels that actually start work

- **Native agents or workflows** for bounded work in this mission. Assign an
  isolated worktree at `<repo>/.claude/worktrees/<name>`, and name that path in
  the brief: a brief that says only "a new worktree" gets one beside the repo.
  Verify the worker's actual cwd, origin and base before edits. Agents may
  inherit the parent's directory. A local Node worker starts through
  `scripts/mission-dispatch.js start` ([mission-records.md](mission-records.md)).
- **An authorized existing worker**, through a channel that wakes it. Read back
  identity and started state once, then use completion events or bounded waits.
  A queued message is not an acknowledgment or a running process.
- **Desktop chips** when the user requests separate tasks or that is the
  available transport. Keep them `awaiting-start` until started. A chip needing
  a click cannot satisfy unattended dispatch. If no autonomous channel exists,
  name that limitation instead of assuming execution or generating more chips.
- **A separate unattended session**, where the desktop scheduler exists, with
  `scripts/unattended-worker.js`. Its `brief` refuses a slug already claimed and
  prints `create_scheduled_task` arguments whose prompt opens with `git worktree
  add`, because the run opens in the coordinator's shared origin checkout. Call
  `mcp__scheduled-tasks__create_scheduled_task` with them (no schedule), then
  `mcp__scheduled-tasks__run_scheduled_task`, then `record` the returned session
  id. `[measured 2026-09-22]` it starts a Desktop session in 4.3 s and asks
  nobody. Deleting the task archives its session, so run `settle` with the run's
  status from `mcp__scheduled-tasks__list_task_runs`; call
  `mcp__scheduled-tasks__delete_scheduled_task` only when it answers
  `deleteSafe: true`, then `deleted`. A `started` record is a session id, not
  proof that STEP 0 passed: read the session's events.
- **The Brain clock queue**, for work that starts with no session open:
  `unattended-worker.js enqueue --repo <path> --slug <slug> --brief-file <file>
  --return <address> [--after <taskId>]`. Enqueue refuses a brief with no
  acceptance criteria the receipt gate can run, under a heading that reads
  `Acceptance criteria` (a bare `## Acceptance` is read as none):

  ```
  ## Acceptance criteria
  - AC1: the touched suite passes
    check: node tooling/test-x.js
    expect: /0 failed/
  ```

  `check:` runs through a shell from the worktree, which is cmd.exe on
  Windows, so use node one-liners or direct suite commands, not `tail` or
  `$VAR`. `--without-criteria "<reason>"` queues a brief that cannot name a
  fixed command, and its accept then needs `--accept-without-receipt`. The clock's `judge` capability runs
  `scripts/brain-judge.js tick` every pass. It closes a finished headless run,
  judges it (accept, follow-up or escalate) with a tool-less `claude -p`, and
  starts ready work through `unattended-worker.js launch`: at most 2 running,
  2 launched an hour, 6 judge runs an hour. A task with `--after` starts only
  once each dependency is closed as succeeded with an `accept` or `follow-up`
  verdict. `brain-judge.js switch --judge <mode> --start <mode>` is the kill
  switch, with modes off, dry and live. A step is live only when the switch
  says live AND the clock pass is live, and no switch file means dry. Three
  failed clock passes stop judging and starting. When you read a closed
  record yourself, write your call with `unattended-worker.js verdict
  --task-id <id> --decision <d> --reason <why> --by brain`: a judge never
  overwrites it, and `brain-judge.js compare` grades the judge against it.
- **A scheduled unslop sweep** for each product with a user-facing surface
  (weekly, and after a batch of UI merges): write the brief with
  `unslop-sweep.js brief --repo <path> --base http://localhost:<port> --return <address>`
  to a file, then queue it with `unattended-worker.js enqueue --slug unslop-<product>
  --without-criteria "unslop: the compare verdict is in the report"`, since its outputs are dated.
  The worker runs the `unslop` skill locally, writes component stories, fixes
  them through `auto`, and returns the compare verdict and before/after counts.

## What an unattended worker cannot do

- It is unattended. No one answers a panel, and it runs on its brief alone.
- It cannot receive `mcp__ccd_session_mgmt__send_message`, so a mid-run
  correction never arrives. Put everything in the brief, and name a report file
  as its return channel.
- It cannot be cleared from outside, and it cannot call `run_scheduled_task`
  itself, so a worker never dispatches a worker. Fan-out stays with you.
- It starts in your origin checkout, and the tool takes no cwd. The STEP 0 that
  `brief` writes (`git worktree add`, then `cd` on every command) is the only
  thing keeping it out of the shared tree. STEP 0 also links the worktree's
  node_modules to the main checkout's (`shared-install.js link`). A chip or
  any other brief you write by hand carries the same line after its
  `git worktree add`: `node "$(printf '%s\n' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/autodev-core/*/scripts/shared-install.js | sort -V | tail -1)" link .`

## A queued task must be able to finish whole

The judge accepts a run only when nothing is left but your landing step: a
gated, committed branch the brief told the worker to leave for you counts as
done. A run that ends ungated, red or on an owner's pick is a follow-up or an
escalation, correctly. So every brief you queue with `unattended-worker.js
enqueue` carries two things:

- **Its acceptance test, by name.** Name a command that exists at the base SHA,
  or one the brief tells the worker to write first, and the exact line or exit
  code that means done (`node tooling/test-x.js` prints `x: 9/9 checks passed`).
  "Make it work" or "tests pass" names no test. A worker that has to guess its
  endpoint is the run that comes back as a follow-up.
- **A gated commit from the worker, and the landing by you.** A headless builder
  may not push or write through `gh` (`worker-authority.js`). The worker rebases
  onto `origin/main`, commits on its branch, runs the repository's merge-bar gate
  under its receipt wrapper, and stops. Its report gives the head SHA and the
  receipt path. Once the record is `closed`, you land it: `git -C <worktree> push
  -u origin claude/<slug>`, `gh pr create`, then `merge-lock.js merge --pr <n>
  --head <sha> --gate-receipt <file>`. The coordinator write guard allows that
  one push, of a closed record's branch from its worktree, and blocks every other
  product write of yours (docs/decisions.md, 2026-10-25). A moved base makes
  merge-lock refuse: queue a follow-up to rebase and re-gate. This is a DECIDE in
  the decision policy for the owner's own repositories, so it needs no panel.
  Where the policy says ASK (payments, client repositories, a production write),
  the task is not queueable as one unit: split the part that can land from the
  decision, and raise the decision yourself.

Leave a task out of the queue, rather than choosing a smaller one, when it cannot
meet both. A run that is trivial so that it gets accepted inflates the delivery
window it is graded by and proves nothing.
