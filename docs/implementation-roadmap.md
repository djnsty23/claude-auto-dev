# Implementation Roadmap: Memory System for claude-auto-dev

> Phased plan for adding persistent memory, ordered by impact and effort.

## Phase 1: Foundation (1-2 days) — Highest Impact

### 1.1 SQLite Observation Store

Add a SQLite database to persist observations across sessions.

**Location:** `~/.claude/auto-dev-memory.db`

**Schema:**
```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT,
    request TEXT,          -- what the user asked for
    investigated TEXT,     -- what was explored
    learned TEXT,          -- what was discovered
    completed TEXT,        -- what was done
    next_steps TEXT        -- what should happen next
);

CREATE TABLE observations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_path TEXT NOT NULL,
    type TEXT NOT NULL,    -- decision | bugfix | feature | refactor | discovery | change
    title TEXT NOT NULL,
    concept TEXT,          -- what was learned/decided
    source_files TEXT,     -- JSON array of affected files
    token_cost INTEGER DEFAULT 0,
    timestamp TEXT NOT NULL,
    content_hash TEXT,     -- 16-char SHA256 for dedup
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_obs_project ON observations(project_path);
CREATE INDEX idx_obs_type ON observations(type);
CREATE INDEX idx_obs_timestamp ON observations(timestamp);
CREATE INDEX idx_obs_hash ON observations(content_hash);

-- Full-text search
CREATE VIRTUAL TABLE observations_fts USING fts5(
    title, concept, content=observations, content_rowid=rowid
);
```

**File:** `scripts/memory-db.js` — Node.js module using `better-sqlite3` (or built-in `node:sqlite` in Node 22+).

**Key functions:**
```javascript
initDB()                    // Create tables if not exist
saveObservation(obs)        // Insert with dedup check
saveSession(session)        // Insert/update session
getSessionContext(projectPath, limit=5)  // Recent sessions for this project
searchObservations(query, projectPath)   // FTS5 search
getObservationsByType(type, projectPath) // Filter by type
```

### 1.2 Observation Capture Hook

Extend `post-tool-typecheck.js` to capture observations.

**What to capture:**
- File writes/edits → type: `change`, source_files from tool input
- Bug fixes (detect from commit messages or user prompt) → type: `bugfix`
- New features → type: `feature`
- Refactors → type: `refactor`

**Implementation:** After the existing typecheck logic, append:
```javascript
// Capture observation from tool result
const obs = classifyObservation(toolName, toolInput, toolResult);
if (obs) {
    const db = require('./memory-db');
    db.saveObservation(obs);
}
```

**Type classification heuristic:**
- Write/Edit tool + new file → `feature`
- Write/Edit tool + existing file → `change`
- Bash tool + test/fix keywords → `bugfix`
- User prompt contains "refactor" → `refactor`
- User prompt contains "why", "how", "what" → `discovery`

### 1.3 Context Injection at Session Start

Extend `session-start.js` to inject relevant past context.

**After existing version/sprint display, add:**
```javascript
// Inject memory context
const db = require('./memory-db');
const recentSessions = db.getSessionContext(process.cwd(), 3);
if (recentSessions.length > 0) {
    console.log('[Memory] Last sessions:');
    for (const s of recentSessions) {
        console.log(`  ${s.start_time}: ${s.request || 'no summary'}`);
        if (s.next_steps) console.log(`  → Next: ${s.next_steps}`);
    }
}
```

**Token budget:** Cap injection at ~200 tokens. Use progressive disclosure — show summaries only, let Claude ask for details via mem-search skill.

---

## Phase 2: Search & Skills (2-3 days)

### 2.1 mem-search Skill

**Location:** `skills/mem-search/SKILL.md`

A skill that lets Claude query the memory database using natural language.

**Commands:**
- `mem search <query>` — keyword search across observations
- `mem recent` — last 10 observations for this project
- `mem decisions` — all decision-type observations
- `mem session <id>` — full details of a past session
- `mem timeline` — chronological project history

**Progressive disclosure implementation:**
1. Default response: index only (titles + timestamps)
2. User asks for more → timeline view (session summaries)
3. User asks for specific item → full observation details

### 2.2 Session Summarization

Extend `stop-auto-check.js` (or add a new `session-end.js` hook):

**On session end:**
1. Collect all observations from this session
2. Generate a structured summary:
   - `request`: What the user asked for (from first user prompt)
   - `investigated`: Files read, searches performed
   - `learned`: Discoveries and decisions
   - `completed`: Files written/edited, tests passed
   - `next_steps`: Unfinished work, follow-up items
3. Save to sessions table

**Critical:** Make this async. Don't block the stop hook. Write to a temp file and let the next session-start process it.

### 2.3 Deduplication

Before saving any observation, compute a 16-char SHA256 hash:

```javascript
const crypto = require('crypto');
function contentHash(obs) {
    const key = `${obs.type}:${obs.title}:${obs.concept}`;
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}
```

