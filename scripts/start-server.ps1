<#
.SYNOPSIS
    Start dev server in external terminal (Windows)
.DESCRIPTION
    Launches npm run dev in a new terminal window that persists after Claude Code closes.
    Checks if port is already in use first.
.EXAMPLE
    .\start-server.ps1
    .\start-server.ps1 -Port 3001
#>

param(
    [int]$Port = 3000
)

$ErrorActionPreference = "Stop"

# Check if port is already in use
$portInUse = netstat -ano | Select-String ":$Port\s"
if ($portInUse) {
    Write-Host "Port $Port is already in use." -ForegroundColor Yellow
    Write-Host "Existing server detected - no action needed." -ForegroundColor Green

    # Extract PID
    $match = $portInUse[0].ToString() -match '\s(\d+)$'
    if ($match) {
        $pid = $matches[1]
        Write-Host "Process ID: $pid" -ForegroundColor Gray
    }
    exit 0
}

# Get current directory
$projectDir = Get-Location

# Start dev server in new terminal
Write-Host "Starting dev server on port $Port..." -ForegroundColor Cyan
Start-Process cmd -ArgumentList "/k", "cd /d `"$projectDir`" && npm run dev"

Write-Host "Dev server starting in new terminal window." -ForegroundColor Green
Write-Host "URL: http://localhost:$Port" -ForegroundColor Gray
