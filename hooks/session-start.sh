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
                cp "$REPO_PATH/config/settings-unix.json" "$CLAUDE_DIR/settings.json" 2>/dev/null
                echo "[Auto-Dev] Skills/hooks/settings synced"
            fi
        else
            echo "[Auto-Dev v$VERSION]"
        fi
    fi
else
    echo "[Auto-Dev v5.0]"
fi

# Auto-source .env.local (project-isolated credentials) - safe parser
if [[ -f ".env.local" ]]; then
    while IFS= read -r line; do
        # Skip comments and empty lines
        [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
        # Split on first = only (preserves = in values like base64, JWT, URLs)
        key="${line%%=*}"
        value="${line#*=}"
        key=$(echo "$key" | tr -d ' ')
        # Strip surrounding quotes from value
        value=$(echo "$value" | sed 's/^"//;s/"$//;s/^'"'"'//;s/'"'"'$//')
        # Only export valid variable names
        [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && export "$key=$value"
    done < .env.local
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
    else
        sprint=$(grep -oP '"sprint"\s*:\s*"?\K[^",}]+' prd.json 2>/dev/null | head -1)
        total=$(grep -oP '"completedStories"\s*:\s*\K[0-9]+' prd.json 2>/dev/null | head -1)
        all=$(grep -oP '"totalStories"\s*:\s*\K[0-9]+' prd.json 2>/dev/null | head -1)
    fi
    total=${total:-0}
    all=${all:-0}
    pending=$((all - total))
    if [[ -n "$sprint" ]]; then
        echo "[Sprint] $sprint | $total done, $pending pending"
    fi
fi

# Git status (brief)
changes=$(git status --short 2>/dev/null | wc -l | tr -d ' ')
if [[ "$changes" -gt 0 ]]; then
    echo "[Git] $changes uncommitted changes"
fi
