# Andy's Claude Code

## Identity
GitHub: djnsty23
Email: removed@example.com
Google Workspace: andy@nvision-data.com (for OAuth testing)

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
| adjust | Pick which features to prioritize |
| stop | Clear claims before closing |
| reset | Clear all claims after crash |
| ship | Build → deploy → verify |
| set up | CLAUDE.md + stack + Supabase |
| test | Build check → Playwright tests |

## Autonomous Development
Full system: https://github.com/djnsty23/claude-auto-dev
- **prd.json**: Task list with `passes: true/false` status
- **progress.txt**: Append-only learnings log
- **adjust**: Say "adjust" to reprioritize remaining tasks
- See `~/.claude/skills/build.md` for full workflow

## Rules
- TypeScript strict, no `any`
- All UI states handled
- Never commit secrets
- **BEFORE starting dev server**: Check if port is already in use with `netstat -ano | findstr :3000` (Windows) or `lsof -i :3000` (Mac/Linux). If running, use existing server - don't start a new one on different port. OAuth callbacks are configured for specific ports.

## Global OAuth (for test projects)
Set in Windows env vars, reference in project .env.local:
```powershell
setx GOOGLE_CLIENT_ID "your-id"
setx GOOGLE_CLIENT_SECRET "your-secret"
setx SUPABASE_ACCESS_TOKEN "sbp_..."
```

Projects can then use: `GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}`

## User Accounts

| Account | Role | Usage |
|---------|------|-------|
| andy@nvision-data.com | **Admin** | App management, admin UI, Google Workspace |
| nvision.tester@gmail.com | **Tester** | Automated Playwright tests only |

### Test Account
- **Email**: nvision.tester@gmail.com
- **Password**: Stored in `TEST_USER_PASSWORD` env var
- **ONLY use this for automated testing** - never use andy@ for tests
- Supabase projects should have "Confirm email" disabled for dev/test

### User Roles (all projects must implement)
- **admin**: Full access, user management, settings
- **user**: Standard access, own data only
- Andy's admin email should auto-assign admin role on signup

## MCP Servers (Global)
- **playwright** - Browser automation for testing
- **supabase** - Database operations via MCP

## GitHub Access
- **PAT**: `GITHUB_PAT` env var (full repo access)
- **User**: djnsty23
- Can create repos, push code, manage PRs
- Use `gh` CLI for GitHub operations

## Auto-Testing Flow
Say "test" → Playwright MCP → categorize issues → auto-fix code → report unfixable

## Dev Server Troubleshooting
- **HMR not updating?** Run `npm run build` to check for TypeScript errors first
- **Kill stuck process:** `powershell -Command "Stop-Process -Id PID -Force"`
- **After fixing TS errors:** Restart dev server (HMR cache can be stale)

## Common Implementation Patterns
- **New error types:** Update both `ErrorCode` type AND `USER_MESSAGES` object
- **New hooks:** Add query key to `queryKeys` object before using in hook
- **New API routes:** Test with curl/fetch before building UI
- **YouTube API:** Uses `GOOGLE_API_KEY` or `YOUTUBE_API_KEY` env var

## Skills
Located in `~/.claude/skills/`:
- **build.md** - Autonomous task loop (prd.json + progress.txt)
- **ship.md** - Build, deploy, verify workflow
- **test.md** - Playwright auto-testing
- **fix.md** - Debug and fix issues
- **setup-project.md** - New project setup
- **env-vars.md** - Environment variable management
- **supabase-schema.md** - Database schema operations

## Scripts
Located in `~/.claude/scripts/`:
- `start-server.ps1` - Auto-launch dev server in external terminal (Windows)
- `start-server.sh` - Auto-launch dev server in external terminal (Mac/Linux)

## Included Rules
@rules/security.md
@rules/design-system.md
@rules/windows.md
