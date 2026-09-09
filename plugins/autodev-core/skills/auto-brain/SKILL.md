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

Keep the question channel available. An away window may route reversible
choices to Brain; denying the question tool removes the escalation route.
Confirm role and return-address validity before workers rely on the coordinator.
Report meaningful completions, failures and required user actions according to
the user's notification preferences.

Read [historical notes](references/history-2026-09-09.md) only to investigate an
earlier incident. They are not an alternative operating procedure.
