#!/bin/bash
echo "[Auto-Dev v4.8]"

# Auto-source .env.local (project-isolated credentials)
if [[ -f ".env.local" ]]; then
    set -a
    source .env.local 2>/dev/null
    set +a
    echo "[Env] .env.local loaded"
fi

# Check for checkpoint (context restore after /compact)
if [[ -f ".claude/checkpoint.md" ]]; then
    echo ""
    echo "[Checkpoint Found] Restoring context..."
    head -30 .claude/checkpoint.md
    echo ""
    echo "---"
fi

# Sprint context from prd.json
if [[ -f "prd.json" ]]; then
    if command -v jq &> /dev/null; then
        sprint=$(jq -r '.sprint // empty' prd.json 2>/dev/null)
        total=$(jq -r '.completedStories // 0' prd.json 2>/dev/null)
        all=$(jq -r '.totalStories // 0' prd.json 2>/dev/null)
        pending=$((all - total))
        if [[ -n "$sprint" ]]; then
            echo "[Sprint] $sprint | $total done, $pending pending"
        fi
    fi
fi

# Git status (brief)
changes=$(git status --short 2>/dev/null | wc -l | tr -d ' ')
if [[ "$changes" -gt 0 ]]; then
    echo "[Git] $changes uncommitted changes"
fi
