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

## Rules
- TypeScript strict, no `any`
- All UI states handled
- Never commit secrets

## User Accounts (Update These)

| Account | Role |
|---------|------|
| YOUR_ADMIN_EMAIL | Admin |
| YOUR_TEST_EMAIL | Tester (automated tests only) |

## Browser Testing
- **agent-browser** - CLI for browser automation
- Install: `npm install -g agent-browser && agent-browser install`

## GitHub Access
- **PAT**: `GITHUB_PAT` env var
- Use `gh` CLI for GitHub operations

## Included
@skills/commands.md
@rules/security.md
@rules/design-system.md
@rules/windows.md
@rules/file-organization.md
