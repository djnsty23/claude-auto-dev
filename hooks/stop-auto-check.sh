#!/bin/bash
# Stop hook - Blocks stopping when auto mode is active.
# Checks for .claude/auto-active flag file.

# Stale flag cleanup (>2 hours old = crashed session)
AUTO_FLAG=".claude/auto-active"
if [[ -f "$AUTO_FLAG" ]]; then
    flag_age=$(($(date +%s) - $(date -r "$AUTO_FLAG" +%s 2>/dev/null || echo 0)))
    if [[ "$flag_age" -gt 7200 ]]; then
        rm -f "$AUTO_FLAG"
        echo "[Auto-Dev] Removed stale auto-active flag (>2h old)" >&2
    fi
fi

# jq fallback: if jq missing, still check flag file
if ! command -v jq &>/dev/null; then
    if [[ -f "$AUTO_FLAG" ]]; then
        echo "[Auto-Dev] Auto mode active (jq unavailable for task count)" >&2
        echo '{"ok":false,"reason":"Auto mode active (install jq for task count)"}'
    else
        echo '{"ok":true}'
    fi
    exit 0
fi

if [[ -f "$AUTO_FLAG" ]]; then
    # Auto mode is active - count remaining tasks
    remaining=0
    if [[ -f "prd.json" ]]; then
        remaining=$(jq '[.stories | to_entries[] | select(.value.passes != true)] | length' prd.json 2>/dev/null || echo 0)
    fi

    if [[ "$remaining" -gt 0 ]] 2>/dev/null; then
        echo "[Auto-Dev] Auto mode active. $remaining tasks remaining. Continuing..." >&2
        echo "{\"ok\":false,\"reason\":\"[Auto-Dev] $remaining tasks remaining in auto mode\"}"
    else
        echo "[Auto-Dev] Sprint complete. Running IDLE detection..." >&2
        echo "{\"ok\":false,\"reason\":\"[Auto-Dev] Sprint complete - running smart next action\"}"
    fi
else
    # Not in auto mode - allow normal stop evaluation
    echo '{"ok":true}'
fi
