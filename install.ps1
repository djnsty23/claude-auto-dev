<#
.SYNOPSIS
    Claude Auto-Dev Installer
.EXAMPLE
    .\install.ps1 -Global          # Install skill (once per machine)
    .\install.ps1 -Init            # Initialize current project
    .\install.ps1 -Global -Init    # Both
    .\install.ps1 -Update          # Update skill file
    .\install.ps1 -Full            # FULL RESTORE: all configs + API key setup
#>

param(
    [switch]$Global,
    [switch]$Init,
    [switch]$Update,
    [switch]$Full,
    [string]$Name = (Split-Path -Leaf (Get-Location))
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Version = Get-Content "$ScriptDir\VERSION" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Version) { $Version = "dev" }

function Write-Step { param($msg) Write-Host "[>] $msg" -ForegroundColor Cyan }
function Write-Done { param($msg) Write-Host "[+] $msg" -ForegroundColor Green }
function Write-Skip { param($msg) Write-Host "[o] $msg (exists)" -ForegroundColor Yellow }

# Full restore (includes Global)
if ($Full) {
    Write-Host "`n=== FULL RESTORE (v$Version) ===" -ForegroundColor Magenta

    $claudeDir = "$env:USERPROFILE\.claude"

    # Create directories
    @("$claudeDir", "$claudeDir\skills", "$claudeDir\rules", "$claudeDir\hooks") | ForEach-Object {
        if (-not (Test-Path $_)) {
            New-Item -ItemType Directory -Path $_ -Force | Out-Null
        }
    }

    # Copy global configs
    Write-Step "Installing global configs..."
    Copy-Item "$ScriptDir\config\CLAUDE.md" "$claudeDir\CLAUDE.md" -Force
    Write-Done "~/.claude/CLAUDE.md"

    Copy-Item "$ScriptDir\config\QUICKSTART.md" "$claudeDir\QUICKSTART.md" -Force
    Write-Done "~/.claude/QUICKSTART.md"

    # Copy rules
    Write-Step "Installing rules..."
    Get-ChildItem "$ScriptDir\config\rules\*.md" | ForEach-Object {
        Copy-Item $_.FullName "$claudeDir\rules\$($_.Name)" -Force
        Write-Done "~/.claude/rules/$($_.Name)"
    }

    # Copy all skills
    Write-Step "Installing skills..."
    Get-ChildItem "$ScriptDir\skills\*.md" | ForEach-Object {
        Copy-Item $_.FullName "$claudeDir\skills\$($_.Name)" -Force
        Write-Done "~/.claude/skills/$($_.Name)"
    }

    # Copy hooks
    if (Test-Path "$ScriptDir\hooks") {
        Write-Step "Installing hooks..."
        Get-ChildItem "$ScriptDir\hooks\*.ps1" | ForEach-Object {
            Copy-Item $_.FullName "$claudeDir\hooks\$($_.Name)" -Force
            Write-Done "~/.claude/hooks/$($_.Name)"
        }
    }

    # Copy settings.json (if not exists)
    if (-not (Test-Path "$claudeDir\settings.json")) {
        Write-Step "Installing settings.json with hooks..."
        Copy-Item "$ScriptDir\config\settings.json" "$claudeDir\settings.json" -Force
        Write-Done "~/.claude/settings.json"
    } else {
        Write-Skip "settings.json (run manually to update hooks config)"
    }

    # Install plugin for slash commands
    Write-Step "Installing claude-auto-dev plugin..."
    $pluginDir = "$claudeDir\plugins\local\claude-auto-dev"
    if (-not (Test-Path $pluginDir)) {
        New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
    }
    Copy-Item "$ScriptDir\plugin\*" $pluginDir -Recurse -Force
    Write-Done "~/.claude/plugins/local/claude-auto-dev"

    # Register plugin in installed_plugins.json
    $pluginsFile = "$claudeDir\plugins\installed_plugins.json"
    if (Test-Path $pluginsFile) {
        $plugins = Get-Content $pluginsFile -Raw | ConvertFrom-Json
        if (-not $plugins.plugins."claude-auto-dev@local") {
            $plugins.plugins | Add-Member -NotePropertyName "claude-auto-dev@local" -NotePropertyValue @(
                @{
                    scope = "user"
                    installPath = $pluginDir.Replace('\', '\\')
                    version = $Version
                    installedAt = (Get-Date -Format "o")
                    lastUpdated = (Get-Date -Format "o")
                }
            ) -Force
            $plugins | ConvertTo-Json -Depth 10 | Out-File $pluginsFile -Encoding UTF8
            Write-Done "Registered in installed_plugins.json"
        } else {
            Write-Skip "Plugin already registered"
        }
    }

    # Enable plugin in settings.json
    $settingsFile = "$claudeDir\settings.json"
    if (Test-Path $settingsFile) {
        $settings = Get-Content $settingsFile -Raw | ConvertFrom-Json
        if (-not $settings.enabledPlugins."claude-auto-dev@local") {
            if (-not $settings.enabledPlugins) {
                $settings | Add-Member -NotePropertyName "enabledPlugins" -NotePropertyValue @{} -Force
            }
            $settings.enabledPlugins | Add-Member -NotePropertyName "claude-auto-dev@local" -NotePropertyValue $true -Force
            $settings | ConvertTo-Json -Depth 10 | Out-File $settingsFile -Encoding UTF8
            Write-Done "Enabled in settings.json"
        } else {
            Write-Skip "Plugin already enabled"
        }
    }

    # Run API key setup if mcp.json doesn't exist
    if (-not (Test-Path "$claudeDir\mcp.json")) {
        Write-Host "`n=== API Key Setup ===" -ForegroundColor Magenta
        Write-Host "No mcp.json found. Running setup wizard..." -ForegroundColor Yellow
        & "$ScriptDir\setup-keys.ps1"
    } else {
        Write-Skip "mcp.json (run setup-keys.ps1 manually to update)"
    }

    Write-Host "`n=== Full Restore Complete ===" -ForegroundColor Green
    exit 0
}

# Global install or update
if ($Global -or $Update) {
    Write-Host "`n=== Skill Install (v$Version) ===" -ForegroundColor Magenta

    $skillDir = "$env:USERPROFILE\.claude\skills"
    if (-not (Test-Path $skillDir)) {
        New-Item -ItemType Directory -Path $skillDir -Force | Out-Null
    }

    Get-ChildItem "$ScriptDir\skills\*.md" | ForEach-Object {
        Copy-Item $_.FullName "$skillDir\$($_.Name)" -Force
        Write-Done "~/.claude/skills/$($_.Name)"
    }
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
if (-not $Global -and -not $Init -and -not $Update -and -not $Full) {
    Write-Host @"

Claude Auto-Dev v$Version
========================
.\install.ps1 -Full      FULL RESTORE (all configs + API keys)
.\install.ps1 -Global    Install all skills
.\install.ps1 -Init      Initialize project
.\install.ps1 -Update    Update all skills

Commands: auto, continue, status, brainstorm, adjust, stop, reset

"@ -ForegroundColor Cyan
    exit 0
}

Write-Host "`n[+] Done. Run: claude `"brainstorm`"" -ForegroundColor Green
