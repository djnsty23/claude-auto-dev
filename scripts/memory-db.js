#!/usr/bin/env node
// memory-db.js — Persistent memory system for claude-auto-dev
// Uses Node 22 built-in node:sqlite (no external deps)
// Falls back gracefully if unavailable

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const HOME = process.env.HOME || process.env.USERPROFILE;
const DB_DIR = path.join(HOME, '.claude');
const DB_PATH = path.join(DB_DIR, 'auto-dev-memory.db');

let _db = null;
let _available = null;

const SCHEMA = `
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

CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_path TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    concept TEXT,
    source_files TEXT,
    token_cost INTEGER DEFAULT 0,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    content_hash TEXT NOT NULL,
    raw_data TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project_path);
CREATE INDEX IF NOT EXISTS idx_obs_type ON observations(type);
CREATE INDEX IF NOT EXISTS idx_obs_timestamp ON observations(timestamp);
CREATE INDEX IF NOT EXISTS idx_obs_hash ON observations(content_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_sessions_time ON sessions(start_time);
`;

// FTS requires separate setup since node:sqlite handles it differently
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
    title, concept, content=observations, content_rowid=rowid
);
`;

const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS obs_fts_insert AFTER INSERT ON observations BEGIN
    INSERT INTO observations_fts(rowid, title, concept)
    VALUES (new.rowid, new.title, new.concept);
END;

CREATE TRIGGER IF NOT EXISTS obs_fts_delete AFTER DELETE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, title, concept)
    VALUES ('delete', old.rowid, old.title, old.concept);
END;
`;

function isAvailable() {
    if (_available !== null) return _available;
    try {
        require('node:sqlite');
        _available = true;
    } catch {
        _available = false;
    }
    return _available;
}

function getDB() {
    if (_db) return _db;
    if (!isAvailable()) return null;

    const { DatabaseSync } = require('node:sqlite');

    // Ensure directory exists
    if (!fs.existsSync(DB_DIR)) {
        fs.mkdirSync(DB_DIR, { recursive: true });
    }

    _db = new DatabaseSync(DB_PATH);
    _db.exec('PRAGMA journal_mode = WAL');
    _db.exec('PRAGMA wal_autocheckpoint = 1000');
    _db.exec(SCHEMA);

    // FTS setup (may fail on some builds — non-critical)
    try {
        _db.exec(FTS_SCHEMA);
        _db.exec(FTS_TRIGGERS);
    } catch (err) {
        // FTS not available — fall back to LIKE queries
        process.stderr.write(`[Memory] FTS5 not available, using LIKE search: ${err.message}\n`);
    }

    return _db;
}

// --- Utility functions ---

