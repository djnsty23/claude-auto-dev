---
name: rule-agent-concurrency
description: "How many agents to spawn, at which model and effort, so a fan-out does not burn the session's limits. Load before spawning subagents, running a workflow, or dispatching background sessions."
when_to_use: "Before spawning subagents, running a workflow, or fanning work out across agents."
user-invocable: false
allowed-tools: Read, Bash
paths:
  - "**/*.workflow.js"
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

**Verify the model that actually ran before a model-specific claim or handoff.**
`model:` frontmatter, `--model`, a saved preference, and a requested fallback
chain are intent, not execution evidence. `[measured 2026-09-01]` the
`PreModelSwitch`/`PostModelSwitch` hooks observed all six explicit interactive
switches but none of three successful unavailable-primary fallbacks. In an
interactive session read `/status` after the switch. In an unattended run use
the command or SDK result's actual model field. If neither readback exists, say
the model is unverified instead of naming the requested one as fact.

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

## What an agent RETURNS is the cost, not which model ran it

`[measured 2026-08-25]` over **280 agents across 52 workflow runs**: returns
totalled 3,524,077 characters, roughly **880k tokens fed back into main
threads**. Median return **12,933 chars**, p90 30,873, max 65,399. **60% exceed
10k.** One run of 30 agents returned 658,588 chars — about 165k tokens — into a
single thread, which then re-reads them on every subsequent turn.

That is why model tier is the wrong lever. A main-thread request already
re-reads ~405k tokens to emit ~1,000; the return is what grows that number
permanently.

**Write the artifact to a file; return the path and a summary.** Agents that
called Write or Edit returned a median **5,217** chars. Agents that wrote
nothing returned **13,389** — 2.6× more. Only 20% of agents wrote anything, and
the write-less 79% produced **86% of all returned characters**.

The specific failure to avoid: **88 returns named a file path *and* still
exceeded 10k chars.** They wrote the file, then pasted the contents anyway.
Naming the path is the point; the paste undoes it.

Budget each return explicitly in the prompt — 400–800 characters is enough for a
path, a count, and the two or three things the caller must decide on. And note
the **2,048-character cap is per schema string field, not a payload budget**:
65,399-char returns exist, so a schema does not protect you. A field that
truncates does so silently, mid-token, and the retry loop then burns five full
generations against the same wall.

Never interpolate a large blob into a downstream prompt.
`JSON.stringify(x, null, 1).slice(0, 90000)` is 90k characters of prompt on
every call that touches it.

## Serial chains duplicate; parallel ones do not

The intuition is backwards, and this corrects point 3 above rather than
replacing it. `[measured]` mean pairwise similarity between parallel agents'
returns was **0.008** (max 0.060 across 51 pairs). Serial chains averaged
**0.072**, with peaks of 0.710, 0.672 and 0.546 — and every pair above 0.25 sat
in a serial refine chain. One chain returned 113,915 characters re-emitting
substantially the same document **fifteen times**.

So sequencing is still right when order matters. But **a serial stage must pass
a delta, never the artifact** — what changed and why, not the document again.
The next stage can read the file.

## Losing agents: it is the quota wall, not the width

`[measured]` 42 of 280 agents (15%) were lost — 20,680 agent-seconds and 1,119
tool calls, journaled as nothing, because the journal records a result only on
completion. **20 of them carry a `<synthetic>` row reading "You've hit your
session limit", and 0 of those 20 journaled.** That is 48% of all lost work from
one cause, and it is greppable after the fact.

Resist reading a loss *rate* by shape as evidence about width: 1-agent runs lost
**67%** while a 16-wide 30-agent run kept **30 of 30**. Width sizes the blast
radius of an interruption; it does not predict one. The caps above stand on
usage limits and on second-wave-beats-bigger-wave, not on a loss rate.

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
