# Role chain

Status: first slice, 2026-11-08. Built: `plugins/autodev-core/scripts/role-chain.js`
(`start`, `handoff`, `status`), the five brief templates and the `role-chain` skill.
Not built yet: automatic dispatch of the next role on a landed handoff.

## Problem

Today the Brain starts one worker per story. That worker writes its own plan,
its own code, checks its own work and words its own copy, all in one context.
Nothing reviews the plan before code exists, and the only check of the code is
the session that wrote it. When a story comes back wrong, the report says
"done" and the reason is lost in a transcript nobody else reads.

The operator already runs a better shape by hand in another tool: a PM tells a
Spec bot what to write, Spec writes the spec, Eng writes the code, QA verifies
and a copy role polishes the words. Each role is a standing agent with its own
skills, and they hand work to each other directly. This document brings that
shape into autodev.

## The five roles

| Role | Takes in | Hands out | Model, effort | Runs in | Writes |
|---|---|---|---|---|---|
| PM | the backlog, escalations, Copy's final handoff | the story and its acceptance criteria, to Spec | the Brain seat (Opus 5.5 high) | the Brain session | nothing |
| Spec | PM's handoff, or Eng's rework | a spec file and sharpened criteria, to Eng | Opus 5.5 medium | own worktree, detached at the base | the spec, in the chain folder |
| Eng | Spec's handoff, or QA's or Copy's rework | a branch and commit, to QA | Opus 5.5 medium | own worktree on `chain/<run>-eng` | code, tests, migrations |
| QA | Eng's handoff | a QA report, to Copy | Haiku 5.5 xhigh | own worktree, detached at Eng's head | the report, in the chain folder |
| Copy | QA's handoff | a copy commit, to PM | Haiku 5.5 xhigh | own worktree on `chain/<run>-copy`, from Eng's head | only the copy files the spec lists |

Model and effort follow the operator's fleet policy: judgement and code on Opus
at medium, mechanical checks on Haiku at xhigh. QA runs commands someone else
wrote and compares output with an expected line, which is mechanical. Copy edits
strings in a list of files. Both escalate rather than judge when unsure.

Eng is the only role that writes code. Spec and QA use their worktrees to read
a fixed commit and write only into the chain folder. Copy writes only to the
files the spec lists under "copy files".

## The handoff file

Every handover is one JSON file, landed with
`role-chain.js handoff <run> <from> <to> --file <json>`. The script validates it,
copies it to `~/.claude/autodev/chain/<run>/handoffs/<seq>-<from>-<to>.json` and
appends an event to `chain.jsonl`.

```json
{
  "schema": 1,
  "run": "seo-og",
  "from": "spec",
  "to": "eng",
  "status": "done",
  "summary": "One line: what this handoff delivers.",
  "artefacts": [{ "kind": "spec", "path": "/abs/path/to/chain/seo-og/artefacts/spec.md" }],
  "acceptanceCriteria": [
    { "id": "AC1", "check": "npx vitest run src/app/og-images.test.ts", "expect": "exit 0" }
  ],
  "rework": { "reasons": ["only with status rework"] },
  "blocker": "only with status blocked",
  "memory": [{ "type": "decision", "title": "...", "concept": "..." }]
}
```

The rules the script enforces, each refusal named:

- `acceptanceCriteria` is a non-empty array on every handoff. Each item has an
  `AC<n>` id, unique, a non-empty `check` and a non-empty `expect`
  (`missing-acceptance-criteria`, `missing-check`, `missing-expect`).
- `status` is `done`, `rework` or `blocked`. `done` follows the forward edge
  (pm, spec, eng, qa, copy, back to pm), `rework` goes to the role that produced
  the input (spec to pm, eng to spec, qa to eng, copy to eng), and `blocked`
  always goes to pm with a `blocker` (`wrong-edge`).
- A `done` carries its role's artefact: PM a `story`, Spec a `spec`, Eng a
  `branch` and a `commit` with a sha, QA a `report`, Copy a `commit`
  (`missing-artefact`). Spec, report and file paths are absolute and exist.
- A `rework` names its reasons (`rework-needs-reasons`).
- `run`, `from` and `to` in the file match the command.

A refused handoff writes nothing and exits 1, so a role fixes and retries
without leaving half a state behind.

## Rework

A role that cannot use its input sends `rework` to the role that produced it,
with the reasons. Each edge allows two rework rounds. The script counts earlier
reworks on the same edge from `chain.jsonl` and refuses a third
(`rework-cap`). The role then sends `blocked` to PM, who decides: rewrite the
story, split it, or drop it. Two rounds is the cap because a third attempt by
the same pair at the same disagreement rarely adds information, and the PM
holds the intent both roles lack.

## Shared memory

Roles do not share a context window. They share two durable stores:

1. **The chain folder** (`~/.claude/autodev/chain/<run>/`) is the source of
   truth: the manifest, every handoff, the briefs and the artefacts. Every role
   reads its input from the newest handoff addressed to it and the files that
   handoff names, never from another session's summary.
2. **autodev-memory.** Each landed handoff writes one `decision` observation
   ("chain <run>: spec -> eng done", with the summary as concept and the
   artefact paths as source files) against the product repo, plus one
   observation per entry in the handoff's `memory` array. Later sessions on the
   same repo find them with `mem-search`. If the memory plugin is missing the
   handoff still lands and its event records `memory: "unavailable"`.

Cached context between sessions is not shared, by design: what a role knows
and the next one needs goes into the handoff or it does not exist.

## What the operator sees

- One side session per role, titled `chain <run>: <role>`, nested under the
  Brain. At most one role of a chain runs at a time.
- `role-chain.js status <run>` prints one line per role: state (`waiting` for input, `pending`
  with its input landed, `rework`, `waiting-rework`, `done`, `blocked`, `escalated`),
  model, effort, rework rounds and the latest artefacts.
- `role-chain.js status` with no run is the chain listing: one line per chain
  with every role's state.
- Each role writes `~/.claude/autodev/reports/chain-<run>-<role>/REPORT.md`
  ending in a `RESULT:` and a `BLOCKER:` line, as every worker does today.

## Dispatch

The script cannot call `start_session`, so the PM does. `start` prints, per
role, the title, short name, model, effort, brief path and worktree. The PM
starts a role when `status` shows it `pending` (its input has landed) or `rework`, with a fresh
context, the role's model and effort, and a prompt that points at the brief.

A session that was itself started by another session cannot start sessions:
the app refuses. In that case the PM proposes the role session as a card, or
runs the role as a subagent pinned to the role's model, and records which
channel ran it in the handoff summary.

## Not in this slice

- Starting the next role automatically when a handoff lands (a Stop hook or the
  Brain clock reading `chain.jsonl`).
- A judge pass on QA's report before PM lands, as `brain-judge.js` does for
  queued workers.
- Several chains sharing one standing role session. Each chain starts its own.
