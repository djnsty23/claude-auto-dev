# Claude Auto-Dev Update Script
# Syncs from source repo to installed locations

$ErrorActionPreference = "SilentlyContinue"
$sourceDir = "$env:USERPROFILE\Downloads\code\claude-auto-dev"
$claudeDir = "$env:USERPROFILE\.claude"

Write-Host "Updating claude-auto-dev..." -ForegroundColor Cyan

# 1. Pull from GitHub
Write-Host "`n[1/4] Pulling from GitHub..."
Push-Location $sourceDir
$gitResult = git pull 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  $gitResult" -ForegroundColor Green
} else {
    Write-Host "  Skipped (not online or not a git repo)" -ForegroundColor Yellow
}
Pop-Location

# 2. Sync plugin
Write-Host "`n[2/4] Syncing plugin..."
Copy-Item -Path "$sourceDir\plugin\*" -Destination "$claudeDir\plugins\local\claude-auto-dev" -Recurse -Force
$version = (Get-Content "$sourceDir\plugin\.claude-plugin\plugin.json" | ConvertFrom-Json).version
Write-Host "  Plugin synced to v$version" -ForegroundColor Green

# 3. Sync hooks
Write-Host "`n[3/4] Syncing hooks..."
$hookCount = (Get-ChildItem "$sourceDir\hooks\*.ps1").Count
Copy-Item -Path "$sourceDir\hooks\*" -Destination "$claudeDir\hooks" -Recurse -Force
Write-Host "  $hookCount hook files synced" -ForegroundColor Green

# 4. Sync config (optional - uncomment if wanted)
# Write-Host "`n[4/4] Syncing config..."
# Copy-Item -Path "$sourceDir\config\CLAUDE.md" -Destination "$claudeDir\CLAUDE.md" -Force
# Copy-Item -Path "$sourceDir\config\rules\*" -Destination "$claudeDir\rules" -Recurse -Force

Write-Host "`n[4/4] Checking Claude Code version..."
$claudeVersion = claude --version 2>&1
Write-Host "  $claudeVersion" -ForegroundColor Green

Write-Host "`n✓ Update complete!" -ForegroundColor Green
Write-Host "  Plugin: v$version"
Write-Host "  Hooks: $hookCount files"
