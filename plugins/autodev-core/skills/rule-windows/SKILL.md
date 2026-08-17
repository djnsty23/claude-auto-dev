---
name: rule-windows
description: "Windows-specific development rules: cmd /c wrappers for MCP, dev servers in an external terminal, path conventions, and the Supabase CLI firewall workaround. Load only when working on Windows."
when_to_use: "Background rules that apply only on Windows hosts. Not user-invocable."
user-invocable: false
allowed-tools: Read, Grep, Glob
---

## MCP Servers
- ALWAYS use `cmd /c` wrapper: `"command": "cmd", "args": ["/c", "npx", ...]`
- Never use bash syntax directly in MCP configs

## Dev Server
- **`preview_start` first**, with a `.claude/launch.json` entry. It owns the
  server lifecycle, reuses an already-running server, and exposes the logs via
  `preview_logs`. The `browser` skill holds the full loop.
- Nothing to preview, or no `launch.json`? Then `Bash({ command: "npm run dev",
  run_in_background: true })`. A backgrounded Bash command is detached and
  survives across turns.
- Never `start cmd /k`. It opens a window no tool can read, so the server's own
  error output becomes invisible — a failed compile looks identical to a slow one.
- Check the port first: `netstat -ano | findstr :3000`

Superseded 2026-08-17. This section used to forbid `npm run dev` outright on the
grounds that it "gets killed on session end". That premise is now false twice
over: `run_in_background` detaches the process, and `preview_start` supervises it
outright. The rule was compensating for a limitation the harness no longer has.

## Paths
- Use forward slashes in code: `src/lib/utils.ts`
- Use backslashes only for Windows commands: `cd C:\Users\...`

## Environment Variables
- System env vars available to all processes
- Reference in .env.local: `${GOOGLE_CLIENT_ID}` or leave it to system
- Check with: `echo %VARIABLE_NAME%` (cmd) or `$env:VARIABLE_NAME` (PowerShell)

## Supabase CLI
- `supabase db query --linked` triggers Windows Firewall prompts and times out — **never use it**
- **Use REST API instead** — fully automatable, no firewall issues:
  - Read: `curl.exe 'https://<ref>.supabase.co/rest/v1/<table>?select=*' -H 'apikey: <anon_key>' -H 'Authorization: Bearer <service_role_key>'`
  - RPC/SQL: `curl.exe -X POST 'https://<ref>.supabase.co/rest/v1/rpc/<fn>' -H 'apikey: <anon_key>' -d '{}'`
  - Schema: `curl.exe 'https://<ref>.supabase.co/rest/v1/' -H 'apikey: <anon_key>'` (lists tables)
  - Write `curl.exe`, not `curl` — see the alias trap under Common Gotchas.
- Keys come from env vars (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) or `.env.local`

## Common Gotchas
- **Always write `curl.exe`, never bare `curl`.** In Windows PowerShell 5.1
  `curl` is an alias for `Invoke-WebRequest`, which does not understand `-H`,
  `-d` or `-X` and fails with a parameter-binding error that never mentions
  curl. Measured on this machine 2026-08-17: `Get-Command curl` returns
  `CommandType: Alias, Definition: Invoke-WebRequest`. `curl.exe` bypasses the
  alias and is the real binary in every shell.
- `curl.exe` ships in `C:\Windows\System32`, so it is available in plain cmd
  too. The old rule here claimed the opposite.
- Use `where` instead of `which` for finding executables
- Line endings: ensure `.gitattributes` has `* text=auto`
