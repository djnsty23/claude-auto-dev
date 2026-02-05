<#
.SYNOPSIS
    Claude Auto-Dev Installer (v4.9)
.EXAMPLE
    .\install.ps1              # Symlink skills + hooks, add update-dev alias
    .\install.ps1 -Full        # + rules + settings
    .\install.ps1 -Init        # + initialize current project with prd.json
    .\install.ps1 -Copy        # Use copy instead of symlinks
#>

param(
    [switch]$Init,
    [switch]$Full,
    [switch]$Copy,
    [string]$Name = (Split-Path -Leaf (Get-Location))
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Version = Get-Content "$ScriptDir\VERSION" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Version) { $Version = "4.9.0" }

$ClaudeDir = "$env:USERPROFILE\.claude"

Write-Host "`nClaude Auto-Dev v$Version" -ForegroundColor Cyan
Write-Host "========================" -ForegroundColor Cyan

# Create base directory
if (-not (Test-Path $ClaudeDir)) {
    New-Item -ItemType Directory -Path $ClaudeDir -Force | Out-Null
}

# Save repo path for update-dev
$RepoPathFile = "$ClaudeDir\repo-path.txt"
Set-Content -Path $RepoPathFile -Value $ScriptDir -NoNewline
Write-Host "`n[Repo Path]" -ForegroundColor Yellow
Write-Host "  Saved to ~/.claude/repo-path.txt" -ForegroundColor Green

# Install skills
Write-Host "`n[Skills]" -ForegroundColor Yellow
$SkillsTarget = "$ClaudeDir\skills"

if ($Copy) {
    # Copy mode
    if (Test-Path $SkillsTarget) { Remove-Item -Recurse -Force $SkillsTarget }
    New-Item -ItemType Directory -Path $SkillsTarget -Force | Out-Null
    Copy-Item -Path "$ScriptDir\skills\*" -Destination $SkillsTarget -Recurse -Force
    Write-Host "  Copied to ~/.claude/skills/" -ForegroundColor Green
} else {
    # Symlink mode (default)
    if (Test-Path $SkillsTarget) { Remove-Item -Recurse -Force $SkillsTarget }
    try {
        New-Item -ItemType SymbolicLink -Path $SkillsTarget -Target "$ScriptDir\skills" -Force | Out-Null
        Write-Host "  Symlinked ~/.claude/skills/ -> repo" -ForegroundColor Green
    } catch {
        Write-Host "  Symlink failed (need admin or Developer Mode). Using copy..." -ForegroundColor Yellow
        New-Item -ItemType Directory -Path $SkillsTarget -Force | Out-Null
        Copy-Item -Path "$ScriptDir\skills\*" -Destination $SkillsTarget -Recurse -Force
        Write-Host "  Copied to ~/.claude/skills/" -ForegroundColor Green
    }
}

# Install hooks
Write-Host "`n[Hooks]" -ForegroundColor Yellow
$HooksTarget = "$ClaudeDir\hooks"

if ($Copy) {
    if (Test-Path $HooksTarget) { Remove-Item -Recurse -Force $HooksTarget }
    New-Item -ItemType Directory -Path $HooksTarget -Force | Out-Null
    Copy-Item -Path "$ScriptDir\hooks\*" -Destination $HooksTarget -Force
    Write-Host "  Copied to ~/.claude/hooks/" -ForegroundColor Green
} else {
    if (Test-Path $HooksTarget) { Remove-Item -Recurse -Force $HooksTarget }
    try {
        New-Item -ItemType SymbolicLink -Path $HooksTarget -Target "$ScriptDir\hooks" -Force | Out-Null
        Write-Host "  Symlinked ~/.claude/hooks/ -> repo" -ForegroundColor Green
    } catch {
        Write-Host "  Symlink failed. Using copy..." -ForegroundColor Yellow
        New-Item -ItemType Directory -Path $HooksTarget -Force | Out-Null
        Copy-Item -Path "$ScriptDir\hooks\*" -Destination $HooksTarget -Force
        Write-Host "  Copied to ~/.claude/hooks/" -ForegroundColor Green
    }
}

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

# Full install adds rules and settings
if ($Full) {
    # Rules (copy, not symlink - these are templates user may customize)
    if (Test-Path "$ScriptDir\config\rules") {
        Write-Host "`n[Rules]" -ForegroundColor Yellow
        if (-not (Test-Path "$ClaudeDir\rules")) {
            New-Item -ItemType Directory -Path "$ClaudeDir\rules" -Force | Out-Null
        }
        Copy-Item -Path "$ScriptDir\config\rules\*" -Destination "$ClaudeDir\rules\" -Force
        Write-Host "  Copied to ~/.claude/rules/" -ForegroundColor Green
    }

    # Settings (only if not exists)
    if (-not (Test-Path "$ClaudeDir\settings.json")) {
        Copy-Item "$ScriptDir\config\settings.json" "$ClaudeDir\settings.json" -Force
        Write-Host "`n[Settings]" -ForegroundColor Yellow
        Write-Host "  Created ~/.claude/settings.json" -ForegroundColor Green
    }
}

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
Write-Host "  Updates pulled automatically on Claude start"
Write-Host "`nStart Claude: claude" -ForegroundColor Cyan
Write-Host "Then say: brainstorm`n"
