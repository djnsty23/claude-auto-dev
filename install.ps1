<#
.SYNOPSIS
    Claude Auto-Dev Installer
.EXAMPLE
    .\install.ps1 -Global          # Install skill (once per machine)
    .\install.ps1 -Init            # Initialize current project
    .\install.ps1 -Global -Init    # Both
    .\install.ps1 -Update          # Update skill file
#>

param(
    [switch]$Global,
    [switch]$Init,
    [switch]$Update,
    [string]$Name = (Split-Path -Leaf (Get-Location))
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step { param($msg) Write-Host "→ $msg" -ForegroundColor Cyan }
function Write-Done { param($msg) Write-Host "✓ $msg" -ForegroundColor Green }
function Write-Skip { param($msg) Write-Host "○ $msg (exists)" -ForegroundColor Yellow }

# Global install or update
if ($Global -or $Update) {
    Write-Host "`n=== Skill Install ===" -ForegroundColor Magenta

    $skillDir = "$env:USERPROFILE\.claude\skills"
    if (-not (Test-Path $skillDir)) {
        New-Item -ItemType Directory -Path $skillDir -Force | Out-Null
    }

    Copy-Item "$ScriptDir\skills\build.md" "$skillDir\build.md" -Force
    Write-Done "Installed ~/.claude/skills/build.md"
}

# Project init
if ($Init) {
    Write-Host "`n=== Project: $Name ===" -ForegroundColor Magenta

    $date = Get-Date -Format 'yyyy-MM-dd'

    @("CLAUDE.md", "prd.json", "progress.txt") | ForEach-Object {
        if (-not (Test-Path $_)) {
            Write-Step "Creating $_"
            (Get-Content "$ScriptDir\templates\$_" -Raw) `
                -replace '\{\{NAME\}\}', $Name `
                -replace '\{\{DATE\}\}', $date |
                Out-File $_ -Encoding UTF8 -NoNewline
            Write-Done $_
        } else {
            Write-Skip $_
        }
    }

    if (-not (Test-Path ".claude\briefs")) {
        New-Item -ItemType Directory -Path ".claude\briefs" -Force | Out-Null
        Write-Done ".claude/briefs/"
    }
}

# Help
if (-not $Global -and -not $Init -and -not $Update) {
    Write-Host @"

Claude Auto-Dev
===============
.\install.ps1 -Global    Install skill file
.\install.ps1 -Init      Initialize project
.\install.ps1 -Update    Update skill file

Commands: auto, continue, status, brainstorm, adjust, stop

"@ -ForegroundColor Cyan
    exit 0
}

Write-Host "`n✓ Done. Run: claude `"brainstorm`"" -ForegroundColor Green
