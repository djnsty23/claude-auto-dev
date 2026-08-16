---
name: mem-search
description: Search persistent project memory across sessions — decisions, bugs, features, discoveries
when_to_use: "Invoked when the user says \"mem search\", \"mem recent\", \"mem decisions\", \"mem bugs\", \"mem timeline\", \"mem stats\", \"mem why\", \"remember\", \"what did we\", \"what was\", \"last session\", \"past sessions\"."
allowed-tools: Bash, Read
model: opus
user-invocable: true
---

# Memory Search

Search the project's persistent memory database. Observations are captured automatically during sessions.

## Commands

| Say | Does |
|-----|------|
| `mem search <query>` | Keyword search — auto-falls back to conceptual (semantic) search when exact matches are sparse |
| `mem why <query>` / `semantic` | Conceptual/fuzzy recall (TF-IDF token similarity + synonym expansion) |
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
# Search — exact FTS5 first, auto-falls back to conceptual search when <3 exact hits
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-db.js" search "$(pwd)" "auth middleware"

# Conceptual / fuzzy recall (lexical TF-IDF ranker, no embeddings, offline)
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-db.js" semantic "$(pwd)" "why did we choose X"

# Recent observations
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-db.js" recent "$(pwd)" 10

# Decisions only
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-db.js" decisions "$(pwd)"

# Bug fixes only
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-db.js" bugs "$(pwd)"

# Session history
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-db.js" sessions "$(pwd)"

# Timeline search
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-db.js" timeline "$(pwd)" "database"

# Stats
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-db.js" stats "$(pwd)"
```

## When to Use

- Starting a new session and want context from past work
- Remembering why a decision was made
- Finding when/where a bug was fixed
- Checking what was explored in previous sessions
- Reviewing what's left to do (next_steps from last session)

## Privacy

Content wrapped in `<private>...</private>` tags is automatically stripped before storage. Secrets, API keys, and sensitive data in private tags never reach the database.
