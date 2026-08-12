---
name: knowledge-agent
description: Distill accumulated observations for a code area into a focused domain knowledge brief
triggers:
  - knowledge
  - what do we know about
  - brief me on
  - domain knowledge
allowed-tools: Bash, Read
model: opus
user-invocable: true
---

# Knowledge Agent

Build a focused "domain brain" for a code area by distilling the project's
accumulated memory. Instead of searching raw observations one at a time, this
gathers every observation touching an area (its files, or its name in a
title/concept), groups them into **decisions**, **bug fixes**, **gotchas &
discoveries**, and **changes & features**, dedupes, and renders a compact
Markdown brief.

## Commands

| Say | Does |
|-----|------|
| `knowledge <area>` | Render a knowledge brief for a code area (path prefix / directory / fragment) |
| `what do we know about <area>` | Same — natural-language phrasing |
| `brief me on <area>` | Same |
| `domain knowledge <area>` | Same |

The **area** is a path prefix, directory, or fragment — e.g. `src/auth`,
`payments`, `hooks/session-start`.

## How It Works

Knowledge briefs are **derived on demand from the existing memory store** — there
is no separate knowledge database and no external service. Observations are
captured automatically by the PostToolUse hook and live in SQLite at
`~/.claude/auto-dev-memory.db`. An observation belongs to an area if any of its
`source_files` matches the area on **path-segment boundaries** — `src/auth`
matches `src/auth/login.js` and `src/auth`, but not `src/authentication/…`, and
`auth` matches a whole path segment but not `author`. For word-like areas (no
`/`), a **whole-word** match of the area in the title or concept also counts
(so `auth` matches "auth token" but not "author"). Work is bounded to the most
recent 500 observations for the project
(same window as semantic search) and degrades gracefully — an area with nothing
recorded returns "no accumulated knowledge yet" rather than an error.

Observations are grouped by type:

- **decision** → Decisions
- **bugfix** → Bug fixes
- **discovery** → Gotchas & discoveries
- **feature / refactor / change** → Changes & features

## Implementation

Run the brief via the memory-db CLI:

```bash
# Knowledge brief for an area (path prefix / directory / fragment)
node ~/.claude/scripts/memory-db.js knowledge "$(pwd)" "src/auth"
```

The command prints Markdown to stdout. Show it to the user, or use it as
context before working in that area.

## When to Use

- Onboarding to an unfamiliar part of the codebase
- Before editing an area — surface prior decisions, fixed bugs, and known gotchas
- Answering "what do we know about X?" from accumulated project history
- Consolidating scattered observations into one readable brief

## Privacy

Briefs are rendered from already-stored observations. Content wrapped in
`<private>...</private>` tags is stripped before storage, so it never appears in
a brief.
