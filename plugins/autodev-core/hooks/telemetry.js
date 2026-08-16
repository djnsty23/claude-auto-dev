#!/usr/bin/env node
// PostToolUse hook - Lightweight telemetry exporter.
//
// OPT-IN: set AUTODEV_TELEMETRY=1 to enable. It was previously on by default,
// which meant every tool call in every project appended a line to a file the
// user never asked for. Writing to someone's repo should be a choice.
//
// Sink: local JSONL at .claude/reports/telemetry-YYYY-MM-DD.jsonl.
// Optional: set CLAUDE_OTEL_ENDPOINT to also POST each event upstream (OTLP JSON).
//
// Fields per event: ts, session, cwd, tool, input_size, output_size, ok.
// NO tool input/output contents are logged — metadata only. Privacy-safe.
//
// Design: exit 0 ALWAYS, fast path < 5ms. Never block a tool call.

const fs = require('fs');
const path = require('path');

try {
    // CLAUDE_TELEMETRY_DISABLED is still honoured so anyone who set it to opt
    // OUT under the old default keeps the behaviour they asked for.
    if (process.env.AUTODEV_TELEMETRY !== '1' || process.env.CLAUDE_TELEMETRY_DISABLED === '1') {
        process.exit(0);
    }

    const input = fs.readFileSync(0, 'utf8');
    let data;
    try {
        data = JSON.parse(input);
    } catch {
        process.exit(0);
    }

    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};
    const toolOutput = data.tool_output || '';

    // Crude byte size — avoids logging content
    const inputSize = JSON.stringify(toolInput).length;
    const outputSize = typeof toolOutput === 'string'
        ? toolOutput.length
        : JSON.stringify(toolOutput || '').length;

    const event = {
        ts: new Date().toISOString(),
        // From the hook payload. This used to read AUTO_DEV_SESSION_ID, an env
        // var nothing ever set, so every event was logged with session: null.
        session: data.session_id || null,
        cwd: data.cwd || process.cwd(),
        tool: toolName,
        input_size: inputSize,
        output_size: outputSize,
        // success = tool didn't return an error field (heuristic; hooks don't get structured error status)
        ok: !(data.tool_error || (typeof toolOutput === 'string' && toolOutput.startsWith('[error')))
    };

    // Local JSONL sink (zero-config, private)
    try {
        const reportsDir = path.join(event.cwd, '.claude', 'reports');
        fs.mkdirSync(reportsDir, { recursive: true });
        const day = new Date().toISOString().slice(0, 10);
        const file = path.join(reportsDir, `telemetry-${day}.jsonl`);
        fs.appendFileSync(file, JSON.stringify(event) + '\n');
    } catch {
        // Local write failed — keep going, don't block
    }

    // Optional upstream OTLP export
    const endpoint = process.env.CLAUDE_OTEL_ENDPOINT;
    if (endpoint) {
        // Fire-and-forget POST. Don't await. Don't block.
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
                                { key: 'ok', value: { boolValue: event.ok } }
                            ]
                        }]
                    }]
                }]
            });
            const req = http.request({
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                timeout: 500  // 500ms — don't slow the session
            }, () => {});
            req.on('error', () => {}); // swallow — never block
            req.on('timeout', () => req.destroy());
            req.write(body);
            req.end();
        } catch {
            // Endpoint unreachable, malformed URL, etc — don't block
        }
    }
} catch (err) {
    process.stderr.write(`telemetry error: ${err.message}\n`);
}

// Always exit 0 — telemetry informs, never blocks
process.exit(0);
