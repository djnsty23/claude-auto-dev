# Claude Code User Configuration

## Identity
GitHub: YOUR_GITHUB_USERNAME
Email: YOUR_EMAIL

## Behavior
- **BE CONCISE** - <2 lines unless asked for detail
- **DISCUSS FIRST** - Clarify before coding
- **PARALLEL OPS** - Batch independent operations
- **DESIGN SYSTEM** - Styles in config, not inline

## Stack
React + TypeScript + Tailwind + shadcn/ui + Supabase + Vercel

## Plain English → Action
| Say | Get |
|-----|-----|
| fix | Debug → fix → test |
| auto | Work through all tasks without stopping |
| continue | One task, then ask |
| status | Show prd.json progress |
| brainstorm | Generate tasks from your description |
| stop | Save progress, safe to close |
| reset | Clear stuck state after crash |
| ship | Build → deploy → verify |
| test | Build check → agent-browser tests |

## Autonomous Development (claude-auto-dev)

**How to start in ANY project:**
```
"brainstorm"  → Creates prd.json + generates tasks from your description
"auto"        → Works through existing tasks in prd.json
"status"      → Shows progress
```

**That's it.** No scripts to run. Just say what you want.

**Files created automatically:**
- `prd.json` - Task list with `passes: true/false` status
- `progress.txt` - Append-only learnings log

## Rules
- TypeScript strict, no `any`
- All UI states handled
- Never commit secrets

## User Accounts

| Account | Role | Usage |
|---------|------|-------|
| YOUR_ADMIN_EMAIL | **Admin** | App management, admin UI |
| YOUR_TEST_EMAIL | **Tester** | Automated browser tests only |

### Test Account
- **Email**: YOUR_TEST_EMAIL
- **Password**: Stored in `TEST_USER_PASSWORD` env var
- **ONLY use this for automated testing**

## Browser Testing
- **agent-browser** - CLI for browser automation (5-6x more token-efficient than Playwright MCP)
- Install: `npm install -g agent-browser && agent-browser install`
- See `~/.claude/skills/agent-browser.md` for full command reference

## MCP Servers (Global)
- **supabase** - Database operations via MCP
- **playwright** - Available but prefer agent-browser CLI for token efficiency

## GitHub Access
- **PAT**: `GITHUB_PAT` env var (full repo access)
- Use `gh` CLI for GitHub operations

## Auto-Testing Flow
Say "test" → agent-browser CLI → categorize issues → auto-fix code → report unfixable

## Skills
Located in `~/.claude/skills/`:
- **build.md** - Autonomous task loop (prd.json + progress.txt)
- **agent-browser.md** - Browser automation CLI
- ship.md, fix.md, test.md, setup-project.md, env-vars.md, supabase-schema.md

## Included Rules
@rules/security.md
@rules/design-system.md
@rules/windows.md
