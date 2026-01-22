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
    mkdir -p "$CLAUDE_DIR/skills" "$CLAUDE_DIR/rules" "$CLAUDE_DIR/hooks"

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

    # Copy hooks
    if [[ -d "$SCRIPT_DIR/hooks" ]]; then
        echo -e "\033[36m→ Installing hooks...\033[0m"
        for f in "$SCRIPT_DIR/hooks/"*.sh; do
            if [[ -f "$f" ]]; then
                cp "$f" "$CLAUDE_DIR/hooks/"
                chmod +x "$CLAUDE_DIR/hooks/$(basename "$f")"
                echo -e "\033[32m✓ ~/.claude/hooks/$(basename "$f")\033[0m"
            fi
        done
    fi

    # Copy settings.json (if not exists)
    if [[ ! -f "$CLAUDE_DIR/settings.json" ]]; then
        echo -e "\033[36m→ Installing settings.json with hooks...\033[0m"
        cp "$SCRIPT_DIR/config/settings-unix.json" "$CLAUDE_DIR/settings.json"
        echo -e "\033[32m✓ ~/.claude/settings.json\033[0m"
    else
        echo -e "\033[33m○ settings.json (exists - run manually to update)\033[0m"
    fi

    # Install plugin for slash commands
    echo -e "\033[36m→ Installing claude-auto-dev plugin...\033[0m"
    PLUGIN_DIR="$CLAUDE_DIR/plugins/local/claude-auto-dev"
    mkdir -p "$PLUGIN_DIR"
    cp -r "$SCRIPT_DIR/plugin/"* "$PLUGIN_DIR/" 2>/dev/null || true
    echo -e "\033[32m✓ ~/.claude/plugins/local/claude-auto-dev\033[0m"

    # Register plugin in installed_plugins.json
    PLUGINS_FILE="$CLAUDE_DIR/plugins/installed_plugins.json"
    if [[ -f "$PLUGINS_FILE" ]]; then
        if ! grep -q "claude-auto-dev@local" "$PLUGINS_FILE"; then
            # Add plugin entry using jq if available, otherwise manual
            if command -v jq &> /dev/null; then
                jq --arg path "$PLUGIN_DIR" --arg ver "$VERSION" --arg date "$(date -Iseconds)" \
                   '.plugins["claude-auto-dev@local"] = [{"scope":"user","installPath":$path,"version":$ver,"installedAt":$date,"lastUpdated":$date}]' \
                   "$PLUGINS_FILE" > "$PLUGINS_FILE.tmp" && mv "$PLUGINS_FILE.tmp" "$PLUGINS_FILE"
                echo -e "\033[32m✓ Registered in installed_plugins.json\033[0m"
            else
                echo -e "\033[33m○ installed_plugins.json (install jq for auto-registration)\033[0m"
            fi
        else
            echo -e "\033[33m○ Plugin already registered\033[0m"
        fi
    fi

    # Enable plugin in settings.json
    SETTINGS_FILE="$CLAUDE_DIR/settings.json"
    if [[ -f "$SETTINGS_FILE" ]]; then
        if ! grep -q "claude-auto-dev@local" "$SETTINGS_FILE"; then
            if command -v jq &> /dev/null; then
                jq '.enabledPlugins["claude-auto-dev@local"] = true' \
                   "$SETTINGS_FILE" > "$SETTINGS_FILE.tmp" && mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"
                echo -e "\033[32m✓ Enabled in settings.json\033[0m"
            fi
        else
            echo -e "\033[33m○ Plugin already enabled\033[0m"
        fi
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
