---
name: grilling
description: "Stress-test a plan or decision BEFORE building it. Use when the user says grill me, poke holes in this, stress-test this, or what am I missing, and before executing any plan whose premise nobody has attacked."
when_to_use: "Before work starts on anything whose FRAME could be wrong: a new feature, an architecture call, a migration, a rewrite. Not for a decision that is reversible, in scope, and obvious — grilling those is its own failure mode."
allowed-tools: Read, Grep, Glob, Bash, WebFetch, WebSearch, AskUserQuestion
---

# Attack the premise before it becomes code

A wrong fix costs one cycle. A wrong frame costs every cycle until someone
questions it, and nothing in the normal workflow questions it: review checks the
diff against the plan, tests check the code against the spec, and both pass
happily while the spec answers the wrong question.

Adapted from Matt Pocock's `grilling` skill (github.com/mattpocock/skills, MIT).
The tree-and-frontier mechanic is his. What is added here is the fact-finding
rule made mandatory, the interaction shape this harness actually has, and an
explicit list of what not to grill.

## The tree and the frontier

Map the plan as a tree of decisions. Each decision branches into the decisions
that hang off it: choosing a queue implies choosing a delivery guarantee, which
implies choosing what a duplicate costs.

The **frontier** is every decision whose prerequisites are already settled — the
questions that can be answered right now, without waiting on another open one.
Work in rounds:

1. Compute the frontier.
2. Ask the whole frontier in ONE round. Not one question at a time: a plan
   interrogated serially takes twenty turns and the user stops answering.
3. Each answer settles a decision and expands the frontier with whatever it
   unblocked.
4. Repeat until the frontier is empty.

A question whose answer depends on an unresolved decision belongs to a later
round. Asking it early produces an answer the user will retract.

## Finding facts is YOUR job

**Never ask the user something the repo, the filesystem, or the network can
answer.** Which database is in use, whether an endpoint exists, what the current
schema is, whether a library is already a dependency, what the last migration
did — go and read it. Every fact you ask for is a question the user has to look
up on your behalf, and it buys nothing that a grep would not.

Ask only about **intent, priority, and tradeoff**: what this is for, who it is
for, what must not break, what you are willing to give up, what happens if it is
wrong. Those are not in the repo.

This is the same discipline as the options protocol's vet-before-you-offer: do
the lookups first, then write the questions out of what you learned.

## How to ask, in this harness

Every question carries **your recommendation**, and the reason lives in the
first clause. A question without one pushes the ranking work back onto the
person you are supposed to be helping.

- **Frontier of 4 or fewer** — use `AskUserQuestion`. It is clickable and the
  answers come back structured.
- **Frontier larger than 4** — use numbered prose instead. `AskUserQuestion`
  caps at four questions of four options, so a wider frontier would have to be
  truncated, and silently dropping a decision from a design tree is far worse
  than a less clickable turn. Number them so the user can answer `1b, 2a, 3 —
  own everything`:

```
Q1 — <the decision, as a question>
     a) <option>   b) <option>   c) <option>
  -> recommend (b): <reason, first clause>
```

Keep the recommendation honest. It is what you would do if the user said
nothing at all, not the safest option and not the one that flatters the plan
you have already half-built.

## What NOT to grill

Grilling everything is a failure mode of its own — it reads as diligence and
produces a backlog of answered questions nobody needed.

- **Reversible, in scope, obvious.** Decide it and say you did.
- **Anything already decided and written down.** Read `DECISIONS.md` and the
  project rules first; re-litigating a settled call wastes the user's time and
  suggests you did not look.
- **Preferences with a conventional default.** Pick the convention.
- **The same question in three costumes.** Two questions that collapse into one
  action are one question.

## Finish by stating the understanding

When the frontier empties, write the shared understanding back in a short block:
what is being built, for whom, what it explicitly will NOT do, and the decisions
that were settled with their answers. That block is the artifact — it goes into
`DECISIONS.md` or the spec, because a decision that lives only in this
conversation is invisible to the next session and will be re-made differently.

Then say what you are going to do first.
