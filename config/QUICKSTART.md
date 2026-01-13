# Quick Start Guide

## One-Time Setup

### Run This Once (Admin PowerShell):
```powershell
& "$env:USERPROFILE\claude-auto-dev\setup-keys.ps1"
```

### Global Keys Available:

| Category | Keys |
|----------|------|
| **Google OAuth** | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| **AI/LLM** | `ELEVENLABS_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `ZAI_API_KEY` |
| **Search/Scrape** | `FIRECRAWL_API_KEY`, `BRAVE_API_KEY`, `LINKUP_API_KEY`, `CAPSOLVER_API_KEY` |
| **Email** | `RESEND_API_KEY` |
| **Dev** | `GITHUB_PAT`, `SUPABASE_ACCESS_TOKEN` |

### Google OAuth Redirect URIs (pre-configured):
`http://localhost:3000/api/auth/youtube/callback` (add more in Google Console if needed)

---

## Starting a New Project

```bash
cd ~/Downloads/code
npx create-next-app@latest my-project
cd my-project
```

Then say: **"Set up this project - I want to build [description]"**

I'll create CLAUDE.md, wire up Supabase, configure auth, add OAuth.

---

## Existing Project

Just say what you want:
- "Add user authentication"
- "Create a dashboard"
- "Fix the build errors"
- "Ship it"

---

## Auto-Dev System

Install once per project:
```powershell
git clone https://github.com/YOUR_GITHUB_USERNAME/claude-auto-dev "$env:USERPROFILE\claude-auto-dev"
& "$env:USERPROFILE\claude-auto-dev\install.ps1" -Global -Init
```

| Say | Action |
|-----|--------|
| `auto` | Work through all tasks |
| `brainstorm` | Discovery questionnaire → new stories |
| `adjust` | Pick features to prioritize |
| `stop` | Clear claims before closing |

---

## Skills (Auto-Triggered)

| Say | Skill Activated |
|-----|-----------------|
| "set up" | setup-project.md |
| "ship" / "deploy" | ship.md |
| "create table" / "schema" | supabase-schema.md |
| "fix" / "debug" | fix.md |
| "test" / "verify" | test.md (Playwright auto-testing) |
| "env" / "credentials" | env-vars.md |
| "auto" / "build" / "brainstorm" | build.md (Auto-Dev) |

---

## MCP Servers (Global)

Configured in `~/.claude/mcp.json`:
- **playwright** - Browser automation for testing
- **supabase** - Database operations via MCP

Usage:
```
"Test the OAuth flow" → Playwright opens browser, clicks through, reports result
"Run the schema" → Supabase MCP executes SQL directly
```

---

## Project .env.local Template

```env
# Supabase (project-specific)
NEXT_PUBLIC_SUPABASE_URL=https://[ref].supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...

# OAuth (uses global env vars - already set)
# Next.js picks up system env vars automatically
# Or explicitly reference if needed:
# GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
# GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}

# Redirect URI (project-specific port)
YOUTUBE_REDIRECT_URI=http://localhost:3000/api/auth/youtube/callback
```
