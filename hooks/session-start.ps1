$ErrorActionPreference = "SilentlyContinue"

Write-Host "[Auto-Dev v4.1] Quality-First Mode"
Write-Host "  - Read before write | Match existing patterns | Verify all states"

# Sprint context from project-meta.json (~200 bytes)
if (Test-Path "project-meta.json") {
    try {
        $meta = Get-Content "project-meta.json" -Raw | ConvertFrom-Json
        $sprint = $meta.currentSprint
        $total = $meta.totalCompleted
        Write-Host "[Sprint] $sprint | $total completed"
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

# Check for existing UI components (helps preserve-ui skill)
if (Test-Path "src/components/ui") {
    $uiComponents = (Get-ChildItem "src/components/ui" -Filter "*.tsx" | Measure-Object).Count
    Write-Host "[UI] $uiComponents components in ui/ - use existing before creating new"
}
