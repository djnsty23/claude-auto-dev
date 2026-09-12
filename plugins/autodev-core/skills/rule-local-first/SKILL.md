---
name: rule-local-first
description: "Verification happens on this machine, in a browser you drive, before anything is pushed. Covers the local gate, the batched publish cadence, why GitHub Actions is not the gate, and why a restored browser session fakes a pass. Load before verifying, before pushing, and before any visual check."
when_to_use: "Before verifying, pushing, or calling any work done."
user-invocable: false
allowed-tools: Read, Grep, Glob, Bash, mcp__Claude_Browser__*
paths:
  - "**/*.workflow.js"
  - "**/.claude/launch.json"
  - "**/PUBLISH-QUEUE.md"
---

# Verify locally, then verify the requested delivery boundary

Run the relevant checks against the candidate on an identified environment.
A remote CI result complements the local evidence when the project uses CI; it
does not replace observing the behavior the user requested. Likewise, local
success alone does not establish that a later deployed artifact works.

The current request and project policy determine publication, CI and batching.
Read [historical notes](references/history-2026-09-09.md) only for earlier
incidents. Their operator quotes, disabled schedulers and host-specific tool
limits are not a present grant, prohibition or capability inventory.

## Execute the actual gate

Discover the project's package manager and real gate command. Use its full
verification chain, preserving each process's exit status and complete failure
output. If there is no aggregate gate, run and record the necessary commands
explicitly; use `preflight` to consolidate them when that change is in scope.
Do not assume every repository uses npm, typecheck or a particular script name.

For final delivery, commit the owned changes and run the full gate on that exact
clean candidate. Do not edit tracked files while a mutation/check suite is
running. A later edit or base integration invalidates the earlier full-candidate
result. If a chained stage fails, name the stages that did not run and execute
them separately when useful; their results do not turn the failed chain green.

## Launch an owned candidate

For UI work, use the host's available supervised preview/browser capability.
When `preview_start` exists, inspect the launch configuration and its working
directory. Otherwise use a supported owned server process with recorded PID,
cwd, port and cleanup. A Bash background process is acceptable only when its
lifecycle is actually managed.

Confirm the server serves this repository and candidate before testing it.
An HTTP response on the first open port proves reachability only. Read back a
build marker or another verifiable candidate identity. A production URL without
matching deployment identity is evidence about production, not a local change.
Stop only processes this task owns.

## Exercise the real flow

Use the current browser driver's actual API. Record a nonzero viewport and the
dimensions relevant to the surface, then interact through the rendered controls.
Inspect console/network errors and relevant persisted state. Capture useful
screenshots for visual changes. An unavailable browser or screenshot capability
is an explicit verification gap, not a reason to substitute a source read and
claim a visual pass.

Admin/internal UI has users too. Verify its affected workflows and permission
states. Server-only changes need their real API/data boundary checks; they do
not automatically need a browser.

Check the effective interaction region, including pseudo-elements and overlays,
before interpreting a small element rectangle as a broken touch target. Record
the tested population and representative behavior, not a bare count.

## Establish the intended user state

Use an owned test profile/account or supported isolated context for first-contact
flows such as signup, consent, onboarding and sign-in. Verify that the required
state is fresh. Clearing JavaScript-visible cookies does not prove an HttpOnly
session or another origin was cleared.

Do not reset a shared personal browser profile incidentally. Reuse an existing
authorized session for ordinary feature checks when appropriate; disclose the
state. Suppress onboarding only when it is deliberately outside the scenario,
and verify onboarding separately when it is part of acceptance.

## Publish within the existing mandate

Default to a verified local commit unless the current request/project mandate
includes publication. Preserve a still-valid grant across turns; do not ask
again merely because a skill boundary or turn changed. A queue age or historical
operator quote does not authorize a new destination or effect.

Resolve whether push/merge triggers deployment before acting. Follow `ship` for
the intended release, with fresh whole-batch evidence, deployed artifact
identity, relevant live flow and recovery. Keep the shared publish queue in
tracked `PUBLISH-QUEUE.md` when the project uses it. A configured batching policy
does not imply an empty queue should publish.

A backup mirror is a separate authorized scope, not a universal exception that
lets any repository push. Read its actual configuration and result before
claiming an automatic backup exists.
