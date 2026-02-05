---
name: clean
description: Remove temporary artifacts
allowed-tools: Bash, Glob
model: haiku
user-invocable: true
disable-model-invocation: true
---

# Clean

Remove Claude Code artifacts and temporary files.

## Process

1. **Screenshots** - Delete all `.claude/screenshots/*.png`
2. **Backups** - Delete `prd-backup-*.json` older than 7 days
3. **Handoffs** - Delete `handoff-*.md` older than 7 days
4. **Archives** - List `prd-archive-*.json` older than 30 days (prompt before delete)
5. **Auto flag** - Delete `.claude/auto-active` if stale (from crashed sessions)
6. **Playwright** - Delete `.playwright-mcp/` folder if exists
7. **Report** - Show files removed and space reclaimed

## Commands

```bash
# Screenshots (all)
rm -f .claude/screenshots/*.png

# Backups older than 7 days
find . -maxdepth 1 -name "prd-backup-*.json" -mtime +7 -delete

# Handoffs older than 7 days
find . -maxdepth 1 -name "handoff-*.md" -mtime +7 -delete

# Archives - list only (prompt user)
find . -maxdepth 1 -name "prd-archive-*.json" -mtime +30

# Stale auto mode flag
rm -f .claude/auto-active

# Playwright MCP artifacts
rm -rf .playwright-mcp/
```

## Windows (PowerShell)

```powershell
# Screenshots
Remove-Item .claude\screenshots\*.png -Force -ErrorAction SilentlyContinue

# Backups older than 7 days
Get-ChildItem prd-backup-*.json | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item

# Handoffs older than 7 days
Get-ChildItem handoff-*.md | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item
```

## Rules

- Never touch source code, prd.json, or config files
- Always report what was deleted
- Prompt before deleting archives (they contain history)
