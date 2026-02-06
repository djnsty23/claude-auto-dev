#!/bin/bash
# update.sh — Sync repo files to ~/.claude installation
# Usage: bash scripts/update.sh [REPO_PATH]
# Called by the update skill after git pull

REPO="${1:-.}"
DEST="${HOME:-$USERPROFILE}/.claude"
VERSION=$(cat "$REPO/VERSION" 2>/dev/null || echo "unknown")

# Ensure dest dirs exist
mkdir -p "$DEST/skills" "$DEST/hooks" "$DEST/rules"

# Skills (includes commands.md)
cp -r "$REPO/skills/"* "$DEST/skills/"

# Hooks
cp "$REPO/hooks/"* "$DEST/hooks/"

# Rules (add/update only, no delete)
cp "$REPO/config/rules/"* "$DEST/rules/" 2>/dev/null || true

# Settings (hooks config + security deny rules)
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || -n "$WINDIR" ]]; then
  cp "$REPO/config/settings.json" "$DEST/settings.json"
else
  cp "$REPO/config/settings-unix.json" "$DEST/settings.json"
fi

# Clean stale skill directories not in manifest
NATIVE_REPO=$(cygpath -m "$REPO" 2>/dev/null || echo "$REPO")
NATIVE_DEST=$(cygpath -m "$DEST" 2>/dev/null || echo "$DEST")
node -e "
try {
  const fs = require('fs');
  const path = require('path');
  const manifest = JSON.parse(fs.readFileSync(path.join('$NATIVE_REPO','skills','manifest.json'), 'utf8'));
  const validSkills = new Set(Object.keys(manifest.skills));
  const dest = path.join('$NATIVE_DEST','skills');
  fs.readdirSync(dest, { withFileTypes: true })
    .filter(d => d.isDirectory() && validSkills.has(d.name) === false)
    .forEach(d => {
      fs.rmSync(path.join(dest, d.name), { recursive: true, force: true });
      console.log('Removed stale: ' + d.name);
    });
} catch(e) { console.log('Stale cleanup skipped: ' + e.message); }
" || true

# Report
echo "[Update] Now at v$VERSION"
echo "[Update] Skills: synced"
echo "[Update] Hooks: synced"
echo "[Update] Settings: synced"

# Cleanup temp clone if used
[ "$REPO" = "/tmp/claude-auto-dev" ] && rm -rf "$REPO" || true

exit 0
