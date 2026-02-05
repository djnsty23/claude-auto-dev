---
name: update
description: Update claude-auto-dev to latest version. Syncs repo with ~/.claude.
triggers: update dev, update auto-dev, update skills, sync skills
allowed-tools: Bash, Read, Write, Glob
model: haiku
user-invocable: true
disable-model-invocation: true
---

# Update Claude Auto-Dev

Sync the local repo with ~/.claude installation.

## Process

### 1. Find repo

```bash
# Option A: repo-path.txt exists (installed via install.sh/ps1)
REPO=$(cat ~/.claude/repo-path.txt 2>/dev/null | tr -d '\r\n')

# Option B: No repo-path.txt → clone to temp
if [ -z "$REPO" ] || [ ! -d "$REPO" ]; then
  REPO=/tmp/claude-auto-dev
  rm -rf "$REPO"
  gh repo clone djnsty23/claude-auto-dev "$REPO"
fi
```

### 2. Pull latest

```bash
cd "$REPO" && git pull
```

### 3. Sync skills/ (includes commands.md)

```bash
# Mac/Linux
rsync -av --delete "$REPO/skills/" ~/.claude/skills/

# Windows (PowerShell)
robocopy "$REPO\skills" "$env:USERPROFILE\.claude\skills" /MIR /NFL /NDL /NJH /NJS
```

### 4. Sync hooks/

```bash
rsync -av --delete "$REPO/hooks/" ~/.claude/hooks/

# Windows
robocopy "$REPO\hooks" "$env:USERPROFILE\.claude\hooks" /MIR /NFL /NDL /NJH /NJS
```

### 5. Sync rules/ (add new, keep existing)

```bash
# Copy new/updated rules WITHOUT deleting user customizations
cp "$REPO/config/rules/"* ~/.claude/rules/ 2>/dev/null

# Windows
Copy-Item "$REPO\config\rules\*" "$env:USERPROFILE\.claude\rules\" -Force
```

### 6. Report

```
[Update] Now at v5.0
[Update] Skills: synced (34)
[Update] Hooks: synced
[Update] Rules: synced
```

### 7. Cleanup (if cloned to temp)

```bash
[ "$REPO" = "/tmp/claude-auto-dev" ] && rm -rf "$REPO"
```

## Windows Commands

```powershell
# Full update script
$repo = (Get-Content "$env:USERPROFILE\.claude\repo-path.txt" -Raw).Trim()

# Pull
Push-Location $repo
git pull
$version = Get-Content "$repo\VERSION"
Pop-Location

# Sync skills (robocopy /MIR = mirror, deletes extras)
robocopy "$repo\skills" "$env:USERPROFILE\.claude\skills" /MIR /E /NFL /NDL /NJH /NJS /NP

# Sync hooks
robocopy "$repo\hooks" "$env:USERPROFILE\.claude\hooks" /MIR /E /NFL /NDL /NJH /NJS /NP

Write-Host "Updated to v$version"
```

## Mac/Linux Commands

```bash
REPO=$(cat ~/.claude/repo-path.txt | tr -d '\r\n')

# Pull
cd "$REPO" && git pull

# Sync with rsync (--delete removes stale files)
rsync -av --delete "$REPO/skills/" ~/.claude/skills/
rsync -av --delete "$REPO/hooks/" ~/.claude/hooks/

echo "Updated to v$(cat $REPO/VERSION)"
```

## What Gets Synced

| Source | Destination | Mode |
|--------|-------------|------|
| `repo/skills/` | `~/.claude/skills/` | Mirror (delete stale) |
| `repo/hooks/` | `~/.claude/hooks/` | Mirror (delete stale) |
| `repo/config/rules/` | `~/.claude/rules/` | Copy (add/update only, no delete) |

Note: `commands.md` lives inside `skills/` — it syncs automatically with skills.

## What Does NOT Get Synced

- `~/.claude/settings.json` - User config, never touched
- `~/.claude/CLAUDE.md` - User instructions, never touched

## Execution

When user says "update dev":

1. Find repo via `~/.claude/repo-path.txt` or clone from GitHub
2. Pull latest
3. Mirror skills/ and hooks/ (rsync --delete or robocopy /MIR)
4. Copy rules/ (add/update only)
5. Report version
6. Clean up temp clone if used
