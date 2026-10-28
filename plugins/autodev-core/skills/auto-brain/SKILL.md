---
name: auto-brain
description: Run Brain's assigned mission while the user is away. Use when asked to coordinate the fleet autonomously, carrying work through implementation, verification and the authorized release boundary.
when_to_use: "Invoked when the user says \"auto-brain\", \"run the fleet while I am away\", or delegates unattended coordination."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, Agent, Workflow, AskUserQuestion, SendMessage, Monitor, mcp__ccd_session_mgmt__send_message, mcp__ccd_session_mgmt__list_sessions, mcp__ccd_session_mgmt__get_session, mcp__ccd_session__spawn_task
model: opus
user-invocable: true
---

# Auto Brain

Load [Brain](../brain/SKILL.md) and execute its full delivery procedure. Scope,
dispatch, verification, release and recovery have one procedure. Being away
changes the user's availability, not the meaning of completion.

Read the assigned scope and any declared away window. Decide reversible details
and record reasons. Preserve existing authorization instead of asking again.
When one item requires unavailable intent, credentials or permission, preserve
its blocker and owner and continue independent work. Do not invent the answer.

Register the mission queue before the first dispatch (Brain section 2,
`scripts/mission-queue.js`). Nobody is there to restart a turn that ends early,
so a failed command is retried or recorded as blocked, never a reason to stop.

Start workers through an available autonomous channel and verify they started.
A chip awaiting a click remains `awaiting-start`; a proposed restart remains
`awaiting-restart`. Neither is execution. Persist work and recovery instructions
before quota/process loss. Promise a later wake-up only when an authorized
scheduler is installed and verified.

Before unattended edits, verify the worker's effective filesystem boundary and
required controls through Brain's host-admission procedure. A hook payload may
omit the tool's requested working directory; its thread cwd cannot establish
where a command will write. Keep reservations through uncertain worker exits,
and require operation/acceptance evidence beyond native turn completion.

When the user says they are away, asleep, or wants no panels, declare it before
the next tool call: write the AWAY file `scripts/away-state.js` reads, with an
`until:` line and their words. From then until it expires, nothing asks the
user. No panel, no wrap_up `ask`, `actions` or `blocked`, no question in
closing text, and no `start_session` other than an `own_initiative` card: a
start waits for a click. Start workers on the headless channel instead. The
`panel-recommendation` hook holds all of these, and in every other session it
routes the held question to Brain, which manages every session meanwhile.
Decide reversible choices, log them, record irreducible ones as blocked, and
end each turn with a recap. Never deny the question tool in settings: workers
route their questions to Brain through it. Confirm role and return-address validity before workers rely on the coordinator.
Report meaningful completions, failures and required user actions according to
the user's notification preferences.

Historical notes are not shipped with the plugin. They live in the autodev
repository at `docs/history-auto-brain-2026-09-09.md`, for investigating an earlier
incident only. They are not an alternative operating procedure.
