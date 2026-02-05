<#
.SYNOPSIS
    Stop hook - Blocks stopping when auto mode is active.
    Checks for .claude/auto-active flag file.
#>

$ErrorActionPreference = "SilentlyContinue"
$autoFlag = ".claude/auto-active"

# Stale flag cleanup (>2 hours old = crashed session)
if (Test-Path $autoFlag) {
    $flagAge = (Get-Date) - (Get-Item $autoFlag).LastWriteTime
    if ($flagAge.TotalHours -gt 2) {
        Remove-Item $autoFlag -Force
        [Console]::Error.WriteLine("[Auto-Dev] Removed stale auto-active flag (>2h old)")
    }
}

if (Test-Path $autoFlag) {
    # Auto mode is active - count remaining tasks
    $remaining = 0
    if (Test-Path "prd.json") {
        try {
            $prd = Get-Content "prd.json" -Raw | ConvertFrom-Json
            if ($prd.stories) {
                $stories = $prd.stories.PSObject.Properties
                $remaining = @($stories | Where-Object { $_.Value.passes -ne $true }).Count
            }
        } catch {}
    }

    if ($remaining -gt 0) {
        # Tasks remain - block stop
        [Console]::Error.WriteLine("[Auto-Dev] Auto mode active. $remaining tasks remaining. Continuing...")
        @{ ok = $false; reason = "[Auto-Dev] $remaining tasks remaining in auto mode" } | ConvertTo-Json -Compress
    } else {
        # No tasks but flag still active = IDLE detection phase (brainstorm/ask user)
        [Console]::Error.WriteLine("[Auto-Dev] Sprint complete. Running IDLE detection...")
        @{ ok = $false; reason = "[Auto-Dev] Sprint complete - running smart next action" } | ConvertTo-Json -Compress
    }
} else {
    # Not in auto mode - allow normal stop evaluation
    @{ ok = $true } | ConvertTo-Json -Compress
}
