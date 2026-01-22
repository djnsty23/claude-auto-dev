#!/bin/bash
# SessionStart hook - Inject project context and skill index

SKILLS_DIR=~/.claude/skills

echo ""

# Project context from prd.json
if [ -f "prd.json" ]; then
    done_count=$(jq '[.stories[] | select(.passes == true)] | length' prd.json 2>/dev/null || echo 0)
    total_count=$(jq '.stories | length' prd.json 2>/dev/null || echo 0)

    echo "[Auto-Dev] Progress: $done_count/$total_count tasks complete"

    remaining=$(jq '[.stories[] | select(.passes != true)] | length' prd.json 2>/dev/null || echo 0)
    if [ "$remaining" -gt 0 ]; then
        next_id=$(jq -r '[.stories[] | select(.passes != true)][0].id // empty' prd.json 2>/dev/null)
        next_title=$(jq -r '[.stories[] | select(.passes != true)][0].title // empty' prd.json 2>/dev/null)
        echo "[Auto-Dev] Next: $next_id - $next_title"
    else
        echo "[Auto-Dev] All tasks complete!"
    fi
else
    echo "[Auto-Dev] No prd.json - say 'brainstorm' to create tasks"
fi

# Git status (brief)
changed=$(git status --short 2>/dev/null | wc -l | tr -d ' ')
if [ "$changed" -gt 0 ]; then
    echo "[Git] $changed changed files"
fi

# Skill index from manifest.json (for efficient skill loading)
MANIFEST="$SKILLS_DIR/manifest.json"
if [ -f "$MANIFEST" ] && command -v jq &> /dev/null; then
    echo ""
    echo "[Skills] Command -> File mapping:"
    jq -r '.skills | to_entries[] | "  \(.value.triggers | join(", ")) -> \(.value.file)"' "$MANIFEST" 2>/dev/null
fi

echo ""
