---
name: telemetry
description: Show token / tool usage stats from the local telemetry log. Use when you want to know "which tools am I burning context on", "which skills are expensive", or "was yesterday's session mostly Read/Grep or actually productive".
when_to_use: "Invoked when the user says \"telemetry\", \"usage stats\", \"tool stats\", \"token stats\"."
allowed-tools: Bash, Read, Glob
model: haiku
user-invocable: true
argument-hint: "[today|week|month|all]"
---

# Telemetry

Local stats from `.claude/reports/telemetry-*.jsonl` — written by the `hooks/telemetry.js` PostToolUse hook. Privacy-safe: metadata only, no tool input/output contents.

## Log format

One JSONL file per day at `.claude/reports/telemetry-YYYY-MM-DD.jsonl`. Each line:

```json
{"ts":"2026-04-22T20:00:00.000Z","session":"abc123","cwd":"C:\\Users\\...","tool":"Bash","input_size":127,"output_size":842,"ok":true}
```

Fields captured:
- `ts` — event timestamp (ISO 8601)
- `session` — session ID if available from auto-dev memory system
- `cwd` — working directory (for per-project breakdown)
- `tool` — name of the tool that fired (Bash, Read, Edit, Agent, etc.)
- `input_size` — bytes of tool input
- `output_size` — bytes of tool output
- `ok` — heuristic success flag

**What's NOT captured:** tool input/output contents, file paths, bash commands. Privacy-safe by design.

## On "telemetry" or "tool stats"

### Default (today)

```bash
DAY=$(date +%Y-%m-%d)
FILE=".claude/reports/telemetry-$DAY.jsonl"
if [ ! -f "$FILE" ]; then
  echo "No telemetry for today. Hook fires on every tool call — try a few commands and check back."
  exit 0
fi

echo "=== Today ($DAY) ==="
wc -l < "$FILE" | xargs -I {} echo "Events: {}"
echo ""
echo "Top tools by event count:"
node -e "
  const fs = require('fs');
  const lines = fs.readFileSync('$FILE', 'utf8').trim().split('\n').filter(Boolean);
  const counts = {};
  const bytes = {};
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      counts[e.tool] = (counts[e.tool] || 0) + 1;
      bytes[e.tool] = (bytes[e.tool] || 0) + (e.input_size || 0) + (e.output_size || 0);
    } catch {}
  }
  Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([tool, n]) => {
    const kb = Math.round((bytes[tool] || 0) / 1024);
    console.log('  ' + tool.padEnd(15), n, 'calls,', kb, 'KB');
  });
"
```

### Week view

```bash
FILES=$(ls .claude/reports/telemetry-*.jsonl 2>/dev/null | tail -7)
[ -z "$FILES" ] && { echo "No telemetry files."; exit 0; }
cat $FILES | node -e "
  const lines = require('fs').readFileSync('/dev/stdin', 'utf8').trim().split('\n').filter(Boolean);
  const byDay = {};
  const byTool = {};
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      const day = e.ts.slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
      byTool[e.tool] = (byTool[e.tool] || 0) + 1;
    } catch {}
  }
  console.log('=== Week ===');
  Object.entries(byDay).sort().forEach(([d, n]) => console.log(' ', d, '—', n, 'events'));
  console.log('');
  console.log('Top tools overall:');
  Object.entries(byTool).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([t, n]) => console.log('  ' + t.padEnd(15), n));
"
```

### Month / All

Same pattern; extend the `ls | tail -N` or use `cat .claude/reports/telemetry-*.jsonl`.

## Interpreting the output

- **Top 3 tools are Bash / Read / Grep:** normal exploration pattern. Fine.
- **Top 3 tools are Edit / Write / Bash:** active development session. Fine.
- **Top tool is Read with huge KB:** you're re-reading the same files. Consider caching via memory skill or tighter Grep.
- **`ok: false` rate >20%:** tool errors are common. Check which tool — usually Bash with bad commands or Read on missing files.
- **Agent events dominate input_size:** a subagent swarm is burning context. Audit / brainstorm with 7 agents can easily be 100+ KB per run.

## Upstream export

Set `CLAUDE_OTEL_ENDPOINT` env var to also POST each event to an OTLP-compatible HTTP endpoint:

```bash
# Windows
[Environment]::SetEnvironmentVariable('CLAUDE_OTEL_ENDPOINT', 'https://api.honeycomb.io/v1/logs', 'User')

# Or local collector
export CLAUDE_OTEL_ENDPOINT=http://localhost:4318/v1/logs
```

The hook uses OTLP JSON format with `service.name=claude-auto-dev`. Fire-and-forget, 500ms timeout — won't slow your session if endpoint is unreachable.

## Disable

```bash
export CLAUDE_TELEMETRY_DISABLED=1
```

Or remove the PostToolUse entry for `telemetry.js` from `~/.claude/settings.json`.

## Cleanup

```bash
# Keep last 30 days
find .claude/reports -name "telemetry-*.jsonl" -mtime +30 -delete
```

Also handled by the `clean` skill.

## Rules

- **Never** log tool input/output contents — metadata only
- **Always** exit 0 in the hook — telemetry informs, never blocks
- **500ms** cap on upstream HTTP — session cannot be slowed by a remote outage
- File size grows ~1KB per 10 tool calls — a heavy session = ~50KB/day. Retention is a non-issue.
