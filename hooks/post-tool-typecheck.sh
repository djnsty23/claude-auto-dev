#!/bin/bash
# PostToolUse hook - Run typecheck after TypeScript/JavaScript edits

# Read JSON input from stdin
input=$(cat)

# jq fallback: use grep to extract file_path
if ! command -v jq &>/dev/null; then
    file_path=$(echo "$input" | grep -oP '"file_path"\s*:\s*"([^"]*)"' | head -1 | sed 's/.*"file_path"\s*:\s*"//;s/"$//')
else
    file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')
fi

# Only run typecheck for TypeScript/JavaScript files
if echo "$file_path" | grep -qE '\.(ts|tsx|js|jsx)$'; then
    if [ -f "package.json" ]; then
        # Check if typecheck script exists (grep fallback if no jq)
        has_typecheck=false
        if command -v jq &>/dev/null; then
            jq -e '.scripts.typecheck' package.json >/dev/null 2>&1 && has_typecheck=true
        else
            grep -q '"typecheck"' package.json && has_typecheck=true
        fi
        if [ "$has_typecheck" = true ]; then
            result=$(timeout 30 npm run typecheck 2>&1)
            if [ $? -ne 0 ]; then
                echo ""
                echo "[TYPECHECK FAILED] Fix these errors before continuing:"
                echo "$result"
                echo ""
            fi
        fi
    fi
fi

exit 0