Skip insert if same hash exists within last 30 seconds (prevents rapid PostToolUse duplicates).

---

## Phase 3: Intelligence (3-5 days)

### 3.1 Vector Search (Optional but Powerful)

Add ChromaDB for semantic search alongside SQLite FTS5.

**When to use which:**
- Exact terms ("auth middleware", "prd.json") → FTS5
- Conceptual queries ("why did we choose this approach") → ChromaDB
- Auto-select: if FTS5 returns <3 results, fall back to ChromaDB

**Dependency:** `chromadb` npm package + Python runtime for the Chroma server.

**Alternative:** Skip ChromaDB entirely. Use OpenAI/Anthropic embeddings stored in SQLite with a simple cosine similarity function. Lighter weight, no extra daemon.

### 3.2 knowledge-agent Skill

Build domain-specific "brains" from filtered observation history:

```
mem knowledge create "auth-system"
→ Filters observations touching auth files
→ Compresses into a focused knowledge document
→ Stored as .claude/knowledge/auth-system.md
→ Auto-injected when Claude touches auth files
```

### 3.3 smart-explore (AST-Based Code Exploration)

Uses Tree-sitter to parse code into AST, then provides structured exploration:
- 4-8x token savings vs reading full files
- Supports 24+ languages
- Returns function signatures, class hierarchies, import graphs

**Implementation:** `scripts/smart-explore.js` using `tree-sitter` npm package.

---

## Phase 4: Infrastructure (Ongoing)

### 4.1 Worker Daemon

Background HTTP service for memory operations.

**Scope:** Only needed if search becomes too slow for synchronous hook execution. Start without it — SQLite queries are fast enough for Phase 1-2.

**If needed:**
- Port 37778 (avoid conflict with claude-mem's 37777)
- Endpoints: `/search`, `/observe`, `/session`, `/health`
- Web dashboard at `/ui`

### 4.2 Circuit Breaker

Wrap all DB operations:
```javascript
let failures = 0;
const MAX_FAILURES = 3;
const BACKOFF = [1000, 2000, 4000];

function withCircuitBreaker(fn) {
    if (failures >= MAX_FAILURES) return null; // circuit open
    try {
        const result = fn();
        failures = 0; // reset on success
        return result;
    } catch (err) {
        failures++;
        if (failures < MAX_FAILURES) {
            setTimeout(() => {}, BACKOFF[failures - 1]);
        }
        return null;
    }
}
```

### 4.3 Privacy Layer

Process `<private>` tags before storage:
```javascript
function stripPrivate(text) {
    return text.replace(/<private>.*?<\/private>/gs, '[REDACTED]');
}
```

Add to observation capture pipeline, before DB write.

### 4.4 Web Dashboard

Real-time memory visualization at localhost.

**Low priority** — only build if the CLI skill isn't sufficient for debugging and inspecting memory state.

---

## Priority Matrix

| Feature | Impact | Effort | Phase |
|---------|--------|--------|-------|
| SQLite observation store | **High** | Low | 1 |
| Observation capture hook | **High** | Low | 1 |
| Context injection at start | **High** | Low | 1 |
| mem-search skill | **High** | Medium | 2 |
| Session summarization | **High** | Medium | 2 |
| Deduplication | Medium | Low | 2 |
| Privacy layer | Medium | Low | 2 |
| Circuit breaker | Medium | Low | 4 |
| Vector search (ChromaDB) | Medium | High | 3 |
| knowledge-agent skill | Medium | Medium | 3 |
| smart-explore (Tree-sitter) | Medium | High | 3 |
| Worker daemon | Low | High | 4 |
| Web dashboard | Low | High | 4 |

---

## Dependencies

**Phase 1:**
- `better-sqlite3` (npm) — or use Node 22's built-in `node:sqlite`
- No other external deps

**Phase 2:**
- Nothing new (all Node.js built-ins)

**Phase 3:**
- `chromadb` (npm) + Python 3.8+ (for Chroma server)
- OR: skip Chroma, use manual embeddings in SQLite
- `tree-sitter` + language grammars (npm)

---

## File Structure (After Implementation)

```
claude-auto-dev/
├── docs/
│   ├── claude-mem-integration.md    # This reference doc
│   ├── implementation-roadmap.md    # This roadmap
│   └── memory-system-design.md     # Technical spec
├── hooks/
│   ├── session-start.js            # + context injection
│   ├── post-tool-typecheck.js      # + observation capture
│   ├── stop-auto-check.js          # + session summarization
│   └── ...existing hooks...
├── scripts/
│   ├── memory-db.js                # NEW: SQLite memory layer
│   ├── memory-search.js            # NEW: Search functions
│   └── ...existing scripts...
├── skills/
│   ├── mem-search/                 # NEW: Memory search skill
│   │   └── SKILL.md
│   ├── knowledge/                  # NEW: Knowledge agent skill (Phase 3)
│   │   └── SKILL.md
│   └── ...existing skills...
└── ...
```
