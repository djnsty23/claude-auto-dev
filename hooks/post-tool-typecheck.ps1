<#
.SYNOPSIS
    PostToolUse hook - Run typecheck after TypeScript/JavaScript edits
.DESCRIPTION
    Only runs typecheck for TS/JS files, not for markdown/json/etc.
    More efficient than running on every file edit.
#>

param()

$ErrorActionPreference = "SilentlyContinue"

# Read JSON input from stdin (use Console.In for reliable piped input)
$inputJson = [Console]::In.ReadToEnd()

try {
    $data = $inputJson | ConvertFrom-Json
    $toolInput = $data.tool_input
    $filePath = $toolInput.file_path
}
catch {
    [Console]::Error.WriteLine("PostToolUse: Failed to parse input")
    exit 0
}

# Only run typecheck for TypeScript/JavaScript files
if ($filePath -match '\.(ts|tsx|js|jsx)$') {
    if (Test-Path "package.json") {
        # Check if typecheck script exists
        $pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
        if ($pkg.scripts.typecheck) {
            $job = Start-Job {
                $output = npm run typecheck 2>&1
                @{ exitCode = $LASTEXITCODE; output = ($output -join "`n") }
            }
            $completed = Wait-Job $job -Timeout 30
            if (-not $completed) { Stop-Job $job; Remove-Job $job -Force; exit 0 }
            $result = Receive-Job $job
            Remove-Job $job -Force
            if ($result.exitCode -ne 0) {
                [Console]::Error.WriteLine("[Typecheck] Errors found:")
                [Console]::Error.WriteLine($result.output)
            }
        }
    }
}

exit 0
