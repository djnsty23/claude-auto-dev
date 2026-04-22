---
description: Search persistent project memory across sessions — decisions, bugs, features, discoveries
triggers:
  - mem search
  - mem recent
  - mem decisions
  - mem bugs
  - mem timeline
  - mem stats
  - remember
  - what did we
  - what was
  - last session
  - past sessions
allowed-tools:
  - Bash
  - Read
---

# Memory Search

Search the project's persistent memory database. Observations are captured automatically during sessions.

## Commands

| Say | Does |
|-----|------|
| `mem search <query>` | Keyword search across all observations |
| `mem recent` | Last 10 observations for this project |
| `mem decisions` | All architectural/design decisions |
| `mem bugs` | All bug fixes |
| `mem timeline <query>` | Session-level view with summaries |
| `mem sessions` | List all past sessions |
| `mem stats` | Memory database statistics |

## How It Works

Memory is stored in SQLite at `~/.claude/auto-dev-memory.db`. Observations are captured automatically by the PostToolUse hook and classified by type:

- **decision** — Architectural or design choices
- **bugfix** — Bug fixes and patches
- **feature** — New functionality added
- **refactor** — Code restructuring
- **discovery** — Investigations and findings
- **change** — General modifications

## Progressive Disclosure (Token-Efficient)

1. **Start with `mem search`** — returns titles + timestamps only (~50-100 tokens)
2. **Then `mem timeline`** — shows session context around matches (~500 tokens)
3. **Then drill into specifics** — full observation details only when needed

This 3-layer approach saves ~10x tokens vs dumping full context.

## Implementation

Run queries via the memory-db CLI:

```bash
# Search
node ~/.claude/scripts/memory-db.js search "$(pwd)" "auth middleware"

# Recent observations
node ~/.claude/scripts/memory-db.js recent "$(pwd)" 10

# Decisions only
node ~/.claude/scripts/memory-db.js decisions "$(pwd)"

# Bug fixes only
node ~/.claude/scripts/memory-db.js bugs "$(pwd)"

# Session history
node ~/.claude/scripts/memory-db.js sessions "$(pwd)"

# Timeline search
node ~/.claude/scripts/memory-db.js timeline "$(pwd)" "database"

# Stats
node ~/.claude/scripts/memory-db.js stats "$(pwd)"
```

## When to Use

- Starting a new session and want context from past work
- Remembering why a decision was made
- Finding when/where a bug was fixed
- Checking what was explored in previous sessions
- Reviewing what's left to do (next_steps from last session)

## Privacy

Content wrapped in `<private>...</private>` tags is automatically stripped before storage. Secrets, API keys, and sensitive data in private tags never reach the database.
