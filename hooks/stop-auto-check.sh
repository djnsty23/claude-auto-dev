#!/bin/bash
# Stop hook - Blocks stopping when auto mode is active.
# Checks for .claude/auto-active flag file.

command -v jq &>/dev/null || exit 0

AUTO_FLAG=".claude/auto-active"

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
