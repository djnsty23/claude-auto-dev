# Claude Auto-Dev Update Script
# Syncs from source repo to installed locations

$ErrorActionPreference = "SilentlyContinue"
$sourceDir = "$env:USERPROFILE\Downloads\code\claude-auto-dev"
$claudeDir = "$env:USERPROFILE\.claude"
$pluginDir = "$claudeDir\plugins\local\claude-auto-dev"

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

# 2. Sync plugin (clean copy to avoid nesting)
Write-Host ""
Write-Host "[2/4] Syncing plugin..."

# Remove and recreate to avoid nesting issues
Remove-Item -Recurse -Force "$pluginDir\.claude-plugin" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$pluginDir\commands" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path "$pluginDir\.claude-plugin" -Force | Out-Null
New-Item -ItemType Directory -Path "$pluginDir\commands" -Force | Out-Null

# Copy files (not folders)
Copy-Item "$sourceDir\.claude-plugin\plugin.json" "$pluginDir\.claude-plugin\plugin.json" -Force
Copy-Item "$sourceDir\commands\*.md" "$pluginDir\commands\" -Force
Copy-Item "$sourceDir\PLUGIN.md" "$pluginDir\README.md" -Force -ErrorAction SilentlyContinue

$version = (Get-Content "$sourceDir\.claude-plugin\plugin.json" | ConvertFrom-Json).version
Write-Host "  Plugin synced to v$version" -ForegroundColor Green

# 3. Sync hooks
Write-Host ""
Write-Host "[3/4] Syncing hooks..."
$hookFiles = Get-ChildItem "$sourceDir\hooks\*.ps1" -ErrorAction SilentlyContinue
$hookCount = if ($hookFiles) { $hookFiles.Count } else { 0 }
Copy-Item -Path "$sourceDir\hooks\*" -Destination "$claudeDir\hooks" -Force
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
