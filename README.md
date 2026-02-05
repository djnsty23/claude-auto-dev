# Claude Auto-Dev

[![Claude Code](https://img.shields.io/badge/Claude%20Code-Compatible-blueviolet)](https://claude.ai/code)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-4.8.0-blue.svg)](https://github.com/djnsty23/claude-auto-dev/releases)

**Autonomous development workflow for Claude Code.** Say what you want to build - Claude handles the rest.

---

## Install

**Prerequisites:** [Node.js 18+](https://nodejs.org/), [Claude Code](https://github.com/anthropics/claude-code)

```bash
# Mac/Linux
git clone https://github.com/djnsty23/claude-auto-dev ~/claude-auto-dev
cd ~/claude-auto-dev && chmod +x install.sh && ./install.sh

# Windows (PowerShell)
git clone https://github.com/djnsty23/claude-auto-dev $env:USERPROFILE\claude-auto-dev
cd $env:USERPROFILE\claude-auto-dev; .\install.ps1
```

**Options:**
- `--full` / `-Full` - Also install hooks and rules
- `--init` / `-Init` - Initialize current project with prd.json

**Verify:** `ls ~/.claude/skills/` should show skill folders.

---

## Commands

| Say | Does |
|-----|------|
| `brainstorm` | Scan codebase, propose improvements and features |
| `auto` | Work through all tasks autonomously |
| `status` | Show progress |
| `audit` | 6-agent parallel quality audit |
| `review` | Code quality check |
| `security` | Pre-deploy security scan |
| `ship` | Build and deploy |
| `test` | Run tests |
| `fix` | Debug issues |
| `clean` | Remove temp files |
| `help` | Show all commands |

---

## Workflow

```
brainstorm  →  generates tasks  →  auto  →  completes all  →  ship
```

That's it. No config files, no scripts to run.

---

## Files

**Global** (`~/.claude/`):
```
skills/     # Command instructions (39 skills)
hooks/      # Auto-run scripts (optional)
rules/      # Always-applied rules (optional)
```

**Per Project**:
```
prd.json       # Tasks and sprint history
progress.txt   # Append-only learnings log
```

---

## Task Format

```json
{
  "projectName": "my-app",
  "sprint": "S1",
  "stories": {
    "S1-001": {
      "title": "Add user auth",
      "passes": null
    }
  }
}
```

**States:** `null` = pending, `true` = done, `"deferred"` = postponed

---

## Update

```bash
# Mac/Linux
cd ~/claude-auto-dev && git pull && ./install.sh

# Windows
cd $env:USERPROFILE\claude-auto-dev; git pull; .\install.ps1
```

---

## Uninstall

```bash
rm -rf ~/.claude/skills/ ~/.claude/hooks/ ~/.claude/rules/
```

---

## License

MIT
