<#
.SYNOPSIS
    PostToolUse hook - Run typecheck after TypeScript/JavaScript edits
.DESCRIPTION
    Only runs typecheck for TS/JS files, not for markdown/json/etc.
    More efficient than running on every file edit.
#>

param()

$ErrorActionPreference = "SilentlyContinue"

# Read JSON input from stdin
$inputJson = $input | Out-String

try {
    $data = $inputJson | ConvertFrom-Json
    $toolInput = $data.tool_input
    $filePath = $toolInput.file_path
}
catch {
    exit 0
}

# Only run typecheck for TypeScript/JavaScript files
if ($filePath -match '\.(ts|tsx|js|jsx)$') {
    if (Test-Path "package.json") {
        # Check if typecheck script exists
        $pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
        if ($pkg.scripts.typecheck) {
            $result = npm run typecheck 2>&1
            if ($LASTEXITCODE -ne 0) {
                # Output errors for Claude to see
                Write-Host "[Typecheck] Errors found:"
                Write-Host $result
            }
        }
    }
}

exit 0
