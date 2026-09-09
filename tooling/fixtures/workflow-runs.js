'use strict';
// Fixture builder for Workflow run directories, shared by
// test-workflow-run-triage.js and test-stop-workflow-wall-note.js.
//
// Builds the layout the harness writes on disk, shaped from a real run read on
// 2026-09-08:
//
//   <projects>/<slug>/<sessionId>.jsonl                          the main transcript
//   <projects>/<slug>/<sessionId>/workflows/scripts/<name>-<wf>.js
//   <projects>/<slug>/<sessionId>/subagents/workflows/<wf>/journal.jsonl
//   <projects>/<slug>/<sessionId>/subagents/workflows/<wf>/agent-<id>.jsonl
//   <projects>/<slug>/<sessionId>/subagents/workflows/<wf>/agent-<id>.meta.json
//
// Rows copy the real shapes: a quota-wall row is an assistant row whose
// message.model is "<synthetic>" carrying the limit text, error "rate_limit"
// and apiErrorStatus 429; a user interrupt is a user row whose text is
// "[Request interrupted by user for tool use]". Agent files get an mtime an
// hour in the past unless asked otherwise, so a run reads as finished rather
// than in flight.

const fs = require('fs');
const path = require('path');

const WALL_TEXT = "You've hit your session limit · resets 5:50am (Europe/Bucharest)";

function iso(ms) { return new Date(ms).toISOString(); }

/**
 * agents: [{ id, key, journaled, marker: 'wall'|'interrupt'|'api'|null, secs, tools, missingTranscript }]
 * Returns { projects, slug, sessionDir, sessionId, transcriptPath, runDir, scriptPath }.
 */
function makeRun(projects, { slug = '-Users-someone-Code-proj', sessionId = 'sess-0001', runId = 'wf_00000000-000', name = 'fixture', agents = [], agentMtimeMs, startMs = Date.parse('2026-08-18T23:07:05.261Z'), withScript = true, withJournal = true } = {}) {
    const projDir = path.join(projects, slug);
    const sessionDir = path.join(projDir, sessionId);
    const runDir = path.join(sessionDir, 'subagents', 'workflows', runId);
    fs.mkdirSync(runDir, { recursive: true });
    const transcriptPath = path.join(projDir, sessionId + '.jsonl');
    if (!fs.existsSync(transcriptPath)) fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
    let scriptPath = null;
    if (withScript) {
        const sdir = path.join(sessionDir, 'workflows', 'scripts');
        fs.mkdirSync(sdir, { recursive: true });
        scriptPath = path.join(sdir, name + '-' + runId + '.js');
        fs.writeFileSync(scriptPath, "export const meta = { name: '" + name + "', description: 'fixture' }\nreturn 1\n");
    }
    const journal = [];
    const mtime = typeof agentMtimeMs === 'number' ? agentMtimeMs : Date.now() - 3600 * 1000;
    let t = startMs;
    for (const a of agents) {
        journal.push({ type: 'started', key: a.key || ('v2:' + a.id), agentId: a.id });
        if (a.missingTranscript) continue;
        const rows = [];
        const t0 = t;
        rows.push({ parentUuid: null, isSidechain: true, agentId: a.id, type: 'user', uuid: 'u-' + a.id, timestamp: iso(t0), message: { role: 'user', content: 'Repo: fixture. Do the thing for ' + a.id } });
        const tools = a.tools || 0;
        const secs = a.secs || 0;
        for (let i = 0; i < tools; i++) {
            const ti = t0 + Math.round(((i + 1) / (tools + 1)) * secs * 1000);
            rows.push({ isSidechain: true, agentId: a.id, type: 'assistant', uuid: 'a-' + a.id + '-' + i, timestamp: iso(ti), message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'toolu_' + i, name: 'Bash', input: { command: 'echo ' + i } }], usage: { input_tokens: 10, output_tokens: 5 } } });
            // A tool result that QUOTES a transcript row: the counter must not count it.
            rows.push({ isSidechain: true, agentId: a.id, type: 'user', uuid: 'r-' + a.id + '-' + i, timestamp: iso(ti + 10), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_' + i, content: '{"type":"tool_use","name":"Bash"} echoed back' }] } });
        }
        const tEnd = t0 + secs * 1000;
        if (a.marker === 'wall') {
            rows.push({ isSidechain: true, agentId: a.id, type: 'assistant', uuid: 'w-' + a.id, timestamp: iso(tEnd), message: { id: 'm-' + a.id, model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', type: 'message', usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'text', text: WALL_TEXT }] }, error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429 });
        } else if (a.marker === 'api') {
            rows.push({ isSidechain: true, agentId: a.id, type: 'assistant', uuid: 'w-' + a.id, timestamp: iso(tEnd), message: { id: 'm-' + a.id, model: '<synthetic>', role: 'assistant', type: 'message', usage: {}, content: [{ type: 'text', text: 'API Error: 529 overloaded' }] }, error: 'overloaded', isApiErrorMessage: true, apiErrorStatus: 529 });
        } else if (a.marker === 'interrupt') {
            rows.push({ isSidechain: true, agentId: a.id, type: 'user', uuid: 'i-' + a.id, timestamp: iso(tEnd), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
        } else {
            rows.push({ isSidechain: true, agentId: a.id, type: 'assistant', uuid: 'e-' + a.id, timestamp: iso(tEnd), message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 5 } } });
        }
        const file = path.join(runDir, 'agent-' + a.id + '.jsonl');
        fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
        fs.writeFileSync(path.join(runDir, 'agent-' + a.id + '.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }));
        fs.utimesSync(file, new Date(mtime), new Date(mtime));
        if (a.journaled) journal.push({ type: 'result', key: a.key || ('v2:' + a.id), agentId: a.id, result: { ok: true, from: a.id } });
        t = tEnd + 1000;
    }
    if (withJournal) {
        const jp = path.join(runDir, 'journal.jsonl');
        fs.writeFileSync(jp, journal.map((r) => JSON.stringify(r)).join('\n') + '\n');
        fs.utimesSync(jp, new Date(mtime), new Date(mtime));
    }
    return { projects, slug, sessionDir, sessionId, transcriptPath, runDir, scriptPath, runId };
}

module.exports = { makeRun, WALL_TEXT };
