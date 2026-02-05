<#
.SYNOPSIS
    PreToolUse hook - Security filtering and token optimization
.DESCRIPTION
    Blocks dangerous Bash commands and unnecessary file reads.
    Saves tokens by preventing wasteful operations.
#>

param()

$ErrorActionPreference = "SilentlyContinue"

# Read JSON input from stdin (use Console.In for reliable piped input)
$inputJson = [Console]::In.ReadToEnd()

try {
    $data = $inputJson | ConvertFrom-Json
    $toolName = $data.tool_name
    $toolInput = $data.tool_input
}
catch {
    # Can't parse input, allow operation
    exit 0
}

# Bash command filtering
if ($toolName -eq "Bash") {
    $command = $toolInput.command

    # Dangerous patterns to block
    $dangerousPatterns = @(
        'rm\s+(-[a-z]*r[a-z]*\s+-[a-z]*f|--recursive)', # rm -rf, rm -r -f, rm --recursive
        'find\s+/\s+-delete',     # find / -delete
        'dd\s+if=.*/dev/',        # dd if=/dev/zero
        'mkfs\.',                 # mkfs.ext4
        'chmod\s+-R\s+000\s+/',   # chmod -R 000 /
        'git\s+reset\s+--hard',   # git reset --hard
        'git\s+push\s+(--force|.*--force)', # git push --force (any flag order)
        'git\s+clean\s+-fd',      # git clean -fd
        'format\s+c:',            # format c:
        'del\s+/s\s+/q\s+c:',    # del /s /q c:
        'DROP\s+(TABLE|DATABASE)', # SQL injection
        'curl.*\|\s*(ba)?sh',     # curl | bash (remote code exec)
        'wget.*\|\s*(ba)?sh'      # wget | bash
    )

    foreach ($pattern in $dangerousPatterns) {
        if ($command -match $pattern) {
            Write-Error "Blocked potentially dangerous command: $command"
            exit 2
        }
    }
}

# Read file filtering - skip large/generated files
if ($toolName -eq "Read") {
    $filePath = $toolInput.file_path

    # Patterns to skip (saves tokens)
    $skipPatterns = @(
        'node_modules',
        'dist[\\/]',
        'build[\\/]',
        '\.git[\\/]',
        'package-lock\.json',
        'yarn\.lock',
        'pnpm-lock\.yaml',
        '\.next[\\/]',
        'coverage[\\/]',
        '\.turbo[\\/]'
    )

    foreach ($pattern in $skipPatterns) {
        if ($filePath -match $pattern) {
            Write-Error "Skipping generated/large file: $filePath (use targeted search instead)"
            exit 2
        }
    }
}

# Allow operation
exit 0
