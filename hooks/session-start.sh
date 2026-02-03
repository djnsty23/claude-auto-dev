#!/bin/bash
# Session start - lightweight sprint display

# Sprint context from project-meta.json (~200 bytes)
if [ -f "project-meta.json" ]; then
    if command -v jq &> /dev/null; then
        sprint=$(jq -r '.currentSprint // "none"' project-meta.json 2>/dev/null)
        total=$(jq -r '.totalCompleted // 0' project-meta.json 2>/dev/null)
        echo "[Auto-Dev v4] Sprint: $sprint | Completed: $total total"
    else
        echo "[Auto-Dev v4] project-meta.json found (install jq for details)"
    fi
else
    echo "[Auto-Dev v4] No project-meta.json - say 'audit' or run 'npx claude-auto-dev --init'"
fi

# Git status (brief)
changed=$(git status --short 2>/dev/null | wc -l | tr -d ' ')
if [ "$changed" -gt 0 ]; then
    echo "[Git] $changed changed files"
fi
