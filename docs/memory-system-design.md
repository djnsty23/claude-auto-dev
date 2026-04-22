# Memory System Technical Spec

> Detailed technical design for the claude-auto-dev persistent memory layer.

## Overview

A lightweight, file-based + SQLite memory system that captures observations during Claude Code sessions and makes them searchable across sessions. Designed to run entirely within Node.js hooks — no separate daemon required for Phase 1-2.

---

## Module: `scripts/memory-db.js`

### Initialization

```javascript
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.HOME || process.env.USERPROFILE;
const DB_PATH = path.join(HOME, '.claude', 'auto-dev-memory.db');

let _db = null;

function getDB() {
    if (_db) return _db;
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('wal_autocheckpoint = 1000'); // Prevent WAL bloat
    _db.exec(SCHEMA);
    return _db;
}
```

### Schema

```sql
-- Sessions: one per Claude Code session
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    start_time TEXT NOT NULL DEFAULT (datetime('now')),
    end_time TEXT,
    user_request TEXT,
    investigated TEXT,
    learned TEXT,
    completed TEXT,
    next_steps TEXT,
    total_observations INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0
);

-- Observations: individual knowledge units
CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_path TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
    title TEXT NOT NULL,
    concept TEXT,
    source_files TEXT,  -- JSON array
    token_cost INTEGER DEFAULT 0,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    content_hash TEXT NOT NULL,
    raw_data TEXT,      -- JSON blob for extensibility
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project_path);
CREATE INDEX IF NOT EXISTS idx_obs_type ON observations(type);
CREATE INDEX IF NOT EXISTS idx_obs_timestamp ON observations(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_obs_hash ON observations(content_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_sessions_time ON sessions(start_time DESC);

-- Full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
    title, concept,
    content=observations,
    content_rowid=rowid
);

-- FTS triggers to keep index in sync
CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
    INSERT INTO observations_fts(rowid, title, concept)
    VALUES (new.rowid, new.title, new.concept);
END;

CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, title, concept)
    VALUES ('delete', old.rowid, old.title, old.concept);
END;
```

### Core Functions

```javascript
// Generate unique IDs
function genId(prefix = 'obs') {
    return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

// Content hash for dedup (16-char SHA256)
function contentHash(type, title, concept) {
    const key = `${type}:${title}:${concept || ''}`;
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// Check for duplicate within time window
function isDuplicate(hash, windowSeconds = 30) {
    const db = getDB();
    const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString();
    const row = db.prepare(
        'SELECT id FROM observations WHERE content_hash = ? AND timestamp > ?'
    ).get(hash, cutoff);
    return !!row;
}

// Strip <private> tags
function stripPrivate(text) {
    if (!text) return text;
    return text.replace(/<private>[\s\S]*?<\/private>/g, '[REDACTED]');
}
```

### API

