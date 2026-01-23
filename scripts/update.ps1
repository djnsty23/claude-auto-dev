# Claude Auto-Dev Update Script
# Syncs from source repo to installed locations

$ErrorActionPreference = "SilentlyContinue"
$sourceDir = "$env:USERPROFILE\Downloads\code\claude-auto-dev"
$claudeDir = "$env:USERPROFILE\.claude"

Write-Host "Updating claude-auto-dev..." -ForegroundColor Cyan

# 1. Pull from GitHub
Write-Host ""
Write-Host "[1/4] Pulling from GitHub..."
Push-Location $sourceDir
$gitResult = git pull 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  $gitResult" -ForegroundColor Green
} else {
    Write-Host "  Skipped (not online or not a git repo)" -ForegroundColor Yellow
}
Pop-Location

# 2. Sync plugin
Write-Host ""
Write-Host "[2/4] Syncing plugin..."
Copy-Item -Path "$sourceDir\.claude-plugin" -Destination "$claudeDir\plugins\local\claude-auto-dev\.claude-plugin" -Recurse -Force
Copy-Item -Path "$sourceDir\commands" -Destination "$claudeDir\plugins\local\claude-auto-dev\commands" -Recurse -Force
$version = (Get-Content "$sourceDir\.claude-plugin\plugin.json" | ConvertFrom-Json).version
Write-Host "  Plugin synced to v$version" -ForegroundColor Green

# 3. Sync hooks
Write-Host ""
Write-Host "[3/4] Syncing hooks..."
$hookFiles = Get-ChildItem "$sourceDir\hooks\*.ps1" -ErrorAction SilentlyContinue
$hookCount = if ($hookFiles) { $hookFiles.Count } else { 0 }
Copy-Item -Path "$sourceDir\hooks\*" -Destination "$claudeDir\hooks" -Recurse -Force
Write-Host "  $hookCount hook files synced" -ForegroundColor Green

# 4. Check Claude version
Write-Host ""
Write-Host "[4/4] Checking Claude Code version..."
$claudeVersion = claude --version 2>&1
Write-Host "  $claudeVersion" -ForegroundColor Green

Write-Host ""
Write-Host "Update complete!" -ForegroundColor Green
Write-Host "  Plugin: v$version"
Write-Host "  Hooks: $hookCount files"
