# A coordinator has nobody to wake it and no one to stop for

Loaded from `brain` step 6 when the context grows deep, before any self-clear,
and whenever the inbox is empty. Both halves of an ordinary worker's ending
(hand over, then stop) assume something above you. Neither is true in this
seat, and each cost a measured outage on 2026-09-11.

## Contents

- Compact in place
- A self-clear does not shed context
- With an empty inbox, drive

## Compact in place

**Approaching the context limit, compact in place. Do not stop, and do not spawn
a successor.** The instruction elsewhere in this workflow (finish the step, write
the handoff, tell whoever is coordinating, and stop) is a no-op when the Brain IS
the coordinator: there is nobody to tell and nobody to resume the work. One Brain
announced stopping about six times between 300k and 706k and never handed over,
so its sessions kept working with nothing to integrate what they finished. The
fix that followed was a successor spawned as a chip, and a chip needs a person to
click it. `[measured 2026-09-22]` 23 Brains in 27 hours meant 22 hand-overs, each one
waiting on a click.

So the Brain keeps its seat and sheds the context instead. With an auto-compact
window configured (`autoCompactWindow` in settings, recommended 320k in
`docs/recommended-settings.json`), the context-depth Stop hook holds your Stop
once at the 250k soft line. When it does, finish the unit you are in, refresh the
handoff with `session-exit.js --out` at the path the hook names, re-point its
START HERE, and end the turn. Compaction lands after the state is on disk, and
the SessionStart that follows it names the handoff and the fleet ledger
(`unattended-worker.js status`) to re-read. Keep your address and your role
record: the session id survives a compaction, so `~/.claude/brain-role.json`
stays claimed. Compaction is a remedy for CONTEXT DEPTH, not the answer to an
empty inbox, and filing it as both is how that outage was first misdiagnosed.

`[measured 2026-10-25]` Desktop sessions compact at the configured window: 150
compactions in six days of one machine's transcripts with `autoCompactWindow`
300000, the Brain among them. A Stop can read a depth past the window before
the next request compacts, so the hook still says compaction follows there. A
worker that claims it "can't compact" keeps working: it writes its handoff at a
natural break and never stops or asks for a fresh session over context depth.
The continuation chip is only for a host with no window configured.

## A self-clear does not shed context

Only a fresh session or a compaction does. `[measured 2026-09-16]` One
interactive Brain (claude-opus-5, bypass permissions) issued the
session-management self-clear (`clear_session` with `session_id: "self"`) eight
times between 364k and 557k tokens of context. The first call was refused
because a user message was queued behind the turn; the other seven answered that
the conversation would be cleared when the turn ended. After each accepted clear
the process restarted (new pid, SessionStart hooks re-ran, `peer_name` reset to
the session title), the session id stayed the same, and the next turn read the
whole transcript again: 364,478 tokens after the first clear, 557,606 after the
last, never fewer than before. The only drop in that session was the harness's
own automatic compaction, at 967,210 tokens down to 29,546, after which the
queue survived only as far as the compaction summary carried it. Measured by
summing `input_tokens`, `cache_read_input_tokens` and
`cache_creation_input_tokens` per assistant turn in the session's transcript
under `~/.claude/projects/`; re-measure the same way after a harness change
before trusting a different result.

So at the context line, do not reach for `mcp__ccd_session_mgmt__clear_session`
expecting relief. Write and mirror the handoff, re-point its START HERE, and let
the compaction above shed the context. If the clear is issued anyway, re-stamp
`peer_name` in the role record afterwards, because `check-brain-role.js --json`
reads `degraded` (dead peer) until then, and issue it only when nothing is
inbound: a queued user message, peer message or task notification drops it.

## With an empty inbox, drive

**Fan the work out to background agents from this session.** Reporting and
waiting for an inbound peer message is not coordination; it makes the
coordinator idle exactly when its sessions go quiet to run long gates. The same
Brain merged 15 PRs in the 4h15m it had traffic, then 0 in the next 4h53m,
because every turn ended by waiting to be spoken to. Work needing no message to
arrive first: rebasing stale PRs, sequencing a stack, re-measuring a board whose
base has moved, chasing a blocked session.

**A task chip is not this mechanism**: step 3 already rules a chip out for
unattended dispatch, and an empty inbox overnight is that case exactly. One
raised then sits unclicked until morning. Background agents started from your
own session, and unattended workers started with `unattended-worker.js`, run
without anyone clicking, and you keep coordinating while they do. A
self-scheduled wake is not it either: waking to an empty inbox and reporting
again repeats the failure on a timer. The one exception is polling a board: a
dynamic `/loop` that wakes every 300 to 1800 s, reads the board and dispatches
what it finds is a poll, not a driver. The work it finds still runs in
background agents or unattended workers.
