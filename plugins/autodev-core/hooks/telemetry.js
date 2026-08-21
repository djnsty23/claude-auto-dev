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
//
// 2026-08-19: the same porting bug was still live in two more fields. The
// PostToolUse payload is built by the CLI as
//   { hook_event_name, tool_name, tool_input, tool_response, tool_use_id,
//     duration_ms, session_id, cwd, ... }
// (read out of the shipping binary, v2.1.234 — there is no `tool_output` and no
// `tool_error`). Reading the 7.x names meant `output_size` was 0 and `ok` was
// true in 878 of 878 rows on this machine: the field that exists to record a
// FAILED tool call had never once fired. The legacy names are kept as a
// fallback so an older CLI keeps working, but the real key is read first.

const fs = require('fs');
const path = require('path');

try {
    if (process.env.CLAUDE_TELEMETRY_DISABLED === '1') process.exit(0);

    let data;
    try { data = JSON.parse(fs.readFileSync(0, 'utf8')); }
    catch { process.exit(0); }

    const toolInput = data.tool_input || {};
    const toolResponse = data.tool_response !== undefined ? data.tool_response : (data.tool_output || '');

    // Sizes only — never content. An object response is measured by its encoded
    // length, which is a size and not a leak.
    const sizeOf = (v) => {
        if (typeof v === 'string') return v.length;
        if (v === undefined || v === null) return 0;
        try { return JSON.stringify(v).length; } catch { return 0; }
    };

    // Failure signals, most explicit first. The string-prefix test is LAST on
    // purpose: a command whose stdout happens to begin "Error:" is not a failed
    // tool call, so it must never outrank a structured flag.
    const failed = (
        (toolResponse && typeof toolResponse === 'object' && toolResponse.is_error === true)
        || Boolean(data.tool_error)
        || (typeof toolResponse === 'string'
            && (toolResponse.startsWith('[error') || toolResponse.startsWith('Error: ')))
    );

    const event = {
        ts: new Date().toISOString(),
        // Payload first, env second: the env var is the 7.x carrier and is kept
        // only so an existing exporter setup does not silently change meaning.
        session: data.session_id || process.env.AUTO_DEV_SESSION_ID || null,
        cwd: process.cwd(),
        tool: data.tool_name || '',
        input_size: JSON.stringify(toolInput).length,
        output_size: sizeOf(toolResponse),
        // The CLI already measures this; throwing it away left the harness
        // unable to answer "which tool call is costing us wall-clock".
        duration_ms: typeof data.duration_ms === 'number' ? data.duration_ms : null,
        ok: !failed,
    };

    // One advisory rides along here rather than in a hook of its own. This hook
    // already spawns on every tool call, and a dedicated PostToolUse hook on
    // Bash would cost ~6.3 minutes of wall clock a day on this machine (64ms a
    // spawn, 5,923 Bash calls measured) to prevent a class costing about five.
    // It stays silent unless a FAILED Bash call carries the /tmp signature —
    // roughly 0.15% of calls — so "telemetry does not print" still holds where
    // that rule is load-bearing, which is the per-call cost of printing.
    // Both advisories collect into ONE stdout write. Two JSON objects on one
    // stream is not parseable output, so this must stay a single write however
    // many riders are added later.
    const notes = [];

    try {
        if (failed) {
            const { adviseOnToolFailure } = require(path.join(__dirname, '..', 'scripts', 'tool-failure-advisory.js'));
            const advice = adviseOnToolFailure(event.tool, toolResponse, failed);
            if (advice) notes.push(advice.advice);
        }
    } catch { /* an advisory must never be why a tool call failed */ }

    // Second rider, same reasoning as the first and the same measurement: after
    // a `git commit`, report the options-protocol queue. It shipped in 8.91.0 as
    // its own PostToolUse hook on Bash and that was the wrong shape by this
    // file's own note above — a measured ~56ms per Bash call, every call, for a
    // report that fires only on commits.
    //
    // Gating is on the command because a hook matcher only ever sees the TOOL
    // name. The token skip is non-greedy so `git -C <path> commit` matches; an
    // options-only pattern missed exactly that shape, which is the common one
    // here.
    try {
        const cmd = (toolInput && typeof toolInput.command === 'string') ? toolInput.command : '';
        const isCommit = /(^|[;&|]|\s)git\s+(?:\S+\s+)*?commit\b/.test(cmd) && !/--dry-run\b/.test(cmd);
        if (event.tool === 'Bash' && isCommit) {
            const transcript = data.transcript_path || data.transcriptPath;
            if (transcript && fs.existsSync(transcript)) {
                const { report } = require(path.join(__dirname, '..', 'scripts', 'check-queue-drained.js'));
                const lines = [];
                report(transcript, (l) => lines.push(l));
                if (lines.length) notes.push(lines.join('\n'));
            } else {
                // Could-not-run is reported, never passed off as nothing to report.
                notes.push('[queue] NOT RUN after commit - no readable transcript.');
            }
        }
    } catch { /* the queue report must never be why a commit looks failed */ }

    if (notes.length) {
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notes.join('\n\n') },
        }));
    }

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
                                { key: 'duration_ms', value: { intValue: event.duration_ms || 0 } },
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
