$ErrorActionPreference = "SilentlyContinue"

Write-Host "[Auto-Dev v4.8]"

# Auto-source .env.local (project-isolated credentials)
if (Test-Path ".env.local") {
    Get-Content ".env.local" | ForEach-Object {
        if ($_ -match "^([^#=]+)=(.*)$") {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim()
            if ($name -and $value) {
                [Environment]::SetEnvironmentVariable($name, $value, "Process")
            }
        }
    }
    Write-Host "[Env] .env.local loaded"
}

# Check for checkpoint (context restore after /compact)
if (Test-Path ".claude/checkpoint.md") {
    Write-Host ""
    Write-Host "[Checkpoint Found] Restoring context..."
    Get-Content ".claude/checkpoint.md" | Select-Object -First 30
    Write-Host ""
    Write-Host "---"
}

# Sprint context from prd.json
if (Test-Path "prd.json") {
    try {
        $prd = Get-Content "prd.json" -Raw | ConvertFrom-Json
        $sprint = $prd.sprint
        $total = $prd.completedStories
        $pending = $prd.totalStories - $prd.completedStories
        Write-Host "[Sprint] $sprint | $total done, $pending pending"
    } catch {
        # Silent fail
    }
}

# Git status (brief)
$gitStatus = git status --short 2>$null
if ($gitStatus) {
    $changedFiles = ($gitStatus | Measure-Object -Line).Lines
    Write-Host "[Git] $changedFiles uncommitted changes"
}
