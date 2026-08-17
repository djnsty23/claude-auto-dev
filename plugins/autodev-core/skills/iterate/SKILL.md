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

Autonomous brainstorm→fix→re-scan cycle. Runs until the codebase converges (no more findings) or hits the round limit.

## How It Works

```
iterate
  |-- Round 1: brainstorm (5 parallel scans) → apply → auto (fix all)
  |-- Round 2: brainstorm (re-scan) → apply → auto (fix remaining)
  |-- Round 3: brainstorm (re-scan) → 0-2 findings → done
  |
  +-- Converged: "Codebase clean after N rounds."
```

Typical convergence: 3-4 rounds. Each round finds fewer issues as the codebase improves.

## Entry

1. Set auto-active flag (same as auto mode)
2. Check pre-flight: build passes, prd.json archived if needed
3. Start Round 1

## Round Execution

Each round follows this sequence:

### Step 1: Brainstorm (scan)

Run the full brainstorm Phase 1 scan (5 parallel agents: dead code, errors, complexity, deps, live QA).

### Step 2: Evaluate findings

Count findings by priority:
- If **0 findings** → converged, exit loop
- If **1-2 low-priority** findings → fix inline without creating stories, then exit
- If **3+ findings** → continue to Step 3

### Step 3: Apply (create stories)

Write findings to prd.json as stories (brainstorm apply). Deduplicate against existing stories.

### Step 4: Auto (execute)

Work through all pending stories using the auto execution flow:
- Context loading → implement → typecheck → build → visual verification → mark complete
- Commit every 3 tasks

### Step 5: Check round limit

- If rounds < max (default 4) → start next round
- If rounds >= max → exit with summary

## Round Limit

Default: 4 rounds. Override with argument:
- `iterate 2` — max 2 rounds (quick pass)
- `iterate 6` — max 6 rounds (thorough)

## Focus Mode

`iterate auth` — only scan and fix auth-related files
`iterate perf` — only scan and fix performance issues
`iterate design` — only scan design quality and visual issues

In focus mode, brainstorm scans are limited to the specified area.

## Convergence Report

After exiting the loop:

```
Iterate Complete
════════════════

Rounds: 3 (converged)
Total findings: 18 (round 1: 10, round 2: 6, round 3: 2)
Total fixed: 16
Remaining: 2 (low priority, deferred)

By category:
- Dead code: 4 found, 4 fixed
- Quality: 5 found, 5 fixed
- Performance: 3 found, 3 fixed
- Visual/Design: 2 found, 2 fixed
- A11y: 2 found, 2 fixed
- Features: 2 found, 0 fixed (deferred)

Codebase health: improved from [initial assessment] to [final assessment]
```

## Rules

- Each round must find FEWER issues than the previous round. If a round finds MORE, something is wrong — stop and report.
- Do not create duplicate stories across rounds. Deduplicate aggressively.
- The auto-active flag stays active for the entire iterate session.
- Commit between rounds (not just every 3 tasks).
- If build breaks during a round, fix it before continuing to the next round.
- Visual verification is required for UI tasks in every round, not just the final one.
- Delete the auto-active flag on exit.

## Feeding the learning loop

**Threshold — record it when an iteration undoes an earlier one.** Oscillation is
the signal this skill is uniquely placed to see and the only one worth storing.

Two changes that reverse each other mean the requirement was never settled, and
the third pass will cost as much as the first two. Write down what the two
positions were and which constraint decides between them — that constraint is the
thing nobody wrote down the first time.
