#!/bin/bash
# PreToolUse hook - Security filtering and token optimization
# Blocks dangerous Bash commands and unnecessary file reads.

# Read JSON input from stdin
input=$(cat)

# jq fallback: use grep-based filtering if jq unavailable
if ! command -v jq &>/dev/null; then
    # Basic safety filtering without jq
    if echo "$input" | grep -q '"Bash"'; then
        if echo "$input" | grep -qE 'rm\s+-rf|rm\s+--recursive|find\s+/\s+-delete|dd\s+if=|mkfs\.|chmod\s+-R\s+000|git\s+reset\s+--hard|git\s+push\s+--force|git\s+clean\s+-fd|DROP\s+(TABLE|DATABASE)|curl.*\|\s*bash'; then
            echo "Blocked potentially dangerous command (jq unavailable)" >&2
            exit 2
        fi
    fi
    exit 0
fi

tool_name=$(echo "$input" | jq -r '.tool_name // empty')
command=$(echo "$input" | jq -r '.tool_input.command // empty')
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

# Bash command filtering
if [ "$tool_name" = "Bash" ] && [ -n "$command" ]; then
    # Dangerous patterns to block (expanded to catch flag variations and indirect execution)
    if echo "$command" | grep -qiE 'rm\s+(-[a-z]*r[a-z]*\s+(-[a-z]*f|/)|-[a-z]*f[a-z]*\s+-[a-z]*r)|rm\s+--recursive|find\s+/\s+-delete|dd\s+if=.*/dev/|mkfs\.|chmod\s+-R\s+000\s+/|git\s+reset\s+--hard|git\s+push\s+(--force|.*--force)|git\s+clean\s+-fd|DROP\s+(TABLE|DATABASE)|curl.*\|\s*(ba)?sh|wget.*\|\s*(ba)?sh'; then
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
