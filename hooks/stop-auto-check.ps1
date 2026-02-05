<#
.SYNOPSIS
    Stop hook - Blocks stopping when auto mode is active.
    Checks for .claude/auto-active flag file.
#>

$ErrorActionPreference = "SilentlyContinue"
$autoFlag = ".claude/auto-active"

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
        Write-Host "[Auto-Dev] Auto mode active. $remaining tasks remaining. Continuing..."
        @{ ok = $false; reason = "[Auto-Dev] $remaining tasks remaining in auto mode" } | ConvertTo-Json -Compress
    } else {
        # No tasks but flag still active = IDLE detection phase (brainstorm/ask user)
        Write-Host "[Auto-Dev] Sprint complete. Running IDLE detection..."
        @{ ok = $false; reason = "[Auto-Dev] Sprint complete - running smart next action" } | ConvertTo-Json -Compress
    }
} else {
    # Not in auto mode - allow normal stop evaluation
    @{ ok = $true } | ConvertTo-Json -Compress
}
