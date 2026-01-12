#!/bin/bash
#
# API Key Setup Wizard for Claude Code (Mac/Linux)
# Stores keys in ~/.bashrc or ~/.zshrc and generates mcp.json
#

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "\n\033[35m=== Claude Code API Key Setup ===\033[0m"
echo "Keys are stored in your shell profile (~/.zshrc or ~/.bashrc)."
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

declare -A values

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
    "RESEND_API_KEY:Resend Email API Key:optional"
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
        values[$name]="$value"
        set_key "$name" "$value"
        echo -e "  \033[32m✓ Saved\033[0m"
    elif [[ -n "$existing" ]]; then
        values[$name]="$existing"
        echo -e "  \033[33m○ Keeping existing\033[0m"
    else
        echo -e "  \033[90m- Skipped\033[0m"
    fi
done

# Generate mcp.json
echo -e "\n\033[35m=== Generating mcp.json ===\033[0m"

MCP_TEMPLATE="$SCRIPT_DIR/config/mcp.template.json"
MCP_PATH=~/.claude/mcp.json

mkdir -p ~/.claude

# Read template and replace placeholders
content=$(cat "$MCP_TEMPLATE")
for name in "${!values[@]}"; do
    content="${content//\{\{$name\}\}/${values[$name]}}"
done

echo "$content" > "$MCP_PATH"
echo -e "\033[32m✓ Generated $MCP_PATH\033[0m"

echo -e "\n\033[32m=== Done ===\033[0m"
echo ""
echo "Keys stored in $PROFILE"
echo "MCP config generated at ~/.claude/mcp.json"
echo ""
echo "Next: Run the full installer:"
echo "  ./install.sh --full"
echo ""
echo "Note: Run 'source $PROFILE' or restart your terminal for env vars to take effect."
