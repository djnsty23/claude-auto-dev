# Windows Development Rules

## MCP Servers
- ALWAYS use `cmd /c` wrapper: `"command": "cmd", "args": ["/c", "npx", ...]`
- Never use bash syntax directly in MCP configs

## Dev Server
- NEVER run `npm run dev` directly via Claude Code (gets killed on session end)
- Use external terminal: `start cmd /k "cd /d %CD% && npm run dev"`
- Check port first: `netstat -ano | findstr :3000`

## Paths
- Use forward slashes in code: `src/lib/utils.ts`
- Use backslashes only for Windows commands: `cd C:\Users\...`

## Environment Variables
- System env vars available to all processes
- Reference in .env.local: `${GOOGLE_CLIENT_ID}` or leave it to system
- Check with: `echo %VARIABLE_NAME%` (cmd) or `$env:VARIABLE_NAME` (PowerShell)

## Common Gotchas
- `curl` works in PowerShell and Git Bash, not in plain cmd
- Use `where` instead of `which` for finding executables
- Line endings: ensure `.gitattributes` has `* text=auto`
