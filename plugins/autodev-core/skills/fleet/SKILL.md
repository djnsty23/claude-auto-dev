---
name: fleet
description: Shows every Claude Code session on this machine and which ones are blocked on an unanswered question. Use when asked what other sessions are doing, which are waiting, or to open the fleet board.
when_to_use: "Invoked when the user says \"fleet\", asks which sessions are waiting or blocked, or asks to open the session board."
allowed-tools: Bash
user-invocable: true
---

# Fleet

One view of every session on this machine, and the unanswered question each
blocked one is sitting on.

## The common case — just answer the question

Most of the time the user wants the answer, not a browser. Run:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/fleet-status.js" --pending
```

That prints only the blocked sessions with their questions and options, plus the
population it scanned. **Report the population line.** A bare "nothing is
blocked" is indistinguishable from a probe that read nothing.

For the whole fleet, drop `--pending`. `--days N` widens the window (default 2).

## The board

For a live view that refreshes off disk every 15 seconds:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/fleet-board.js"
```

Serves `http://127.0.0.1:7717` on loopback only. Blocked sessions sort first and
expand to show their question inline.

## Notifications

A pending panel is perishable — measured, panels were answered inside fifteen
minutes — so a board you must remember to open misses the window it exists for.
To be tapped instead:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/fleet-notify.js" --watch 120
```

Fires once per panel, not per scan. `--dry` prints what would fire without
notifying; `--test` sends one sample toast.

To run it permanently, `install-fleet-notify-task.ps1` registers a scheduled task
(every 2 min, interactive, hidden). Check it is doing the WORK, not merely
launching — Task Scheduler's "Last Result: 0" only means the launcher started:

```bash
cat "$USERPROFILE/.claude/fleet/.notify-last-run.json"
```

**It waits 15 minutes before notifying, and that number is measured.** Across 606
panels over 7 days the median panel is answered in 2.2 minutes and 47% inside 2
minutes, so notifying on sight would fire ~46 times a day with a worst hour of
24. At a 15-minute floor it is ~11 a day and no hour exceeds 6. Change it with
`--min-age N`, but re-measure rather than guessing.

## Other machines

The MESSAGING registry is machine-local: peers talk over a socket on one host,
so this board covers ONE host unless another machine publishes. Check what has:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/fleet-publish.js" --read
```

Publishing is **counts only** — no titles, branches, paths or panel text —
because `claude-auto-dev` is public and the fleet contains client work. Do not
widen the payload; a test derives its forbidden strings from the live fleet and
will fail rather than leak. `--push` sends it immediately when the counts change
(it holds when they have not, which is what makes it safe on a timer);
without it the file waits for ClaudeMemorySync's ~4h push.

Setting up a second machine: `docs/fleet-cross-machine.md`.

**`ListAgents` is no longer strictly one host, and the difference matters before
you conclude a peer is unreachable.** Since Claude Code 2.1.225 it also lists
Remote Control sessions on other machines and cloud sessions, each row labelled
by kind, when Remote Control is connected here. `[measured 2026-08-30]` a send
to a local peer returned "another Claude session on this machine; it is also
connected via Remote Control", so the cross-machine rows are visible from an
ordinary session. What was NOT verified here is an actual cross-machine
delivery, only that the mechanism and the labelling exist. Treat the git remote
as the reliable cross-machine channel and `ListAgents` as the thing that tells
you whether a direct reply is even possible.

**`SendMessage` success is acceptance by the transport, not delivery evidence.**
`crossSessionInbound` (2.1.224) governs whether an incoming peer message is
delivered or held. `[measured 2026-09-01]` a bypass-permissions sender reported
`success: true` and "sent" while accept-edits recipients held the message for
manual review. Matching permission-mode classes delivered it; disabling
telemetry made no difference. Re-run `ListAgents` immediately before sending,
use the full `name [ref]` when names collide, and confirm receipt from the target
transcript, reply, or resulting branch state before claiming delivery. A queued,
sent, or successful sender result alone is not confirmation.

Stale refs are worse than an offline error: `[measured 2026-09-01]` after one of
two same-named sessions stopped, a send to its old full ref returned success but
arrived in the surviving session. If a fresh `ListAgents` read no longer contains
the exact ref, do not send. Pull the target transcript when local, or use the git
remote and current branch evidence as the reliable fallback.

**Every remote figure must be shown with its age.** It rides a periodic git push,
not a live connection, so a synced count read as current is the failure mode.

## What to tell the user, and what not to

**Never offer to answer a blocked session's question for them.** Measured
2026-08-21: `send_message` reaches an idle session in ~20 seconds and does not
reach a busy one at all — over 482 seconds and 166KB of transcript growth it
never arrived. An AskUserQuestion panel does not end a turn, so a session cycling
through panels may never reach the boundary where queued mail is delivered.

The sessions most worth answering are exactly the ones that cannot receive an
answer. Tell the user **which session to go to**. If a row says "not addressable"
it has no desktop record and cannot be messaged even when idle.

## States

| State | Means |
|---|---|
| `blocked` | an unanswered panel. Proven by the transcript, not inferred. |
| `working` | the transcript grew in the last 3 minutes. |
| `stalled` | a turn started and never ended, or the user spoke last and nothing followed — **and** the session is reachable and quiet for 15–240 minutes. The one worth surfacing. |
| `done` | merged PR, quiet an hour. |
| `waiting` | it spoke last and stopped. The normal resting state. |
| `cold` | quiet for a day or more. Most of the fleet, and deliberately the quietest. |

`classify()` in `fleet-status.js` holds these, tuned against the real
distribution (124 sessions over 7 days) rather than guessed.

**Why `stalled` carries two extra conditions.** Unbounded, it flagged 15 sessions
— every one idle between 10 hours and 5 days, none with a desktop record, so none
reachable. Those are finished, not stuck. And the threshold was inert: 14 matched
at `>=5m` and the same 14 at `>=60m`, so the number was decorative. Bounding it to
240 minutes and requiring an addressable id took it to 1. If you loosen it, check
the distribution again rather than the verdict.
