#!/bin/bash
# Session start - quality-first mode

echo "[Auto-Dev v4.3] Quality-First Mode"

# Auto-source .env.local (project-isolated credentials)
if [ -f ".env.local" ]; then
    set -a
    source .env.local 2>/dev/null
    set +a
    echo "[Env] .env.local loaded"
fi

# Check for checkpoint (context restore after /compact)
if [ -f ".claude/checkpoint.md" ]; then
    echo ""
    echo "[Checkpoint Found] Restoring context..."
    head -30 .claude/checkpoint.md
    echo ""
    echo "---"
fi

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
        echo "[UI] $ui_count components in ui/"
    fi
fi
