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
                    // DELIBERATE DUPLICATE of autodev-core's prd-states.js
                    // storiesOf(), for the same reason the state filter below is
                    // one: ${CLAUDE_PLUGIN_ROOT} resolves per plugin, so this
                    // plugin cannot require that file. Marked so the two are
                    // changed together rather than drifting silently.
                    //
                    // prd.json has two container shapes. This read the flat one
                    // alone, so a nested `{ sprints: [{ stories }] }` file wrote
                    // an EMPTY summary into memory for a full sprint — and unlike
                    // a crash, a later session reads that as "nothing happened".
                    // Every sprint, not just the newest: a story pending in an
                    // earlier sprint is still work the report must carry.
                    const sprints = Array.isArray(prd.sprints) ? prd.sprints : [];
                    let stories = null;
                    for (const sp of sprints) {
                        if (!sp || !sp.stories || typeof sp.stories !== 'object') continue;
                        stories = stories || {};
                        for (const [id, story] of Object.entries(sp.stories)) {
                            // Match core's reader: __proto__ is an own JSON
                            // story key, never a prototype mutation.
                            Object.defineProperty(stories, id, { value: story, enumerable: true, writable: true, configurable: true });
                        }
                    }
                    if (!stories) stories = (prd.stories && typeof prd.stories === 'object') ? prd.stories : {};
                    const entries = Object.entries(stories);
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
                    //
                    // ONE list of the outstanding states, used for BOTH the count
                    // and the breakdown, so the two cannot drift apart and a fifth
                    // state cannot be counted without also being named.
                    //
                    // `[measured 2026-09-11]` the filter here was already right and
                    // the LABEL was the defect: four outstanding stories in three
                    // different states rendered as
                    //   "4 tasks remaining: S1-002, S1-003, S1-005, S1-006"
                    // — the word FAILED appeared nowhere, and nothing said one of
                    // them was waiting on the operator. That is session-start.js's
                    // documented defect one plugin over, and CLAUDE.md records it as
                    // the costly one: the next session reads this line, picks up the
                    // story blocked on an API key, and burns a turn every run.
                    //
                    // The TOTAL is unchanged — a human is on the hook for all four.
                    // What changes is that a reader can tell which is which without
                    // opening prd.json. The three predicates are disjoint, so the
                    // groups partition the total rather than overlapping it.
                    const OUTSTANDING = [
                        ['pending', (v) => v.passes === null || v.passes === undefined],
                        ['FAILED, retry', (v) => v.passes === false],
                        ['BLOCKED ON SETUP, no agent can advance these', (v) => v.passes === 'needs-setup'],
                    ];
                    const pending = entries.filter(([, v]) => OUTSTANDING.some(([, match]) => match(v)));
                    const groups = OUTSTANDING
                        .map(([label, match]) => [label, pending.filter(([, v]) => match(v)).map(([k]) => k)])
                        .filter(([, ids]) => ids.length > 0);
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
                        summary.nextSteps = `${pending.length} tasks remaining: `
                            + groups.map(([label, ids]) => `${ids.length} ${label} (${ids.join(', ')})`).join('; ');
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
