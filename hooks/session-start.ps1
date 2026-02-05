$ErrorActionPreference = "SilentlyContinue"

# Auto-update claude-auto-dev (with timeout for offline)
$repoPathFile = "$env:USERPROFILE\.claude\repo-path.txt"
$claudeDir = "$env:USERPROFILE\.claude"

if (Test-Path $repoPathFile) {
    $repoPath = (Get-Content $repoPathFile -Raw).Trim()
    if (Test-Path "$repoPath\.git") {
        # Quick fetch with 5s timeout
        Push-Location $repoPath
        $job = Start-Job { git pull 2>&1 }
        $completed = Wait-Job $job -Timeout 5
        if ($completed) {
            $result = Receive-Job $job
        } else {
            Stop-Job $job
            $result = "timeout"
        }
        Remove-Job $job -Force
        Pop-Location

        $version = Get-Content "$repoPath\VERSION" -ErrorAction SilentlyContinue

        # Check if using copy mode (skills is a directory, not symlink)
        $skillsPath = "$claudeDir\skills"
        $isSymlink = (Get-Item $skillsPath -ErrorAction SilentlyContinue).Attributes -match "ReparsePoint"

        if ($result -notmatch "Already up to date" -and $result -ne "timeout") {
            Write-Host "[Auto-Dev] Updated to v$version"
            # If copy mode, re-copy skills and hooks
            if (-not $isSymlink) {
                Copy-Item -Path "$repoPath\skills\*" -Destination "$claudeDir\skills\" -Recurse -Force
                Copy-Item -Path "$repoPath\hooks\*" -Destination "$claudeDir\hooks\" -Force
                Write-Host "[Auto-Dev] Skills/hooks synced"
            }
        } else {
            Write-Host "[Auto-Dev v$version]"
        }
    }
} else {
    Write-Host "[Auto-Dev v5.0]"
}

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
