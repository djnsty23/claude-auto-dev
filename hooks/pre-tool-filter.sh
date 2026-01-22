#!/bin/bash
# PreToolUse hook - Security filtering and token optimization
# Blocks dangerous Bash commands and unnecessary file reads.

# Read JSON input from stdin
input=$(cat)

tool_name=$(echo "$input" | jq -r '.tool_name // empty')
command=$(echo "$input" | jq -r '.tool_input.command // empty')
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

# Bash command filtering
if [ "$tool_name" = "Bash" ] && [ -n "$command" ]; then
    # Dangerous patterns to block
    if echo "$command" | grep -qE 'rm\s+-rf\s+/|rm\s+-rf\s+\*|rm\s+-rf\s+\.|git\s+reset\s+--hard|git\s+push\s+--force|git\s+clean\s+-fd|DROP\s+TABLE|DROP\s+DATABASE'; then
        echo "Blocked potentially dangerous command: $command" >&2
        exit 2
    fi
fi

# Read file filtering - skip large/generated files
if [ "$tool_name" = "Read" ] && [ -n "$file_path" ]; then
    if echo "$file_path" | grep -qE 'node_modules|dist/|build/|\.git/|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.next/|coverage/|\.turbo/'; then
        echo "Skipping generated/large file: $file_path (use targeted search instead)" >&2
        exit 2
    fi
fi

# Allow operation
exit 0