```javascript
module.exports = {
    // Session management
    startSession(projectPath) {
        const db = getDB();
        const id = genId('ses');
        db.prepare(
            'INSERT INTO sessions (id, project_path) VALUES (?, ?)'
        ).run(id, projectPath);
        return id;
    },

    endSession(sessionId, summary = {}) {
        const db = getDB();
        db.prepare(`
            UPDATE sessions SET
                end_time = datetime('now'),
                user_request = ?,
                investigated = ?,
                learned = ?,
                completed = ?,
                next_steps = ?,
                total_observations = (SELECT COUNT(*) FROM observations WHERE session_id = ?),
                total_tokens = (SELECT COALESCE(SUM(token_cost), 0) FROM observations WHERE session_id = ?)
            WHERE id = ?
        `).run(
            stripPrivate(summary.request),
            stripPrivate(summary.investigated),
            stripPrivate(summary.learned),
            stripPrivate(summary.completed),
            stripPrivate(summary.nextSteps),
            sessionId, sessionId, sessionId
        );
    },

    // Observation capture
    saveObservation({ sessionId, projectPath, type, title, concept, sourceFiles, tokenCost, rawData }) {
        const db = getDB();
        const hash = contentHash(type, title, concept);

        // Dedup: skip if same hash within 30s
        if (isDuplicate(hash)) return null;

        const id = genId('obs');
        db.prepare(`
            INSERT INTO observations (id, session_id, project_path, type, title, concept, source_files, token_cost, content_hash, raw_data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id, sessionId, projectPath, type,
            stripPrivate(title),
            stripPrivate(concept),
            JSON.stringify(sourceFiles || []),
            tokenCost || 0,
            hash,
            rawData ? JSON.stringify(rawData) : null
        );
        return id;
    },

    // Search — Layer 1: Index (compact)
    searchIndex(query, projectPath, limit = 20) {
        const db = getDB();
        return db.prepare(`
            SELECT o.id, o.timestamp, o.type, o.title
            FROM observations_fts f
            JOIN observations o ON o.rowid = f.rowid
            WHERE observations_fts MATCH ?
            AND o.project_path = ?
            ORDER BY rank
            LIMIT ?
        `).all(query, projectPath, limit);
    },

    // Search — Layer 2: Timeline (session context)
    searchTimeline(query, projectPath, limit = 5) {
        const db = getDB();
        // Find matching sessions
        const sessions = db.prepare(`
            SELECT DISTINCT s.id, s.start_time, s.user_request, s.learned, s.completed, s.next_steps
            FROM sessions s
            JOIN observations o ON o.session_id = s.id
            JOIN observations_fts f ON f.rowid = o.rowid
            WHERE observations_fts MATCH ?
            AND s.project_path = ?
            ORDER BY s.start_time DESC
            LIMIT ?
        `).all(query, projectPath, limit);

        return sessions;
    },

    // Search — Layer 3: Full details (specific observation)
    getObservation(id) {
        const db = getDB();
        return db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
    },

    // Context for session start
    getRecentContext(projectPath, limit = 3) {
        const db = getDB();
        return db.prepare(`
            SELECT id, start_time, user_request, learned, completed, next_steps
            FROM sessions
            WHERE project_path = ? AND end_time IS NOT NULL
            ORDER BY start_time DESC
            LIMIT ?
        `).all(projectPath, limit);
    },

    // Get observations by type
    getByType(type, projectPath, limit = 20) {
        const db = getDB();
        return db.prepare(`
            SELECT id, timestamp, title, concept, source_files
            FROM observations
            WHERE type = ? AND project_path = ?
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(type, projectPath, limit);
    },

    // Recent observations for a project
    getRecent(projectPath, limit = 10) {
        const db = getDB();
        return db.prepare(`
            SELECT id, timestamp, type, title, concept
            FROM observations
            WHERE project_path = ?
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(projectPath, limit);
    },

    // Cleanup: remove observations older than N days
    cleanup(daysOld = 90) {
        const db = getDB();
        const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
        const result = db.prepare('DELETE FROM observations WHERE timestamp < ?').run(cutoff);
        db.prepare('DELETE FROM sessions WHERE end_time < ? AND id NOT IN (SELECT DISTINCT session_id FROM observations)').run(cutoff);
        return result.changes;
    }
};
```

---

## Observation Classifier

### `scripts/observation-classifier.js`

Determines observation type from tool usage context:

```javascript
function classifyObservation(toolName, toolInput, toolResult, userPrompt) {
    // File operations
    if (toolName === 'Write' || toolName === 'Edit') {
        const filePath = toolInput.file_path || toolInput.path || '';
        const sourceFiles = [filePath];

        // New file = feature, existing = change
        if (toolName === 'Write') {
            return {
                type: 'feature',
                title: `Created ${path.basename(filePath)}`,
                concept: `New file added to project`,
                sourceFiles
            };
        }

        // Edit with fix keywords = bugfix
        const editContent = (toolInput.new_string || '').toLowerCase();
        const isFix = /fix|bug|error|crash|broken|issue|patch/.test(userPrompt?.toLowerCase() || '');
        if (isFix) {
            return {
                type: 'bugfix',
                title: `Fixed issue in ${path.basename(filePath)}`,
                concept: extractConcept(toolInput, userPrompt),
                sourceFiles
            };
        }

        return {
            type: 'change',
            title: `Modified ${path.basename(filePath)}`,
            concept: extractConcept(toolInput, userPrompt),
            sourceFiles
        };
    }

    // Bash commands
    if (toolName === 'Bash') {
        const cmd = toolInput.command || '';

        // Test runs
        if (/\b(test|jest|vitest|pytest|mocha)\b/.test(cmd)) {
            return {
                type: 'discovery',
                title: `Ran tests: ${cmd.slice(0, 60)}`,
                concept: toolResult?.includes('FAIL') ? 'Tests failing' : 'Tests passing',
                sourceFiles: []
            };
        }

        // Git operations
        if (/\bgit\s+(commit|push|merge)/.test(cmd)) {
            return {
                type: 'change',
                title: `Git: ${cmd.slice(0, 60)}`,
                concept: 'Version control operation',
                sourceFiles: []
            };
        }
    }

    // Read operations = discovery
    if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
        return {
            type: 'discovery',
            title: `Explored: ${(toolInput.file_path || toolInput.pattern || toolInput.query || '').slice(0, 60)}`,
            concept: `Investigated codebase structure`,
            sourceFiles: toolInput.file_path ? [toolInput.file_path] : []
        };
    }

    return null; // Don't capture unrecognized tools
}

function extractConcept(toolInput, userPrompt) {
    // Try to extract meaningful concept from context
    if (userPrompt) return userPrompt.slice(0, 200);
    if (toolInput.new_string) return `Changed to: ${toolInput.new_string.slice(0, 100)}`;
    return null;
}

