---
name: rule-windows
description: "Windows-specific development rules: cmd /c wrappers for MCP, dev servers in an external terminal, path conventions, and the Supabase CLI firewall workaround. Load only when working on Windows."
when_to_use: "Background rules that apply only on Windows hosts. Not user-invocable."
user-invocable: false
allowed-tools: Read, Grep, Glob
paths:
  - "**/*.ps1"
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

## Writing PowerShell blocks in skills and docs

How you fence a block decides whether the Windows conventions are enforced on it.
`check-superseded` scans `powershell`, `ps1` and `pwsh` fences for Windows
conventions and deliberately exempts `bash`, `sh`, `zsh`, `shell` and `console`
fences — even inside a file whose name matches `windows`. So the label is not
cosmetic: it is the switch that decides which rules apply.

**Label every block, and label it honestly.**

- An unlabelled ` ``` ` fence is scanned by nothing. If the content is PowerShell,
  say `powershell` — otherwise the Windows rules silently do not apply to it.
- Never put bash inside a `powershell` fence, or PowerShell inside a `bash` fence.
  The Windows rules then fire on content they should spare, or spare content they
  should catch. Two fences beat one mislabelled fence.
- A Mac/Linux comparison block belongs in its own `bash` fence. That is explicitly
  fine here and the detector will leave it alone.

**Close what you open, and mind the marker length.** Fence tracking follows the
CommonMark rule: a fence closes only on the *same* character, *at least as long*
as the opener, with no info string.

- An unclosed fence used to leak its language to the end of the file, so prose
  twenty lines down was read as PowerShell. It no longer does, but an unclosed
  fence still renders wrong for the reader.
- Inside a ` ````markdown ` wrapper, an inner ` ```powershell ` is **content**, not
  an instruction — a displayed example. That is correct, and it also means you
  cannot enforce a rule on a block you are only demonstrating.
- `~~~powershell` is a valid fence and is scanned. Prefer backticks for
  consistency, but tildes are the escape hatch when the block itself contains
  backtick fences.

**Content rules inside a PowerShell block**, all of which the detector or the
gotchas above cover:

| Write | Instead of | Because |
|---|---|---|
| `curl.exe` with flags | bare `curl` | `curl` is an alias for `Invoke-WebRequest` in PS 5.1 |
| `cmd1; cmd2` | `cmd1 && cmd2` | `&&` is not a PS 5.1 operator |
| backtick continuation | `\` continuation | `\` is not a line continuation in PowerShell |
| `$env:VAR` | `%VAR%` / `$VAR` | cmd and POSIX syntax respectively |
| `New-Item -Force` | `mkdir -p` | no `-p` on the PowerShell alias |
| `Select-String` | `grep` | not present unless Git Bash is on PATH |

Note what happened while that table was being written. The first draft spelled the
wrong form out in full, and `check-superseded` flagged its own documentation at
`SKILL.md:96` — correctly, because a bare `curl` followed by a flag is an
instruction wherever it appears, including in a table cell labelled as wrong. A doc
that shows a banned form has to **name** it, not **invoke** it. `bare curl` carries
the meaning; `curl` plus a flag carries the bug.

**One trap that is not about fences at all.** When a script shells out with a git
ref, use `execFileSync` with an argv array, never `execSync` with a string.
`execSync` routes through `cmd.exe /d /s /c`, where `^` is the escape character, so
`git rev-parse HEAD^` returns HEAD's own sha — silently, with exit 0. Measured
2026-08-17: `execSync` gave `af3bd7b` where `execFileSync` gave `faa3c21`. Any
caret-bearing ref (`HEAD^`, `HEAD^^`, `main^`, `HEAD^2`) is affected.
