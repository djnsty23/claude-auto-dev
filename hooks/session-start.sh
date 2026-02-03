#!/bin/bash
# Session start - quality-first mode

echo "[Auto-Dev v4.1] Quality-First Mode"
echo "  - Read before write | Match existing patterns | Verify all states"

# Sprint context from project-meta.json (~200 bytes)
if [ -f "project-meta.json" ]; then
    if command -v jq &> /dev/null; then
        sprint=$(jq -r '.currentSprint // "none"' project-meta.json 2>/dev/null)
        total=$(jq -r '.totalCompleted // 0' project-meta.json 2>/dev/null)
        echo "[Sprint] $sprint | $total completed"
    fi
fi

# Git status (brief)
changed=$(git status --short 2>/dev/null | wc -l | tr -d ' ')
if [ "$changed" -gt 0 ]; then
    echo "[Git] $changed uncommitted changes"
fi

# Check for existing UI components (helps preserve-ui skill)
if [ -d "src/components/ui" ]; then
    ui_count=$(find src/components/ui -name "*.tsx" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$ui_count" -gt 0 ]; then
        echo "[UI] $ui_count components in ui/ - use existing before creating new"
    fi
fi
