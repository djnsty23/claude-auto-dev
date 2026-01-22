# Quick Start Guide

## One-Time Setup

### Run This Once (Admin PowerShell):
```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\scripts\set-global-keys.ps1"
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

**No installation needed.** Just say what you want:

### New Project
```
"brainstorm"  → I'll ask what you want to build, then create prd.json with tasks
```

### Existing Project
```
"auto"        → Work through all tasks in prd.json
"status"      → Show progress (X/Y complete)
"continue"    → One task, then stop
```

### Common Commands
| Say | Action |
|-----|--------|
| `brainstorm` | Generate tasks from your description |
| `auto` | Work through all tasks automatically |
| `status` | Show progress |
| `continue` | One task, then ask |
| `stop` | Save progress, safe to close |
| `reset` | Clear stuck state after crash |
| `archive` | Compact prd.json when too large (>2000 lines) |
| `clean` | Remove screenshots, old backups, temp files |

---

## Skills (Auto-Triggered)

| Say | Skill Activated |
|-----|-----------------|
| "set up" | setup-project.md |
| "ship" / "deploy" | ship.md |
| "create table" / "schema" | supabase-schema.md |
| "fix" / "debug" | fix.md |
| "test" / "verify" | test.md (agent-browser auto-testing) |
| "browser" / "agent-browser" | agent-browser.md (Browser automation CLI) |
| "env" / "credentials" | env-vars.md |
| "auto" / "build" / "brainstorm" | build.md (Auto-Dev with doom loop detection) |
| "context" / "load context" | context.md (Quick session startup) |
| "help" / "commands" | help.md (List all available commands) |

---

## Browser Testing

**agent-browser** - CLI for browser automation (5-6x more token-efficient than Playwright MCP)

**Screenshot Convention:** Save to `.claude/screenshots/` (auto-gitignored)
```bash
agent-browser screenshot .claude/screenshots/test-1.png
```

Install:
```bash
npm install -g agent-browser
agent-browser install
```

Usage:
```bash
agent-browser open http://localhost:3000
agent-browser snapshot -i              # Get interactive elements
agent-browser click @e1                # Click by ref
agent-browser fill @e2 "test@test.com" # Fill input
```

---

## MCP Servers (Global)

Configured in `~/.mcp.json`:
- **supabase** - Database operations via MCP
- **playwright** - Available but prefer agent-browser CLI

Usage:
```
"Test the OAuth flow" → agent-browser opens browser, clicks through, reports result
"Run the schema" → Supabase MCP executes SQL directly
```

---

## Supabase Projects

| Project | Ref | Region | Status |
|---------|-----|--------|--------|
| Reelr | wlafounbfsvumwzxstom | eu-north-1 | Active |
| spotivibly | vsrinmyovugtabghgxoz | - | Active |
| cozy-code-studio | ugplgjocwlvjldbyonhw | - | Active |

**New project:** "Create a new Supabase project called [name]"
**Archive:** "Archive [name] and create new project [name]"

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
