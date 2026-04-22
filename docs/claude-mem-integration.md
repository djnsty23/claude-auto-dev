# Claude-Mem Integration: Architecture & Patterns Reference

> Reference doc for integrating persistent memory into claude-auto-dev, based on [claude-mem](https://github.com/thedotmack/claude-mem) (46K+ stars).

## What claude-mem does

Claude-mem is a persistent memory compression system for Claude Code. It automatically captures everything Claude does during a session, semantically compresses it with AI, stores it in a searchable database, and injects relevant context back into future sessions. The result: Claude remembers what it did, what it learned, and what decisions were made — across sessions.

## Why this matters for claude-auto-dev

claude-auto-dev already has lifecycle hooks (session-start, stop, pre-tool, post-tool, user-prompt) and a task management system (prd.json). What it lacks is **persistent memory** — when a session ends, all context about decisions, discoveries, and patterns is lost. Adding claude-mem's memory patterns would let auto-dev:

- Resume work across sessions without re-scanning the codebase
- Remember why architectural decisions were made
- Track which approaches failed and which succeeded
- Build project-specific knowledge that compounds over time
- Reduce token waste by not rediscovering the same things

---

## Architecture (4 Layers)

### Layer 1: Claude Code Host (hooks)

Five lifecycle triggers capture activity passively:

| Hook | Fires when | What it captures |
|------|-----------|-----------------|
| `SessionStart` | Session begins | Injects relevant past context into the conversation |
| `UserPromptSubmit` | User sends a message | Captures user intent, task context |
| `PreToolUse` | Before a tool runs | Can filter/block dangerous operations |
| `PostToolUse` | After a tool completes | Captures tool results, file changes, decisions |
| `Stop` / `SessionEnd` | Session ending | Triggers summarization of the entire session |

**Mapping to claude-auto-dev:** We already have `session-start.js`, `stop-auto-check.js`, `pre-tool-filter.js`, `post-tool-typecheck.js`, `pre-compact.js`, and `user-prompt-image-scan.js`. The integration adds observation capture to the existing PostToolUse and Stop hooks, plus context injection at SessionStart.

### Layer 2: CLI Layer (Bun runtime)

Hook commands and event handlers that manage:
- Context injection at session start
- Session initialization
- Observation capture from tool results
- Session summarization at end

### Layer 3: Worker Daemon

An HTTP API server (port 37777) that:
- Coordinates session lifecycle
- Runs AI summarization via Claude Agent SDK
- Handles all search endpoints (10 total)
- Manages subprocess lifecycle
- Serves a web dashboard for real-time memory visualization

### Layer 4: Storage

Two databases working together:

**SQLite** — structured data + full-text search (FTS5)
- Sessions table: id, start/end times, project path, summary fields
- Observations table: typed entries with metadata
- FTS5 index for keyword search

**ChromaDB** — vector embeddings for semantic search
- Stores embeddings of observations and summaries
- Enables "find similar" queries (conceptual search)
- Hybrid with SQLite: auto-selects best approach per query

---

## Core Data Model

### Observations

The fundamental unit of captured knowledge. Every meaningful action gets typed:

```
type: decision | bugfix | feature | refactor | discovery | change
title: Short description
concept: What was learned or decided
sourceFiles: [array of affected files]
tokenCost: How many tokens this observation consumed
sessionId: Which session produced this
timestamp: When it happened
```

### Sessions

Each session tracks:

```
contentSessionId: Constant per user session (survives restarts)
memorySessionId: Changes on worker restarts (for SDK agent resume)
projectPath: Which project directory
startTime / endTime
summary:
  request: What the user asked for
  investigated: What was explored
  learned: What was discovered
  completed: What was done
  next_steps: What should happen next
```

### Dual Session ID Architecture

- `contentSessionId` stays constant for the entire user interaction
- `memorySessionId` changes when the worker restarts
- This lets the system resume SDK agent sessions after crashes without losing the user's context thread

---

## Progressive Disclosure Search (Key Innovation)

The most important pattern to adopt. Instead of dumping full context, it uses 3 layers:

### Layer 1: Index (~50-100 tokens)
Returns compact results: IDs, timestamps, titles only.
```
[
  { id: "obs_123", ts: "2024-03-15", title: "Decided on SQLite over Postgres" },
  { id: "obs_456", ts: "2024-03-16", title: "Fixed auth middleware race condition" }
]
```

### Layer 2: Timeline (~500-1000 tokens)
Shows chronological context around filtered results.
```
Session 2024-03-15:
  → User asked to fix database performance
  → Investigated: Postgres vs SQLite for local storage
  → Decided: SQLite (simpler, no daemon, sufficient for single-user)
  → Completed: Migrated storage layer
```

### Layer 3: Full Details (~500-1000 tokens)
Complete observation with all metadata, only for pre-selected IDs.

**Principle: filter before fetching = 10x token savings.**

The user (or Claude) starts at Layer 1, decides what's relevant, drills into Layer 2 for context, and only fetches Layer 3 for the specific items needed.

---

## Resilience Patterns

### Circuit Breaker
- 3 sequential restart attempts
- Exponential backoff: 1s → 2s → 4s
- After 3 failures: abandon (don't infinite loop)

### CLAIM-CONFIRM Message Queue
Messages transition through states:
```
pending → processing → deleted/reset
```
Self-healing: if a message stays in "processing" too long, it resets to "pending."

### Deduplication
- 16-character SHA256 hash of observation content
- Prevents duplicates within 30-second windows
- Critical for PostToolUse hooks that fire rapidly

### Graceful Degradation
- Transport failures (worker down) → exit 0 (never block Claude)
- Client bugs (bad data) → exit 2 (blocking error, needs fix)
- Memory system is optional — Claude works fine without it

---

## Privacy Controls

`<private>` tags are processed at the hook layer, before data reaches the worker or database:

```
User: My API key is <private>sk-abc123</private>
→ Hook strips private content
→ Worker only sees: "My API key is [REDACTED]"
→ Database never contains the secret
```

Edge-processing means secrets never touch the persistence layer.

---

## Skills (7)

| Skill | Purpose |
|-------|---------|
| `mem-search` | Natural language query against the memory database |
| `knowledge-agent` | Build AI-powered knowledge bases from observation history |
| `smart-explore` | AST-based code exploration via Tree-sitter (4-8x token savings, 24+ languages) |
| `make-plan` | Phased implementation planning (Phase 0: doc discovery → delegation → synthesis → verification) |
| `do` | Action execution |
| `timeline-report` | Chronological project history |
| `version-bump` | Semantic versioning automation |

---

## Known Limitations (Learn from These)

| Issue | Severity | Mitigation |
|-------|----------|-----------|
| Stop hook blocks 3-7s per turn (up to 110s extreme) | High | Make observation capture async, don't block the hook |
| Background observer burns $17+ in 3 hours | High | Cap token budget per session, use progressive disclosure |
| Worker OOM/SIGKILL in extended sessions | Medium | Implement memory limits, periodic cleanup |
| Windows: Bun PATH issues, zombie port blocking | Medium | Use Node.js instead of Bun, add port cleanup on start |
| Context bleeding between concurrent sessions | Medium | Strict session isolation via project path + session ID |
| SQLite WAL can grow too large | Low | Periodic WAL checkpointing |
| smart_outline can't handle .txt files | Low | Add plaintext fallback parser |

---

## How This Maps to claude-auto-dev

| claude-mem component | claude-auto-dev equivalent | Gap |
|---------------------|---------------------------|-----|
| SessionStart hook | `session-start.js` | Needs context injection from memory DB |
| PostToolUse hook | `post-tool-typecheck.js` | Needs observation capture |
| Stop hook | `stop-auto-check.js` | Needs session summarization |
| UserPromptSubmit hook | `user-prompt-image-scan.js` | Needs intent tracking |
| SQLite storage | None | New: add SQLite DB for observations |
| ChromaDB vectors | None | New: add vector search (or start with FTS5 only) |
| Worker daemon | None | New: add background service |
| mem-search skill | None | New: add memory search skill |
| Progressive disclosure | None | New: 3-layer search |
| prd.json tasks | `prd.json` | Already exists — connect to memory |
| Web dashboard | None | Nice-to-have, not critical |
