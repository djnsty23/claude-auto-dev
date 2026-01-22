<#
.SYNOPSIS
    Stop hook for claude-auto-dev - Inform about remaining tasks
.DESCRIPTION
    Checks prd.json for incomplete tasks. If any remain, outputs a reminder
    but ALLOWS stopping (doesn't block). User intent takes priority.
#>

$ErrorActionPreference = "SilentlyContinue"

# Check if prd.json exists in current directory
if (Test-Path "prd.json") {
    try {
        $prd = Get-Content "prd.json" -Raw | ConvertFrom-Json

        if ($prd.stories) {
            $remaining = @($prd.stories | Where-Object { $_.passes -ne $true })
            $remainingCount = $remaining.Count

            if ($remainingCount -gt 0) {
                $next = $remaining | Select-Object -First 1

                # INFORM but don't block - user intent takes priority
                Write-Host "[Auto-Dev] $remainingCount tasks remain. Next: $($next.id) - $($next.title)"
                Write-Host "[Auto-Dev] Say 'auto' to continue, or close session to stop."
            }
        }
    }
    catch {
        # JSON parse error - allow stopping
    }
}

# Always allow stopping - user intent takes priority
@{ ok = $true } | ConvertTo-Json -Compress
