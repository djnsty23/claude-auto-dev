#!/bin/bash
# update.sh — Sync repo files to ~/.claude installation
# Usage: bash scripts/update.sh [REPO_PATH]
# Called by the update skill after git pull

REPO="${1:-.}"

# Delegate to sync.js (single source of truth)
node "$REPO/scripts/sync.js" --repo "$REPO" --rules --settings --clean-deprecated

# Cleanup temp clone if used
[ "$REPO" = "/tmp/claude-auto-dev" ] && rm -rf "$REPO" || true

exit 0
