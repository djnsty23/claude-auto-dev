<#
.SYNOPSIS
    Stop hook for claude-auto-dev - Auto-continue if tasks remain
.DESCRIPTION
    Checks prd.json for incomplete tasks. If any remain, blocks stopping
    and instructs Claude to continue with the next task.
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

                # Block stopping, tell Claude to continue
                $output = @{
                    decision = "block"
                    reason = "Auto-dev: $remainingCount tasks remain. Continue with: $($next.id) - $($next.title)"
                }
                $output | ConvertTo-Json -Compress
                exit 0
            }
        }
    }
    catch {
        # JSON parse error - allow stopping
    }
}

# Allow stopping if no prd.json or all tasks complete
@{ ok = $true } | ConvertTo-Json -Compress
