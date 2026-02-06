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

# Settings — merge (preserves user-added allow rules and custom hooks)
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || -n "$WINDIR" ]]; then
  SETTINGS_SRC="$REPO/config/settings.json"
else
  SETTINGS_SRC="$REPO/config/settings-unix.json"
fi
NATIVE_SRC=$(cygpath -m "$SETTINGS_SRC" 2>/dev/null || echo "$SETTINGS_SRC")
NATIVE_SETTINGS_DEST=$(cygpath -m "$DEST/settings.json" 2>/dev/null || echo "$DEST/settings.json")
UPDATE_SRC="$NATIVE_SRC" UPDATE_DEST="$NATIVE_SETTINGS_DEST" node -e "
const fs = require('fs');
const src = process.env.UPDATE_SRC;
const dest = process.env.UPDATE_DEST;
try {
  const incoming = JSON.parse(fs.readFileSync(src, 'utf8'));
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(dest, 'utf8')); } catch {}

  // Backup existing settings
  if (Object.keys(existing).length > 0) {
    fs.writeFileSync(dest.replace('.json', '.backup.json'), JSON.stringify(existing, null, 2));
  }

  // Merge permissions: incoming is base, add user-only entries
  const merged = JSON.parse(JSON.stringify(incoming));
  const incomingAllow = new Set(incoming.permissions?.allow || []);
  const incomingDeny = new Set(incoming.permissions?.deny || []);
  (existing.permissions?.allow || []).forEach(r => { if (incomingAllow.has(r) === false) merged.permissions.allow.push(r); });
  (existing.permissions?.deny || []).forEach(r => { if (incomingDeny.has(r) === false) merged.permissions.deny.push(r); });

  // Preserve user model preference if they changed it
  if (existing.model && existing.model !== 'opus') merged.model = existing.model;

  // Hooks: incoming wins (security-critical), but preserve user-added hook events
  const incomingHookEvents = new Set(Object.keys(incoming.hooks || {}));
  Object.entries(existing.hooks || {}).forEach(([event, hooks]) => {
    if (incomingHookEvents.has(event) === false) merged.hooks[event] = hooks;
  });

  fs.writeFileSync(dest, JSON.stringify(merged, null, 2) + '\\n');
  console.log('[Update] Settings: merged (user rules preserved)');
} catch(e) {
  // Fallback: validate incoming before copying
  try {
    JSON.parse(fs.readFileSync(src, 'utf8'));
    fs.copyFileSync(src, dest);
    console.log('[Update] Settings: copied (merge failed: ' + e.message + ')');
  } catch(e2) {
    console.log('[Update] Settings: skipped (invalid source: ' + e2.message + ')');
  }
}
" || true

# Clean deprecated skills only (user-created skills are never touched)
NATIVE_REPO=$(cygpath -m "$REPO" 2>/dev/null || echo "$REPO")
NATIVE_DEST=$(cygpath -m "$DEST" 2>/dev/null || echo "$DEST")
UPDATE_REPO="$NATIVE_REPO" UPDATE_DEST_DIR="$NATIVE_DEST" node -e "
try {
  const fs = require('fs');
  const path = require('path');
  const manifest = JSON.parse(fs.readFileSync(path.join(process.env.UPDATE_REPO,'skills','manifest.json'), 'utf8'));
  const deprecated = new Set(manifest.deprecated || []);
  const dest = path.join(process.env.UPDATE_DEST_DIR,'skills');
  fs.readdirSync(dest, { withFileTypes: true })
    .filter(d => d.isDirectory() && deprecated.has(d.name))
    .forEach(d => {
      fs.rmSync(path.join(dest, d.name), { recursive: true, force: true });
      console.log('Removed deprecated: ' + d.name);
    });
} catch(e) { console.log('Stale cleanup skipped: ' + e.message); }
" || true

# Post-install validation
ERRORS=0
[ ! -f "$DEST/skills/manifest.json" ] && echo "[WARN] manifest.json missing" && ERRORS=$((ERRORS+1))
[ ! -f "$DEST/hooks/session-start.js" ] && echo "[WARN] session-start.js missing" && ERRORS=$((ERRORS+1))
[ ! -f "$DEST/settings.json" ] && echo "[WARN] settings.json missing" && ERRORS=$((ERRORS+1))
[ ! -f "$DEST/skills/commands.md" ] && echo "[WARN] commands.md missing" && ERRORS=$((ERRORS+1))

# Report
echo "[Update] Now at v$VERSION"
echo "[Update] Skills: synced"
echo "[Update] Hooks: synced"
[ $ERRORS -eq 0 ] && echo "[Update] Validation: OK" || echo "[Update] Validation: $ERRORS warnings"

# Cleanup temp clone if used
[ "$REPO" = "/tmp/claude-auto-dev" ] && rm -rf "$REPO" || true

exit 0
