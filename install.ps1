<#
.SYNOPSIS
    Claude Auto-Dev Installer (v4.8)
.EXAMPLE
    .\install.ps1              # Install skills to ~/.claude/skills/
    .\install.ps1 -Init        # Initialize current project
    .\install.ps1 -Full        # Skills + hooks + rules
#>

param(
    [switch]$Init,
    [switch]$Full,
    [string]$Name = (Split-Path -Leaf (Get-Location))
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Version = Get-Content "$ScriptDir\VERSION" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Version) { $Version = "4.8.0" }

$ClaudeDir = "$env:USERPROFILE\.claude"

Write-Host "`nClaude Auto-Dev v$Version" -ForegroundColor Cyan
Write-Host "========================" -ForegroundColor Cyan

# Create directories
@("$ClaudeDir", "$ClaudeDir\skills") | ForEach-Object {
    if (-not (Test-Path $_)) {
        New-Item -ItemType Directory -Path $_ -Force | Out-Null
    }
}

# Always install skills (copy entire folder recursively)
Write-Host "`n[Skills]" -ForegroundColor Yellow
Copy-Item -Path "$ScriptDir\skills\*" -Destination "$ClaudeDir\skills\" -Recurse -Force
Write-Host "  Installed to ~/.claude/skills/" -ForegroundColor Green

# Full install includes hooks and rules
if ($Full) {
    # Rules
    if (Test-Path "$ScriptDir\config\rules") {
        Write-Host "`n[Rules]" -ForegroundColor Yellow
        if (-not (Test-Path "$ClaudeDir\rules")) {
            New-Item -ItemType Directory -Path "$ClaudeDir\rules" -Force | Out-Null
        }
        Copy-Item -Path "$ScriptDir\config\rules\*" -Destination "$ClaudeDir\rules\" -Force
        Write-Host "  Installed to ~/.claude/rules/" -ForegroundColor Green
    }

    # Hooks
    if (Test-Path "$ScriptDir\hooks") {
        Write-Host "`n[Hooks]" -ForegroundColor Yellow
        if (-not (Test-Path "$ClaudeDir\hooks")) {
            New-Item -ItemType Directory -Path "$ClaudeDir\hooks" -Force | Out-Null
        }
        Copy-Item -Path "$ScriptDir\hooks\*.ps1" -Destination "$ClaudeDir\hooks\" -Force
        Write-Host "  Installed to ~/.claude/hooks/" -ForegroundColor Green
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

    # prd.json
    if (-not (Test-Path "prd.json")) {
        (Get-Content "$ScriptDir\templates\prd.json" -Raw) `
            -replace '\{\{NAME\}\}', $Name `
            -replace '\{\{DATE\}\}', $Date |
            Out-File "prd.json" -Encoding UTF8 -NoNewline
        Write-Host "  Created prd.json" -ForegroundColor Green
    } else {
        Write-Host "  prd.json exists (skipped)" -ForegroundColor DarkGray
    }

    # .claude directory
    if (-not (Test-Path ".claude")) {
        New-Item -ItemType Directory -Path ".claude" -Force | Out-Null
        Write-Host "  Created .claude/" -ForegroundColor Green
    }
}

Write-Host "`nDone! Run: claude" -ForegroundColor Green
Write-Host "Then say: brainstorm`n" -ForegroundColor Cyan
