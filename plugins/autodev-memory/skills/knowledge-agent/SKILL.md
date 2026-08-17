---
name: knowledge-agent
description: Distill accumulated observations for a code area into a focused domain knowledge brief
when_to_use: "Invoked when the user says \"knowledge\", \"what do we know about\", \"brief me on\", \"domain knowledge\"."
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
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-db.js" knowledge "$(pwd)" "src/auth"
```

The command prints Markdown to stdout. Show it to the user, or use it as
context before working in that area.

### Automatic surfacing

Briefs are **also surfaced automatically**. The PostToolUse (Write|Edit) hook
derives the area from the edited file's directory (first 1-2 path segments, e.g.
`src/auth` for `src/auth/login.js`) and, the **first** time an area with
accumulated knowledge is edited in a session, prints a compact `[Memory] Domain
knowledge for <area> (<n> notes):` line plus the top few items to stderr. This
is **throttled to once per area per session** via a small state file
(`.claude/knowledge-surfaced`, git-ignored), so it surfaces knowledge without
flooding: at most one brief is computed per distinct area per session. The state
file is rewritten on each update to hold only the current session's markers, so
it stays bounded to the active session's areas rather than growing across
sessions. Root-level files and empty/too-broad areas are skipped, and everything
degrades silently when the memory DB is unavailable. A transient DB failure is
**not** recorded as surfaced, so the next edit retries; only a real result (even
an empty one) is recorded.

**Limitation — monorepo over-broadening.** The auto-surfaced area is derived from
the **first two path segments** of the edited file's directory. In a monorepo
this collapses `packages/foo/src/auth/login.js` to just `packages/foo`, so every
area inside a package shares one throttle key and one brief. Invoke the skill
explicitly with a deeper area (e.g. `knowledge packages/foo/src/auth`) when you
need finer granularity — the on-demand `knowledge <area>` command accepts any
path prefix.

## When to Use

- Onboarding to an unfamiliar part of the codebase
- Before editing an area — surface prior decisions, fixed bugs, and known gotchas
- Answering "what do we know about X?" from accumulated project history
- Consolidating scattered observations into one readable brief

## Privacy

Briefs are rendered from already-stored observations. Content wrapped in
`<private>...</private>` tags is stripped before storage, so it never appears in
a brief.

## Proving the run

**Observable:** a query for something known to be stored returns it, before any
"nothing found" is reported.

An empty result from a search is a claim about the index, not about the past. The
store may be empty, the embedding call may have failed, the filter may exclude
everything. Run one query whose answer you already know; if that comes back empty
the retrieval is broken and no other result from this run means anything. Report
how many records were searched.
