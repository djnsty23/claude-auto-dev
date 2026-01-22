#!/bin/bash
# Stop hook for claude-auto-dev - Auto-continue if tasks remain
# Checks prd.json for incomplete tasks. If any remain, blocks stopping.

if [ -f "prd.json" ]; then
    # Count remaining tasks (passes != true)
    remaining=$(jq '[.stories[] | select(.passes != true)] | length' prd.json 2>/dev/null)

    if [ "$remaining" -gt 0 ] 2>/dev/null; then
        # Get next task info
        next_id=$(jq -r '[.stories[] | select(.passes != true)][0].id // empty' prd.json 2>/dev/null)
        next_title=$(jq -r '[.stories[] | select(.passes != true)][0].title // empty' prd.json 2>/dev/null)

        # Block stopping, tell Claude to continue
        echo "{\"decision\":\"block\",\"reason\":\"Auto-dev: $remaining tasks remain. Continue with: $next_id - $next_title\"}"
        exit 0
    fi
fi

# Allow stopping if no prd.json or all tasks complete
echo '{"ok":true}'