module.exports = { classifyObservation };
```

---

## Hook Modifications

### session-start.js (additions)

After the existing git status section (~line 120), add:

```javascript
// ============================================================
// 6. Memory context injection
// ============================================================
try {
    const memDB = require(path.join(HOME, '.claude', 'scripts', 'memory-db'));
    const context = memDB.getRecentContext(process.cwd());
    if (context.length > 0) {
        console.log(`[Memory] ${context.length} past sessions for this project`);
        const last = context[0];
        if (last.next_steps) {
            console.log(`[Memory] Last session next steps: ${last.next_steps.slice(0, 150)}`);
        }
        if (last.learned) {
            console.log(`[Memory] Last learned: ${last.learned.slice(0, 150)}`);
        }
    }
} catch {
    // Memory system not yet installed or DB error — skip silently
}
```

### post-tool-typecheck.js (additions)

After existing typecheck logic, add observation capture:

```javascript
// ============================================================
// Observation capture (memory system)
// ============================================================
try {
    const memDB = require(path.join(HOME, '.claude', 'scripts', 'memory-db'));
    const classifier = require(path.join(HOME, '.claude', 'scripts', 'observation-classifier'));

    const sessionId = process.env.AUTO_DEV_SESSION_ID;
    if (sessionId) {
        const obs = classifier.classifyObservation(toolName, toolInput, toolResult, lastUserPrompt);
        if (obs) {
            memDB.saveObservation({
                sessionId,
                projectPath: process.cwd(),
                ...obs
            });
        }
    }
} catch {
    // Memory capture is non-critical — never block tool execution
}
```

### stop-auto-check.js (additions)

Before the final `process.exit(0)`, add session end:

```javascript
// ============================================================
// Session summarization (memory system)
// ============================================================
try {
    const sessionId = process.env.AUTO_DEV_SESSION_ID;
    if (sessionId) {
        const memDB = require(path.join(HOME, '.claude', 'scripts', 'memory-db'));
        memDB.endSession(sessionId, {
            // These will be populated by the session-end skill in Phase 2
            // For now, just close the session with timestamps
        });
    }
} catch {
    // Non-critical
}
```

---

## Skill: mem-search

### `skills/mem-search/SKILL.md`

```markdown
---
name: mem-search
description: Search project memory across sessions
triggers: ["mem search", "mem recent", "mem decisions", "mem timeline", "remember", "what did we"]
---

# Memory Search

Search the project's persistent memory database.

## Commands

- `mem search <query>` — Search observations by keyword
- `mem recent` — Last 10 observations for this project
- `mem decisions` — All architectural decisions
- `mem bugs` — All bug fixes
- `mem timeline` — Session history with summaries
- `mem session <id>` — Full details of a past session

## How It Works

Memory is stored in SQLite at ~/.claude/auto-dev-memory.db.
Observations are captured automatically during sessions.

## Progressive Disclosure

1. Start with `mem search <query>` for an overview (titles only)
2. Use `mem timeline` to see session context
3. Use `mem session <id>` for full details

This saves tokens by only loading what you need.

## Implementation

Read the database using the functions in ~/.claude/scripts/memory-db.js.
Use Bash to run queries:

```bash
node -e "
const db = require('$HOME/.claude/scripts/memory-db');
const results = db.searchIndex('auth middleware', process.cwd());
console.log(JSON.stringify(results, null, 2));
"
```
```

---

## Token Budget Guidelines

| Operation | Target | Max |
|-----------|--------|-----|
| Session start context injection | 100 tokens | 200 tokens |
| Single observation capture | 50 tokens | 100 tokens |
| Search index response | 100 tokens | 200 tokens |
| Search timeline response | 500 tokens | 1000 tokens |
| Full observation fetch | 500 tokens | 1000 tokens |
| Session summary | 200 tokens | 500 tokens |

**Total per-session overhead target:** <500 tokens for context injection + ~50 tokens per tool use for capture.

---

## Error Handling

All memory operations are wrapped in try/catch with silent failure:
- Memory system should NEVER block Claude Code
- Memory system should NEVER cause hook failures
- If the DB is locked or corrupt, skip and continue
- Log errors to stderr only (never stdout, which is the hook response)

```javascript
// Pattern for all memory operations in hooks
try {
    // memory operation
} catch (err) {
    process.stderr.write(`[Auto-Dev Memory] ${err.message}\n`);
    // Continue normally — memory is enhancement, not requirement
}
```

---

## Migration Path

If upgrading from a version without memory:
1. `memory-db.js` auto-creates tables on first `getDB()` call
2. No existing data to migrate — starts fresh
3. Old hooks continue to work (memory additions are additive)
4. Install adds `better-sqlite3` to dependencies

## Testing

```bash
# Unit test the memory module
node -e "
const db = require('./scripts/memory-db');
const sid = db.startSession('/tmp/test-project');
db.saveObservation({
    sessionId: sid,
    projectPath: '/tmp/test-project',
    type: 'decision',
    title: 'Test observation',
    concept: 'Testing the memory system',
    sourceFiles: ['test.js']
});
const results = db.searchIndex('test', '/tmp/test-project');
console.log('Search results:', results);
db.endSession(sid, { request: 'test', completed: 'verified memory works' });
console.log('Context:', db.getRecentContext('/tmp/test-project'));
"
```
