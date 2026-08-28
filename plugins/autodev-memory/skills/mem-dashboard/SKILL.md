---
name: mem-dashboard
description: Render a compact markdown dashboard of the project's memory — stats, per-type breakdown, top code areas, recent activity and sessions
when_to_use: "Invoked when the user says \"mem dashboard\", \"memory dashboard\", \"memory overview\", or asks what this project remembers."
allowed-tools: Bash, Read
model: opus
user-invocable: true
---

# Memory Dashboard

A compact **markdown** view of the project's persistent memory. No server, no
browser, no daemon, and no second database — it is derived on demand from the
same SQLite store the capture hook already writes to, and it never writes.

## Commands

| Say | Does |
|-----|------|
| `mem dashboard` | Render the full memory dashboard for this project |
| `memory dashboard` | Same — natural-language phrasing |
| `memory overview` | Same |

## What it shows

- **Overview** — sessions, observations and token cost for this project.
- **Observations by type** — ASCII bars across decision / bugfix / feature /
  refactor / discovery / change, in a fixed order so equal counts do not
  reshuffle between runs.
- **Top areas** — the most-touched code areas, folded from each observation's
  `source_files` to their first 1–2 path segments (`src/auth/login.js` →
  `src/auth`), the same rule the knowledge agent uses. An area is counted once
  per observation, not once per file, so a commit touching eight files in one
  directory does not drown out the rest.
- **Recent activity** — the last ~10 observations.
- **Recent sessions** — the last ~5, with `next_steps` / `learned` snippets.

## Running it

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-db.js" dashboard "$(pwd)"
```

It prints Markdown to stdout. Show it to the user as-is.

`${CLAUDE_PLUGIN_ROOT}` resolves per plugin, so this path only works from
`autodev-memory`. Do not reach for it from another plugin — copy what you need
into that plugin instead.

## Reading the empty cases

Three outcomes, deliberately distinct, because collapsing them is how a broken
probe reads as a healthy empty project:

| Output | Means |
|---|---|
| `No memory recorded yet.` | The database could **not be read** — not a zero |
| `No memory recorded yet for <project>.` | Store is readable, this project has nothing |
| `No observations recorded yet for <project> (N sessions).` | Sessions ran but produced no observations |

## Privacy

Rendered from already-stored observations. Content wrapped in
`<private>...</private>` is stripped before storage, so it cannot appear here.
