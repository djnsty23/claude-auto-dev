---
name: telemetry
description: Show tool-usage stats from the local telemetry log — which tools a session burns context on, which days were busy, what failed. Use for "tool stats", "what did I spend context on", "which tools am I using most".
when_to_use: "Invoked when the user says \"telemetry\" or \"tool stats\", or asks where a session's context went."
allowed-tools: Bash, Read, Glob
model: haiku
user-invocable: true
---

# Telemetry

A PostToolUse hook writes one line per tool call to
`.claude/reports/telemetry-YYYY-MM-DD.jsonl`. **Metadata only** — timestamp,
session, cwd, tool name, input and output *sizes*, and whether the call
succeeded. No tool input or output content is ever written, which is what makes
it safe to leave on in a repo that handles credentials; the hook's suite asserts
that by feeding a canary secret through and grepping the log for it.

## Reading it

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/telemetry-report.js"           # today
node "${CLAUDE_PLUGIN_ROOT}/scripts/telemetry-report.js" --days=7  # the week
node "${CLAUDE_PLUGIN_ROOT}/scripts/telemetry-report.js" --days=0  # everything
```

It prints the event count, distinct tools, per-day totals, and a per-tool table
of calls and kilobytes, biggest first.

## Interpreting it

The number that usually matters is **KB per tool**, not calls. Fifty `Bash` calls
returning a line each are cheap; three `Read`s of a lockfile are not. A session
that feels slow and shows most of its bytes in `Read` is usually one where a
targeted `Grep` would have done.

`failed` counts in the last column are a rough signal — the hook infers success
from the absence of an error marker, so treat a nonzero count as "look at what
happened", not as an exact figure.

A day missing from the table means no tool calls were recorded, which is not the
same as no work: if the hook is disabled or not installed, every day is missing.
Check that the current day appears before drawing conclusions from a gap.

## Turning it off

Set `CLAUDE_TELEMETRY_DISABLED=1` in the environment. The hook checks it first
and exits before writing anything.

Do **not** edit the plugin's `hooks.json` in the installed tree to disable it —
installed plugin files are replaced wholesale on the next marketplace update, so
the change would silently come back.

## Upstream export

Set `CLAUDE_OTEL_ENDPOINT` to also POST each event as OTLP JSON. It is
fire-and-forget with a 500ms timeout: an unreachable collector cannot slow or
fail a tool call, and the local file is written either way.

## Proving the run

**Observable:** the event count and the number of files it read, printed before
any interpretation.

The report prints its own population for this reason — "Read is your top tool" is
a different claim over 40 events than over 4,000, and an empty log and a missing
hook produce the same silence. If the count is zero, say the hook may not be
running rather than reporting a quiet session.
