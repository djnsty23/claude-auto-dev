$ErrorActionPreference = "SilentlyContinue"

Write-Host "[Auto-Dev v4.3] Quality-First Mode"

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
    Write-Host "[UI] $uiComponents components in ui/"
}
