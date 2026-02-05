#!/bin/bash
# Stop hook - Inform about remaining tasks (doesn't block)

if [[ -f "prd.json" ]]; then
    # Count remaining tasks (stories is an object, not array)
    remaining=$(jq '[.stories | to_entries[] | select(.value.passes != true)] | length' prd.json 2>/dev/null)

    if [[ "$remaining" -gt 0 ]] 2>/dev/null; then
        # Get next task info
        next_id=$(jq -r '[.stories | to_entries[] | select(.value.passes != true)][0].key // empty' prd.json 2>/dev/null)
        next_title=$(jq -r '[.stories | to_entries[] | select(.value.passes != true)][0].value.title // empty' prd.json 2>/dev/null)

        # INFORM but don't block - user intent takes priority
        echo "[Auto-Dev] $remaining tasks remain. Next: $next_id - $next_title"
        echo "[Auto-Dev] Say 'auto' to continue, or close session to stop."
    fi
fi

# Always allow stopping - user intent takes priority
echo '{"ok":true}'
