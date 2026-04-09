#!/bin/bash
# Claude Auto-Dev Uninstaller
# Surgically removes only files owned by this repo — leaves user skills/hooks/rules intact.
#
# Usage:
#   ./uninstall.sh            # actually remove
#   ./uninstall.sh --dry-run  # preview what would be removed

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node &> /dev/null; then
    echo "Error: Node.js required. Install from https://nodejs.org"
    exit 1
fi

node "$SCRIPT_DIR/scripts/uninstall.js" --repo "$SCRIPT_DIR" "$@"
