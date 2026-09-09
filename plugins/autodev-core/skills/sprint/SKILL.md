---
name: sprint
description: Creates or advances sprints in prd.json. Use when starting new work cycles or closing completed sprints.
when_to_use: "Invoked when the user says \"sprint\"."
allowed-tools: Bash, Read, Write, Edit
model: opus
user-invocable: true
argument-hint: "[new|advance|close]"
---

# Sprint

Create a new sprint or advance to the next one.

## Usage

- `sprint [description]` - Create new sprint from feature description
- `sprint next` - Advance to next sprint from roadmap

## Creating from Description

1. Read the current request, SPEC.md and existing PRD. Preserve the established
   story/container schema and existing IDs. When the request includes building,
   the plan is an intermediate artifact, not the terminal deliverable.
2. Create the smallest useful set of stories directly in prd.json using `core`.
   Each names its actor/trigger, observable outcome, acceptance checks,
   verification method, priority and relevant files. Use `blockedBy` for real
   dependencies and `needs-setup` with a reason for external requirements.
3. Run the shared `workPlan(prd)` from core across all sprints. Resolve missing
   or malformed dependency IDs and cycles before selecting work. A native task
   tool may mirror the queue only if the current host exposes it; it is not the
   authoritative writer or a prerequisite for creating the sprint.
4. Report the scope and ready/blocked counts. Continue with `auto` when building
   is already authorized. A request only to plan ends with the reviewable plan.

## Advancing (sprint next)

1. Read the shared work plan and verification records for the existing stories.
2. Close a sprint only when its acceptance evidence is complete. Neither an
   old sprint flag nor lack of ready work overrides unresolved story states.
   Keep pending, failed, setup-blocked and invalid records visible; preserve
   deferred decisions rather than silently reactivating them.
3. Select the next unscheduled roadmap outcome within the mandate. Independent
   new work may proceed while an older sprint is blocked, but that older sprint
   remains incomplete and its stories remain readable by the shared planner.
4. Add the new sprint without dropping earlier stories or changing their IDs.
   Verify dependency readiness, then continue authorized execution.

## Auto-Archive Check

Use `archive-prd` when completed history makes the PRD unwieldy. Inspect real
file bytes/lines and the story population instead of counting commas as lines.
Only eligible completed records may move, regardless of sprint age. Keep passed
prerequisites that retained stories still reference, since the task planner reads
active PRD records rather than resolving dependency IDs out of archives.

Run the archive split/durability checks before deleting anything from the PRD.
A blocked sprint may have completed records worth archiving, but must not be
reported as completed merely because its only remaining work needs setup.

## Rules
- HARD CAP: 20 stories per sprint
- Stories must be detailed enough to implement without guessing
- Every story must be testable
- If user asks to expand a plan, produce the concrete stories; when implementation
  is already authorized, continue into the ready work instead of re-offering it.
