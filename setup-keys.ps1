<#
.SYNOPSIS
    API Key Setup Wizard for Claude Code
.DESCRIPTION
    Prompts for API keys and stores them securely in Windows environment variables.
    Also generates mcp.json from template.
.EXAMPLE
    .\setup-keys.ps1
#>

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "`n=== Claude Code API Key Setup ===" -ForegroundColor Magenta
Write-Host "Keys are stored in Windows system environment variables."
Write-Host "Press Enter to skip any key you don't have.`n"

# Define all keys
$keys = @(
    @{ Name = "SUPABASE_ACCESS_TOKEN"; Desc = "Supabase Access Token (sbp_...)"; Required = $true },
    @{ Name = "GITHUB_PAT"; Desc = "GitHub Personal Access Token (ghp_...)"; Required = $true },
    @{ Name = "BRAVE_API_KEY"; Desc = "Brave Search API Key"; Required = $false },
    @{ Name = "GOOGLE_CLIENT_ID"; Desc = "Google OAuth Client ID"; Required = $false },
    @{ Name = "GOOGLE_CLIENT_SECRET"; Desc = "Google OAuth Client Secret"; Required = $false },
    @{ Name = "ELEVENLABS_API_KEY"; Desc = "ElevenLabs API Key"; Required = $false },
    @{ Name = "OPENROUTER_API_KEY"; Desc = "OpenRouter API Key"; Required = $false },
    @{ Name = "DEEPSEEK_API_KEY"; Desc = "DeepSeek API Key"; Required = $false },
    @{ Name = "GEMINI_API_KEY"; Desc = "Google Gemini API Key"; Required = $false },
    @{ Name = "RESEND_API_KEY"; Desc = "Resend Email API Key"; Required = $false },
    @{ Name = "TEST_USER_PASSWORD"; Desc = "Test account password"; Required = $false }
)

$values = @{}

foreach ($key in $keys) {
    $existing = [Environment]::GetEnvironmentVariable($key.Name, "User")
    $prompt = "$($key.Desc)"

    if ($existing) {
        $masked = $existing.Substring(0, [Math]::Min(8, $existing.Length)) + "..."
        $prompt += " [current: $masked]"
    }

    if ($key.Required) {
        $prompt += " (required)"
    }

    Write-Host $prompt -ForegroundColor Cyan
    $value = Read-Host "  $($key.Name)"

    if ($value) {
        $values[$key.Name] = $value
        [Environment]::SetEnvironmentVariable($key.Name, $value, "User")
        Write-Host "  ✓ Saved" -ForegroundColor Green
    } elseif ($existing) {
        $values[$key.Name] = $existing
        Write-Host "  ○ Keeping existing" -ForegroundColor Yellow
    } else {
        Write-Host "  - Skipped" -ForegroundColor Gray
    }
}

# Generate mcp.json from template
Write-Host "`n=== Generating mcp.json ===" -ForegroundColor Magenta

$mcpTemplate = Get-Content "$ScriptDir\config\mcp.template.json" -Raw
$mcpPath = "$env:USERPROFILE\.claude\mcp.json"

# Replace placeholders with actual values
foreach ($key in $values.Keys) {
    $mcpTemplate = $mcpTemplate -replace "\{\{$key\}\}", $values[$key]
}

# Create .claude directory if needed
if (-not (Test-Path "$env:USERPROFILE\.claude")) {
    New-Item -ItemType Directory -Path "$env:USERPROFILE\.claude" -Force | Out-Null
}

$mcpTemplate | Out-File -FilePath $mcpPath -Encoding UTF8 -NoNewline
Write-Host "✓ Generated $mcpPath" -ForegroundColor Green

Write-Host "`n=== Done ===" -ForegroundColor Green
Write-Host @"

Keys stored in Windows environment variables.
MCP config generated at ~/.claude/mcp.json

Next: Run the full installer:
  .\install.ps1 -Full

Note: Restart your terminal for env vars to take effect.
"@
