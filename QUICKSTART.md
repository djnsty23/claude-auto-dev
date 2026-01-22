# Quick Start Guide

Get productive with Claude Auto-Dev in 5 minutes.

## Prerequisites

| Requirement | Check | Install |
|------------|-------|---------|
| Claude Code | `claude --version` | [claude.ai/download](https://claude.ai/download) |
| Node.js 18+ | `node --version` | [nodejs.org](https://nodejs.org) |
| Git | `git --version` | [git-scm.com](https://git-scm.com) |

## Install (One Time)

**Windows (PowerShell):**
```powershell
git clone https://github.com/djnsty23/claude-auto-dev $env:USERPROFILE\claude-auto-dev
& $env:USERPROFILE\claude-auto-dev\install.ps1 -Full
```

**Mac/Linux:**
```bash
git clone https://github.com/djnsty23/claude-auto-dev ~/claude-auto-dev
~/claude-auto-dev/install.sh --full
```

**Restart Claude Code after install.**

---

## Your First Project

### Option A: New Project

```bash
mkdir my-project && cd my-project
claude
```

Then say:
```
brainstorm
```

Claude will ask what you want to build, then create tasks in `prd.json`.

### Option B: Existing Project

```bash
cd your-project
claude
```

Then say:
```
status
```

If no `prd.json` exists, say `brainstorm` to create tasks.

---

## Core Commands

| Say This | What Happens |
|----------|--------------|
| `brainstorm` | Create tasks from your description |
| `auto` | Work through all tasks automatically |
| `status` | Show progress |
| `continue` | Complete one task, then pause |
| `stop` | Save and exit safely |

---

## Example Session

```
You: brainstorm

Claude: What do you want to build?

You: A todo app with user auth and dark mode

Claude: I'll create these tasks:
1. Set up project with Vite + React + TypeScript
2. Add Supabase authentication
3. Create todo CRUD operations
4. Implement dark mode toggle
5. Add responsive styling

Confirm? (y/n)

You: y

Claude: Created prd.json with 5 tasks. Say "auto" to start.

You: auto

Claude: Starting task 1...
[Works through all tasks automatically]
```

---

## Optional: Supabase Integration

For database and auth features:

### 1. Create Supabase Account
Go to [supabase.com](https://supabase.com) and create a free account.

### 2. Get Access Token
```
Supabase Dashboard → Account → Access Tokens → Generate New Token
```

### 3. Configure MCP (Recommended)
```bash
# Windows
setx SUPABASE_ACCESS_TOKEN "sbp_your_token_here"

# Mac/Linux
echo 'export SUPABASE_ACCESS_TOKEN="sbp_your_token_here"' >> ~/.bashrc
```

Then add to `~/.mcp.json`:
```json
{
  "mcpServers": {
    "supabase": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@supabase/mcp-server-supabase@latest"],
      "env": {
        "SUPABASE_ACCESS_TOKEN": "${SUPABASE_ACCESS_TOKEN}"
      }
    }
  }
}
```

### 4. Test It
```
claude
> list my supabase projects
```

---

## Optional: Browser Testing

For E2E testing with agent-browser:

```bash
npm install -g agent-browser
agent-browser install
```

Then say `test` to run browser tests.

---

## Resuming Work

### Same Session
Just keep talking - Claude remembers context.

### New Terminal
```bash
claude -p --resume
```
Pick your session from the list.

### Quick Alias (Optional)
Add to your shell profile:
```bash
alias cr='claude -p --resume'
```

---

## Project Files

After running `brainstorm`, your project will have:

| File | Purpose |
|------|---------|
| `prd.json` | Your task list |
| `progress.txt` | Learnings log |
| `CLAUDE.md` | Project context for Claude |

---

## Troubleshooting

### "Command not found: claude"
Reinstall Claude Code from [claude.ai/download](https://claude.ai/download)

### "prd.json too large"
Say `archive` to compact completed tasks.

### "Skills not loading"
Run the install again:
```powershell
# Windows (PowerShell)
& $env:USERPROFILE\claude-auto-dev\install.ps1 -Full
```
```bash
# Mac/Linux
~/claude-auto-dev/install.sh --full
```

### "MCP server not connecting"
Check your token is set:
```bash
echo $SUPABASE_ACCESS_TOKEN  # Mac/Linux
echo %SUPABASE_ACCESS_TOKEN% # Windows cmd
```

---

## Next Steps

1. **Read the full README**: [github.com/djnsty23/claude-auto-dev](https://github.com/djnsty23/claude-auto-dev)
2. **Try slash commands**: `/status`, `/auto`, `/brainstorm`
3. **Explore plugins**: `claude /help` for available commands

---

## Getting Help

- **GitHub Issues**: [Report bugs](https://github.com/djnsty23/claude-auto-dev/issues)
- **Claude Code Help**: Type `/help` in any session
