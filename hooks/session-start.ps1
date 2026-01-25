<#
.SYNOPSIS
    SessionStart hook - Inject project context and skill index
.DESCRIPTION
    Outputs project status and skill mapping for efficient skill loading.
#>

$ErrorActionPreference = "SilentlyContinue"
$skillsDir = "$env:USERPROFILE\.claude\skills"

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

# Status line reminder
$settingsPath = "$env:USERPROFILE\.claude\settings.local.json"
$hasStatusLine = $false
if (Test-Path $settingsPath) {
    try {
        $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
        if ($settings.statusLine) {
            $hasStatusLine = $true
        }
    } catch {}
}

if (-not $hasStatusLine) {
    Write-Host ""
    Write-Host "[Status] Run '/status line' to enable context monitoring (model, %, tokens)"
}

# Skill index from manifest.json (for efficient skill loading)
$manifestPath = "$skillsDir\manifest.json"
if (Test-Path $manifestPath) {
    try {
        $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
        Write-Host ""
        Write-Host "[Skills] Command -> File mapping:"
        foreach ($skill in $manifest.skills.PSObject.Properties) {
            $triggers = $skill.Value.triggers -join ", "
            $file = $skill.Value.file
            Write-Host "  $triggers -> $file"
        }
    }
    catch {
        # Manifest parse error - skip
    }
}

Write-Host ""