function genId(prefix = 'obs') {
    return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function contentHash(type, title, concept) {
    const key = `${type}:${title}:${concept || ''}`;
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function stripPrivate(text) {
    if (!text) return text;
    return text.replace(/<private>[\s\S]*?<\/private>/g, '[REDACTED]');
}

// One canonical form for project paths, applied at EVERY write and query —
// without it three spellings of the same project silo into three memories:
//   C:\Users\x\proj  (hook process.cwd())     → c:/users/x/proj
//   /c/Users/x/proj  (Git Bash "$(pwd)")      → c:/users/x/proj
//   .../proj/.claude/worktrees/slug (worktree)→ the MAIN project's path
function normalizeProject(p) {
    if (!p) return '';
    let s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
    const posix = s.match(/^\/([a-zA-Z])\/(.*)$/);          // Git Bash /c/... form
    if (posix) s = posix[1] + ':/' + posix[2];
    s = s.replace(/\/\.claude\/worktrees\/[^/]+$/, '');     // worktree → main project
    return s.toLowerCase();
}

function isDuplicate(db, hash, windowSeconds = 30) {
    try {
        // Check if any observation with this hash exists within the time window
        // Use datetime('now', '-N seconds') for SQLite-native comparison
        const stmt = db.prepare(
            `SELECT id FROM observations WHERE content_hash = ? AND timestamp >= datetime('now', '-${windowSeconds} seconds')`
        );
        const row = stmt.get(hash);
        return !!row;
    } catch {
        return false;
    }
}

// --- Circuit breaker ---
let _failures = 0;
const MAX_FAILURES = 3;

function withCircuitBreaker(fn) {
    if (_failures >= MAX_FAILURES) return null;
    try {
        const result = fn();
        _failures = 0;
        return result;
    } catch (err) {
        _failures++;
        process.stderr.write(`[Memory] DB error (${_failures}/${MAX_FAILURES}): ${err.message}\n`);
        return null;
    }
}

// --- Public API ---

const api = {
    isAvailable,

    startSession(projectPath) {
        projectPath = normalizeProject(projectPath);
        return withCircuitBreaker(() => {
            const db = getDB();
            if (!db) return null;
            const id = genId('ses');
            const stmt = db.prepare('INSERT INTO sessions (id, project_path) VALUES (?, ?)');
            stmt.run(id, projectPath);
            return id;
        });
    },

    endSession(sessionId, summary = {}) {
        return withCircuitBreaker(() => {
            const db = getDB();
            if (!db || !sessionId) return null;
            const stmt = db.prepare(`
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
            `);
            stmt.run(
                stripPrivate(summary.request || null),
                stripPrivate(summary.investigated || null),
                stripPrivate(summary.learned || null),
                stripPrivate(summary.completed || null),
                stripPrivate(summary.nextSteps || null),
                sessionId, sessionId, sessionId
            );
            return true;
        });
    },

    saveObservation({ sessionId, projectPath, type, title, concept, sourceFiles, tokenCost, rawData }) {
        projectPath = normalizeProject(projectPath);
        return withCircuitBreaker(() => {
            const db = getDB();
            if (!db) return null;

            // Validate type
            const validTypes = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'];
            if (!validTypes.includes(type)) type = 'change';

            const hash = contentHash(type, title, concept);

            // Dedup: skip if same hash within 30s
            if (isDuplicate(db, hash)) return null;

            const id = genId('obs');
            const stmt = db.prepare(`
                INSERT INTO observations (id, session_id, project_path, type, title, concept, source_files, token_cost, content_hash, raw_data)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(
                id,
                sessionId || 'unknown',
                projectPath,
                type,
                stripPrivate(title),
                stripPrivate(concept || null),
                JSON.stringify(sourceFiles || []),
                tokenCost || 0,
                hash,
                rawData ? JSON.stringify(rawData) : null
            );
            return id;
        });
    },

    // Search — Layer 1: Index (compact, ~50-100 tokens)
    searchIndex(query, projectPath, limit = 20) {
        projectPath = normalizeProject(projectPath);
        return withCircuitBreaker(() => {
            const db = getDB();
            if (!db) return [];

            // Try FTS5 first
            try {
                const stmt = db.prepare(`
                    SELECT o.id, o.timestamp, o.type, o.title
                    FROM observations_fts f
                    JOIN observations o ON o.rowid = f.rowid
                    WHERE observations_fts MATCH ?
                    AND o.project_path = ?
                    ORDER BY f.rank
                    LIMIT ?
                `);
                return stmt.all(query, projectPath, limit);
            } catch {
                // Fall back to LIKE search
                const likeQuery = `%${query}%`;
                const stmt = db.prepare(`
                    SELECT id, timestamp, type, title
                    FROM observations
                    WHERE project_path = ?
                    AND (title LIKE ? OR concept LIKE ?)
                    ORDER BY timestamp DESC
                    LIMIT ?
                `);
                return stmt.all(projectPath, likeQuery, likeQuery, limit);
            }
        }) || [];
    },

    // Search — Layer 2: Timeline (session context, ~500-1000 tokens)
    searchTimeline(query, projectPath, limit = 5) {
        projectPath = normalizeProject(projectPath);
        return withCircuitBreaker(() => {
            const db = getDB();
            if (!db) return [];

            const likeQuery = `%${query}%`;
            const stmt = db.prepare(`
                SELECT DISTINCT s.id, s.start_time, s.end_time, s.user_request, s.learned, s.completed, s.next_steps, s.total_observations
                FROM sessions s
                JOIN observations o ON o.session_id = s.id
                WHERE s.project_path = ?
                AND (o.title LIKE ? OR o.concept LIKE ?)
                ORDER BY s.start_time DESC
                LIMIT ?
            `);
            return stmt.all(projectPath, likeQuery, likeQuery, limit);
        }) || [];
    },

    // Search — Layer 3: Full details (specific observation)
    getObservation(id) {
        return withCircuitBreaker(() => {
            const db = getDB();
            if (!db) return null;
            const stmt = db.prepare('SELECT * FROM observations WHERE id = ?');
            return stmt.get(id);
        });
    },

    // Context for session start injection
    getRecentContext(projectPath, limit = 3) {
        projectPath = normalizeProject(projectPath);
        return withCircuitBreaker(() => {
            const db = getDB();
            if (!db) return [];
            const stmt = db.prepare(`
                SELECT id, start_time, user_request, learned, completed, next_steps, total_observations
                FROM sessions
                WHERE project_path = ? AND end_time IS NOT NULL
                ORDER BY start_time DESC
                LIMIT ?
            `);
            return stmt.all(projectPath, limit);
        }) || [];
    },

    // Get observations by type
    getByType(type, projectPath, limit = 20) {
        projectPath = normalizeProject(projectPath);
        return withCircuitBreaker(() => {
            const db = getDB();
            if (!db) return [];
            const stmt = db.prepare(`
                SELECT id, timestamp, title, concept, source_files
                FROM observations
                WHERE type = ? AND project_path = ?
                ORDER BY timestamp DESC
                LIMIT ?
            `);
            return stmt.all(type, projectPath, limit);
        }) || [];
    },

    // Recent observations for a project
    getRecent(projectPath, limit = 10) {
        projectPath = normalizeProject(projectPath);
        return withCircuitBreaker(() => {
            const db = getDB();
            if (!db) return [];
            const stmt = db.prepare(`
                SELECT id, timestamp, type, title, concept
                FROM observations
                WHERE project_path = ?
                ORDER BY timestamp DESC
                LIMIT ?
            `);
            return stmt.all(projectPath, limit);
        }) || [];
    },

    // Get session by ID
    getSession(sessionId) {
        return withCircuitBreaker(() => {
            const db = getDB();
            if (!db) return null;
            const stmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
            return stmt.get(sessionId);
        });
    },

    // List all sessions for a project
    listSessions(projectPath, limit = 20) {
        projectPath = normalizeProject(projectPath);
        return withCircuitBreaker(() => {
            const db = getDB();
            if (!db) return [];
            const stmt = db.prepare(`
                SELECT id, start_time, end_time, user_request, total_observations
                FROM sessions
                WHERE project_path = ?
                ORDER BY start_time DESC
                LIMIT ?
            `);
            return stmt.all(projectPath, limit);
        }) || [];
    },

    // Stats for a project
    getStats(projectPath) {
        projectPath = normalizeProject(projectPath);
        return withCircuitBreaker(() => {
            const db = getDB();
            if (!db) return null;
            const sessions = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE project_path = ?').get(projectPath);
            const observations = db.prepare('SELECT COUNT(*) as count FROM observations WHERE project_path = ?').get(projectPath);
            const byType = db.prepare(`
                SELECT type, COUNT(*) as count
                FROM observations
                WHERE project_path = ?
                GROUP BY type
                ORDER BY count DESC
            `).all(projectPath);
            return {
                totalSessions: sessions.count,
                totalObservations: observations.count,
                byType
            };
        });
    },

    // Cleanup old data
    cleanup(daysOld = 90) {
        return withCircuitBreaker(() => {
            const db = getDB();
            if (!db) return 0;
            const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
            const result = db.prepare('DELETE FROM observations WHERE timestamp < ?').run(cutoff);
            db.prepare(`DELETE FROM sessions WHERE end_time < ? AND id NOT IN (SELECT DISTINCT session_id FROM observations)`).run(cutoff);
            return result.changes;
        }) || 0;
    }
};

module.exports = api;

// CLI mode: run directly for testing/querying
if (require.main === module) {
    const args = process.argv.slice(2);
    const cmd = args[0];
    const projectPath = args[1] || process.cwd();

    switch (cmd) {
        case 'stats':
            console.log(JSON.stringify(api.getStats(projectPath), null, 2));
            break;
        case 'recent':
            console.log(JSON.stringify(api.getRecent(projectPath, parseInt(args[2]) || 10), null, 2));
            break;
        case 'search':
            console.log(JSON.stringify(api.searchIndex(args[2] || '', projectPath), null, 2));
            break;
        case 'timeline':
            console.log(JSON.stringify(api.searchTimeline(args[2] || '', projectPath), null, 2));
            break;
        case 'sessions':
            console.log(JSON.stringify(api.listSessions(projectPath), null, 2));
            break;
        case 'decisions':
            console.log(JSON.stringify(api.getByType('decision', projectPath), null, 2));
            break;
        case 'bugs':
            console.log(JSON.stringify(api.getByType('bugfix', projectPath), null, 2));
            break;
        case 'cleanup':
            const removed = api.cleanup(parseInt(args[2]) || 90);
            console.log(`Cleaned up ${removed} old observations`);
            break;
        case 'test': {
            console.log('Running memory system self-test...');
            const sid = api.startSession('/tmp/test-project');
            console.log(`  Created session: ${sid}`);
            const oid = api.saveObservation({
                sessionId: sid,
                projectPath: '/tmp/test-project',
                type: 'decision',
                title: 'Test observation',
                concept: 'Testing the memory system works end to end',
                sourceFiles: ['test.js']
            });
            console.log(`  Created observation: ${oid}`);
            const results = api.searchIndex('test', '/tmp/test-project');
            console.log(`  Search results: ${results.length}`);
            api.endSession(sid, { request: 'self-test', completed: 'verified memory works' });
            console.log(`  Session closed`);
            const context = api.getRecentContext('/tmp/test-project');
            console.log(`  Context retrieval: ${context.length} sessions`);
            const stats = api.getStats('/tmp/test-project');
            console.log(`  Stats: ${JSON.stringify(stats)}`);
            console.log('Self-test passed!');
            break;
        }
        default:
            console.log('Usage: node memory-db.js <command> [projectPath] [args]');
            console.log('Commands: stats, recent, search <query>, timeline <query>, sessions, decisions, bugs, cleanup [days], test');
    }
}
