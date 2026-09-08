---
name: iterate
description: Convergence loop — brainstorm, fix, re-scan until the codebase is clean. Combines brainstorm→apply→auto in one command.
when_to_use: "Invoked when the user says \"iterate\", \"deep work\", \"converge\"."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebSearch, Agent, SendMessage
model: opus
user-invocable: true
argument-hint: "[focus area or max rounds]"
---

# Iterate — Convergence Loop

Autonomous scan→fix→verify cycle within the requested scope. It ends when the
agreed acceptance checks pass with no unresolved in-scope actionable findings,
or when its budget/round limit is reached. A limit means partial work with a
continuation record, not “clean.” Finding counts and ratings describe progress;
they are not completion criteria.

## Entry

Load `auto` for its current entry/exit and task-state protocol, plus
`rule-agent-concurrency` before any dispatch. Identify the revision, scope,
acceptance criteria and verification baseline. Preserve existing authorization;
feature ideas outside that scope remain proposals. Diagnose an existing red
baseline and keep independent checks moving.

## Round Execution

1. **Scan the scope.** Use `audit` for defects and `brainstorm` for requested
   product/architecture ideas. Choose relevant perspectives and use supported
   tools within the available budget; do not assume five parallel agents.
2. **Validate findings.** Reproduce candidates and check known-good controls.
   Deduplicate by root cause and observable behavior, not just file/title.
   Unexecuted checks or an unexpectedly empty target population are gaps. A
   successfully executed scan with zero findings is valid within its measured
   scope. More findings can mean better coverage;
   compare rounds only when scopes and methods are comparable.
3. **Persist and fix.** Record accepted work in `prd.json` using `core`, then
   follow `auto` for dependency-ready work. Do not reactivate deferred work or
   spin on `needs-setup`; name the concrete blocker and continue ready tasks.
4. **Verify each change.** Follow `rule-verification` and `prove`, including
   relevant live flows/states and the actual entry points. Small inline fixes
   still require verification; “one or two low findings” is not an exit waiver.
5. **Check completion.** Re-scan the changed and adjacent risk surfaces and run
   applicable acceptance/gate checks on the current revision. If findings remain,
   continue within the budget. If the limit is reached, checkpoint exact work
   and gaps for continuation.

## Round Limit

Default: 4 rounds. Override with argument:
- `iterate 2` — max 2 rounds (quick pass)
- `iterate 6` — max 6 rounds (thorough)

## Focus Mode

`iterate auth` — only scan and fix auth-related files
`iterate perf` — only scan and fix performance issues
`iterate design` — only scan design quality and visual issues

In focus mode, scans are limited to the specified area and its affected callers.

## Convergence Report

After exiting the loop:

Report the tested revision/environment, rounds used, confirmed findings fixed,
remaining actionable work, explicit deferred decisions, blocked checks and
evidence paths. Say whether acceptance criteria passed or the run merely hit
its limit. Any /10 rating needs a stated rubric, evidence and unknowns; it does
not substitute for the final gate or live verification.

## Rules

- Preserve unresolved findings and deduplicate without discarding distinct defects.
- Use `auto`’s actual entry/exit mechanism, including on budget or error exit; do
  not invent flag manipulation that can strand or prematurely release the loop.
- Commit reviewable progress at the project’s cadence and coordinate a frozen
  tree for a gate that grades committed code. Never edit that tree while it runs.
- If a change breaks the build, repair or safely revert the owned change before
  proceeding; attribute pre-existing/infrastructure failures rather than hiding them.
- Verify affected UI flows after each meaningful change, not only the final round.

## Feeding the learning loop

**Threshold — record it when an iteration undoes an earlier one.** Oscillation is
the signal this skill is uniquely placed to see and the only one worth storing.

Two changes that reverse each other mean the requirement was never settled, and
the third pass will cost as much as the first two. Write down what the two
positions were and which constraint decides between them — that constraint is the
thing nobody wrote down the first time.
