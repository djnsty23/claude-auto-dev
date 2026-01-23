---
description: Update Claude Code plugins and sync from source repo
---

# Update

Refresh and update all system components.

## Process

1. **Sync local plugin from source repo**
   ```powershell
   # Copy plugin files from source to installed location
   Copy-Item -Path "$env:USERPROFILE\Downloads\code\claude-auto-dev\plugin\*" `
             -Destination "$env:USERPROFILE\.claude\plugins\local\claude-auto-dev" `
             -Recurse -Force
   ```

2. **Sync hooks from source repo**
   ```powershell
   Copy-Item -Path "$env:USERPROFILE\Downloads\code\claude-auto-dev\hooks\*" `
             -Destination "$env:USERPROFILE\.claude\hooks" `
             -Recurse -Force
   ```

3. **Sync config files**
   ```powershell
   Copy-Item -Path "$env:USERPROFILE\Downloads\code\claude-auto-dev\config\CLAUDE.md" `
             -Destination "$env:USERPROFILE\.claude\CLAUDE.md" -Force
   Copy-Item -Path "$env:USERPROFILE\Downloads\code\claude-auto-dev\config\rules\*" `
             -Destination "$env:USERPROFILE\.claude\rules" -Recurse -Force
   ```

4. **Pull latest from GitHub** (if online)
   ```powershell
   cd "$env:USERPROFILE\Downloads\code\claude-auto-dev"
   git pull origin main
   ```

5. **Check Claude Code version**
   ```bash
   claude --version
   ```

## Quick Command

Run this single command to update everything:

```powershell
powershell -ExecutionPolicy Bypass -Command "& { cd $env:USERPROFILE\Downloads\code\claude-auto-dev; git pull 2>$null; Copy-Item -Path plugin\* -Destination $env:USERPROFILE\.claude\plugins\local\claude-auto-dev -Recurse -Force; Copy-Item -Path hooks\* -Destination $env:USERPROFILE\.claude\hooks -Recurse -Force; Write-Host 'Updated!' }"
```

## Report Format

```
Update Complete:
- Source repo: [pulled X commits / already up to date]
- Plugin: synced to vX.X.X
- Hooks: X files updated
- Claude Code: vX.X.X
```
