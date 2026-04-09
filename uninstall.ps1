<#
.SYNOPSIS
    Claude Auto-Dev Uninstaller
    Surgically removes only files owned by this repo — leaves user skills/hooks/rules intact.
.EXAMPLE
    .\uninstall.ps1
    .\uninstall.ps1 -DryRun
#>

param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "Error: Node.js required. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}

$args = @("$ScriptDir\scripts\uninstall.js", "--repo", "$ScriptDir")
if ($DryRun) { $args += "--dry-run" }

& node @args
