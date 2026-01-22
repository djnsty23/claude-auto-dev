<#
.SYNOPSIS
    SessionStart hook - Inject project context at session start
.DESCRIPTION
    Outputs project status from prd.json and git status.
    This context is automatically added to Claude's initial prompt.
#>

$ErrorActionPreference = "SilentlyContinue"

Write-Host ""

# Project context from prd.json
if (Test-Path "prd.json") {
    try {
        $prd = Get-Content "prd.json" -Raw | ConvertFrom-Json

        if ($prd.stories) {
            $done = @($prd.stories | Where-Object { $_.passes -eq $true }).Count
            $total = $prd.stories.Count
            $remaining = @($prd.stories | Where-Object { $_.passes -ne $true })

            Write-Host "[Auto-Dev] Progress: $done/$total tasks complete"

            if ($remaining.Count -gt 0) {
                $next = $remaining | Select-Object -First 1
                Write-Host "[Auto-Dev] Next: $($next.id) - $($next.title)"
            } else {
                Write-Host "[Auto-Dev] All tasks complete!"
            }
        }
    }
    catch {
        Write-Host "[Auto-Dev] prd.json exists but could not be parsed"
    }
} else {
    Write-Host "[Auto-Dev] No prd.json - say 'brainstorm' to create tasks"
}

# Git status (brief)
$gitStatus = git status --short 2>$null
if ($gitStatus) {
    $changedFiles = ($gitStatus | Measure-Object -Line).Lines
    Write-Host "[Git] $changedFiles changed files"
}

Write-Host ""
