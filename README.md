# Claude Auto-Dev

> **Version 1.0.0** | Autonomous task management for Claude Code.

## Full Restore (New Machine)

After Windows reinstall or on a new machine, run this to restore everything:

**Windows:**
```powershell
git clone https://github.com/djnsty23/claude-auto-dev $env:USERPROFILE\claude-auto-dev
& $env:USERPROFILE\claude-auto-dev\install.ps1 -Full
```

**Mac/Linux:**
```bash
git clone https://github.com/djnsty23/claude-auto-dev ~/claude-auto-dev
~/claude-auto-dev/install.sh --full
```

This installs:
- `~/.claude/CLAUDE.md` - Global config
- `~/.claude/QUICKSTART.md` - Quick reference
- `~/.claude/rules/*.md` - Coding rules (security, design-system, windows)
- `~/.claude/skills/*.md` - All 7 skill files
- `~/.claude/scripts/*` - Helper scripts (start-server)
- `~/.claude/mcp.json` - MCP config (uses `${ENV_VAR}` references)

## Quick Install (Skills Only)

**Windows:**
```powershell
git clone https://github.com/djnsty23/claude-auto-dev $env:USERPROFILE\claude-auto-dev
& $env:USERPROFILE\claude-auto-dev\install.ps1 -Global -Init
```

**Mac/Linux:**
```bash
git clone https://github.com/djnsty23/claude-auto-dev ~/claude-auto-dev
~/claude-auto-dev/install.sh --global --init
```

## Commands

### Task Management (build.md)

| Say | What Happens |
|-----|--------------|
| `auto` | Work through all tasks autonomously |
| `continue` | One task, then ask |
| `work on S42` | Do specific task |
| `status` | Show progress summary |
| `brainstorm` | Generate new stories from requirements |
| `adjust` | Reprioritize remaining tasks |
| `stop` | Clear claims before closing session |
| `reset` | Clear all claims after crash |

### Additional Skills

| Say | Skill | What Happens |
|-----|-------|--------------|
| `ship` / `deploy` | ship.md | Build → deploy to Vercel → verify |
| `test` | test.md | Full E2E with network/console monitoring |
| `test auth` | test.md | Test authentication flow only |
| `test api` | test.md | Check API integrations |
| `test network` | test.md | Monitor all network requests |
| `fix` / `debug` | fix.md | Systematic debugging workflow |
| `set up` / `init` | setup-project.md | Initialize new project with stack |
| `env` / `credentials` | env-vars.md | Manage environment variables |
| `schema` / `database` | supabase-schema.md | Create tables, migrations via MCP |

## Skills Reference

| Skill | Triggers | Purpose |
|-------|----------|---------|
| **build.md** | auto, continue, status, brainstorm, adjust, stop, reset | Autonomous task loop |
| **ship.md** | ship, deploy | Build and deploy to production |
| **test.md** | test, verify, e2e, playwright | Full E2E testing with network/console monitoring |
| **fix.md** | fix, debug | Reproduce → isolate → fix → verify |
| **setup-project.md** | set up, init, new project | Scaffold new projects |
| **env-vars.md** | env, credentials, api key | Environment variable management |
| **supabase-schema.md** | schema, database, table, migration | Database operations via Supabase MCP |

## Workflow

```bash
claude "brainstorm"    # Generate tasks from requirements
claude "auto"          # Build everything autonomously
claude "stop"          # Before closing session
```

**Deployment:**
```bash
claude "ship"          # Build → deploy → verify
```

**Testing:**
```bash
claude "test"          # Run Playwright tests
```

## Multi-Agent

Run `claude "auto"` in multiple terminals. Each picks unclaimed tasks. 30-minute claim expiry handles abandoned work.

**Best practice:**
```bash
# Terminal 1
claude "auto"

# Wait 10-30 seconds, then Terminal 2
claude "auto"

# Wait 10-30 seconds, then Terminal 3
claude "auto"
```

Stagger starts slightly to avoid collisions. Each agent will:
1. Read prd.json, find first unclaimed task
2. Set `claimedAt` timestamp immediately
3. Work on task
4. Mark `passes: true` when done

