# Claude Auto-Dev

[![Claude Code](https://img.shields.io/badge/Claude%20Code-Compatible-blueviolet)](https://claude.ai/code)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-6.1-blue.svg)](https://github.com/djnsty23/claude-auto-dev/releases)

**Autonomous development workflow for Claude Code.** Say what you want to build - Claude handles the rest.

---

## Quick Start

```bash
# Mac/Linux
git clone https://github.com/djnsty23/claude-auto-dev ~/claude-auto-dev
cd ~/claude-auto-dev && chmod +x install.sh && ./install.sh

# Windows (PowerShell)
git clone https://github.com/djnsty23/claude-auto-dev $env:USERPROFILE\claude-auto-dev
cd $env:USERPROFILE\claude-auto-dev; .\install.ps1
```
```
claude
```
```
You: brainstorm
Claude: [Scans codebase, finds improvements] → Created 5 stories in prd.json

You: auto
Claude: [Works through all tasks autonomously] → 5/5 complete

You: ship
Claude: [Review → security scan → deploy] → Shipped to production
```

---

## Install

**Prerequisites:** [Git](https://git-scm.com/), [Claude Code](https://github.com/anthropics/claude-code)

```bash
# Mac/Linux
git clone https://github.com/djnsty23/claude-auto-dev ~/claude-auto-dev
cd ~/claude-auto-dev && chmod +x install.sh && ./install.sh

# Windows (PowerShell)
git clone https://github.com/djnsty23/claude-auto-dev $env:USERPROFILE\claude-auto-dev
cd $env:USERPROFILE\claude-auto-dev; .\install.ps1
```

**What it does:**
- Symlinks `skills/` and `hooks/` to `~/.claude/` (auto-sync with repo)
- Adds `update-dev` command to your shell
- Saves repo path for portable updates

**Options:**
- `--full` / `-Full` - Also install rules and settings templates
- `--init` / `-Init` - Initialize current project with prd.json
- `--copy` / `-Copy` - Use copy instead of symlinks (if symlinks fail)

---

## Updates

**Option 1: Say "update dev"** (recommended)
```
You: update dev
Claude: [pulls latest, syncs skills/hooks, removes stale files]
        Updated to v6.1
```

**Option 2: Automatic on session start**
- Session hook pulls latest from GitHub (5s timeout)
- Re-copies if changes detected

**Option 3: Manual**
```bash
cd ~/claude-auto-dev && git pull
# Then say "update dev" to sync
```

---

## Commands

| Say | Does |
|-----|------|
| `brainstorm` | Scan codebase, propose improvements and features |
| `auto` | Work through all tasks autonomously |
| `progress` | Show sprint progress |
| `audit` | 7-agent parallel quality audit |
| `review` | Code quality check (add `quick` or `deep`) |
| `security` | Pre-deploy security scan |
| `sprint` | Create/advance sprint |
| `ship` | Build, test, review, deploy |
| `test` | Run unit + browser tests |
| `fix` | Debug issues |
| `commit` | Conventional commit + push + PR |
| `refactor` | Code refactoring patterns |
| `perf` | Performance audit (Core Web Vitals) |
| `a11y` | Accessibility audit (WCAG 2.1 AA) |
| `clean` | Remove temp files |
| `setup` | Initialize new project |
| `update dev` | Sync latest from GitHub to ~/.claude |

**Note:** `/help`, `/status`, `/init`, `/compact` are Claude Code built-ins.

---

## Workflow

```
brainstorm → scans codebase, creates stories in prd.json
auto       → implements all pending stories + runs tests
ship       → review + security scan + build + deploy
```

See [`skills/commands.md`](skills/commands.md) for the full list of 30 skills.

---

## Files

**Global** (`~/.claude/`):
```
skills/        # Synced from repo (30 skills)
hooks/         # Symlink to repo
rules/         # Your custom rules (optional)
repo-path.txt  # Points to your clone location
```

**Per Project**:
```
prd.json       # Tasks and sprint history
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

## New PC Setup

```bash
# Clone anywhere
git clone https://github.com/djnsty23/claude-auto-dev /path/to/claude-auto-dev

# Run installer (creates symlinks + update-dev alias)
cd /path/to/claude-auto-dev
./install.sh   # or .\install.ps1 on Windows

# Done - open new terminal and use update-dev
```

---

## Troubleshooting

**Symlinks fail on Windows?**
- Enable Developer Mode in Settings > Update & Security > For developers
- Or run PowerShell as Administrator
- Or use `.\install.ps1 -Copy` (auto-updates still work, just slower)

**Not seeing updates?**
- Check `~/.claude/repo-path.txt` points to your clone
- Ensure you have internet on Claude start
- Manual: `cd ~/claude-auto-dev && git pull`

**Skills not loading?**
- Verify `~/.claude/skills/` exists and contains skill directories
- Restart terminal after install

**Hook errors?**
- Requires Node.js v18+. Check: `node -v`
- Hooks fail silently by design — run `node validate.js` to check consistency

---

## Uninstall

```bash
rm -rf ~/.claude/skills ~/.claude/hooks ~/.claude/repo-path.txt
# Remove update-dev function from your shell profile
```

---

## License

MIT
