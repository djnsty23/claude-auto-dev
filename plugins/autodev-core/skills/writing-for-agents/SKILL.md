---
name: writing-for-agents
description: "Writing a document another agent will execute: a SKILL.md, a CLAUDE.md or AGENTS.md line, a subagent brief, a scheduled-task prompt, a doc reached by a pointer. Use when creating or editing any of those."
when_to_use: "Before writing instructions an agent rather than a person will follow. Distinct from rules/writing-style.md, which governs prose for humans; this governs document architecture."
allowed-tools: Read, Grep, Glob, Bash
---

# The document is a program with a fuzzy interpreter

Adapted from Matt Pocock's `writing-for-agents` (github.com/mattpocock/skills,
MIT). The concept names below are his and worth keeping verbatim, because a
shared name is the whole point of a leading word. What is added is this
harness's measured numbers and the checks that already exist here.

This is a different axis from `rules/writing-style.md`. That governs prose a
person reads. This governs how a document an agent executes is structured.

## Context pointers

A **context pointer** is a reference sitting in the agent's context that names
material it does not have, plus the condition for going and getting it. A
skill's `description` is one. A line in CLAUDE.md naming a doc is the same
object.

The pointer's **wording, not its target, decides whether the material is ever
reached.** A must-have document behind a weakly worded pointer is not a
documentation gap, it is a variance bug: it works on some runs. Sharpen the
wording first; inline the material only when sharpening fails.

So a description is a **trigger, not a summary**. Name the situation the agent
will be in, not the category the document belongs to.

`npm run check:triggers` measures this across every skill here: it flags
descriptions naming no condition, and prints the standing cost of the set.

## The two loads

Every pointer and document spends one of two budgets:

- **Context load** — always-loaded material, paid every turn whether or not it
  fires. Measured here: **13,886 bytes, about 3,472 tokens** across 56 skill
  descriptions, resident in every session on this machine. That is the real
  price of "just add another skill", and it is why a description earns harder
  pruning than the body it points at.
- **Cognitive load** — the cost on the human of knowing which documents exist.
  Not a cost to drive to zero: it is the price of human agency. Spend it where
  judgement matters.

## Information hierarchy

Rank each piece by how immediately the agent needs it:

1. **In-file step** — what the agent does, in order.
2. **In-file reference** — consulted on demand. A flat peer-set of rules is a
   legitimate shape, not a smell.
3. **Disclosed reference** — pushed behind a pointer, loaded only when it fires.

**Progressive disclosure** is the move down that ladder. The test is branching:
inline what every run needs, disclose what only some runs reach. Push too little
and the top bloats; push too much and you hide what the agent actually needs.

**Sprawl** is the failure mode — a document too long even when every line is
live. Attention thins across the excess.

## Completion criteria

Every step ends on a condition telling the agent it is done, and two properties
make that a lever:

- **Clarity** — can it tell done from not-done? A vague bound invites
  **premature completion**, where attention slides to being finished. Sharpen
  the bound first; that is local and cheap.
- **Demand** — how much it asks. "Every modified model accounted for" forces
  legwork that "produce a change list" does not.

The strongest criteria are checkable AND exhaustive. This is the same instinct
as `rule-gate-integrity`: a gate that prints a population is partly
self-verifying, one that prints a verdict is indistinguishable from a probe that
found nothing.

## Leading words

A **leading word** is a compact concept already in the model's pretraining that
the agent thinks with while running the document. Repeat it as a token, never as
a sentence, and it anchors a region of behaviour cheaply by recruiting priors
the model already holds. Coining your own works only if you define it, and you
pay in definition tokens what a pretrained word gives free.

This harness already runs on them: *frontier*, *blast radius*, *population*,
*known-positive*, *mutation*, *the answer is zero*. Each retired a paragraph.

**Negation is the failure mode beside it.** Steering by prohibition drags the
forbidden behaviour into context and makes it MORE available. Prompt the
positive: state the target so the banned thing is never spoken. Keep a
prohibition only as a hard guardrail, and pair it with the positive target.

## Pruning

- **Single source of truth.** The same meaning in two places costs maintenance
  and inflates its apparent rank.
- **The environment is a source of truth.** `package.json` scripts, config, the
  directory layout, `--help`. A document restating them is a cache, and a cache
  earns its load only when the lookup is expensive. Cache what cannot be looked
  up: the unwritten convention, the reason behind a choice, the gotcha no config
  confesses.
- **Hunt no-ops.** An instruction the model already follows by default pays load
  to say nothing. The test is model-relative and settled by RUNNING the
  document, not by argument. Delete the whole sentence rather than trimming it.

## One addition, specific to briefs

A claim written into a subagent's brief is not a claim, it is built work. A
wrong steer to a person costs a correction; the same steer to an agent costs a
branch. So mark which parts of a brief are DECIDED and which are PROPOSALS — an
agent cannot tell them apart from tone, and confident prose reads as decided.
