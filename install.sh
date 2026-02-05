#!/bin/bash
# Claude Auto-Dev Installer (v4.8)
# Usage: ./install.sh [--init] [--full]

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME=$(basename "$(pwd)")
VERSION=$(head -1 "$SCRIPT_DIR/VERSION" 2>/dev/null || echo "4.8.0")
CLAUDE_DIR=~/.claude

INIT=0
FULL=0

for arg in "$@"; do
    case $arg in
        --init|-i) INIT=1 ;;
        --full|-f) FULL=1 ;;
        --name=*) NAME="${arg#*=}" ;;
    esac
done

echo -e "\nClaude Auto-Dev v$VERSION"
echo "========================"

# Create directories
mkdir -p "$CLAUDE_DIR/skills"

# Always install skills (copy entire folder recursively)
echo -e "\n\033[33m[Skills]\033[0m"
cp -r "$SCRIPT_DIR/skills/"* "$CLAUDE_DIR/skills/"
echo -e "  \033[32mInstalled to ~/.claude/skills/\033[0m"

# Full install includes hooks and rules
if [[ $FULL -eq 1 ]]; then
    # Rules
    if [[ -d "$SCRIPT_DIR/config/rules" ]]; then
        echo -e "\n\033[33m[Rules]\033[0m"
        mkdir -p "$CLAUDE_DIR/rules"
        cp "$SCRIPT_DIR/config/rules/"* "$CLAUDE_DIR/rules/"
        echo -e "  \033[32mInstalled to ~/.claude/rules/\033[0m"
    fi

    # Hooks
    if [[ -d "$SCRIPT_DIR/hooks" ]]; then
        echo -e "\n\033[33m[Hooks]\033[0m"
        mkdir -p "$CLAUDE_DIR/hooks"
        cp "$SCRIPT_DIR/hooks/"*.sh "$CLAUDE_DIR/hooks/" 2>/dev/null || true
        chmod +x "$CLAUDE_DIR/hooks/"*.sh 2>/dev/null || true
        echo -e "  \033[32mInstalled to ~/.claude/hooks/\033[0m"
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

    # prd.json
    if [[ ! -f "prd.json" ]]; then
        sed "s/{{NAME}}/$NAME/g; s/{{DATE}}/$DATE/g" "$SCRIPT_DIR/templates/prd.json" > prd.json
        echo -e "  \033[32mCreated prd.json\033[0m"
    else
        echo -e "  \033[90mprd.json exists (skipped)\033[0m"
    fi

    # .claude directory
    mkdir -p .claude
    echo -e "  \033[32mCreated .claude/\033[0m"
fi

echo -e "\n\033[32mDone! Run: claude\033[0m"
echo -e "\033[36mThen say: brainstorm\033[0m\n"
