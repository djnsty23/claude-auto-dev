#!/bin/bash
# Claude Auto-Dev Installer
# Usage: ./install.sh --global --init

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME=$(basename "$(pwd)")

for arg in "$@"; do
    case $arg in
        --global|-g) GLOBAL=1 ;;
        --init|-i) INIT=1 ;;
        --update|-u) UPDATE=1 ;;
        --name=*) NAME="${arg#*=}" ;;
    esac
done

# Global/Update
if [[ $GLOBAL || $UPDATE ]]; then
    echo -e "\n\033[35m=== Skill Install ===\033[0m"
    mkdir -p ~/.claude/skills
    cp "$SCRIPT_DIR/skills/build.md" ~/.claude/skills/build.md
    echo -e "\033[32m✓ Installed ~/.claude/skills/build.md\033[0m"
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
if [[ ! $GLOBAL && ! $INIT && ! $UPDATE ]]; then
    echo "
Claude Auto-Dev
===============
./install.sh --global    Install skill file
./install.sh --init      Initialize project
./install.sh --update    Update skill file

Commands: auto, continue, status, brainstorm, adjust, stop
"
    exit 0
fi

echo -e "\n\033[32m✓ Done. Run: claude \"brainstorm\"\033[0m"
