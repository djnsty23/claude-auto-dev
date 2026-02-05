#!/bin/bash
# PostToolUse hook - Run typecheck after TypeScript/JavaScript edits

command -v jq &>/dev/null || exit 0

# Read JSON input from stdin
input=$(cat)

file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

# Only run typecheck for TypeScript/JavaScript files
if echo "$file_path" | grep -qE '\.(ts|tsx|js|jsx)$'; then
    if [ -f "package.json" ]; then
        # Check if typecheck script exists
        if jq -e '.scripts.typecheck' package.json >/dev/null 2>&1; then
            result=$(npm run typecheck 2>&1)
            if [ $? -ne 0 ]; then
                echo "[Typecheck] Errors found:"
                echo "$result"
            fi
        fi
    fi
fi

exit 0
