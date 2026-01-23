---
description: Update Claude Code plugins and sync from source repo
---

# Update

Refresh and update all system components.

## Process

1. **Pull latest from GitHub**
   ```powershell
   cd "$env:USERPROFILE\Downloads\code\claude-auto-dev"
   git pull origin main
   ```

2. **Sync plugin from source repo**
   ```powershell
   Copy-Item -Path "$env:USERPROFILE\Downloads\code\claude-auto-dev\.claude-plugin" `
             -Destination "$env:USERPROFILE\.claude\plugins\local\claude-auto-dev\.claude-plugin" -Recurse -Force
   Copy-Item -Path "$env:USERPROFILE\Downloads\code\claude-auto-dev\commands" `
             -Destination "$env:USERPROFILE\.claude\plugins\local\claude-auto-dev\commands" -Recurse -Force
   ```

3. **Sync hooks**
   ```powershell
   Copy-Item -Path "$env:USERPROFILE\Downloads\code\claude-auto-dev\hooks\*" `
             -Destination "$env:USERPROFILE\.claude\hooks" -Recurse -Force
   ```

4. **Check Claude Code version**
   ```bash
   claude --version
   ```

## Quick Command

Run this to update everything:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Downloads\code\claude-auto-dev\scripts\update.ps1"
```

## Report Format

```
Update Complete:
- Source repo: [pulled X commits / already up to date]
- Plugin: synced to vX.X.X
- Hooks: X files updated
- Claude Code: vX.X.X
```
