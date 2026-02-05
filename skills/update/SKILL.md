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

1. **Pull latest from GitHub**
   ```bash
   cd <repo-path> && git pull
   ```

2. **Sync skills/** - Copy all, remove stale
   ```bash
   # Get repo path
   REPO=$(cat ~/.claude/repo-path.txt)

   # Sync skills (mirror mode - adds new, updates changed, removes deleted)
   rsync -av --delete "$REPO/skills/" ~/.claude/skills/

   # Windows alternative (PowerShell):
   robocopy "$REPO\skills" "$env:USERPROFILE\.claude\skills" /MIR /NFL /NDL /NJH /NJS
   ```

3. **Sync hooks/** - Same approach
   ```bash
   rsync -av --delete "$REPO/hooks/" ~/.claude/hooks/

   # Windows:
   robocopy "$REPO\hooks" "$env:USERPROFILE\.claude\hooks" /MIR /NFL /NDL /NJH /NJS
   ```

4. **Report changes**
   ```
   [Update] Pulled 3 commits
   [Update] Skills: 2 added, 1 updated, 0 removed
   [Update] Hooks: 0 added, 1 updated, 0 removed
   [Update] Now at v5.0
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

## What Does NOT Get Synced

- `~/.claude/rules/` - User customizations, never touched
- `~/.claude/settings.json` - User config
- `~/.claude/CLAUDE.md` - User instructions

## Execution

When user says "update dev":

1. Read `~/.claude/repo-path.txt` to find repo
2. Run git pull in repo
3. Run robocopy/rsync to mirror skills and hooks
4. Report version and changes
