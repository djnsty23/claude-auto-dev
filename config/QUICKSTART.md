# Quick Start Guide

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
| "auto" / "brainstorm" | build.md (Auto-Dev) |

---

## Browser Testing

**agent-browser** - CLI for browser automation (5-6x more token-efficient than Playwright MCP)

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

Configured in `~/.claude/mcp.json`:
- **supabase** - Database operations via MCP
- **playwright** - Available but prefer agent-browser CLI

Usage:
```
"Test the OAuth flow" → agent-browser opens browser, clicks through, reports result
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
```
