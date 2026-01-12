<#
.SYNOPSIS
    Claude Auto-Dev Installer
.DESCRIPTION
    Installs the autonomous development system for Claude Code.

    -Global : Installs skill file to ~/.claude/skills/
    -Init   : Initializes prd.json, progress.txt, CLAUDE.md in current directory
.EXAMPLE
    # Install globally (once per machine)
    .\install.ps1 -Global

    # Initialize a project (run in project root)
    .\install.ps1 -Init

    # Both at once
    .\install.ps1 -Global -Init

    # One-liner from anywhere (after cloning)
    ~\Downloads\code\claude-auto-dev\install.ps1 -Global -Init
#>

param(
    [switch]$Global,
    [switch]$Init,
    [string]$ProjectName = (Split-Path -Leaf (Get-Location))
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Colors
function Write-Step { param($msg) Write-Host "→ $msg" -ForegroundColor Cyan }
function Write-Done { param($msg) Write-Host "✓ $msg" -ForegroundColor Green }
function Write-Skip { param($msg) Write-Host "○ $msg (exists)" -ForegroundColor Yellow }

# ============================================================================
# GLOBAL INSTALL
# ============================================================================

if ($Global) {
    Write-Host "`n=== Global Install ===" -ForegroundColor Magenta

    $skillDir = "$env:USERPROFILE\.claude\skills"
    $skillFile = "$skillDir\build.md"
    $sourceSkill = "$ScriptDir\skills\build.md"

    # Create skills directory
    if (-not (Test-Path $skillDir)) {
        Write-Step "Creating skills directory"
        New-Item -ItemType Directory -Path $skillDir -Force | Out-Null
        Write-Done "Created $skillDir"
    }

    # Copy skill file
    Write-Step "Installing build.md skill"
    Copy-Item -Path $sourceSkill -Destination $skillFile -Force
    Write-Done "Installed $skillFile"
}

# ============================================================================
# PROJECT INIT
# ============================================================================

if ($Init) {
    Write-Host "`n=== Project Init: $ProjectName ===" -ForegroundColor Magenta

    # Copy templates
    $templates = @{
        "CLAUDE.md" = "$ScriptDir\templates\CLAUDE.md"
        "prd.json" = "$ScriptDir\templates\prd.json"
        "progress.txt" = "$ScriptDir\templates\progress.txt"
    }

    foreach ($file in $templates.Keys) {
        if (-not (Test-Path $file)) {
            Write-Step "Creating $file"
            $content = Get-Content $templates[$file] -Raw
            $content = $content -replace '\$PROJECT_NAME', $ProjectName
            $content = $content -replace '\$DATE', (Get-Date -Format 'yyyy-MM-dd')
            $content | Out-File -FilePath $file -Encoding UTF8 -NoNewline
            Write-Done "Created $file"
        } else {
            Write-Skip $file
        }
    }

    # Create briefs directory
    $briefsDir = ".claude\briefs"
    if (-not (Test-Path $briefsDir)) {
        Write-Step "Creating .claude/briefs/"
        New-Item -ItemType Directory -Path $briefsDir -Force | Out-Null
        Write-Done "Created $briefsDir"
    } else {
        Write-Skip ".claude/briefs/"
    }

    # Update .gitignore
    $gitignore = ".gitignore"
    if (Test-Path $gitignore) {
        $content = Get-Content $gitignore -Raw
        if ($content -notmatch "tmpclaude-") {
            Write-Step "Adding tmpclaude-* to .gitignore"
            Add-Content -Path $gitignore -Value "tmpclaude-*"
            Write-Done "Updated .gitignore"
        }
    }
}

# ============================================================================
# USAGE HELP
# ============================================================================

if (-not $Global -and -not $Init) {
    Write-Host @"

Claude Auto-Dev Installer
=========================

Usage:
  # Install globally (once per machine)
  .\install.ps1 -Global

  # Initialize a project
  .\install.ps1 -Init

  # Both at once
  .\install.ps1 -Global -Init

After install:
  1. Add stories to prd.json
  2. Run: claude "auto"

Commands:
  auto     - Work through all tasks
  continue - One task at a time
  status   - Show progress
  adjust   - Interactive feature picker
  stop     - Clear claims before closing
  reset    - Clear all claims after crash

"@ -ForegroundColor Cyan
    exit 0
}

Write-Host "`n=== Done ===" -ForegroundColor Green
Write-Host @"

Next steps:
  1. Add stories to prd.json (or say "build [goal]" to generate)
  2. Run: claude "auto"

Commands:
  auto     - Autonomous mode (just keeps going)
  adjust   - Pick which features to work on next
  stop     - Before closing your session

"@ -ForegroundColor White
