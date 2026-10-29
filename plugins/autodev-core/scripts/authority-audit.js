#!/usr/bin/env node
'use strict';
// Replay settled workers against the current policy, using their recorded launch scope.
// Stream tool_use IDs are joined to tool_result IDs, never to nearby text or exit 0.
// Missing results and ambiguous errors are unknown, never evidence of zero escapes.
// Schedule as {id:"authority-audit",script:"authority-audit.js",everyMin:60}.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const policy = require('./worker-authority.js');
const { configDir } = require('./claude-paths.js');
const TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'PowerShell']);
const runKey = (r) => `${r.code}@${r.startedAt}`;

function auditRun(rec) {
    const row = { at: rec.startedAt, auditedAt: new Date().toISOString(), runKey: runKey(rec), callsChecked: 0, denials: 0, escapes: 0, unknown: 0, complete: false };
    try {
        if (!rec.cwd || !rec.profile || !Array.isArray(rec.tools) || !Array.isArray(rec.secrets)) throw new Error('missing launch scope');
        const auth = policy.resolveAuthority(rec.profile, { tools: rec.tools, cwd: rec.cwd, reportDir: rec.report ? path.dirname(rec.report) : null, secrets: rec.secrets });
        const text = fs.readFileSync(rec.log, 'utf8');
        const calls = new Map();
        const results = new Map();
        let ended = false;
        let resultEvent = false;
        let malformed = false;
        for (const line of text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
            if (/^CLAUDE_EXIT=-?\d+$/.test(line)) { ended = true; continue; }
            if (!line.startsWith('{')) continue; // supervisor diagnostics and stderr
            let e;
            try { e = JSON.parse(line); } catch { malformed = true; continue; }
            if (e.type === 'result') resultEvent = true;
            const blocks = e.message && e.message.content;
            if (!Array.isArray(blocks)) continue;
            for (const b of blocks) {
                if (e.type === 'assistant' && b.type === 'tool_use' && TOOLS.has(b.name)) {
                    if (!b.id || !b.input || typeof b.input !== 'object') { malformed = true; continue; }
                    if (calls.has(b.id) && JSON.stringify(calls.get(b.id)) !== JSON.stringify(b)) malformed = true;
                    calls.set(b.id, b);
                }
                if (e.type === 'user' && b.type === 'tool_result') {
                    if (!b.tool_use_id || results.has(b.tool_use_id)) malformed = true;
                    results.set(b.tool_use_id, { block: b, execution: e.tool_use_result });
                }
            }
        }
        for (const [id, call] of calls) {
            row.callsChecked++;
            const denied = policy.decide({ tool_name: call.name, tool_input: call.input, cwd: rec.cwd }, auth).decision === 'deny';
            if (denied) row.denials++;
            const result = results.get(id);
            if (!result) { row.unknown++; continue; }
            const b = result.block;
            const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            const execution = result.execution;
            const executed = execution && typeof execution === 'object' && ('stdout' in execution || 'exitCode' in execution);
            const blocked = !executed && b.is_error === true && /worker-authority denied |permission to use .* (denied|rejected)|tool use (was )?rejected/i.test(content || '');
            const ran = executed || b.is_error !== true;
            if (!blocked && !ran) row.unknown++;
            if (denied && ran) row.escapes++;
        }
        row.complete = ended && resultEvent && !malformed && row.unknown === 0;
        if (!row.complete) row.why = !ended || !resultEvent ? 'no complete transcript ending' : malformed ? 'malformed transcript' : 'unresolved tool results';
    } catch (e) { row.why = e.code || e.message; }
    return row;
}

function main(argv) {
    if (argv.includes('--help')) { console.log('Usage: node authority-audit.js [--json]'); return 0; }
    const home = process.env.BRAIN_CLOCK_CLAUDE_DIR || configDir();
    const dir = path.join(home, 'autodev', 'windows');
    const log = path.join(dir, 'authority-audit.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    let lock;
    try { lock = fs.openSync(log + '.lock', 'wx'); } catch (e) { if (e.code === 'EEXIST') return 0; throw e; }
    try {
        const ledger = JSON.parse(fs.readFileSync(path.join(home, 'autodev', 'headless-workers.json'), 'utf8'));
        if (!Array.isArray(ledger.records)) throw new Error('invalid headless ledger');
        const prior = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
        const seen = new Set(prior.map((r) => r.runKey));
        const policyHash = crypto.createHash('sha256').update(fs.readFileSync(require.resolve('./worker-authority.js'))).digest('hex');
        const rows = ledger.records.filter((r) => r.state === 'settled' && !seen.has(runKey(r))).map((r) => ({ ...auditRun(r), policyHash }));
        for (const row of rows) fs.appendFileSync(log, JSON.stringify(row) + '\n');
        if (argv.includes('--json')) console.log(JSON.stringify(rows));
        return rows.some((r) => !r.complete || r.escapes > 0) ? 1 : 0;
    } finally { fs.closeSync(lock); fs.unlinkSync(log + '.lock'); }
}
if (require.main === module) {
    try { process.exitCode = main(process.argv.slice(2)); }
    catch (e) { console.error(`authority-audit: ${e.code || e.message}`); process.exitCode = 2; }
}
module.exports = { auditRun, main };
