#!/bin/bash
#
# API Key Setup Wizard for Claude Code (Mac/Linux)
# Stores keys in ~/.bashrc or ~/.zshrc
# MCP config uses ${ENV_VAR} syntax - no hardcoding needed
#

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "\n\033[35m=== Claude Code API Key Setup ===\033[0m"
echo "Keys are stored in your shell profile (~/.zshrc or ~/.bashrc)."
echo "MCP config references them via \${ENV_VAR} syntax."
echo -e "Press Enter to skip any key you don't have.\n"

# Detect shell profile
if [[ -f ~/.zshrc ]]; then
    PROFILE=~/.zshrc
elif [[ -f ~/.bashrc ]]; then
    PROFILE=~/.bashrc
else
    PROFILE=~/.profile
fi

echo "Using profile: $PROFILE"

# Function to set env var
set_key() {
    local name=$1
    local value=$2

    # Remove existing entry
    sed -i.bak "/^export $name=/d" "$PROFILE" 2>/dev/null || true

    # Add new entry
    echo "export $name=\"$value\"" >> "$PROFILE"

    # Export for current session
    export "$name"="$value"
}

# Prompt for keys
keys=(
    "SUPABASE_ACCESS_TOKEN:Supabase Access Token (sbp_...):required"
    "GITHUB_PAT:GitHub Personal Access Token (ghp_...):required"
    "BRAVE_API_KEY:Brave Search API Key:optional"
    "GOOGLE_CLIENT_ID:Google OAuth Client ID:optional"
    "GOOGLE_CLIENT_SECRET:Google OAuth Client Secret:optional"
    "ELEVENLABS_API_KEY:ElevenLabs API Key:optional"
    "OPENROUTER_API_KEY:OpenRouter API Key:optional"
    "DEEPSEEK_API_KEY:DeepSeek API Key:optional"
    "GEMINI_API_KEY:Google Gemini API Key:optional"
    "RESEND_API_KEY:Resend Email API Key:optional"
    "TEST_USER_PASSWORD:Test account password:optional"
)

for entry in "${keys[@]}"; do
    IFS=':' read -r name desc req <<< "$entry"

    existing="${!name}"
    prompt="$desc"

    if [[ -n "$existing" ]]; then
        masked="${existing:0:8}..."
        prompt+=" [current: $masked]"
    fi

    if [[ "$req" == "required" ]]; then
        prompt+=" (required)"
    fi

    echo -e "\033[36m$prompt\033[0m"
    read -p "  $name: " value

    if [[ -n "$value" ]]; then
        set_key "$name" "$value"
        echo -e "  \033[32m✓ Saved to $PROFILE\033[0m"
    elif [[ -n "$existing" ]]; then
        echo -e "  \033[33m○ Keeping existing\033[0m"
    else
        echo -e "  \033[90m- Skipped\033[0m"
    fi
done

# Copy MCP config (uses ${ENV_VAR} references, no substitution needed)
echo -e "\n\033[35m=== Installing mcp.json ===\033[0m"

MCP_SOURCE="$SCRIPT_DIR/config/mcp.template.json"
MCP_PATH=~/.claude/mcp.json

mkdir -p ~/.claude
cp "$MCP_SOURCE" "$MCP_PATH"

echo -e "\033[32m✓ Installed $MCP_PATH\033[0m"
echo -e "  \033[90m(Uses \${ENV_VAR} references - no secrets in file)\033[0m"

echo -e "\n\033[32m=== Done ===\033[0m"
echo ""
echo "Keys stored in $PROFILE"
echo "MCP config installed at ~/.claude/mcp.json"
echo ""
echo "The config uses \${ENV_VAR} syntax - MCP reads from your env vars at runtime."
echo "No secrets are hardcoded in the config file."
echo ""
echo "Note: Run 'source $PROFILE' or restart your terminal for env vars to take effect."
