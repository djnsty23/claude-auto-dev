#!/usr/bin/env node
// SessionEnd hook (autodev-memory) — close this session's memory session and
// record a summary of what it accomplished.
//
// This runs on SessionEnd, NOT Stop. Stop fires at the end of every assistant
// turn: closing the session there ended it after turn one and deleted the
// carrier file, so every later turn's observations were silently dropped. A
// memory session must span the whole Claude session.
//
// Emits no decision payload — autodev-core owns the Stop decision. Exits 0.

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

function readPayload() {
    try {
        if (process.stdin.isTTY) return {};
        return JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        return {};
    }
}

const payload = readPayload();
const cwd = payload.cwd || process.cwd();
const harnessSessionId = payload.session_id || null;

try {
    const memDbPath = path.join(PLUGIN_ROOT, 'scripts', 'memory-db.js');
    if (fs.existsSync(memDbPath)) {
        const carrier = require(path.join(PLUGIN_ROOT, 'scripts', 'session-carrier.js'));
        const sessionId = carrier.read(cwd, harnessSessionId);
        const memDB = require(memDbPath);

        if (sessionId && memDB.isAvailable()) {
            // Read prd.json for session summary context
            let summary = {};
            const prdPath = path.join(cwd, 'prd.json');
            if (fs.existsSync(prdPath)) {
                try {
                    const prd = JSON.parse(fs.readFileSync(prdPath, 'utf8'));
                    const entries = Object.entries(prd.stories || {});
                    const done = entries.filter(([, v]) => v.passes === true);
                    // DELIBERATE DUPLICATE of autodev-core's prd-states.js
                    // isOutstanding(). ${CLAUDE_PLUGIN_ROOT} resolves per plugin, so
                    // this plugin cannot require that file — if core needs a file,
                    // core ships it, and the same applies here. Marked so the two
                    // are changed together rather than drifting silently.
                    //
                    // isOutstanding, not isActionable: this summary is a REPORT a
                    // later session reads, and prd-states.js says isOutstanding
                    // "is the predicate reports and dashboards want" — a
                    // `needs-setup` story is blocked on a human, but the human is
                    // still on the hook for it, so a report that omits it says the
                    // project is finished while it is waiting on the operator.
                    const pending = entries.filter(([, v]) => v.passes === null || v.passes === false || v.passes === undefined || v.passes === 'needs-setup');
                    let completed = done.map(([k, v]) => `${k}: ${v.title}`).join('; ');
                    // COMPLETED WORK LEAVES prd.stories. archive-prd moves finished
                    // stories to .claude/archives/ and records only a running total
                    // here, so a summary over `stories` alone recorded almost
                    // nothing for a project that had shipped 159 of them. Count,
                    // not story list — the archive keeps no per-story detail.
                    if (prd.archived && typeof prd.archived === 'object') {
                        const nArch = Number(prd.archived.totalCompleted);
                        const note = Number.isFinite(nArch) && nArch >= 0
                            ? `(+${nArch} archived)`
                            : '(archive present, count unreadable)';
                        completed = completed ? `${completed} ${note}` : note;
                    }
                    if (completed) summary.completed = completed;
                    if (pending.length > 0) {
                        summary.nextSteps = `${pending.length} tasks remaining: ${pending.map(([k]) => k).join(', ')}`;
                    }
                } catch { /* non-critical */ }
            }

            memDB.endSession(sessionId, summary);
        }

        // Clear only THIS session's carrier — other sessions on the same
        // project keep theirs.
        carrier.clear(cwd, harnessSessionId);
        carrier.clearPrompt(cwd, harnessSessionId);
    }
} catch (err) {
    // Memory close is non-critical — never interfere with session teardown.
    process.stderr.write(`[Memory] session close error: ${err.message}\n`);
}

process.exit(0);
