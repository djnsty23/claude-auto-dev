#!/bin/bash

# Auto-update claude-auto-dev (with timeout for offline)
REPO_PATH_FILE="$HOME/.claude/repo-path.txt"
CLAUDE_DIR="$HOME/.claude"

if [[ -f "$REPO_PATH_FILE" ]]; then
    REPO_PATH=$(cat "$REPO_PATH_FILE" | tr -d '\r\n')
    if [[ -d "$REPO_PATH/.git" ]]; then
        pushd "$REPO_PATH" > /dev/null
        # 5 second timeout
        RESULT=$(timeout 5 git pull 2>&1 || echo "timeout")
        popd > /dev/null

        VERSION=$(head -1 "$REPO_PATH/VERSION" 2>/dev/null)

        # Check if using copy mode (skills is a directory, not symlink)
        IS_SYMLINK=false
        [[ -L "$CLAUDE_DIR/skills" ]] && IS_SYMLINK=true

        if [[ "$RESULT" != *"Already up to date"* && "$RESULT" != "timeout" ]]; then
            echo "[Auto-Dev] Updated to v$VERSION"
            # If copy mode, re-copy skills and hooks
            if [[ "$IS_SYMLINK" == false ]]; then
                cp -r "$REPO_PATH/skills/"* "$CLAUDE_DIR/skills/"
                cp "$REPO_PATH/hooks/"* "$CLAUDE_DIR/hooks/"
                echo "[Auto-Dev] Skills/hooks synced"
            fi
        else
            echo "[Auto-Dev v$VERSION]"
        fi
    fi
else
    echo "[Auto-Dev v4.9]"
fi

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
