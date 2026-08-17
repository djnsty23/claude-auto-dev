#!/usr/bin/env node
// PostToolUse hook — lightweight local telemetry.
//
// Writes one JSON line per tool call to .claude/reports/telemetry-YYYY-MM-DD.jsonl.
// Metadata only: timestamp, session, cwd, tool name, input/output SIZES, ok.
// No tool input or output CONTENT is ever written, which is what makes it safe
// to leave on in a repo that handles credentials. The suite asserts that
// directly rather than trusting the comment.
//
// Disable with CLAUDE_TELEMETRY_DISABLED=1. Optional upstream OTLP export via
// CLAUDE_OTEL_ENDPOINT, fire-and-forget with a 500ms timeout.
//
// Exits 0 on every path including its own failure. Telemetry informs; it must
// never be the reason a tool call did not happen.
//
// Ported from the 7.x install on 2026-08-17. One behaviour change: the session
// id now comes from the hook payload. 7.x read AUTO_DEV_SESSION_ID, which 8.x
// does not set, so every event logged on this machine recorded "session": null
// and the field was dead.

const fs = require('fs');
const path = require('path');

try {
    if (process.env.CLAUDE_TELEMETRY_DISABLED === '1') process.exit(0);

    let data;
    try { data = JSON.parse(fs.readFileSync(0, 'utf8')); }
    catch { process.exit(0); }

    const toolInput = data.tool_input || {};
    const toolOutput = data.tool_output || '';

    const event = {
        ts: new Date().toISOString(),
        // Payload first, env second: the env var is the 7.x carrier and is kept
        // only so an existing exporter setup does not silently change meaning.
        session: data.session_id || process.env.AUTO_DEV_SESSION_ID || null,
        cwd: process.cwd(),
        tool: data.tool_name || '',
        input_size: JSON.stringify(toolInput).length,
        output_size: typeof toolOutput === 'string' ? toolOutput.length : JSON.stringify(toolOutput || '').length,
        ok: !(data.tool_error || (typeof toolOutput === 'string' && toolOutput.startsWith('[error'))),
    };

    try {
        const dir = path.join(process.cwd(), '.claude', 'reports');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, `telemetry-${event.ts.slice(0, 10)}.jsonl`), JSON.stringify(event) + '\n');
    } catch { /* a full disk must not break the session */ }

    const endpoint = process.env.CLAUDE_OTEL_ENDPOINT;
    if (endpoint) {
        try {
            const http = endpoint.startsWith('https:') ? require('https') : require('http');
            const url = new URL(endpoint);
            const body = JSON.stringify({
                resourceLogs: [{
                    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-auto-dev' } }] },
                    scopeLogs: [{
                        logRecords: [{
                            timeUnixNano: String(Date.now() * 1000000),
                            severityText: 'INFO',
                            body: { stringValue: JSON.stringify(event) },
                            attributes: [
                                { key: 'tool', value: { stringValue: event.tool } },
                                { key: 'session', value: { stringValue: event.session || '' } },
                                { key: 'cwd', value: { stringValue: event.cwd } },
                                { key: 'input_size', value: { intValue: event.input_size } },
                                { key: 'output_size', value: { intValue: event.output_size } },
                                { key: 'ok', value: { boolValue: event.ok } },
                            ],
                        }],
                    }],
                }],
            });
            const req = http.request({
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                timeout: 500,
            }, () => {});
            req.on('error', () => {});
            req.on('timeout', () => req.destroy());
            req.write(body);
            req.end();
        } catch { /* unreachable or malformed endpoint — never block */ }
    }
} catch { /* deliberately silent: a hook that prints costs context on every call */ }

process.exit(0);
