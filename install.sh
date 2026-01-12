#!/bin/bash
# Claude Auto-Dev Installer
# Usage: ./install.sh --global --init --full

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME=$(basename "$(pwd)")
VERSION=$(head -1 "$SCRIPT_DIR/VERSION" 2>/dev/null || echo "dev")

for arg in "$@"; do
    case $arg in
        --global|-g) GLOBAL=1 ;;
        --init|-i) INIT=1 ;;
        --update|-u) UPDATE=1 ;;
        --full|-f) FULL=1 ;;
        --name=*) NAME="${arg#*=}" ;;
    esac
done

# Full restore (includes Global)
if [[ $FULL ]]; then
    echo -e "\n\033[35m=== FULL RESTORE (v$VERSION) ===\033[0m"

    CLAUDE_DIR=~/.claude

    # Create directories
    mkdir -p "$CLAUDE_DIR/skills" "$CLAUDE_DIR/rules" "$CLAUDE_DIR/scripts"

    # Copy global configs
    echo -e "\033[36m→ Installing global configs...\033[0m"
    cp "$SCRIPT_DIR/config/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md"
    echo -e "\033[32m✓ ~/.claude/CLAUDE.md\033[0m"

    cp "$SCRIPT_DIR/config/QUICKSTART.md" "$CLAUDE_DIR/QUICKSTART.md"
    echo -e "\033[32m✓ ~/.claude/QUICKSTART.md\033[0m"

    # Copy rules
    echo -e "\033[36m→ Installing rules...\033[0m"
    for f in "$SCRIPT_DIR/config/rules/"*.md; do
        if [[ -f "$f" ]]; then
            cp "$f" "$CLAUDE_DIR/rules/"
            echo -e "\033[32m✓ ~/.claude/rules/$(basename "$f")\033[0m"
        fi
    done

    # Copy all skills
    echo -e "\033[36m→ Installing skills...\033[0m"
    for f in "$SCRIPT_DIR/skills/"*.md; do
        if [[ -f "$f" ]]; then
            cp "$f" "$CLAUDE_DIR/skills/"
            echo -e "\033[32m✓ ~/.claude/skills/$(basename "$f")\033[0m"
        fi
    done

    # Copy scripts
    if [[ -d "$SCRIPT_DIR/scripts" ]]; then
        echo -e "\033[36m→ Installing scripts...\033[0m"
        for f in "$SCRIPT_DIR/scripts/"*; do
            if [[ -f "$f" ]]; then
                cp "$f" "$CLAUDE_DIR/scripts/"
                echo -e "\033[32m✓ ~/.claude/scripts/$(basename "$f")\033[0m"
            fi
        done
    fi

    # Run API key setup if mcp.json doesn't exist
    if [[ ! -f "$CLAUDE_DIR/mcp.json" ]]; then
        echo -e "\n\033[35m=== API Key Setup ===\033[0m"
        echo -e "\033[33mNo mcp.json found. Running setup wizard...\033[0m"
        bash "$SCRIPT_DIR/setup-keys.sh"
    else
        echo -e "\033[33m○ mcp.json (run setup-keys.sh manually to update)\033[0m"
    fi

    echo -e "\n\033[32m=== Full Restore Complete ===\033[0m"
    exit 0
fi

# Global/Update
if [[ $GLOBAL || $UPDATE ]]; then
    echo -e "\n\033[35m=== Skill Install (v$VERSION) ===\033[0m"
    mkdir -p ~/.claude/skills
    for f in "$SCRIPT_DIR/skills/"*.md; do
        if [[ -f "$f" ]]; then
            cp "$f" ~/.claude/skills/
            echo -e "\033[32m✓ ~/.claude/skills/$(basename "$f")\033[0m"
        fi
    done
fi

# Project init
if [[ $INIT ]]; then
    echo -e "\n\033[35m=== Project: $NAME ===\033[0m"
    DATE=$(date +%Y-%m-%d)

    for f in CLAUDE.md prd.json progress.txt; do
        if [[ ! -f $f ]]; then
            sed "s/{{NAME}}/$NAME/g; s/{{DATE}}/$DATE/g" "$SCRIPT_DIR/templates/$f" > "$f"
            echo -e "\033[32m✓ $f\033[0m"
        else
            echo -e "\033[33m○ $f (exists)\033[0m"
        fi
    done

    mkdir -p .claude/briefs
fi

# Help
if [[ ! $GLOBAL && ! $INIT && ! $UPDATE && ! $FULL ]]; then
    echo "
Claude Auto-Dev v$VERSION
========================
./install.sh --full      FULL RESTORE (all configs + API keys)
./install.sh --global    Install all skills
./install.sh --init      Initialize project
./install.sh --update    Update all skills

Commands: auto, continue, status, brainstorm, adjust, stop, reset
"
    exit 0
fi

echo -e "\n\033[32m✓ Done. Run: claude \"brainstorm\"\033[0m"
