---
name: rule-agent-concurrency
description: "How many agents to spawn, at which model and effort, so a fan-out does not burn the session's limits. Load before spawning subagents, running a workflow, or dispatching background sessions."
when_to_use: "Before spawning subagents, running a workflow, or fanning work out across agents."
user-invocable: false
allowed-tools: Read, Bash
---

# Agent concurrency

Claude Code's own ceilings are far higher than what is useful here: subagents
default to **20 concurrent** (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), nesting
runs **3 deep** (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`), the per-session spawn
cap was removed entirely in 2.1.224, and a workflow runs
`min(16, CPUs − 2)` agents at once. Nothing stops a fan-out from exhausting a
usage window in one turn.

These are the project's own limits. They are lower on purpose.

## Caps

| Mode | Ceiling | Use when |
|---|---|---|
| **Ultra / deep work** | **5–6 agents** | An audit, a multi-lens review, a wide research sweep. This is the maximum for any single fan-out. |
| **Normal** | **3–4 concurrent** | Everything else, including background sessions running in parallel. |

Count *concurrent*, not total. Ten agents run three at a time is normal mode;
six at once is ultra. If a plan needs more than six, it needs a second wave, not
a bigger wave — and a second wave means the first one's results narrow the
second, which is usually a better result anyway.

**Never nest fan-outs.** A depth of 3 means six agents each spawning six is
thirty-six live agents. Set `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` if a task
tempts you.

## Model and effort

Pick one of these three. Do not invent combinations.

| Tier | Use for |
|---|---|
| **Opus 5 · xhigh** | The hardest single agent in a fan-out — the judge, the synthesiser, the adversarial verifier. |
| **Opus 5 · high** | The default for everything else. |
| **Opus 4.8 · xhigh** | When a task benefits from 4.8's behaviour specifically, or Opus 5 is unavailable. |

Do not drop a fan-out to Haiku or Sonnet to "save budget" — a cheap agent that
returns a wrong finding costs more than it saves, because the finding still has
to be verified. Reduce the agent *count* instead.

Effort is per-agent (`effort:` in skill frontmatter, `opts.effort` in a
workflow). Spend `xhigh` on the one agent whose judgement decides the outcome,
`high` on the rest.

## Before spawning

1. **Say how many and why.** "Six: one per audit dimension" is a plan. "Spawn
   agents to review this" is not.
2. **Check the budget.** If the user set a `+Nk` target, `budget.remaining()`
   governs; a fan-out that would exhaust it should shrink, not proceed.
3. **Prefer sequential when order matters.** Parallel agents cannot see each
   other's findings; if agent 2's work depends on agent 1's, running them at once
   just produces two half-informed answers.

## Workflows specifically

The session's dynamic-workflow guideline (`workflowSizeGuideline`, or the
`/config` row) is advisory and defaults to **medium: under 15 agents**. These
caps are stricter and win. Set `phases` in `meta` so the user can see the shape
before it runs.

## The Task tools are gone on current models

As of 2.1.233, `TaskCreate` / `TaskGet` / `TaskUpdate` / `TaskList` and
`TodoWrite` are **not available on Opus 4.8, Sonnet 5, Fable 5, and newer**.
Any skill that lists them in `allowed-tools` will find them missing at run time.

Track multi-step work in `prd.json` — which is this framework's persistent task
system and survives `/clear`, compaction, and a restart, none of which the
native task list does. Set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` only if a user
explicitly wants the native list back.
