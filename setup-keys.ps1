<#
.SYNOPSIS
    API Key Setup Wizard for Claude Code
.DESCRIPTION
    Prompts for API keys and stores them in Windows system environment variables.
    MCP config uses ${ENV_VAR} syntax - no hardcoding needed.
.EXAMPLE
    .\setup-keys.ps1
#>

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "`n=== Claude Code API Key Setup ===" -ForegroundColor Magenta
Write-Host "Keys are stored in Windows system environment variables."
Write-Host "MCP config references them via `${ENV_VAR}` syntax."
Write-Host "Press Enter to skip any key you don't have.`n"

# Define all keys (grouped by category)
$keys = @(
    # Required
    @{ Name = "SUPABASE_ACCESS_TOKEN"; Desc = "Supabase Access Token (sbp_...)"; Required = $true },
    @{ Name = "GITHUB_PAT"; Desc = "GitHub Personal Access Token (ghp_...)"; Required = $true },
    # Google OAuth
    @{ Name = "GOOGLE_CLIENT_ID"; Desc = "Google OAuth Client ID"; Required = $false },
    @{ Name = "GOOGLE_CLIENT_SECRET"; Desc = "Google OAuth Client Secret"; Required = $false },
    # AI/LLM
    @{ Name = "ELEVENLABS_API_KEY"; Desc = "ElevenLabs API Key (voice)"; Required = $false },
    @{ Name = "OPENROUTER_API_KEY"; Desc = "OpenRouter API Key"; Required = $false },
    @{ Name = "DEEPSEEK_API_KEY"; Desc = "DeepSeek API Key"; Required = $false },
    @{ Name = "GEMINI_API_KEY"; Desc = "Google Gemini API Key"; Required = $false },
    @{ Name = "ZAI_API_KEY"; Desc = "ZAI API Key"; Required = $false },
    # Search/Scrape
    @{ Name = "BRAVE_API_KEY"; Desc = "Brave Search API Key"; Required = $false },
    @{ Name = "FIRECRAWL_API_KEY"; Desc = "Firecrawl API Key (web scraping)"; Required = $false },
    @{ Name = "LINKUP_API_KEY"; Desc = "Linkup API Key"; Required = $false },
    @{ Name = "CAPSOLVER_API_KEY"; Desc = "Capsolver API Key (captcha)"; Required = $false },
    # Email
    @{ Name = "RESEND_API_KEY"; Desc = "Resend Email API Key"; Required = $false },
    # Testing
    @{ Name = "TEST_USER_PASSWORD"; Desc = "Test account password"; Required = $false }
)

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
        [Environment]::SetEnvironmentVariable($key.Name, $value, "User")
        Write-Host "  ✓ Saved to system env vars" -ForegroundColor Green
    } elseif ($existing) {
        Write-Host "  ○ Keeping existing" -ForegroundColor Yellow
    } else {
        Write-Host "  - Skipped" -ForegroundColor Gray
    }
}

# Copy MCP config (uses ${ENV_VAR} references, no substitution needed)
Write-Host "`n=== Installing mcp.json ===" -ForegroundColor Magenta

$mcpSource = "$ScriptDir\config\mcp.template.json"
$mcpPath = "$env:USERPROFILE\.claude\mcp.json"

# Create .claude directory if needed
if (-not (Test-Path "$env:USERPROFILE\.claude")) {
    New-Item -ItemType Directory -Path "$env:USERPROFILE\.claude" -Force | Out-Null
}

Copy-Item $mcpSource $mcpPath -Force
Write-Host "✓ Installed $mcpPath" -ForegroundColor Green
Write-Host "  (Uses `${ENV_VAR}` references - no secrets in file)" -ForegroundColor Gray

Write-Host "`n=== Done ===" -ForegroundColor Green
Write-Host @"

Keys stored in Windows environment variables.
MCP config installed at ~/.claude/mcp.json

The config uses `${ENV_VAR}` syntax - MCP reads from your system env vars at runtime.
No secrets are hardcoded in the config file.

Note: Restart your terminal for env vars to take effect.
"@
