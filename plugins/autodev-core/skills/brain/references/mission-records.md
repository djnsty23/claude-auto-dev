# Mission records: plan, queue, contract, store, delivery

Loaded from `brain` steps 2, 3 and 6, whenever a mission is planned, dispatched
or recovered through the scripts below. Every script answers `--help`.

## Contents

- Planning ready work
- A mission with no prd.json
- Contract and store
- The local-node dispatcher
- Delivery and recovery

## Planning ready work

Use `workPlan(prd)` from `scripts/prd-states.js` for dependency-ready work from
all sprints, as Auto and its Stop hook do. For missions recorded in the store,
`scripts/mission-supervisor.js tick` is one bounded pass over that plan: it
settles claimed missions (reconcile, deliver, accept the envelope or fail the
attempt with the store's retry codes), starts what is ready or past its
backoff through the dispatcher, admits each mission in its own worktree with
`--worktrees`, and reports exhausted, blocked and invalid work by name. It
never loops, never writes `prd.json`, and reports an accepted envelope as
awaiting verification, never as done.

## A mission with no prd.json

A mission with no `prd.json` registers its queue so the Stop hook can hold it:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/mission-queue.js" start --mission "<goal>"`, then
`add <id> <title>` per item. Move items as they change: `set <id> inflight` once a
worker or wakeup will bring you back, `blocked --note "<who>"` for a person,
`done` or `dropped` with the evidence. The Stop hook blocks while any item is
`pending`. A failed command leaves its item pending: retry it, or record the
blocker. `stalled --minutes 60` lists missions stopped with pending work.

## Contract and store

Record the dispatch durably, not in the conversation:
`scripts/mission-contract.js` turns the story's acceptance criterion, verified
repository identity and base SHA into an immutable contract, and
`scripts/mission-store.js` `admit` then `claim` persist it under a fenced owner.
The same story at the same base yields the same contract; a changed criterion is
refused under the original event, so stale evidence cannot be carried forward by
re-admitting. The store records and fences; it starts nothing, delivers nothing
and verifies nothing, and every status it returns says `verified: false`. A
decision log is not a cross-machine lease; inspect existing ownership, including
`mission-store.js status`, before a second dispatch.

## The local-node dispatcher

For a worker that is a local Node script, `scripts/mission-dispatch.js start` is
the start boundary: it forks the worker in the contract root with no shell,
waits for it to register with the store, reads back its pid, cwd and HEAD, and
refuses a readback that disagrees with the contract. After a crash, `reconcile`
reports prepared, terminal, live or unknown and never starts a second worker.
Any other adapter answers `awaiting-start` and records nothing.

## Delivery and recovery

Keep dispatch records until results are acknowledged: after a restart,
`mission-store.js status` returns the mission's attempts, results, launches and
outbox as recorded, and a replayed event returns its first answer instead of
acting twice. A worker's result lives in the store's outbox from the moment it
enqueued it; `scripts/mission-deliver.js deliver` consumes it once, recovers a
lost acknowledgement without a second send, reports an exhausted send budget
instead of retrying, and `status` keeps sent, received, quarantined, rejected
and accepted apart. `accept` records only that the envelope matches the
contract; it is not verification.
