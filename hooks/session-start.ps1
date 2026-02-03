$ErrorActionPreference = "SilentlyContinue"

# Sprint context from project-meta.json (~200 bytes)
if (Test-Path "project-meta.json") {
    try {
        $meta = Get-Content "project-meta.json" -Raw | ConvertFrom-Json
        $sprint = $meta.currentSprint
        $total = $meta.totalCompleted
        Write-Host "[Auto-Dev v4] Sprint: $sprint | Completed: $total total"
    } catch {
        Write-Host "[Auto-Dev v4] project-meta.json parse error"
    }
} else {
    Write-Host "[Auto-Dev v4] No project-meta.json - say 'audit' or run 'npx claude-auto-dev --init'"
}

# Git status (brief)
$gitStatus = git status --short 2>$null
if ($gitStatus) {
    $changedFiles = ($gitStatus | Measure-Object -Line).Lines
    Write-Host "[Git] $changedFiles changed files"
}
