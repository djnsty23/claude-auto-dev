<#
.SYNOPSIS
    Stop hook - Inform about remaining tasks (doesn't block)
#>

$ErrorActionPreference = "SilentlyContinue"

if (Test-Path "prd.json") {
    try {
        $prd = Get-Content "prd.json" -Raw | ConvertFrom-Json

        if ($prd.stories) {
            # stories is an object (hashtable), not array
            $stories = $prd.stories.PSObject.Properties
            $remaining = @($stories | Where-Object { $_.Value.passes -ne $true })
            $remainingCount = $remaining.Count

            if ($remainingCount -gt 0) {
                $next = $remaining | Select-Object -First 1
                $nextId = $next.Name
                $nextTitle = $next.Value.title

                # INFORM but don't block - user intent takes priority
                Write-Host "[Auto-Dev] $remainingCount tasks remain. Next: $nextId - $nextTitle"
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
