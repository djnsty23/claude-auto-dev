<#
.SYNOPSIS
    Claude Auto-Dev Installer (v7.0)
.EXAMPLE
    .\install.ps1              # Symlink skills + hooks, add update-dev alias
    .\install.ps1 -Full        # + rules + settings
    .\install.ps1 -Init        # + initialize current project with prd.json
    .\install.ps1 -Copy        # Use copy instead of symlinks
#>

param(
    [switch]$Init,
    [switch]$Full,
    [switch]$Force,
    [switch]$Copy,   # deprecated: kept for back-compat, ignored
    [string]$Name = (Split-Path -Leaf (Get-Location))
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Version = Get-Content "$ScriptDir\VERSION" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Version) { $Version = "7.0" }

$ClaudeDir = "$env:USERPROFILE\.claude"

Write-Host "`nClaude Auto-Dev v$Version" -ForegroundColor Cyan
Write-Host "========================" -ForegroundColor Cyan

# Check for Claude Code (Node.js only needed if Claude Code not installed)
Write-Host "`n[Prerequisites]" -ForegroundColor Yellow
$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if ($claudeCmd) {
    $claudeVersion = (claude --version 2>$null | Select-Object -First 1)
    Write-Host "  Claude Code $claudeVersion" -ForegroundColor Green
} else {
    # Need Node.js to install Claude Code
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Host "  Node.js not found. Install from https://nodejs.org (v18+)" -ForegroundColor Red
        exit 1
    }
    $nodeVersion = (node -v) -replace '^v', ''
    $nodeMajor = [int]($nodeVersion -split '\.')[0]
    if ($nodeMajor -lt 18) {
        Write-Host "  Node.js v18+ required (found v$nodeVersion)" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Node.js v$nodeVersion" -ForegroundColor Green
    Write-Host "  Claude Code not found - installing..." -ForegroundColor Yellow
    npm install -g @anthropic-ai/claude-code
    $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($claudeCmd) {
        $claudeVersion = (claude --version 2>$null | Select-Object -First 1)
        Write-Host "  Claude Code $claudeVersion installed" -ForegroundColor Green
    } else {
        Write-Host "  Claude Code install failed. Try: npm install -g @anthropic-ai/claude-code" -ForegroundColor Red
        exit 1
    }
}

# Create base directory
if (-not (Test-Path $ClaudeDir)) {
    New-Item -ItemType Directory -Path $ClaudeDir -Force | Out-Null
}

# Save repo path for update-dev
$RepoPathFile = "$ClaudeDir\repo-path.txt"
Set-Content -Path $RepoPathFile -Value $ScriptDir -NoNewline
Write-Host "`n[Repo Path]" -ForegroundColor Yellow
Write-Host "  Saved to ~/.claude/repo-path.txt" -ForegroundColor Green

# Sync skills, hooks, agents via sync.js
Write-Host "`n[Syncing Skills, Hooks, Agents]" -ForegroundColor Yellow
$SyncArgsList = @("--repo", $ScriptDir)
if ($Full)  { $SyncArgsList += @("--rules", "--settings") }
if ($Force) { $SyncArgsList += "--force" }
& node "$ScriptDir\scripts\sync.js" @SyncArgsList

# Add update-dev alias to PowerShell profile (detect correct location)
Write-Host "`n[Update Alias]" -ForegroundColor Yellow

# Use $PROFILE to get correct path (handles OneDrive, PowerShell versions)
$ProfilePath = $PROFILE.CurrentUserCurrentHost
if (-not $ProfilePath) {
    # Fallback for older PowerShell
    $ProfilePath = "$env:USERPROFILE\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1"
}
$ProfileDir = Split-Path -Parent $ProfilePath

if (-not (Test-Path $ProfileDir)) {
    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
}

$AliasFunction = @'

# Claude Auto-Dev update function
function Update-Dev {
    $repoPathFile = "$env:USERPROFILE\.claude\repo-path.txt"
    if (-not (Test-Path $repoPathFile)) {
        Write-Host "Error: repo-path.txt not found" -ForegroundColor Red
        return
    }
    $repoPath = (Get-Content $repoPathFile -Raw).Trim()
    if (-not (Test-Path $repoPath)) {
        Write-Host "Error: Repo not found at $repoPath" -ForegroundColor Red
        return
    }
    Write-Host "Updating claude-auto-dev..." -ForegroundColor Cyan
    Push-Location $repoPath
    git fetch
    $behind = git rev-list --count HEAD..origin/main 2>$null
    if ($behind -gt 0) {
        Write-Host "Pulling $behind new commit(s)..." -ForegroundColor Yellow
        git pull
        $version = Get-Content "$repoPath\VERSION" -ErrorAction SilentlyContinue
        Write-Host "Updated to v$version" -ForegroundColor Green
        # Re-sync if using copy mode (not symlinks)
        $skillsDir = "$env:USERPROFILE\.claude\skills"
        if (-not ((Get-Item $skillsDir -ErrorAction SilentlyContinue).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Write-Host "Re-syncing (copy mode)..." -ForegroundColor Yellow
            node "$repoPath\scripts\sync.js" --repo "$repoPath" --rules --clean-deprecated
        }
    } else {
        Write-Host "Already up to date." -ForegroundColor Green
    }
    Pop-Location
}
Set-Alias -Name update-dev -Value Update-Dev
'@

if (Test-Path $ProfilePath) {
    $ProfileContent = Get-Content $ProfilePath -Raw
    if ($ProfileContent -notmatch 'function Update-Dev') {
        Add-Content -Path $ProfilePath -Value $AliasFunction
        Write-Host "  Added update-dev to PowerShell profile" -ForegroundColor Green
    } else {
        Write-Host "  update-dev already in profile (skipped)" -ForegroundColor DarkGray
    }
} else {
    Set-Content -Path $ProfilePath -Value $AliasFunction.TrimStart()
    Write-Host "  Created PowerShell profile with update-dev" -ForegroundColor Green
}

# Rules and settings are now handled inline by sync.js via --rules --settings
# when -Full is passed (see $SyncArgsList above).

# Project init
if ($Init) {
    Write-Host "`n[Project: $Name]" -ForegroundColor Yellow
    $Date = Get-Date -Format 'yyyy-MM-dd'

    if (-not (Test-Path "prd.json")) {
        (Get-Content "$ScriptDir\templates\prd.json" -Raw) `
            -replace '\{\{NAME\}\}', $Name `
            -replace '\{\{DATE\}\}', $Date |
            Out-File "prd.json" -Encoding UTF8 -NoNewline
        Write-Host "  Created prd.json" -ForegroundColor Green
    } else {
        Write-Host "  prd.json exists (skipped)" -ForegroundColor DarkGray
    }

    if (-not (Test-Path ".claude")) {
        New-Item -ItemType Directory -Path ".claude" -Force | Out-Null
        Write-Host "  Created .claude/" -ForegroundColor Green
    }
}

Write-Host "`n[Done]" -ForegroundColor Green
Write-Host "  Skills/hooks auto-sync with repo"
Write-Host "  Run 'update-dev' to pull latest changes"
Write-Host "`nStart Claude: claude" -ForegroundColor Cyan
Write-Host "Then say: brainstorm`n"
