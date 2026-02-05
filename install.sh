#!/bin/bash
# Claude Auto-Dev Installer (v5.0)
# Usage: ./install.sh [--init] [--full] [--copy]

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME=$(basename "$(pwd)")
VERSION=$(head -1 "$SCRIPT_DIR/VERSION" 2>/dev/null || echo "5.0")
CLAUDE_DIR=~/.claude

INIT=0
FULL=0
COPY=0

for arg in "$@"; do
    case $arg in
        --init|-i) INIT=1 ;;
        --full|-f) FULL=1 ;;
        --copy|-c) COPY=1 ;;
        --name=*) NAME="${arg#*=}" ;;
    esac
done

echo -e "\n\033[36mClaude Auto-Dev v$VERSION\033[0m"
echo "========================"

# Create base directory
mkdir -p "$CLAUDE_DIR"

# Save repo path for update-dev
echo -n "$SCRIPT_DIR" > "$CLAUDE_DIR/repo-path.txt"
echo -e "\n\033[33m[Repo Path]\033[0m"
echo -e "  \033[32mSaved to ~/.claude/repo-path.txt\033[0m"

# Install skills
echo -e "\n\033[33m[Skills]\033[0m"
if [[ $COPY -eq 1 ]]; then
    rm -rf "$CLAUDE_DIR/skills"
    mkdir -p "$CLAUDE_DIR/skills"
    cp -r "$SCRIPT_DIR/skills/"* "$CLAUDE_DIR/skills/"
    echo -e "  \033[32mCopied to ~/.claude/skills/\033[0m"
else
    rm -rf "$CLAUDE_DIR/skills"
    ln -s "$SCRIPT_DIR/skills" "$CLAUDE_DIR/skills"
    echo -e "  \033[32mSymlinked ~/.claude/skills/ -> repo\033[0m"
fi

# Install hooks
echo -e "\n\033[33m[Hooks]\033[0m"
if [[ $COPY -eq 1 ]]; then
    rm -rf "$CLAUDE_DIR/hooks"
    mkdir -p "$CLAUDE_DIR/hooks"
    cp "$SCRIPT_DIR/hooks/"*.sh "$CLAUDE_DIR/hooks/" 2>/dev/null || true
    chmod +x "$CLAUDE_DIR/hooks/"*.sh 2>/dev/null || true
    echo -e "  \033[32mCopied to ~/.claude/hooks/\033[0m"
else
    rm -rf "$CLAUDE_DIR/hooks"
    ln -s "$SCRIPT_DIR/hooks" "$CLAUDE_DIR/hooks"
    echo -e "  \033[32mSymlinked ~/.claude/hooks/ -> repo\033[0m"
fi

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

# Full install adds rules and settings
if [[ $FULL -eq 1 ]]; then
    # Rules (copy, not symlink - user may customize)
    if [[ -d "$SCRIPT_DIR/config/rules" ]]; then
        echo -e "\n\033[33m[Rules]\033[0m"
        mkdir -p "$CLAUDE_DIR/rules"
        cp "$SCRIPT_DIR/config/rules/"* "$CLAUDE_DIR/rules/"
        echo -e "  \033[32mCopied to ~/.claude/rules/\033[0m"
    fi

    # Settings (only if not exists)
    if [[ ! -f "$CLAUDE_DIR/settings.json" ]]; then
        cp "$SCRIPT_DIR/config/settings-unix.json" "$CLAUDE_DIR/settings.json"
        echo -e "\n\033[33m[Settings]\033[0m"
        echo -e "  \033[32mCreated ~/.claude/settings.json\033[0m"
    fi
fi

# Project init
if [[ $INIT -eq 1 ]]; then
    echo -e "\n\033[33m[Project: $NAME]\033[0m"
    DATE=$(date +%Y-%m-%d)

    if [[ ! -f "prd.json" ]]; then
        sed "s/{{NAME}}/$NAME/g; s/{{DATE}}/$DATE/g" "$SCRIPT_DIR/templates/prd.json" > prd.json
        echo -e "  \033[32mCreated prd.json\033[0m"
    else
        echo -e "  \033[90mprd.json exists (skipped)\033[0m"
    fi

    mkdir -p .claude
    echo -e "  \033[32mCreated .claude/\033[0m"
fi

echo -e "\n\033[32m[Done]\033[0m"
echo "  Skills/hooks auto-sync with repo"
echo "  Updates pulled automatically on Claude start"
echo -e "\n\033[36mStart Claude: claude\033[0m"
echo -e "Then say: brainstorm\n"
