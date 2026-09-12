---
name: rule-windows
description: "Windows-specific development rules: host-aware command wrappers, supervised servers, environment inheritance, native exit status and path conventions. Load only when working on Windows."
when_to_use: "Background rules that apply only on Windows hosts. Not user-invocable."
user-invocable: false
allowed-tools: Read, Grep, Glob
paths:
  - "**/*.ps1"
---

## MCP Servers
- For `.cmd` launchers such as an `npx` shim when the MCP host cannot execute
  them directly, use `"command": "cmd", "args": ["/c", "npx", ...]`.
  Native executables and hosts with their own shell adapter need no blanket wrapper.
- Never use bash syntax directly in MCP configs

## Dev Server
- Use the current host's supervised server tool when available; inspect its
  actual configuration/schema. Otherwise use a supported background process
  with captured logs. Verify owner PID, cwd, port and candidate artifact; do not
  assume detachment survives session shutdown.
- Never `start cmd /k`. It opens a window no tool can read, so the server's own
  error output becomes invisible — a failed compile looks identical to a slow one.
- Check the project's actual port and owning PID; do not assume port 3000 or
  terminate an unrelated listener.

Historical correction, 2026-08-17: a particular host's background/preview
facilities invalidated its old ban on starting dev servers. That observation
does not establish persistence guarantees for another tool or session lifecycle.

## Paths
- Use forward slashes in code: `src/lib/utils.ts`
- Use backslashes only for Windows commands: `cd C:\Users\...`

## Environment Variables
- Processes inherit an environment snapshot from their parent; changes do not
  retroactively update every running process. `.env` interpolation is loader
  specific, so verify the project's loader rather than assuming expansion.
- Check presence of credentials without printing values. Use the established
  secret provider and verify the consuming process receives the intended config.
  See [PowerShell environment scope](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables).

## Supabase CLI
Load the current Supabase skill and inspect installed CLI help before choosing
a database command. A historical timeout on one machine does not establish a
Windows-wide firewall cause. Use the actual error, target and a read-only
control to diagnose it. REST table/RPC access is not arbitrary SQL or exhaustive
schema inspection, and privileged credentials cannot prove ordinary-user RLS.
Use the least-privileged test actor appropriate to the claim, capture HTTP
status and response semantics, and keep credentials out of rendered commands.

## Common Gotchas
- **Always write `curl.exe`, never bare `curl`.** In Windows PowerShell 5.1
  `curl` is an alias for `Invoke-WebRequest`, which does not understand `-H`,
  `-d` or `-X` and fails with a parameter-binding error that never mentions
  curl. Measured on this machine 2026-08-17: `Get-Command curl` returns
  `CommandType: Alias, Definition: Invoke-WebRequest`. `curl.exe` bypasses the
  alias and is the real binary in every shell.
- `curl.exe` ships in `C:\Windows\System32`, so it is available in plain cmd
  too. The old rule here claimed the opposite.
- Use `where.exe` in cmd or `Get-Command` in PowerShell for executable lookup;
  bare `where` can resolve to a PowerShell alias.
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
| Check native `$LASTEXITCODE` before the next command | unconditional semicolon chaining | PS 5.1 lacks `&&`; `;` does not preserve fail-fast semantics |
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
