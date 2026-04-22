#!/bin/bash
# Claude Auto-Dev Installer (v7.4)
# Usage: ./install.sh [--init] [--full] [--copy]

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME=$(basename "$(pwd)")
VERSION=$(head -1 "$SCRIPT_DIR/VERSION" 2>/dev/null || echo "7.4")
CLAUDE_DIR=~/.claude

INIT=0
FULL=0
FORCE=0

for arg in "$@"; do
    case $arg in
        --init|-i) INIT=1 ;;
        --full|-f) FULL=1 ;;
        --force) FORCE=1 ;;
        --copy|-c) ;; # deprecated no-op
        --name=*) NAME="${arg#*=}" ;;
    esac
done

echo -e "\n\033[36mClaude Auto-Dev v$VERSION\033[0m"
echo "========================"

# Check for Claude Code (Node.js only needed if Claude Code not installed)
echo -e "\n\033[33m[Prerequisites]\033[0m"
if command -v claude &> /dev/null; then
    CLAUDE_VERSION=$(claude --version 2>/dev/null | head -1)
    echo -e "  \033[32mClaude Code $CLAUDE_VERSION\033[0m"
else
    # Need Node.js to install Claude Code
    if ! command -v node &> /dev/null; then
        echo -e "  \033[31mNode.js not found. Install from https://nodejs.org (v18+)\033[0m"
        exit 1
    fi
    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [[ "$NODE_VERSION" -lt 18 ]]; then
        echo -e "  \033[31mNode.js v18+ required (found v$(node -v))\033[0m"
        exit 1
    fi
    echo -e "  \033[32mNode.js $(node -v)\033[0m"
    echo -e "  \033[33mClaude Code not found - installing...\033[0m"
    npm install -g @anthropic-ai/claude-code
    if command -v claude &> /dev/null; then
        CLAUDE_VERSION=$(claude --version 2>/dev/null | head -1)
        echo -e "  \033[32mClaude Code $CLAUDE_VERSION installed\033[0m"
    else
        echo -e "  \033[31mClaude Code install failed. Try: npm install -g @anthropic-ai/claude-code\033[0m"
        exit 1
    fi
fi

# Create base directory
mkdir -p "$CLAUDE_DIR"

# Save repo path for update-dev
echo -n "$SCRIPT_DIR" > "$CLAUDE_DIR/repo-path.txt"
echo -e "\n\033[33m[Repo Path]\033[0m"
echo -e "  \033[32mSaved to ~/.claude/repo-path.txt\033[0m"

# Sync skills, hooks, agents via sync.js
echo -e "\n\033[33m[Syncing Skills, Hooks, Agents]\033[0m"
SYNC_ARGS="--repo $SCRIPT_DIR"
if [[ $FULL -eq 1 ]]; then
    SYNC_ARGS="$SYNC_ARGS --rules --settings"
fi
if [[ $FORCE -eq 1 ]]; then
    SYNC_ARGS="$SYNC_ARGS --force"
fi
node "$SCRIPT_DIR/scripts/sync.js" $SYNC_ARGS

# Add update-dev alias to shell profile
echo -e "\n\033[33m[Update Alias]\033[0m"

ALIAS_FUNC='
# Claude Auto-Dev update function
update-dev() {
    local repo_path_file="$HOME/.claude/repo-path.txt"
    if [[ ! -f "$repo_path_file" ]]; then
        echo "Error: repo-path.txt not found"
        return 1
    fi
    local repo_path=$(cat "$repo_path_file")
    if [[ ! -d "$repo_path" ]]; then
        echo "Error: Repo not found at $repo_path"
        return 1
    fi
    echo "Updating claude-auto-dev..."
    pushd "$repo_path" > /dev/null
    git fetch
    local behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
    if [[ $behind -gt 0 ]]; then
        echo "Pulling $behind new commit(s)..."
        git pull
        local version=$(head -1 "$repo_path/VERSION" 2>/dev/null)
        echo "Updated to v$version"
        # Re-sync if using copy mode (not symlinks)
        if [[ ! -L "$HOME/.claude/skills" ]]; then
            echo "Re-syncing (copy mode)..."
            node "$repo_path/scripts/sync.js" --repo "$repo_path" --rules --clean-deprecated
        fi
    else
        echo "Already up to date."
    fi
    popd > /dev/null
}
'

# Detect shell and add to appropriate profile
SHELL_NAME=$(basename "$SHELL")
case "$SHELL_NAME" in
    zsh)  PROFILE_FILE=~/.zshrc ;;
    bash) PROFILE_FILE=~/.bashrc ;;
    *)    PROFILE_FILE=~/.profile ;;
esac

if [[ -f "$PROFILE_FILE" ]] && grep -q "update-dev()" "$PROFILE_FILE"; then
    echo -e "  \033[90mupdate-dev already in $PROFILE_FILE (skipped)\033[0m"
else
    echo "$ALIAS_FUNC" >> "$PROFILE_FILE"
    echo -e "  \033[32mAdded update-dev to $PROFILE_FILE\033[0m"
fi

# Rules and settings are now handled inline by sync.js via --rules --settings
# when --full is passed (see SYNC_ARGS above).

# Project init
if [[ $INIT -eq 1 ]]; then
    echo -e "\n\033[33m[Project: $NAME]\033[0m"
    DATE=$(date +%Y-%m-%d)

    if [[ ! -f "prd.json" ]]; then
        # Escape sed special chars in NAME
        SAFE_NAME=$(printf '%s\n' "$NAME" | sed 's/[&/\]/\\&/g')
        sed "s/{{NAME}}/$SAFE_NAME/g; s/{{DATE}}/$DATE/g" "$SCRIPT_DIR/templates/prd.json" > prd.json
        echo -e "  \033[32mCreated prd.json\033[0m"
    else
        echo -e "  \033[90mprd.json exists (skipped)\033[0m"
    fi

    mkdir -p .claude
    echo -e "  \033[32mCreated .claude/\033[0m"
fi

echo -e "\n\033[32m[Done]\033[0m"
echo "  Skills/hooks auto-sync with repo"
echo "  Run 'update-dev' to pull latest changes"
echo -e "\n\033[36mStart Claude: claude\033[0m"
echo -e "Then say: brainstorm\n"