**Before closing any terminal:**
```bash
claude "stop"
```

## Files

| File | Purpose |
|------|---------|
| `prd.json` | Tasks with `passes: true/false` status |
| `progress.txt` | Append-only learnings log |
| `.claude/briefs/` | Optional detailed specs |

## Task Schema

```json
{
  "id": "S1",
  "title": "Short title",
  "description": "What to build",
  "priority": 1,
  "passes": false,
  "claimedAt": null,
  "completedAt": null,
  "testedAt": null,
  "files": ["path/to/file.ts"],
  "acceptanceCriteria": ["Requirement"],
  "testSpec": { "happyPath": [], "errorCases": [], "edgeCases": [] },
  "testResults": null
}
```

## Test Suites (prd.json)

```json
{
  "testSuites": [
    {
      "id": "TS1",
      "name": "Full User Journey",
      "stories": ["S1", "S2", "S5"],
      "testedAt": null
    }
  ]
}
```

## Testing System

### 3-Pass Test Generation

Tests are auto-generated from three sources:

| Pass | Source | Tests Generated |
|------|--------|-----------------|
| **1. Story** | acceptanceCriteria | Happy path, basic errors |
| **2. Code** | Implementation files | Validation, auth, null checks |
| **3. Integration** | Cross-story deps | User journeys, data flows |

### Test Workflow

```
Story Completion → testSpec Generated → testedAt: null
      ↓
"test" Command → Execute testSpec → Update testedAt + testResults
      ↓
Failures → Auto-fix or Create Bug Story
```

### Test Commands

| Say | Action |
|-----|--------|
| `test` | Test untested stories |
| `test all` | Re-test everything |
| `test S1` | Test specific story |
| `test generate` | Generate testSpec without running |
| `test report` | Show last results |

---

## API Key Setup

Run the API key wizard:

**Windows:**
```powershell
& $env:USERPROFILE\claude-auto-dev\setup-keys.ps1
```

**Mac/Linux:**
```bash
~/claude-auto-dev/setup-keys.sh
```

**Keys prompted (grouped by category):**

| Category | Keys |
|----------|------|
| **Required** | `SUPABASE_ACCESS_TOKEN`, `GITHUB_PAT` |
| **Google OAuth** | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| **AI/LLM** | `ELEVENLABS_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `ZAI_API_KEY` |
| **Search/Scrape** | `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`, `LINKUP_API_KEY`, `CAPSOLVER_API_KEY` |
| **Email** | `RESEND_API_KEY` |
| **Testing** | `TEST_USER_PASSWORD` |

Keys are stored in:
- **Windows:** System environment variables (persists across reboots)
- **Mac/Linux:** `~/.zshrc` or `~/.bashrc`

The `mcp.json` config uses `${ENV_VAR}` syntax - MCP reads from your system env vars at runtime. **No secrets are hardcoded in the config file.**

## Environment Variables

**Never hardcode API keys.** Use system environment variables.

**Manual setup (Windows):**
```powershell
setx SUPABASE_ACCESS_TOKEN "sbp_..."
setx GITHUB_PAT "ghp_..."
```

**Project .env.local (project-specific only):**
```env
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
```

**Rules:**
- API keys in system env vars (not .env files)
- .env.local for project-specific URLs only
- Never commit secrets to git
- Use `.env.example` to document required vars (no values)

## Troubleshooting

**Tasks stuck as claimed?**
- Wait 30 min for auto-expiry, or run `reset` to clear all claims

**Agents grabbing same task?**
- Stagger starts by 10-30 seconds
- Or run `reset` then restart agents

**Build keeps failing?**
- Agent stops after 3 consecutive failures
- Fix the issue manually, then `auto` again

**Dev server issues?**
- Check if port is already in use: `netstat -ano | findstr :3000`
- Use `~/.claude/scripts/start-server.ps1` to launch in external terminal

## Update

```powershell
cd $env:USERPROFILE\claude-auto-dev && git pull && .\install.ps1 -Update
```

## License

MIT
