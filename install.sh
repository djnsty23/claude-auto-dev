#!/bin/bash
#
# Claude Auto-Dev Installer
#
# USAGE:
#   ./install.sh --global        # Install skill file globally
#   ./install.sh --init          # Initialize current project
#   ./install.sh --global --init # Both

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL=false
INIT=false
PROJECT_NAME=$(basename "$(pwd)")

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --global|-g) GLOBAL=true; shift ;;
        --init|-i) INIT=true; shift ;;
        --name|-n) PROJECT_NAME="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Colors
step() { echo -e "\033[36m→ $1\033[0m"; }
done_msg() { echo -e "\033[32m✓ $1\033[0m"; }
skip() { echo -e "\033[33m○ $1 (exists)\033[0m"; }

# ============================================================================
# GLOBAL INSTALL
# ============================================================================

if [ "$GLOBAL" = true ]; then
    echo -e "\n\033[35m=== Global Install ===\033[0m"

    SKILL_DIR="$HOME/.claude/skills"

    # Create skills directory
    if [ ! -d "$SKILL_DIR" ]; then
        step "Creating skills directory"
        mkdir -p "$SKILL_DIR"
        done_msg "Created $SKILL_DIR"
    fi

    # Copy skill file
    step "Installing build.md skill"
    cp "$SCRIPT_DIR/skills/build.md" "$SKILL_DIR/build.md"
    done_msg "Installed $SKILL_DIR/build.md"
fi

# ============================================================================
# PROJECT INIT
# ============================================================================

if [ "$INIT" = true ]; then
    echo -e "\n\033[35m=== Project Init: $PROJECT_NAME ===\033[0m"

    # CLAUDE.md
    if [ ! -f "CLAUDE.md" ]; then
        step "Creating CLAUDE.md"
        sed "s/\$PROJECT_NAME/$PROJECT_NAME/g; s/\$DATE/$(date +%Y-%m-%d)/g" \
            "$SCRIPT_DIR/templates/CLAUDE.md" > CLAUDE.md
        done_msg "Created CLAUDE.md"
    else
        skip "CLAUDE.md"
    fi

    # prd.json
    if [ ! -f "prd.json" ]; then
        step "Creating prd.json"
        sed "s/\$PROJECT_NAME/$PROJECT_NAME/g" \
            "$SCRIPT_DIR/templates/prd.json" > prd.json
        done_msg "Created prd.json"
    else
        skip "prd.json"
    fi

    # progress.txt
    if [ ! -f "progress.txt" ]; then
        step "Creating progress.txt"
        sed "s/\$PROJECT_NAME/$PROJECT_NAME/g; s/\$DATE/$(date +%Y-%m-%d)/g" \
            "$SCRIPT_DIR/templates/progress.txt" > progress.txt
        done_msg "Created progress.txt"
    else
        skip "progress.txt"
    fi

    # Create briefs directory
    if [ ! -d ".claude/briefs" ]; then
        step "Creating .claude/briefs/"
        mkdir -p ".claude/briefs"
        done_msg "Created .claude/briefs/"
    else
        skip ".claude/briefs/"
    fi

    # Update .gitignore
    if [ -f ".gitignore" ]; then
        if ! grep -q "tmpclaude-" .gitignore; then
            step "Adding tmpclaude-* to .gitignore"
            echo "tmpclaude-*" >> .gitignore
            done_msg "Updated .gitignore"
        fi
    fi
fi

# ============================================================================
# USAGE HELP
# ============================================================================

if [ "$GLOBAL" = false ] && [ "$INIT" = false ]; then
    cat << 'EOF'

Claude Auto-Dev Installer
=========================

Usage:
  ./install.sh --global        # Install skill file (once per machine)
  ./install.sh --init          # Initialize current project
  ./install.sh --global --init # Both

After install:
  claude "brainstorm"   # Generate tasks via questionnaire
  claude "auto"         # Start building

Commands:
  auto       - Work through all tasks
  continue   - One task at a time
  status     - Show progress
  brainstorm - Generate new stories
  adjust     - Pick features to prioritize
  stop       - Before closing session
  reset      - Clear all claims after crash

EOF
    exit 0
fi

echo -e "\n\033[32m=== Done ===\033[0m"
cat << 'EOF'

Next steps:
  1. Generate tasks:  claude "brainstorm"
  2. Or add manually to prd.json
  3. Start building:  claude "auto"

EOF
