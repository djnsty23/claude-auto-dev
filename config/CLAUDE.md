# Claude Code User Configuration

## Identity
GitHub: YOUR_GITHUB_USERNAME
Email: YOUR_EMAIL
Google Workspace: YOUR_ADMIN_EMAIL (for OAuth testing)

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
| build X | Auto-generate tasks → implement loop |
| auto | Work through all tasks without stopping |
| continue | One task, then ask |
| status | Show prd.json progress |
| brainstorm | Discovery questionnaire → new stories |
| generate | Same as brainstorm - create new stories |
| adjust | Pick which features to prioritize |
| stop | Clear claims before closing |
| reset | Clear all claims after crash |
| ship | Build → deploy → verify |
| set up | CLAUDE.md + stack + Supabase |
| test | Build check → Playwright tests |

## Autonomous Development
Full system: https://github.com/YOUR_GITHUB_USERNAME/claude-auto-dev
- **prd.json**: Task list with `passes: true/false` status
- **progress.txt**: Append-only learnings log
- **learnings.json**: Structured error→solution pairs
- **adjust**: Say "adjust" to reprioritize remaining tasks
- See `~/.claude/skills/build.md` for full workflow

## Rules
- TypeScript strict, no `any`
- All UI states handled
- Never commit secrets
- **BEFORE starting dev server**: Check if port is already in use

## Global OAuth (for test projects)
Set in Windows env vars, reference in project .env.local:
```powershell
setx GOOGLE_CLIENT_ID "your-id"
setx GOOGLE_CLIENT_SECRET "your-secret"
```

## User Accounts

| Account | Role | Usage |
|---------|------|-------|
| YOUR_ADMIN_EMAIL | **Admin** | App management, admin UI |
| YOUR_TEST_EMAIL | **Tester** | Automated Playwright tests only |

### Test Account
- **Email**: YOUR_TEST_EMAIL
- **Password**: Stored in `TEST_USER_PASSWORD` env var
- **ONLY use this for automated testing**

### User Roles (all projects must implement)
- **admin**: Full access, user management, settings
- **user**: Standard access, own data only

## MCP Servers (Global)
- **playwright** - Browser automation for testing
- **supabase** - Database operations via MCP

## GitHub Access
- **PAT**: `GITHUB_PAT` env var (full repo access)
- **User**: YOUR_GITHUB_USERNAME
- Use `gh` CLI for GitHub operations

## Auto-Testing Flow
Say "test" → Playwright MCP → categorize issues → auto-fix code → report unfixable

## Dev Server Troubleshooting
- **HMR not updating?** Run `npm run build` first
- **Kill stuck process:** `powershell -Command "Stop-Process -Id PID -Force"`

## Skills
Located in `~/.claude/skills/`:
- **build.md** - Autonomous task loop
- **ship.md** - Build, deploy, verify
- **test.md** - Playwright auto-testing
- **fix.md** - Debug and fix issues
- **setup-project.md** - New project setup
- **help.md** - List all commands

## Included Rules
@rules/security.md
@rules/design-system.md
@rules/windows.md
