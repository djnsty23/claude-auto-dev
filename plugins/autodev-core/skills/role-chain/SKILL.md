---
name: role-chain
description: Run one story through standing role sessions, PM to Spec to Eng to QA to Copy, each with its own model, worktree and skills, handing the next a typed handoff file instead of sharing a context window.
when_to_use: "Invoked when the user says \"role chain\", \"run the chain\", \"spec then eng then qa\", or asks for a story to go through separate spec, engineering, QA and copy roles, and when the Brain dispatches a story that needs an independent spec and an independent check."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, SendMessage, mcp__ccd_session__start_session, mcp__ccd_session_mgmt__list_sessions, mcp__ccd_session_mgmt__get_session
model: opus
effort: high
user-invocable: true
argument-hint: "<run> --story <id> --repo <path>"
---

# role-chain

The PM (the Brain seat) runs this. One story goes through five roles in order.
Each role is its own session, on its own model, in its own worktree, and each
hands the next a JSON file the script validates. The design and its reasons are
in the autodev repository at `docs/role-chain.md`.

| Role | Model, effort | Writes | Hands to |
|---|---|---|---|
| PM | the Brain (Opus 5.5 high) | nothing | Spec |
| Spec | Opus 5.5 medium | the spec in the chain folder | Eng |
| Eng | Opus 5.5 medium | code, the only role that does | QA |
| QA | Haiku 5.5 xhigh | its report in the chain folder | Copy |
| Copy | Haiku 5.5 xhigh | only the copy files the spec lists | PM |

## 1. Start the chain

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/role-chain.js" start <run> --story <id> --repo <path>
```

It reads the story from the repo's `prd.json`, writes
`~/.claude/autodev/chain/<run>/` (manifest `chain.json`, event log `chain.jsonl`,
`briefs/<role>.md`, `handoffs/`, `artefacts/`) and lands the first handoff, PM to
Spec, built from the story's acceptance. A story with no acceptance is refused:
pass `--ac "<check>|<expect>"` once per criterion. It prints a `dispatch` list:
title, name, model, effort and brief path per role.

The briefs come from these templates, one per role:
[templates/pm.md](templates/pm.md), [templates/spec.md](templates/spec.md),
[templates/eng.md](templates/eng.md), [templates/qa.md](templates/qa.md),
[templates/copy.md](templates/copy.md).

## 2. Start one role at a time

Start a role only when `role-chain.js status <run>` shows it `pending` (its input has landed) or
`rework`. Use `mcp__ccd_session__start_session` with `context: "fresh"`, the
role's `model` and `effort` from the dispatch list, `cwd` set to the product repo,
and a prompt that tells the session to read its brief file and follow it. The
brief carries STEP 0 (its own worktree), its input handoff, its output, and its
report path under `~/.claude/autodev/reports/chain-<run>-<role>/`.

A session started from another session's message cannot start a session: the
app refuses. Then propose the role session as a card, or run the role as a
subagent pinned to the role's model, and record which channel ran it.

## 3. Read handoffs, not summaries

Every handoff lands through:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/role-chain.js" handoff <run> <from> <to> --file <json>
```

It refuses, with a named reason per problem and exit 1: a missing or malformed
`acceptanceCriteria`, a wrong edge, a `done` without its role's artefact (spec,
branch and commit, report, commit), a rework without reasons, and a third rework
on one edge. The third goes to PM as `blocked`. Each landed handoff writes one
autodev-memory observation, plus any the role put in its `memory` array.

## 4. Watch and land

`role-chain.js status <run>` shows each role's state and artefacts.
`role-chain.js status` with no run lists every chain. When Copy hands to PM, run
QA's acceptance commands yourself, then land through the repository's normal
merge path. A role's `done` is a claim; QA's report and your rerun are evidence.
